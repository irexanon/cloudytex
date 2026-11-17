import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import stream from 'stream';
import { fileURLToPath } from 'url';

import axios from 'axios';
import express from 'express';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import pLimit from 'p-limit';
import sharp from 'sharp';
import multer from 'multer';
import NodeCache from 'node-cache';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { MongoClient, ObjectId } from 'mongodb';
import { customAlphabet } from 'nanoid';
import { google } from 'googleapis';
import { Client, LargeFileUploadTask } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch';

import { TelegramClient, helpers as tgHelpers } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { createServer as createViteServer } from 'vite';

import { initBot } from './telegram.ts';
import {
  parseGoogleRangeOffset,
  parseOneDriveNextOffset,
  withSessionLock,
  validateUploadRequest,
  validateKeyBackupInput,
  validateOpaqueFilename,
  validatePlaintextFilename,
  validateSafeFolderId,
  computeFileSha256,
  isSafeProviderItemId,
  escapeDriveQueryValue,
  isTrustedGraphNextLink,
  isValidHttpsUrl,
  TELEGRAM_ENCRYPTED_CAPTION_MARKER,
  type ValidatedUploadSpec,
} from './provider-transfer-protocol.ts';

dotenv.config();

// Reuse TCP/TLS connections for upstream provider calls (Google Drive / OneDrive / CDNs)
axios.defaults.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PORT       = process.env.PORT || 3000;

const SALT_ROUNDS = 10;
const isProduction = process.env.NODE_ENV === 'production';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || (isProduction ? '' : 'admin');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (isProduction ? '' : 'password');
if (isProduction && (!ADMIN_USERNAME || !ADMIN_PASSWORD || ADMIN_PASSWORD === 'password')) {
  throw new Error('ADMIN_USERNAME and a non-default ADMIN_PASSWORD are required in production');
}
const BASIC_AUTH_ENABLED = Boolean(ADMIN_USERNAME && ADMIN_PASSWORD);
const AUTH_TOKEN         = BASIC_AUTH_ENABLED ? Buffer.from(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).toString('base64') : '';

function timingSafeEqualStrings(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const MICROSOFT_REDIRECT_URI = `${process.env.APP_URL}/auth/microsoft/callback`;
const MEDIA_SIGNING_SECRET = process.env.MEDIA_SIGNING_SECRET || (
  (ADMIN_PASSWORD || process.env.MONGODB_URI || process.env.TELEGRAM_BOT_TOKEN)
    ? crypto.createHash('sha256').update(`cloudyte-media-sig:${ADMIN_PASSWORD}:${process.env.MONGODB_URI || ''}:${process.env.TELEGRAM_BOT_TOKEN || ''}`).digest('hex')
    : crypto.randomBytes(32).toString('hex')
);
const JOB_MAX_ATTEMPTS = Number(process.env.JOB_MAX_ATTEMPTS || 3);
const JOB_LEASE_MS = 10 * 60 * 1000;

const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;

// ─── Thumbnail, Dedicated Temp Dir & Resource Protection Configuration ───────
const THUMB_DIR = process.env.THUMB_DIR || path.join(os.tmpdir(), 'cloudyte-thumbs');
const TEMP_DIR  = process.env.TEMP_DIR || path.join(os.tmpdir(), 'cloudyte-temp');
for (const dir of [THUMB_DIR, TEMP_DIR]) {
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
}

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 15_000);
const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS || 3_000);
const PROVIDER_API_TIMEOUT_MS = Number(process.env.PROVIDER_API_TIMEOUT_MS || 30_000);
const DOWNLOAD_IDLE_TIMEOUT_MS = Number(process.env.DOWNLOAD_IDLE_TIMEOUT_MS || 60_000);
const MAX_CONCURRENT_UPLOADS_PER_USER = Number(process.env.MAX_CONCURRENT_UPLOADS_PER_USER || 5);
const MAX_GLOBAL_CONCURRENT_UPLOADS = Number(process.env.MAX_GLOBAL_CONCURRENT_UPLOADS || 25);
const MAX_DAILY_UPLOAD_BYTES_PER_USER = Number(process.env.MAX_DAILY_UPLOAD_BYTES_PER_USER || 20 * 1024 * 1024 * 1024);
const MAX_CONCURRENT_DOWNLOADS_PER_USER = Number(process.env.MAX_CONCURRENT_DOWNLOADS_PER_USER || 10);
const MAX_JOB_QUEUE_DEPTH = Number(process.env.MAX_JOB_QUEUE_DEPTH || 500);
const WORKER_ID = `worker_${process.pid}_${ crypto.randomBytes(4).toString('hex') }`;

const thumbLimit = pLimit(10);
const inFlightThumbs = new Map<string, Promise<string | null>>();
const inFlightCacheLoads = new Map<string, Promise<any>>();
const providerLimits = new Map<string, ReturnType<typeof pLimit>>();
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_TEMP_FREE_BYTES = Number(process.env.MIN_TEMP_FREE_BYTES || 5 * 1024 * 1024 * 1024);

// Active resource concurrency tracking
const activeUploadsByUser = new Map<string, number>();
let activeGlobalUploads = 0;
const activeDownloadsByUser = new Map<string, number>();
let activeHttpConnections = 0;
let isShuttingDown = false;

export const STANDARD_ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  TRANSFER_FAILED: 'TRANSFER_FAILED',
  INSUFFICIENT_STORAGE: 'INSUFFICIENT_STORAGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

type ProviderMetricBucket = {
  calls: number;
  errors: number;
  consecutiveFailures: number;
  retries: number;
  totalDurationMs: number;
  lastErrorAt: number | null;
};

const systemMetrics = {
  startedAt: Date.now(),
  requestsTotal: 0,
  errorsTotal: 0,
  slowRequestsTotal: 0,
  unhandledRejections: 0,
  uncaughtExceptions: 0,
  uploadsCompleted: 0,
  uploadsFailed: 0,
  transfersCompleted: 0,
  transfersFailed: 0,
  jobsDeadLettered: 0,
  eventLoopLagMs: 0,
  mongoConnected: false,
  mongoReconnects: 0,
  providerCalls: {
    google: { calls: 0, errors: 0, consecutiveFailures: 0, retries: 0, totalDurationMs: 0, lastErrorAt: null } as ProviderMetricBucket,
    onedrive: { calls: 0, errors: 0, consecutiveFailures: 0, retries: 0, totalDurationMs: 0, lastErrorAt: null } as ProviderMetricBucket,
    telegram: { calls: 0, errors: 0, consecutiveFailures: 0, retries: 0, totalDurationMs: 0, lastErrorAt: null } as ProviderMetricBucket,
  } as Record<string, ProviderMetricBucket>,
};

function recordProviderCall(provider: string, operation: string, durationMs: number, ok: boolean, retryCount = 0, statusOrCode?: string | number) {
  const key = provider.toLowerCase().includes('one') ? 'onedrive' : provider.toLowerCase().includes('tg') || provider.toLowerCase().includes('tele') ? 'telegram' : 'google';
  const bucket = systemMetrics.providerCalls[key] || (systemMetrics.providerCalls[key] = { calls: 0, errors: 0, consecutiveFailures: 0, retries: 0, totalDurationMs: 0, lastErrorAt: null });
  bucket.calls++;
  bucket.retries += retryCount;
  bucket.totalDurationMs += durationMs;
  if (!ok) {
    bucket.errors++;
    bucket.consecutiveFailures++;
    bucket.lastErrorAt = Date.now();
  } else {
    bucket.consecutiveFailures = 0;
  }
  console.log(JSON.stringify({
    event: 'provider_call',
    provider: key,
    operation,
    durationMs,
    status: ok ? 'ok' : 'error',
    retryCount,
    ...(statusOrCode !== undefined ? { providerStatus: statusOrCode } : {}),
  }));
}

function getOpenFileDescriptorCount(): number | null {
  try {
    if (fs.existsSync('/proc/self/fd')) {
      return fs.readdirSync('/proc/self/fd').length;
    }
  } catch { /* ignore on non-Linux */ }
  return null;
}

function getTempDirStats(dir = TEMP_DIR): { fileCount: number; totalBytes: number } {
  let fileCount = 0;
  let totalBytes = 0;
  try {
    if (!fs.existsSync(dir)) return { fileCount: 0, totalBytes: 0 };
    for (const name of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile()) {
          fileCount++;
          totalBytes += st.size;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { fileCount, totalBytes };
}

function acquireUserUploadSlot(userId: string): { ok: boolean; reason?: string; release: () => void } {
  const key = String(userId || 'anonymous');
  const currentUser = activeUploadsByUser.get(key) || 0;
  if (currentUser >= MAX_CONCURRENT_UPLOADS_PER_USER) {
    return { ok: false, reason: `Maximum concurrent uploads per user (${MAX_CONCURRENT_UPLOADS_PER_USER}) exceeded`, release: () => {} };
  }
  if (activeGlobalUploads >= MAX_GLOBAL_CONCURRENT_UPLOADS) {
    return { ok: false, reason: 'Server upload capacity is currently full; please retry shortly', release: () => {} };
  }
  activeUploadsByUser.set(key, currentUser + 1);
  activeGlobalUploads++;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      activeGlobalUploads = Math.max(0, activeGlobalUploads - 1);
      const cur = activeUploadsByUser.get(key) || 1;
      if (cur <= 1) activeUploadsByUser.delete(key);
      else activeUploadsByUser.set(key, cur - 1);
    },
  };
}

function acquireUserDownloadSlot(userId: string): { ok: boolean; release: () => void } {
  const key = String(userId || 'anonymous');
  const current = activeDownloadsByUser.get(key) || 0;
  if (current >= MAX_CONCURRENT_DOWNLOADS_PER_USER) {
    return { ok: false, release: () => {} };
  }
  activeDownloadsByUser.set(key, current + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      const cur = activeDownloadsByUser.get(key) || 1;
      if (cur <= 1) activeDownloadsByUser.delete(key);
      else activeDownloadsByUser.set(key, cur - 1);
    },
  };
}

function providerLimit(key: string, concurrency = 3) {
  const normalizedKey = key || 'unknown';
  let limiter = providerLimits.get(normalizedKey);
  if (!limiter) {
    limiter = pLimit(concurrency);
    providerLimits.set(normalizedKey, limiter);
  }
  return limiter;
}

function apiError(res: any, status: number, code: string, message: string, requestId?: string, retryable = status >= 500 || status === 429) {
  if (res?.locals) {
    res.locals.errorCode = code;
  }
  if (status >= 500) {
    systemMetrics.errorsTotal++;
  }
  return res.status(status).json({
    error: message,
    code,
    requestId: requestId || null,
    retryable,
    correlationId: requestId || null,
  });
}

function errorCode(status: number) {
  if (status === 400) return STANDARD_ERROR_CODES.BAD_REQUEST;
  if (status === 401) return STANDARD_ERROR_CODES.UNAUTHORIZED;
  if (status === 403) return STANDARD_ERROR_CODES.FORBIDDEN;
  if (status === 404) return STANDARD_ERROR_CODES.NOT_FOUND;
  if (status === 409) return STANDARD_ERROR_CODES.CONFLICT;
  if (status === 429) return STANDARD_ERROR_CODES.RATE_LIMITED;
  if (status === 502 || status === 503 || status === 504) return STANDARD_ERROR_CODES.PROVIDER_ERROR;
  if (status === 507) return STANDARD_ERROR_CODES.INSUFFICIENT_STORAGE;
  return STANDARD_ERROR_CODES.INTERNAL_ERROR;
}

function getFreeBytes(dir = TEMP_DIR) {
  try {
    const target = fs.existsSync(dir) ? dir : os.tmpdir();
    const stat = fs.statfsSync(target);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

function hasTempDiskHeadroom(requiredBytes = 0) {
  const freeBytes = getFreeBytes(TEMP_DIR);
  return freeBytes === null || freeBytes - requiredBytes >= MIN_TEMP_FREE_BYTES;
}

function signMediaRequest(accountId: string, fileId: string, expiresAt: number) {
  return crypto.createHmac('sha256', MEDIA_SIGNING_SECRET)
    .update(`${accountId}:${fileId}:${expiresAt}`)
    .digest('base64url');
}

function isValidMediaRequest(accountId: string, fileId: string, expiresAt: string, signature: string) {
  const expiry = Number(expiresAt);
  if (!Number.isSafeInteger(expiry) || expiry < Date.now()) return false;
  const expected = signMediaRequest(accountId, fileId, expiry);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

const TEMP_FILE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const TEMP_FILE_PREFIXES = ['upload_', 'transfer_'];

function pruneTempFiles(dir = TEMP_DIR) {
  const cutoff = Date.now() - TEMP_FILE_MAX_AGE_MS;
  const dirsToSweep = dir === TEMP_DIR ? [TEMP_DIR, os.tmpdir()] : [dir];
  for (const targetDir of dirsToSweep) {
    try {
      if (!fs.existsSync(targetDir)) continue;
      for (const name of fs.readdirSync(targetDir)) {
        if (!TEMP_FILE_PREFIXES.some(prefix => name.startsWith(prefix))) continue;
        const fullPath = path.join(targetDir, name);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(fullPath);
        } catch { /* another request may have removed or be using the file */ }
      }
    } catch (err) {
      console.error('[TempFiles] Cleanup error:', err);
    }
  }
}

function pruneThumbDir(dir: string, maxBytes = 500 * 1024 * 1024) {
  try {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir);
    const filesWithStats: { path: string; size: number; mtime: number }[] = [];
    let totalSize = 0;

    for (const name of entries) {
      const fullPath = path.join(dir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          filesWithStats.push({ path: fullPath, size: stat.size, mtime: stat.mtimeMs });
          totalSize += stat.size;
        }
      } catch { /* ignore */ }
    }

    if (totalSize <= maxBytes) return;

    // Delete oldest files first
    filesWithStats.sort((a, b) => a.mtime - b.mtime);
    for (const file of filesWithStats) {
      if (totalSize <= maxBytes) break;
      try {
        fs.unlinkSync(file.path);
        totalSize -= file.size;
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.error('[Thumbs] Prune error:', err);
  }
}

function buildThumbPath(accountId: string, fileId: string, size: number): string {
  const keyHash = crypto.createHash('sha256').update(`${accountId}:${fileId}`).digest('hex');
  const resolvedRoot = path.resolve(THUMB_DIR);
  const candidate = path.resolve(resolvedRoot, `${keyHash}_${size}.jpg`);
  if (!candidate.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Invalid thumbnail path');
  }
  return candidate;
}

function deleteThumbFiles(fileId: string, accountId?: string) {
  try {
    if (!fs.existsSync(THUMB_DIR)) return;
    const files = fs.readdirSync(THUMB_DIR);
    const hashedPrefix = accountId
      ? `${crypto.createHash('sha256').update(`${accountId}:${fileId}`).digest('hex')}_`
      : null;
    const safeRawPrefix = (typeof fileId === 'string' && !fileId.includes('/') && !fileId.includes('\\') && !fileId.includes('..'))
      ? `${fileId}_`
      : null;
    for (const f of files) {
      if ((hashedPrefix && f.startsWith(hashedPrefix)) || (safeRawPrefix && f.startsWith(safeRawPrefix))) {
        try { fs.unlinkSync(path.join(THUMB_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    console.error(`[Thumbs] Delete error for file ${fileId}:`, err);
  }
}

// ─── Caches (bounded size, never mutate directly, stampede protected) ─────────
const driveCache = new NodeCache({ stdTTL: 60, checkperiod: 120, maxKeys: 5000, useClones: true });
const authCache  = new NodeCache({ stdTTL: 60, checkperiod: 120, maxKeys: 5000, useClones: true });

async function withCacheStampedeProtection<T>(cacheKey: string, loader: () => Promise<T>): Promise<T> {
  const existing = inFlightCacheLoads.get(cacheKey);
  if (existing) return existing as Promise<T>;
  const promise = loader().finally(() => {
    inFlightCacheLoads.delete(cacheKey);
  });
  inFlightCacheLoads.set(cacheKey, promise);
  return promise;
}

function invalidateDriveCache(accountId: string) {
  if (!accountId) return;
  const keys = driveCache.keys();
  // Cache keys are namespaced as ...:<accountId>:...; also clear aggregated "all" summaries.
  const boundary = `:${accountId}:`;
  const toDelete = keys.filter(
    k => k.includes(boundary) || k.endsWith(`:${accountId}`) || k.startsWith('storage_summary:all')
  );
  if (toDelete.length > 0) driveCache.del(toDelete);
}

function clearUserAuthCache(userId: string) {
  if (!userId) return;
  const keys = authCache.keys();
  for (const k of keys) {
    const val: any = authCache.get(k);
    if (val && String(val.userId) === String(userId)) {
      authCache.del(k);
    }
  }
}

// ─── GramJS peer resolver ────────────────────────────────────────────────────
let testResolvePeer: ((telegram: any, id: string) => Promise<any>) | null = null;
const resolvePeer = async (telegram: TelegramClient, id: string): Promise<any> => {
  if (testResolvePeer) return testResolvePeer(telegram, id);
  if (!id || id === 'me') return 'me';
  const cleanId = id.trim();
  try {
    return await telegram.getEntity(cleanId);
  } catch (err: any) {
    if (/^-?\d+$/.test(cleanId)) {
      try {
        if (cleanId.startsWith('-100')) {
          return new Api.InputPeerChannel({
            channelId: BigInt(cleanId.substring(4)) as any,
            accessHash: BigInt(0) as any,
          });
        }
        if (cleanId.startsWith('-')) return new Api.InputPeerChat({ chatId: BigInt(cleanId.substring(1)) as any });
        return BigInt(cleanId) as any;
      } catch {
        throw err;
      }
    }
    throw err;
  }
};

const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
const nanoid12 = customAlphabet(alphabet, 12);
const nanoid6  = customAlphabet(alphabet, 6);
const nanoid32 = customAlphabet(alphabet, 32);
const nanoid   = (length = 12) => {
  if (length === 6) return nanoid6();
  if (length === 32) return nanoid32();
  return nanoid12();
};

function escapeRegex(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Multer configured with diskStorage in dedicated TEMP_DIR with 2 GB limit
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
      } catch { /* ignore */ }
      cb(null, TEMP_DIR);
    },
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `upload_${Date.now()}_${nanoid(6)}_${safeName}`);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// ─── MongoDB (with auto-reconnect, pool & socket timeouts, and per-query maxTimeMS) ───
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const MONGODB_QUERY_TIMEOUT_MS = Math.max(1000, Number(process.env.MONGODB_QUERY_TIMEOUT_MS || 15_000));
const client   = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: Number(process.env.MONGODB_SOCKET_TIMEOUT_MS || 45_000),
  maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 20),
  minPoolSize: 1,
  retryWrites: true,
  retryReads: true,
});
let db: any = null;
let mongoConnectPromise: Promise<any> | null = null;

/**
 * Wraps a MongoDB Db instance so every cursor and query applies a default maxTimeMS
 * without breaking in-memory test collections.
 */
function wrapDbWithQueryTimeout(rawDb: any, timeoutMs = MONGODB_QUERY_TIMEOUT_MS): any {
  if (!rawDb || typeof rawDb.collection !== 'function' || rawDb.__queryTimeoutWrapped) return rawDb;
  const colCache = new Map<string, any>();
  return new Proxy(rawDb, {
    get(target, prop, receiver) {
      if (prop === '__queryTimeoutWrapped') return true;
      if (prop === 'collection') {
        return (name: string, options?: any) => {
          if (!options && colCache.has(name)) return colCache.get(name);
          const rawCol = target.collection(name, options);
          if (!rawCol || typeof rawCol !== 'object') return rawCol;
          const wrappedCol = new Proxy(rawCol, {
            get(colTarget, colProp, colReceiver) {
              const orig = Reflect.get(colTarget, colProp, colReceiver);
              if (typeof orig !== 'function') return orig;
              if (colProp === 'find' || colProp === 'aggregate') {
                return (...args: any[]) => {
                  const cursor = orig.apply(colTarget, args);
                  if (cursor && typeof cursor.maxTimeMS === 'function') {
                    try { cursor.maxTimeMS(timeoutMs); } catch { /* ignore */ }
                  }
                  return cursor;
                };
              }
              if ((colProp === 'findOne' || colProp === 'countDocuments') && typeof colTarget.dbName === 'string') {
                return (filter: any = {}, opts?: any) => {
                  const nextOpts = opts && typeof opts === 'object'
                    ? (opts.maxTimeMS !== undefined ? opts : { ...opts, maxTimeMS: timeoutMs })
                    : { maxTimeMS: timeoutMs };
                  return orig.call(colTarget, filter, nextOpts);
                };
              }
              return orig.bind(colTarget);
            },
          });
          if (!options) colCache.set(name, wrappedCol);
          return wrappedCol;
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

client.on('connectionPoolReady', () => {
  systemMetrics.mongoConnected = true;
});
client.on('connectionPoolClosed', () => {
  systemMetrics.mongoConnected = false;
});
client.on('serverHeartbeatSucceeded', () => {
  systemMetrics.mongoConnected = true;
});
client.on('error', (err) => {
  console.error('[Mongo] Client pool error:', err);
});

async function connectToMongo(maxRetries = 3) {
  if (db) return db;
  if (mongoConnectPromise) return mongoConnectPromise;
  mongoConnectPromise = (async () => {
    try {
      let lastErr: any;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await client.connect();
          db = wrapDbWithQueryTimeout(client.db('cloudyte'));
          systemMetrics.mongoConnected = true;
          break;
        } catch (err) {
          lastErr = err;
          systemMetrics.mongoReconnects++;
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 500 * (2 ** (attempt - 1))));
          }
        }
      }
      if (!db) throw lastErr;

    // Startup indexes (ignore if they already exist)
    try { await db.collection('sessions').createIndex({ token: 1 }, { unique: true }); } catch { /* ignore */ }
    try { await db.collection('tg_files').createIndex({ accountId: 1, folder: 1, date: -1 }); } catch { /* ignore */ }
    try { await db.collection('tg_files').createIndex({ accountId: 1, folder: 1, date: -1, _id: -1 }); } catch { /* ignore */ }
    try { await db.collection('tg_files').createIndex({ accountId: 1, name: 1 }); } catch { /* ignore */ }
    try { await db.collection('tg_files').createIndex({ accountId: 1, folder: 1, name: 1 }); } catch { /* ignore */ }
    try { await db.collection('tg_files').createIndex({ accountId: 1, isEncrypted: 1 }); } catch { /* ignore */ }
    try { await db.collection('tg_files').createIndex({ userId: 1, isEncrypted: 1 }); } catch { /* ignore */ }
    try { await db.collection('tg_files').createIndex({ encryptedChecksum: 1 }); } catch { /* ignore */ }
    try { await db.collection('tg_files').createIndex({ accountId: 1, providerFileId: 1 }); } catch { /* ignore */ }
    try { await db.collection('tg_files').createIndex({ accountId: 1, idempotencyKey: 1 }, { sparse: true }); } catch { /* ignore */ }
    try { await db.collection('tg_folders').createIndex({ accountId: 1, path: 1 }); } catch { /* ignore */ }

    // Upload sessions & encryption key backups indexes
    try { await db.collection('upload_sessions').createIndex({ sessionId: 1 }, { unique: true }); } catch { /* ignore */ }
    try { await db.collection('upload_sessions').createIndex({ status: 1, expiresAt: 1 }); } catch { /* ignore */ }
    try { await db.collection('upload_sessions').createIndex({ userId: 1, accountId: 1, idempotencyKey: 1 }); } catch { /* ignore */ }
    try { await db.collection('account_encryption_backups').createIndex({ accountId: 1, userId: 1 }, { unique: true }); } catch { /* ignore */ }

    // Additional collection indexes (drop legacy fixed 30d createdAt TTL so sliding expiresAt governs session expiry)
    try { await db.collection('sessions').dropIndex('createdAt_1'); } catch { /* ignore */ }
    try { await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); } catch { /* ignore */ }
    try { await db.collection('sessions').createIndex({ userId: 1, lastActiveAt: -1 }); } catch { /* ignore */ }
    try { await db.collection('tg_files').createIndex({ accountId: 1, trashed: 1, trashedAt: -1 }); } catch { /* ignore */ }
    try { await db.collection('oauth_states').createIndex({ stateHash: 1, provider: 1 }, { unique: true }); } catch { /* ignore */ }
    try { await db.collection('oauth_states').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); } catch { /* ignore */ }
    try { await db.collection('accounts').createIndex({ userId: 1 }); } catch { /* ignore */ }
    try { await db.collection('accounts').createIndex({ email: 1 }); } catch { /* ignore */ }
    try { await db.collection('users').createIndex({ username: 1 }, { unique: true, sparse: true }); } catch { /* ignore */ }
    try { await db.collection('users').createIndex({ tgIds: 1 }); } catch { /* ignore */ }
    try { await db.collection('settings').createIndex({ key: 1 }, { unique: true }); } catch { /* ignore */ }
    try { await db.collection('tg_files').createIndex({ accountId: 1, messageId: 1 }); } catch { /* ignore */ }
    try { await db.collection('tg_files').createIndex({ userId: 1 }); } catch { /* ignore */ }
    try { await db.collection('tg_files').createIndex({ shareId: 1 }, { unique: true, sparse: true }); } catch { /* ignore */ }
    try { await db.collection('tg_files').createIndex({ name: 'text' }); } catch { /* ignore */ }
    try { await db.collection('shares').createIndex({ shareId: 1 }, { unique: true }); } catch { /* ignore */ }
    try { await db.collection('tg_folders').createIndex({ userId: 1 }); } catch { /* ignore */ }
    try { await db.collection('jobs').createIndex({ type: 1, status: 1, priority: -1, nextRunAt: 1, createdAt: 1 }); } catch { /* ignore */ }
    try { await db.collection('jobs').createIndex({ status: 1, leaseUntil: 1 }); } catch { /* ignore */ }
    try { await db.collection('jobs').createIndex({ userId: 1, createdAt: -1 }); } catch { /* ignore */ }
    try { await db.collection('jobs').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); } catch { /* ignore */ }
    try { await db.collection('upload_sessions').createIndex({ userId: 1, status: 1, createdAt: -1 }); } catch { /* ignore */ }
    try { await db.collection('transfer_manifests').createIndex({ jobId: 1 }, { unique: true }); } catch { /* ignore */ }
    try { await db.collection('transfer_manifests').createIndex({ userId: 1, completedAt: -1 }); } catch { /* ignore */ }

    await runMigration(db);
    await runEncryptionMigration(db);
    await checkAdmin(db);
    await ensureDefaultSettings(db);
    await runIndexDiagnostics(db);

    return db;
    } catch (err) {
      console.error('MongoDB initialization error:', err);
      throw err;
    } finally {
      mongoConnectPromise = null;
    }
  })();
  return mongoConnectPromise;
}

export async function runEncryptionMigration(database: any) {
  if (!database) return;
  try {
    await database.collection('tg_files').updateMany(
      { isEncrypted: { $exists: false } },
      {
        $set: {
          isEncrypted: false,
          encryptionFormatVersion: null,
          encryptionKeyId: null,
          encryptedMetadata: null,
          encryptedSizeBytes: null,
          encryptedChecksum: null,
          opaqueRemoteName: null,
        },
      }
    );
    await database.collection('upload_sessions').updateMany(
      { isEncrypted: { $exists: false } },
      {
        $set: {
          isEncrypted: false,
          encryptionFormatVersion: null,
          encryptionKeyId: null,
          encryptedMetadata: null,
          encryptedSizeBytes: null,
          encryptedChecksum: null,
          opaqueRemoteName: null,
        },
      }
    );
  } catch (err) {
    console.error('[Migration] Encryption backfill failed:', err);
  }
}

async function runIndexDiagnostics(database: any) {
  if (process.env.MONGODB_INDEX_DIAGNOSTICS !== 'true') return;
  const checks = [
    { collection: 'tg_files', filter: { accountId: new ObjectId('000000000000000000000000'), folder: '' }, sort: { date: -1, _id: -1 } },
    { collection: 'tg_files', filter: { accountId: new ObjectId('000000000000000000000000'), folder: '', name: /example/i }, sort: { name: 1 } },
    { collection: 'tg_folders', filter: { accountId: new ObjectId('000000000000000000000000'), path: /^/ }, sort: { path: 1 } },
  ];
  for (const check of checks) {
    try {
      const explain = await database.collection(check.collection)
        .find(check.filter)
        .sort(check.sort)
        .limit(1)
        .explain('executionStats');
      console.log(JSON.stringify({
        event: 'mongodb_index_diagnostic',
        collection: check.collection,
        namespace: explain.queryPlanner?.namespace,
        winningPlan: explain.queryPlanner?.winningPlan?.stage,
        docsExamined: explain.executionStats?.totalDocsExamined,
        keysExamined: explain.executionStats?.totalKeysExamined,
      }));
    } catch (err) {
      console.error('[Mongo] Index diagnostic failed:', err);
    }
  }
}

async function runMigration(database: any) {
  const users = await database.collection('users').find({ tgId: { $exists: true }, userId: { $exists: false } }).toArray();
  if (users.length === 0) return;

  console.log(`[Migration] Starting migration for ${users.length} users...`);

  for (const oldUser of users) {
    const tgId = String(oldUser.tgId);
    const existing = await database.collection('users').findOne({ tgIds: tgId });
    if (existing) {
      await database.collection('accounts').updateMany({ tgId: tgId }, { $set: { userId: existing._id }, $unset: { tgId: "" } });
      await database.collection('sessions').updateMany({ tgId: tgId }, { $set: { userId: existing._id }, $unset: { tgId: "" } });
      await database.collection('tg_files').updateMany({ tgId: tgId }, { $set: { userId: existing._id }, $unset: { tgId: "" } });
      await database.collection('tg_folders').updateMany({ tgId: tgId }, { $set: { userId: existing._id }, $unset: { tgId: "" } });
      await database.collection('users').deleteOne({ _id: oldUser._id });
      continue;
    }

    let targetUsername = oldUser.username || `user_${tgId}`;
    const usernameConflict = await database.collection('users').findOne({ username: targetUsername });
    if (usernameConflict) {
      targetUsername = `${targetUsername}_${tgId}`;
    }

    const userId = nanoid();
    try {
      await database.collection('users').insertOne({
        _id: userId as any,
        username: targetUsername,
        password: oldUser.password || '',
        tgIds: [tgId],
        isAdmin: !!oldUser.isAdmin,
        isActive: true,
        createdAt: oldUser.createdAt || new Date(),
        createdVia: 'migration',
        backupEnabled: !!oldUser.backupEnabled,
        backupAccId: oldUser.backupAccId || null
      });

      await database.collection('accounts').updateMany({ tgId: tgId }, { $set: { userId: userId }, $unset: { tgId: "" } });
      await database.collection('sessions').updateMany({ tgId: tgId }, { $set: { userId: userId }, $unset: { tgId: "" } });
      await database.collection('tg_files').updateMany({ tgId: tgId }, { $set: { userId: userId }, $unset: { tgId: "" } });
      await database.collection('tg_folders').updateMany({ tgId: tgId }, { $set: { userId: userId }, $unset: { tgId: "" } });
      await database.collection('users').deleteOne({ _id: oldUser._id });
    } catch (e) {
      console.error(`[Migration] Failed to migrate user ${tgId}:`, e);
    }
  }
  console.log('[Migration] Migration step finished.');
}

async function checkAdmin(database: any) {
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (adminUsername && adminPassword) {
    const userWithAdminName = await database.collection('users').findOne({ username: adminUsername });
    if (userWithAdminName) {
      if (!userWithAdminName.isAdmin) {
        console.log(`[Admin] Elevating existing user ${adminUsername} to Admin...`);
        await database.collection('users').updateOne({ _id: userWithAdminName._id }, { $set: { isAdmin: true } });
      }
    } else {
      console.log(`[Admin] Creating default admin: ${adminUsername}`);
      const hashedPassword = await bcrypt.hash(adminPassword, SALT_ROUNDS);
      try {
        await database.collection('users').insertOne({
          _id: nanoid() as any,
          username: adminUsername,
          password: hashedPassword,
          tgIds: [],
          isAdmin: true,
          isActive: true,
          createdAt: new Date(),
          createdVia: 'system'
        });
      } catch (e: any) {
        if (e.code !== 11000) console.error('[Admin] Error creating admin:', e);
      }
    }
  }
}

async function ensureDefaultSettings(database: any) {
  const settings = [
    { key: 'registrationEnabled', value: true },
    { key: 'webRegistrationEnabled', value: true },
    { key: 'botRegistrationEnabled', value: true }
  ];

  for (const s of settings) {
    await database.collection('settings').updateOne(
      { key: s.key },
      { $setOnInsert: s },
      { upsert: true }
    );
  }
}

async function getUserIdByTg(tgId: number | string, database: any) {
  const user = await database.collection('users').findOne({ tgIds: String(tgId) });
  if (!user || !user.isActive) return null;
  return user._id;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function parseDeviceNameFromRequest(req: any): string {
  const headerName = typeof req.headers?.['x-device-name'] === 'string' ? req.headers['x-device-name'].trim() : '';
  if (headerName) return headerName.slice(0, 80);
  const ua = typeof req.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : '';
  if (!ua) return 'Cloudyte Client';
  if (/okhttp|android/i.test(ua)) return 'Cloudyte Android';
  if (/iphone|ipad|ios/i.test(ua)) return 'Cloudyte iOS';
  if (/edg\//i.test(ua)) return 'Edge Web';
  if (/chrome\//i.test(ua)) return 'Chrome Web';
  if (/firefox\//i.test(ua)) return 'Firefox Web';
  if (/safari\//i.test(ua)) return 'Safari Web';
  return ua.slice(0, 64);
}

// ─── Auth Middleware with NodeCache ──────────────────────────────────────────
const requireAuth = async (req: any, res: any, next: any) => {
  req.db = db;
  const authHeader     = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const tokenFromQuery = typeof req.query.token === 'string' ? req.query.token : undefined;

  if (BASIC_AUTH_ENABLED && authHeader && timingSafeEqualStrings(authHeader, `Basic ${AUTH_TOKEN}`)) {
    req.isAdmin = true;
    return next();
  }

  // Keep ?token= query auth working, but prefer Authorization header
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const token = bearerToken || (tokenFromQuery ? tokenFromQuery.trim() : null);
  if (token && token.length <= 256) {
    const cachedAuth = authCache.get(token) as any;
    if (cachedAuth) {
      const nowMs = Date.now();
      if (cachedAuth.expiresAt && cachedAuth.expiresAt < nowMs) {
        authCache.del(token);
        if (req.db) {
          try { await req.db.collection('sessions').deleteOne({ token }); } catch { /* ignore */ }
        }
        return res.status(401).json({ error: 'Session expired' });
      }
      if (!cachedAuth.lastTouchedAt || nowMs - cachedAuth.lastTouchedAt >= SESSION_TOUCH_INTERVAL_MS) {
        const newNow = new Date(nowMs);
        const newExp = new Date(nowMs + SESSION_TTL_MS);
        const updatedAuth = { ...cachedAuth, lastTouchedAt: nowMs, expiresAt: newExp.getTime() };
        authCache.set(token, updatedAuth);
        if (req.db) {
          req.db.collection('sessions').updateOne(
            { token },
            { $set: { lastActiveAt: newNow, expiresAt: newExp } }
          ).catch(() => {});
        }
      }
      req.userId    = cachedAuth.userId;
      req.isAdmin   = cachedAuth.isAdmin;
      req.user      = cachedAuth.user;
      req.sessionId = cachedAuth.sessionId;
      req.token     = token;
      return next();
    }

    if (req.db) {
      const session = await req.db.collection('sessions').findOne({ token });
      if (session) {
        const expMs = session.expiresAt ? new Date(session.expiresAt).getTime() : null;
        if (expMs !== null && !Number.isNaN(expMs) && expMs < Date.now()) {
          authCache.del(token);
          try { await req.db.collection('sessions').deleteOne({ _id: session._id }); } catch { /* ignore */ }
          return res.status(401).json({ error: 'Session expired' });
        }

        const user = await req.db.collection('users').findOne({ _id: session.userId });
        if (user && user.isActive !== false) {
          const sessionId = String(session.sessionId || session._id);
          const nowMs = Date.now();
          const lastActiveMs = session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : 0;
          let nextExpMs = expMs ?? (nowMs + SESSION_TTL_MS);
          let lastTouchedAt = lastActiveMs || nowMs;
          if (!lastActiveMs || nowMs - lastActiveMs >= SESSION_TOUCH_INTERVAL_MS) {
            const newNow = new Date(nowMs);
            const newExp = new Date(nowMs + SESSION_TTL_MS);
            nextExpMs = newExp.getTime();
            lastTouchedAt = nowMs;
            req.db.collection('sessions').updateOne(
              { _id: session._id },
              { $set: { sessionId, lastActiveAt: newNow, expiresAt: newExp } }
            ).catch(() => {});
          }
          const authData = { userId: user._id, isAdmin: !!user.isAdmin, user, sessionId, expiresAt: nextExpMs, lastTouchedAt };
          authCache.set(token, authData);
          req.userId    = user._id;
          req.isAdmin   = !!user.isAdmin;
          req.user      = user;
          req.sessionId = sessionId;
          req.token     = token;
          return next();
        }
      }
    }
  }
  res.status(401).json({ error: 'Unauthorized' });
};

const requireAuthOrSignedMedia = async (req: any, res: any, next: any) => {
  req.db = db;
  const { exp, sig } = req.query;
  if (typeof exp === 'string' && typeof sig === 'string' && isValidMediaRequest(req.params.accountId, req.params.fileId, exp, sig)) {
    req.isSignedMedia = true;
    req.mediaSigned = true;
    return next();
  }
  return requireAuth(req, res, next);
};

// ─── GramJS singleton (bot-auth) ─────────────────────────────────────────────
let tgClient: TelegramClient | null = null;
let testTgClientFactory: (() => Promise<any>) | null = null;
async function getTgClient() {
  if (testTgClientFactory) return testTgClientFactory();
  if (tgClient && tgClient.connected) return tgClient;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token === 'YOUR_BOT_TOKEN') throw new Error('TELEGRAM_BOT_TOKEN missing');
  if (!API_ID || !API_HASH) throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH missing');

  let sessionString = '';
  const sessionKey = `tg_session_${Buffer.from(token).toString('base64').slice(0, 16)}`;
  try {
    const database = db || await connectToMongo();
    const saved = await database.collection('config').findOne({ key: sessionKey });
    if (saved?.value) sessionString = saved.value;
  } catch { /* ignore */ }

  const startInstance = async (session: string) => {
    const c = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 5 });
    await c.start({ botToken: token, botAuthToken: token } as any);
    return c;
  };

  try {
    tgClient = await startInstance(sessionString);
  } catch (err: any) {
    if (err.message.includes('AUTH_KEY_UNREGISTERED') || err.message.includes('BotToken') || sessionString) {
      try { const d = db || await connectToMongo(); await d.collection('config').deleteOne({ key: sessionKey }); } catch { /* ignore */ }
      tgClient = await startInstance('');
    } else { throw err; }
  }

  if (tgClient?.session) {
    try {
      const ns = tgClient.session.save() as unknown as string;
      if (ns && ns !== sessionString) {
        const d = db || await connectToMongo();
        await d.collection('config').updateOne({ key: sessionKey }, { $set: { value: ns, updatedAt: new Date() } }, { upsert: true });
      }
    } catch { /* ignore */ }
  }
  return tgClient;
}

// ─── Cloud clients ────────────────────────────────────────────────────────────
let testDriveClientFactory: ((tokens: any) => Promise<any>) | null = null;
let testOneDriveClientFactory: ((tokens: any, accountId?: string) => Promise<any>) | null = null;

export function setTestDependencies(deps: {
  db?: any;
  tgClient?: any;
  getTgClient?: (() => Promise<any>) | null;
  resolvePeer?: ((telegram: any, id: string) => Promise<any>) | null;
  driveClientFactory?: ((tokens: any) => Promise<any>) | null;
  getDriveClient?: ((tokens: any) => Promise<any>) | null;
  oneDriveClientFactory?: ((tokens: any, accountId?: string) => Promise<any>) | null;
  getOneDriveClient?: ((tokens: any, accountId?: string) => Promise<any>) | null;
} | null) {
  if (!deps) {
    testTgClientFactory = null;
    testResolvePeer = null;
    testDriveClientFactory = null;
    testOneDriveClientFactory = null;
    authCache.flushAll();
    driveCache.flushAll();
    return;
  }
  if ('db' in deps) db = deps.db;
  if ('tgClient' in deps) tgClient = deps.tgClient;
  if ('getTgClient' in deps) testTgClientFactory = deps.getTgClient ?? null;
  if ('resolvePeer' in deps) testResolvePeer = deps.resolvePeer ?? null;
  if ('driveClientFactory' in deps) testDriveClientFactory = deps.driveClientFactory ?? null;
  if ('getDriveClient' in deps) testDriveClientFactory = deps.getDriveClient ?? null;
  if ('oneDriveClientFactory' in deps) testOneDriveClientFactory = deps.oneDriveClientFactory ?? null;
  if ('getOneDriveClient' in deps) testOneDriveClientFactory = deps.getOneDriveClient ?? null;
  authCache.flushAll();
  driveCache.flushAll();
}

async function getDriveClient(tokens: any, accountId?: string) {
  if (testDriveClientFactory) return testDriveClientFactory(tokens);
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials(tokens);
  if (accountId && ObjectId.isValid(accountId)) {
    auth.on('tokens', (newTokens) => {
      const merged = { ...tokens, ...newTokens };
      tokens = merged;
      const d = db;
      if (d) {
        d.collection('accounts').updateOne({ _id: new ObjectId(accountId) }, { $set: { tokens: merged } }).catch(() => {});
      }
    });
  }
  return google.drive({ version: 'v3', auth, timeout: PROVIDER_API_TIMEOUT_MS });
}

async function getOneDriveClient(tokens: any, accountId?: string) {
  if (testOneDriveClientFactory) return testOneDriveClientFactory(tokens, accountId);
  if (!tokens.expiry_date && tokens.expires_in)
    tokens = { ...tokens, expiry_date: Date.now() + Number(tokens.expires_in) * 1000 };

  const c = Client.init({
    authProvider: async (done) => {
      try {
        const isExpired = !tokens.expiry_date || Date.now() > tokens.expiry_date - 300000;
        if (isExpired && tokens.refresh_token) {
          await withSessionLock(`onedrive_token:${accountId || 'anon'}`, async () => {
            const stillExpired = !tokens.expiry_date || Date.now() > tokens.expiry_date - 300000;
            if (!stillExpired) return;
            const r = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token',
              new URLSearchParams({
                client_id: MICROSOFT_CLIENT_ID!, client_secret: MICROSOFT_CLIENT_SECRET!,
                grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
              }),
              { timeout: 15_000 }
            );
            tokens = { ...tokens, access_token: r.data.access_token, refresh_token: r.data.refresh_token || tokens.refresh_token,
              expires_in: r.data.expires_in, expiry_date: Date.now() + Number(r.data.expires_in) * 1000 };
            if (accountId && ObjectId.isValid(accountId)) {
              const d = db || await connectToMongo();
              await d.collection('accounts').updateOne({ _id: new ObjectId(accountId) }, { $set: { tokens } });
            }
          });
          done(null, tokens.access_token);
        } else { done(null, tokens.access_token); }
      } catch (err: any) { done(err, null); }
    },
  });
  return c;
}

// ─── Authorization helpers ────────────────────────────────────────────────────
async function resolveAuthorizedAccount(
  database: any,
  accountId: unknown,
  userId?: string | ObjectId | null,
  isAdmin?: boolean
): Promise<{ account: any | null; accessDenied: boolean; invalidId: boolean }> {
  const d = database || db || await connectToMongo();
  if (!accountId || typeof accountId !== 'string' || !ObjectId.isValid(accountId)) {
    return { account: null, accessDenied: false, invalidId: true };
  }
  const account = await d.collection('accounts').findOne({ _id: new ObjectId(accountId) });
  if (!account) {
    return { account: null, accessDenied: false, invalidId: false };
  }
  if (!isAdmin && account.userId !== undefined && String(account.userId) !== String(userId || '')) {
    return { account: null, accessDenied: true, invalidId: false };
  }
  return { account, accessDenied: false, invalidId: false };
}

async function resolveFileMetadataForAccount(
  database: any,
  account: any,
  fileId: string,
  userId?: string | ObjectId | null,
  isAdmin?: boolean,
  includeTrashed = false
): Promise<{ meta: any | null; accessDenied: boolean }> {
  const d = database || db || await connectToMongo();
  if (account.accountType === 'tgdrive') {
    if (!ObjectId.isValid(fileId)) return { meta: null, accessDenied: false };
    const meta = await d.collection('tg_files').findOne({ _id: new ObjectId(fileId) });
    if (!meta) return { meta: null, accessDenied: false };
    if (String(meta.accountId) !== String(account._id)) return { meta: null, accessDenied: true };
    if (!isAdmin && meta.userId && userId && String(meta.userId) !== String(userId)) {
      return { meta: null, accessDenied: true };
    }
    if (!includeTrashed && meta.trashed === true) return { meta: null, accessDenied: false };
    return { meta, accessDenied: false };
  }
  const orClauses: any[] = [{ providerFileId: fileId }];
  if (ObjectId.isValid(fileId)) orClauses.push({ _id: new ObjectId(fileId) });
  const meta = await d.collection('tg_files').findOne({ accountId: account._id, $or: orClauses })
    || await d.collection('tg_files').findOne({ $or: orClauses });
  if (!meta) return { meta: null, accessDenied: false };
  if (String(meta.accountId) !== String(account._id)) return { meta: null, accessDenied: true };
  if (!isAdmin && meta.userId && userId && String(meta.userId) !== String(userId)) {
    return { meta: null, accessDenied: true };
  }
  if (!includeTrashed && meta.trashed === true) return { meta: null, accessDenied: false };
  return { meta, accessDenied: false };
}

// ─── TG Drive helpers ─────────────────────────────────────────────────────────
// Upload a file from disk path to a Telegram channel via GramJS, save metadata, return record.
async function tgUploadFile(
  accountId: string, channelId: string, filePath: string,
  fileName: string, mimeType: string, folder: string, caption = '', idempotencyKey?: string,
  encryptionSpec?: ValidatedUploadSpec, userId?: string
) {
  return providerLimit(`telegram:upload:${accountId}`, 2)(async () => {
    const startedAt = Date.now();
    const database = db || await connectToMongo();
    if (idempotencyKey) {
      const existing = await database.collection('tg_files').findOne({ accountId: new ObjectId(accountId), idempotencyKey });
      if (existing) return existing;
    }
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      const unsupported: any = new Error('Telegram does not accept zero-byte documents through the configured upload protocol');
      unsupported.code = 'UNSUPPORTED_PROVIDER_OPERATION';
      throw unsupported;
    }
    const isEncrypted = Boolean(encryptionSpec?.isEncrypted);
    const effectiveName = isEncrypted ? (encryptionSpec!.opaqueRemoteName || fileName) : fileName;
    if (isEncrypted) {
      const check = validateOpaqueFilename(effectiveName);
      if (!check.ok) {
        const err: any = new Error(check.message);
        err.code = check.code;
        throw err;
      }
    }
    const effectiveCaption = isEncrypted ? TELEGRAM_ENCRYPTED_CAPTION_MARKER : caption;
    let result: any;
    try {
      const telegram   = await getTgClient();
      const peerEntity = await resolvePeer(telegram, channelId);
      result           = await telegram.sendFile(peerEntity, {
        file: filePath,
        caption: effectiveCaption,
        forceDocument: true,
        attributes: [new Api.DocumentAttributeFilename({ fileName: effectiveName })],
      }) as any;
      recordProviderCall('telegram', 'sendFile', Date.now() - startedAt, true, 0);
    } catch (tgErr: any) {
      recordProviderCall('telegram', 'sendFile', Date.now() - startedAt, false, 0, tgErr?.code || 'ERROR');
      throw tgErr;
    }
    const messageId = result.id as number;
    const nowSec    = Math.floor(Date.now() / 1000);
    const nowMs     = Date.now();

    if (isEncrypted && encryptionSpec) {
      const encSize = encryptionSpec.encryptedSizeBytes ?? stat.size;
      const record: any = {
        accountId: new ObjectId(accountId),
        ...(userId ? { userId: String(userId) } : {}),
        messageId,
        shareId:                    null,
        name:                      effectiveName,
        mimeType:                  'application/octet-stream',
        size:                      encSize,
        folder:                    folder || '',
        caption:                   TELEGRAM_ENCRYPTED_CAPTION_MARKER,
        isEncrypted:               true,
        encryptionFormatVersion:   encryptionSpec.encryptionFormatVersion ?? 1,
        encryptionKeyId:           encryptionSpec.encryptionKeyId,
        encryptedMetadata:         encryptionSpec.encryptedMetadata,
        encryptedSizeBytes:        encSize,
        encryptedChecksum:         encryptionSpec.encryptedChecksum,
        opaqueRemoteName:          effectiveName,
        plaintextSizeBytes:        null,
        plaintextChecksum:         null,
        encryptedThumbnailObjectId: null,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        date:                      nowSec,
        updatedAt:                 nowMs,
      };
      const ins = await database.collection('tg_files').insertOne(record);
      return { ...record, _id: record._id ?? ins?.insertedId };
    }

    const shareId = nanoid(6);
    const record: any = {
      accountId:   new ObjectId(accountId),
      ...(userId ? { userId: String(userId) } : {}),
      messageId,
      shareId,
      name:        effectiveName,
      size:        stat.size,
      mimeType,
      folder,
      caption:     effectiveCaption,
      isEncrypted: false,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      date:        nowSec,
      updatedAt:   nowMs,
    };
    const ins = await database.collection('tg_files').insertOne(record);
    return { ...record, _id: record._id ?? ins?.insertedId };
  });
}

function waitForDrainOrClose(res: any): Promise<void> {
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      res.off('drain', onDone);
      res.off('close', onDone);
      res.off('error', onDone);
    };
    const onDone = () => {
      cleanup();
      resolve();
    };
    res.once('drain', onDone);
    res.once('close', onDone);
    res.once('error', onDone);
  });
}

function pipeUpstreamWithAbort(
  upstreamStream: NodeJS.ReadableStream & { destroy?: (err?: Error) => void },
  req: any,
  res: any,
  idleTimeoutMs = DOWNLOAD_IDLE_TIMEOUT_MS
) {
  let cleaned = false;
  let idleTimer: NodeJS.Timeout | null = null;

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const resetIdle = () => {
    clearIdle();
    if (idleTimeoutMs > 0 && !cleaned) {
      idleTimer = setTimeout(() => {
        const timeoutErr = new Error('Upstream stream idle timeout');
        onUpstreamError(timeoutErr);
        try { upstreamStream.destroy?.(timeoutErr); } catch { /* ignore */ }
      }, idleTimeoutMs);
      idleTimer.unref?.();
    }
  };

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearIdle();
    res.off('close', onClientClose);
    req?.off?.('aborted', onClientClose);
    upstreamStream.off?.('data', resetIdle);
    upstreamStream.off?.('error', onUpstreamError);
    upstreamStream.off?.('end', cleanup);
  };
  const onClientClose = () => {
    cleanup();
    if (!res.writableEnded) {
      try { upstreamStream.destroy?.(); } catch { /* ignore */ }
    }
  };
  const onUpstreamError = (err: any) => {
    cleanup();
    console.error('Upstream stream error:', err);
    if (!res.headersSent) {
      res.status(502).send('Upstream stream error');
    } else if (!res.writableEnded) {
      res.destroy(err);
    }
  };
  resetIdle();
  res.on('close', onClientClose);
  req?.on?.('aborted', onClientClose);
  upstreamStream.on('data', resetIdle);
  upstreamStream.on('error', onUpstreamError);
  upstreamStream.on('end', cleanup);
  upstreamStream.pipe(res);
}

// Stream a TG file to an HTTP response (supports Range headers for video/audio and encrypted files).
async function tgStreamFile(messageId: number, channelId: string, req: any, res: any, meta: any) {
  let clientAborted = false;
  let idleTimer: NodeJS.Timeout | null = null;
  const startedAt = Date.now();
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const resetIdle = () => {
    clearIdle();
    if (DOWNLOAD_IDLE_TIMEOUT_MS > 0 && !clientAborted) {
      idleTimer = setTimeout(() => {
        clientAborted = true;
        if (!res.writableEnded) res.destroy(new Error('Telegram stream idle timeout'));
      }, DOWNLOAD_IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    }
  };
  const onClose = () => {
    clientAborted = true;
    clearIdle();
  };
  res.on('close', onClose);
  req?.on?.('aborted', onClose);

  try {
    resetIdle();
    const telegram = await getTgClient();
    const peer     = await resolvePeer(telegram, channelId);
    const messages = await telegram.getMessages(peer, { ids: [messageId] });
    if (!messages || !messages[0] || !messages[0].media) throw new Error('Message not found');
    const media    = messages[0].media as any;

    const isEncrypted = meta?.isEncrypted === true;
    let totalSize: number = isEncrypted ? Number(meta?.encryptedSizeBytes ?? meta?.size ?? 0) : Number(meta?.size || 0);
    if (!totalSize && media?.document?.size) totalSize = Number(media.document.size);
    const contentType = isEncrypted ? 'application/octet-stream' : (meta?.mimeType || 'application/octet-stream');

    const rangeHeader = req.headers['range'];
    if (rangeHeader && totalSize) {
      const [startStr, endStr] = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? Math.min(parseInt(endStr, 10), totalSize - 1) : totalSize - 1;
      if (isNaN(start) || isNaN(end) || start < 0 || start > end || start >= totalSize) {
        res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
        return;
      }
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', chunkSize);
      res.setHeader('Content-Type', contentType);
      const stepSize = 512 * 1024;
      let skipBytes = start % stepSize;
      const alignedStart = start - skipBytes;
      let downloaded = 0;
      for await (const rawChunk of telegram.iterDownload({ file: media, requestSize: stepSize, offset: tgHelpers.returnBigInt(alignedStart) })) {
        resetIdle();
        if (clientAborted || res.destroyed) break;
        let usableChunk = rawChunk;
        if (skipBytes > 0) {
          if (usableChunk.length <= skipBytes) {
            skipBytes -= usableChunk.length;
            continue;
          }
          usableChunk = usableChunk.subarray(skipBytes);
          skipBytes = 0;
        }
        const remaining = chunkSize - downloaded;
        if (remaining <= 0) break;
        const chunk = usableChunk.length > remaining ? usableChunk.subarray(0, remaining) : usableChunk;
        downloaded += chunk.length;
        const canContinue = res.write(chunk);
        if (!canContinue) {
          await waitForDrainOrClose(res);
          if (clientAborted || res.destroyed) break;
        }
        if (downloaded >= chunkSize) break;
      }
      if (!clientAborted && !res.writableEnded) res.end();
    } else {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      if (totalSize) res.setHeader('Content-Length', totalSize);
      for await (const chunk of telegram.iterDownload({ file: media, requestSize: 512 * 1024 })) {
        resetIdle();
        if (clientAborted || res.destroyed) break;
        const canContinue = res.write(chunk);
        if (!canContinue) {
          await waitForDrainOrClose(res);
          if (clientAborted || res.destroyed) break;
        }
      }
      if (!clientAborted && !res.writableEnded) res.end();
    }
    recordProviderCall('telegram', 'streamFile', Date.now() - startedAt, true, 0);
  } catch (err: any) {
    recordProviderCall('telegram', 'streamFile', Date.now() - startedAt, false, 0, err?.code || 'ERROR');
    if (!clientAborted) {
      console.error('tgStreamFile error:', err);
      if (!res.headersSent) res.status(500).send('Streaming error');
      else if (!res.writableEnded) res.destroy(err);
    }
  } finally {
    clearIdle();
    res.off('close', onClose);
    req?.off?.('aborted', onClose);
  }
}

// Normalise a raw tg_files doc to the standard file shape the frontend expects.
export function normaliseTgFile(f: any, accountId?: string) {
  const idStr = String(f.providerFileId || f._id);
  const updatedAt = typeof f.updatedAt === 'number'
    ? f.updatedAt
    : (f.date ? f.date * 1000 : (f.updatedAt ? new Date(f.updatedAt).getTime() : Date.now()));

  if (f.isEncrypted === true) {
    const encSize = Number(f.encryptedSizeBytes ?? f.size ?? 0);
    const opaqueName = f.opaqueRemoteName || f.name;
    return {
      id:                      idStr,
      ...(f.messageId !== undefined ? { messageId: f.messageId } : {}),
      name:                    opaqueName,
      type:                    'other',
      mimeType:                'application/octet-stream',
      size:                    encSize ? (encSize / (1024 ** 2)).toFixed(1) + ' MB' : '0.0 MB',
      sizeBytes:               encSize,
      encryptedSizeBytes:      encSize,
      isEncrypted:             true,
      encryptionFormatVersion: f.encryptionFormatVersion ?? 1,
      encryptionKeyId:         f.encryptionKeyId ?? null,
      encryptedChecksum:       f.encryptedChecksum ?? null,
      encryptedMetadata:       f.encryptedMetadata ?? null,
      modified:                f.date ? new Date(f.date * 1000).toLocaleDateString() : '-',
      createdAt:               f.date ? new Date(f.date * 1000).toLocaleDateString() : '-',
      folder:                  f.folder || '',
      isTgDrive:               !f.providerFileId,
      updatedAt,
      thumbUrl:                null,
    };
  }

  const mime = f.mimeType || '';
  let type   = 'other';
  if (mime.includes('image'))        type = 'image';
  else if (mime.includes('video'))   type = 'video';
  else if (mime.includes('audio'))   type = 'audio';
  else if (mime.includes('pdf'))     type = 'pdf';
  else if (mime.includes('zip') || mime.includes('rar') || mime.includes('7z')) type = 'zip';
  else if (mime.includes('spreadsheet') || mime.includes('excel')) type = 'sheet';
  else if (mime.includes('document') || mime.includes('word'))     type = 'doc';
  else if (mime.includes('presentation') || mime.includes('powerpoint')) type = 'slide';

  const isMedia = type === 'image' || type === 'video';
  const accIdStr = accountId || (f.accountId ? String(f.accountId) : '');

  return {
    id:                      idStr,
    messageId:               f.messageId,
    name:                    f.name,
    type,
    mimeType:                f.mimeType,
    size:                    f.size ? (Number(f.size) / (1024 ** 2)).toFixed(1) + ' MB' : '-',
    sizeBytes:               f.size ? Number(f.size) : 0,
    isEncrypted:             false,
    encryptionFormatVersion: null,
    encryptionKeyId:         null,
    encryptedSizeBytes:      null,
    encryptedChecksum:       null,
    encryptedMetadata:       null,
    modified:                f.date ? new Date(f.date * 1000).toLocaleDateString() : '-',
    createdAt:               f.date ? new Date(f.date * 1000).toLocaleDateString() : '-',
    folder:                  f.folder || '',
    shareId:                 f.shareId,
    isTgDrive:               true,
    updatedAt,
    thumbUrl:                isMedia && accIdStr ? `/api/thumb/${accIdStr}/${idStr}?s=256` : null,
  };
}

function sendJsonWithEtag(req: any, res: any, data: any) {
  const body = JSON.stringify(data);
  const hash = crypto.createHash('md5').update(body).digest('hex');
  const etag = `W/"${hash}"`;
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  res.setHeader('Content-Type', 'application/json');
  return res.send(body);
}

// ─── Thumbnail Generation Engine ──────────────────────────────────────────────
async function generateThumbnail(account: any, fileId: string, s: number, thumbPath: string): Promise<string | null> {
  const database = db || await connectToMongo();

  const { meta } = await resolveFileMetadataForAccount(database, account, fileId);
  if (meta?.isEncrypted === true) {
    return null;
  }

  if (account.accountType === 'tgdrive') {
    if (!meta) return null;

    const telegram = await getTgClient();
    const peer = await resolvePeer(telegram, account.channelId);
    const msgs = await telegram.getMessages(peer, { ids: [meta.messageId] });
    if (!msgs || !msgs[0] || !msgs[0].media) return null;

    const media: any = msgs[0].media;
    const rawThumbs: any[] = (media.document && media.document.thumbs) || (media.photo && media.photo.sizes) || [];

    // Smallest thumb that is >= s px, or largest available sized thumb if all are < s px
    const sizedThumbs = rawThumbs.filter((t: any) => Math.max(t.w || 0, t.h || 0) > 0);
    const eligibleThumbs = sizedThumbs.filter((t: any) => {
      const dim = Math.max(t.w || 0, t.h || 0);
      return dim >= s;
    });
    eligibleThumbs.sort((a: any, b: any) => {
      const dimA = Math.max(a.w || 0, a.h || 0);
      const dimB = Math.max(b.w || 0, b.h || 0);
      return dimA - dimB;
    });
    const fallbackThumbs = [...sizedThumbs].sort((a: any, b: any) => {
      const dimA = Math.max(a.w || 0, a.h || 0);
      const dimB = Math.max(b.w || 0, b.h || 0);
      return dimB - dimA;
    });
    const chosenThumb = eligibleThumbs[0] || fallbackThumbs[0];

    let sourceBuffer: Buffer | null = null;
    if (chosenThumb) {
      try {
        const downloaded = await telegram.downloadMedia(msgs[0], { thumb: chosenThumb }) as any;
        if (downloaded && Buffer.isBuffer(downloaded)) {
          sourceBuffer = downloaded;
        }
      } catch (e) {
        console.warn('[Thumbs] Error downloading Telegram thumb:', e);
      }
    }

    // If none and file is an image under 10 MB, download the file
    if (!sourceBuffer) {
      const mime = meta.mimeType || '';
      const isImage = mime.startsWith('image/') || !!media.photo;
      const isUnder10MB = meta.size ? meta.size <= 10 * 1024 * 1024 : true;
      if (isImage && isUnder10MB) {
        try {
          const downloaded = await telegram.downloadMedia(msgs[0]) as any;
          if (downloaded && Buffer.isBuffer(downloaded)) {
            sourceBuffer = downloaded;
          }
        } catch (e) {
          console.warn('[Thumbs] Error downloading image media for thumb:', e);
        }
      }
    }

    if (!sourceBuffer) return null;

    await sharp(sourceBuffer, { sequentialRead: true })
      .rotate()
      .resize(s, s, { fit: 'cover', fastShrinkOnLoad: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toFile(thumbPath);

    return thumbPath;
  } else if (account.accountType === 'google') {
    const drive = await getDriveClient(account.tokens || account.credentials, String(account._id));
    const fileRes = await drive.files.get({ fileId, fields: 'thumbnailLink' });
    let link = fileRes.data.thumbnailLink;
    if (!link) return null;
    link = link.replace(/=s\d+$/, `=s${s}`);

    const resp = await axios.get(link, { responseType: 'arraybuffer', timeout: 20_000, maxContentLength: 20 * 1024 * 1024 });
    await sharp(Buffer.from(resp.data), { sequentialRead: true })
      .rotate()
      .resize(s, s, { fit: 'cover', fastShrinkOnLoad: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toFile(thumbPath);

    return thumbPath;
  } else if (account.accountType === 'onedrive') {
    const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
    const thumbsRes = await c.api(`/me/drive/items/${fileId}/thumbnails`).get();
    const thumbSet = thumbsRes.value?.[0];
    const thumbUrl = thumbSet?.large?.url || thumbSet?.medium?.url;
    if (!thumbUrl) return null;

    const resp = await axios.get(thumbUrl, { responseType: 'arraybuffer', timeout: 20_000, maxContentLength: 20 * 1024 * 1024 });
    await sharp(Buffer.from(resp.data), { sequentialRead: true })
      .rotate()
      .resize(s, s, { fit: 'cover', fastShrinkOnLoad: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toFile(thumbPath);

    return thumbPath;
  }
  return null;
}

// ─── Express app setup ────────────────────────────────────────────────────────
export const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-ID, Idempotency-Key, X-File-Checksum, X-Chunk-Offset');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// 1. DEPENDENCIES: Add compression before routes
app.use(compression());
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
// Correlate client-visible failures with server logs without logging credentials.
app.use((req: any, res, next) => {
  const startedAt = Date.now();
  const requestId = typeof req.headers['x-correlation-id'] === 'string'
    ? req.headers['x-correlation-id'].slice(0, 128)
    : (typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].slice(0, 128) : crypto.randomUUID());
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-Correlation-Id', requestId);

  if (isShuttingDown && req.path !== '/healthz') {
    return apiError(res, 503, STANDARD_ERROR_CODES.INTERNAL_ERROR, 'Server is shutting down; please retry shortly', requestId, true);
  }

  systemMetrics.requestsTotal++;
  activeHttpConnections++;
  let connDecremented = false;
  const decConn = () => {
    if (!connDecremented) {
      connDecremented = true;
      activeHttpConnections = Math.max(0, activeHttpConnections - 1);
    }
  };
  const origJson = res.json.bind(res);
  res.json = (body: any) => {
    if (body && typeof body === 'object' && !Array.isArray(body) && (res.statusCode >= 400 || typeof body.error === 'string')) {
      const resolvedCode = typeof body.code === 'string' && body.code
        ? body.code
        : errorCode(res.statusCode >= 400 ? res.statusCode : 500);
      const resolvedRetryable = typeof body.retryable === 'boolean'
        ? body.retryable
        : (res.statusCode >= 500 || res.statusCode === 429);
      if (res.locals) res.locals.errorCode = resolvedCode;
      return origJson({
        ...body,
        code: resolvedCode,
        requestId: body.requestId ?? requestId,
        retryable: resolvedRetryable,
      });
    }
    return origJson(body);
  };

  res.once('close', decConn);

  res.once('finish', () => {
    decConn();
    const durationMs = Date.now() - startedAt;
    const isSlow = durationMs >= SLOW_REQUEST_MS;
    if (isSlow) systemMetrics.slowRequestsTotal++;
    console.log(JSON.stringify({
      event: isSlow ? 'http_slow_request' : 'http_request',
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
      slow: isSlow || undefined,
      userId: req.userId ? String(req.userId) : undefined,
      errorCode: res.locals?.errorCode || (res.statusCode >= 400 ? errorCode(res.statusCode) : undefined),
    }));
  });
  next();
});
// Liveness only checks that the process is running; readiness also requires MongoDB & not shutting down.
app.get('/healthz', (_req, res) => res.json({
  ok: true,
  uptimeSec: Math.floor(process.uptime()),
}));
app.get('/readyz', async (req: any, res) => {
  if (isShuttingDown) {
    return apiError(res, 503, STANDARD_ERROR_CODES.INTERNAL_ERROR, 'Server is shutting down', req.requestId, true);
  }
  if (!db) {
    return res.status(503).json({ ok: false, status: 'not_ready', mongo: false, error: 'Database not ready', code: STANDARD_ERROR_CODES.INTERNAL_ERROR, requestId: req.requestId, retryable: true });
  }
  const hasDisk = hasTempDiskHeadroom(0);
  if (!hasDisk) {
    return res.status(503).json({ ok: false, status: 'not_ready', mongo: true, diskHeadroom: false, error: 'Temporary disk space critically low', code: STANDARD_ERROR_CODES.INSUFFICIENT_STORAGE, requestId: req.requestId, retryable: true });
  }
  res.json({ ok: true, status: 'ready', mongo: true, diskHeadroom: true });
});

// 7. ROBUSTNESS: Rate limiter for login & register (10 requests/min per IP)
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.CLOUDYTE_TEST_MODE === '1',
  message: { error: 'Too many requests, please try again later.', code: STANDARD_ERROR_CODES.RATE_LIMITED, retryable: true }
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.UPLOAD_REQUESTS_PER_WINDOW || 300),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.CLOUDYTE_TEST_MODE === '1',
  message: { error: 'Upload rate limit exceeded.', code: STANDARD_ERROR_CODES.RATE_LIMITED, retryable: true },
});

const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.CLOUDYTE_TEST_MODE === '1',
  message: { error: 'Download rate limit exceeded.', code: STANDARD_ERROR_CODES.RATE_LIMITED, retryable: true },
});

app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/upload', uploadLimiter);
app.use('/api/upload-sessions', uploadLimiter);
app.use('/api/download', downloadLimiter);
app.use('/api/public/download', downloadLimiter);

// ─── Auth routes ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password must be strings' });
  }
  const cleanUsername = username.trim();
  if (!cleanUsername || cleanUsername.length > 128 || !password || password.length > 1024) {
    return res.status(400).json({ error: 'Valid username and password required' });
  }

  const database = db || await connectToMongo();
  const globalReg = await database.collection('settings').findOne({ key: 'registrationEnabled' });
  const webReg    = await database.collection('settings').findOne({ key: 'webRegistrationEnabled' });

  if (globalReg?.value === false || webReg?.value === false) {
    return res.status(403).json({ error: 'Registration is currently disabled.' });
  }

  const existing = await database.collection('users').findOne({ username: cleanUsername });
  if (existing) return res.status(400).json({ error: 'Username already taken' });

  try {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    await database.collection('users').insertOne({
      _id: nanoid() as any,
      username: cleanUsername,
      password: hashedPassword,
      tgIds: [],
      isAdmin: false,
      isActive: true,
      createdAt: new Date(),
      createdVia: 'web'
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true });
  } catch (err: any) {
    if (err.code === 11000) return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/public/settings', async (_req, res) => {
  try {
    const database = db || await Promise.race([
      connectToMongo(1),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000)),
    ]);
    const settings = await database.collection('settings').find({}).toArray();
    const publicSettings: any = {};
    settings.forEach((s: any) => {
      if (s.key === 'registrationEnabled' || s.key === 'webRegistrationEnabled' || s.key === 'botRegistrationEnabled') {
        publicSettings[s.key] = s.value;
      }
    });
    res.json(publicSettings);
  } catch {
    res.json({ registrationEnabled: true, webRegistrationEnabled: true, botRegistrationEnabled: true });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password must be strings' });
  }
  const cleanUsername = username.trim();
  if (!cleanUsername || cleanUsername.length > 128 || !password || password.length > 1024) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const database = db || await connectToMongo();

  const user = await database.collection('users').findOne({ username: cleanUsername });
  if (!user || !user.isActive) return res.status(401).json({ error: 'Invalid credentials or account disabled' });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  const sessionToken = nanoid(32);
  const sessionId = nanoid(12);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const deviceName = parseDeviceNameFromRequest(req);
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 256) : '';

  await database.collection('sessions').insertOne({
    sessionId,
    token: sessionToken,
    userId: user._id,
    username: user.username,
    deviceName,
    userAgent,
    createdAt: now,
    lastActiveAt: now,
    expiresAt,
  });

  // Prime auth cache
  authCache.set(sessionToken, {
    userId: user._id,
    isAdmin: !!user.isAdmin,
    user,
    sessionId,
    expiresAt: expiresAt.getTime(),
  });

  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, token: sessionToken, sessionId, username: user.username, isAdmin: !!user.isAdmin });
});

app.get('/api/admin/stats', requireAuth, async (req: any, res: any) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const database = req.db;
  const stats = {
    totalUsers: await database.collection('users').countDocuments(),
    totalAccounts: await database.collection('accounts').countDocuments(),
    totalFiles: await database.collection('tg_files').countDocuments(),
  };
  res.json(stats);
});

app.get('/api/admin/metrics', requireAuth, async (req: any, res: any) => {
  if (!req.isAdmin) return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Forbidden', req.requestId);
  const database = req.db || db || await connectToMongo();
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const tempFreeBytes = getFreeBytes(TEMP_DIR);
  const hasDiskHeadroom = hasTempDiskHeadroom();
  const tempStats = getTempDirStats(TEMP_DIR);
  const thumbStats = getTempDirStats(THUMB_DIR);

  const [queuedJobs, runningJobs, failedJobs, deadLetterJobs, activeUploadSessions] = await Promise.all([
    database.collection('jobs').countDocuments({ status: 'queued' }),
    database.collection('jobs').countDocuments({ status: 'running' }),
    database.collection('jobs').countDocuments({ status: 'failed' }),
    database.collection('jobs').countDocuments({ status: 'failed', deadLettered: true }),
    database.collection('upload_sessions').countDocuments({ status: { $in: ['active', 'paused', 'completing'] } }),
  ]);

  const alerts: { code: string; severity: 'warning' | 'critical'; message: string }[] = [];
  if (!hasDiskHeadroom) {
    alerts.push({ code: 'LOW_TEMP_DISK_SPACE', severity: 'critical', message: 'Temporary disk headroom is below MIN_TEMP_FREE_BYTES threshold' });
  }
  if (queuedJobs >= Math.floor(MAX_JOB_QUEUE_DEPTH * 0.8)) {
    alerts.push({ code: 'JOB_QUEUE_BACKLOG', severity: 'warning', message: `Background job queue depth (${queuedJobs}) is approaching limit (${MAX_JOB_QUEUE_DEPTH})` });
  }
  if (deadLetterJobs > 0) {
    alerts.push({ code: 'DEAD_LETTER_JOBS_PRESENT', severity: 'warning', message: `${deadLetterJobs} background job(s) have exhausted retries` });
  }
  for (const [provider, bucket] of Object.entries(systemMetrics.providerCalls)) {
    if (bucket.consecutiveFailures >= 3) {
      alerts.push({ code: `PROVIDER_DEGRADED_${provider.toUpperCase()}`, severity: 'warning', message: `Provider ${provider} has ${bucket.consecutiveFailures} consecutive failures` });
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    uptimeSeconds: Math.floor((Date.now() - systemMetrics.startedAt) / 1000),
    workerId: WORKER_ID,
    shuttingDown: isShuttingDown,
    memoryUsage: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
    },
    cpuUsage: cpu,
    eventLoopLagMs: systemMetrics.eventLoopLagMs,
    openFileDescriptors: getOpenFileDescriptorCount(),
    connections: {
      activeHttpConnections,
      activeGlobalUploads,
      activeUploadUsers: activeUploadsByUser.size,
      activeDownloadUsers: activeDownloadsByUser.size,
    },
    disk: {
      tempDir: TEMP_DIR,
      tempFreeBytes,
      minTempFreeBytes: MIN_TEMP_FREE_BYTES,
      hasDiskHeadroom,
      tempFiles: tempStats,
      thumbFiles: thumbStats,
    },
    jobs: {
      queued: queuedJobs,
      running: runningJobs,
      failed: failedJobs,
      deadLettered: deadLetterJobs,
      maxQueueDepth: MAX_JOB_QUEUE_DEPTH,
    },
    uploads: {
      activeSessions: activeUploadSessions,
      completedTotal: systemMetrics.uploadsCompleted,
      failedTotal: systemMetrics.uploadsFailed,
    },
    cache: {
      driveCacheKeys: driveCache.keys().length,
      authCacheKeys: authCache.keys().length,
    },
    metrics: systemMetrics,
    alerts,
  });
});

app.get('/api/admin/users', requireAuth, async (req: any, res: any) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const database = req.db;
  
  const users = await database.collection('users').find({}).sort({ createdAt: -1 }).toArray();
  const accounts = await database.collection('accounts').aggregate([
    { $group: { _id: "$userId", count: { $sum: 1 } } }
  ]).toArray();

  const accountMap = new Map(accounts.map((a: any) => [a._id, a.count]));

  const result = users.map((u: any) => ({
    id: u._id,
    username: u.username,
    isActive: u.isActive !== false,
    isAdmin: !!u.isAdmin,
    createdAt: u.createdAt,
    accountCount: accountMap.get(u._id) || 0
  }));

  res.json(result);
});

app.post('/api/admin/users/:id/toggle', requireAuth, async (req: any, res: any) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const database = req.db;
  const user = await database.collection('users').findOne({ _id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.isAdmin) return res.status(400).json({ error: 'Cannot disable admin' });
  
  await database.collection('users').updateOne({ _id: req.params.id }, { $set: { isActive: !user.isActive } });
  clearUserAuthCache(req.params.id);
  res.json({ success: true, isActive: !user.isActive });
});

app.delete('/api/admin/users/:id', requireAuth, async (req: any, res: any) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const database = req.db;
  const user = await database.collection('users').findOne({ _id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.isAdmin) return res.status(400).json({ error: 'Cannot delete admin' });

  // Cleanup: delete cached thumbs for user's tg files
  const userFiles = await database.collection('tg_files').find({ userId: req.params.id }, { projection: { _id: 1, accountId: 1 } }).toArray();
  for (const f of userFiles) {
    deleteThumbFiles(String(f._id), f.accountId ? String(f.accountId) : undefined);
  }

  // Cleanup: delete accounts, files, sessions, key backups, upload sessions, and user
  await database.collection('accounts').deleteMany({ userId: req.params.id });
  await database.collection('tg_files').deleteMany({ userId: req.params.id });
  await database.collection('tg_folders').deleteMany({ userId: req.params.id });
  await database.collection('account_encryption_backups').deleteMany({ userId: String(req.params.id) });
  await database.collection('upload_sessions').deleteMany({ userId: String(req.params.id) });
  await database.collection('sessions').deleteMany({ userId: req.params.id });
  await database.collection('users').deleteOne({ _id: req.params.id });

  clearUserAuthCache(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/users/:id', requireAuth, async (req: any, res: any) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const database = req.db;
  const { id } = req.params;

  const user = await database.collection('users').findOne({ _id: id });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const rawAccounts = await database.collection('accounts').find({ userId: id }).toArray();
  const accounts = rawAccounts.map((acc: any) => {
    const { tokens: _tokens, credentials: _credentials, ...safe } = acc;
    return safe;
  });
  const fileCount = await database.collection('tg_files').countDocuments({ userId: id });

  res.json({
    user: {
      id: user._id,
      username: user.username,
      isActive: user.isActive !== false,
      isAdmin: !!user.isAdmin,
      createdAt: user.createdAt,
      tgIds: user.tgIds || []
    },
    accounts,
    stats: {
      fileCount
    }
  });
});

app.get('/api/admin/settings', requireAuth, async (req: any, res: any) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const database = req.db;
  const settings = await database.collection('settings').find({}).toArray();
  const config: any = {};
  settings.forEach((s: any) => config[s.key] = s.value);
  res.json(config);
});

const ALLOWED_ADMIN_SETTING_KEYS = new Set(['registrationEnabled', 'webRegistrationEnabled', 'botRegistrationEnabled']);
app.post('/api/admin/settings', requireAuth, async (req: any, res: any) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const database = req.db;
  const { key, value } = req.body || {};
  if (typeof key !== 'string' || !ALLOWED_ADMIN_SETTING_KEYS.has(key) || typeof value !== 'boolean') {
    return res.status(400).json({ error: 'Invalid setting key or boolean value' });
  }
  await database.collection('settings').updateOne({ key }, { $set: { value } }, { upsert: true });
  res.json({ success: true });
});

app.post('/api/logout', async (req, res) => {
  const authHeader     = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const tokenFromQuery = typeof req.query.token === 'string' ? req.query.token : undefined;
  const bearerToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const token          = bearerToken || (tokenFromQuery ? tokenFromQuery.trim() : null);
  if (token && token.length <= 256) {
    authCache.del(token);
    const database = db || await connectToMongo();
    await database.collection('sessions').deleteOne({ token });
  }
  res.json({ success: true });
});

// ─── Active Sessions & Device Management ──────────────────────────────────────
app.get('/api/sessions', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  if (!req.userId) return res.json([]);
  const now = Date.now();
  const rawSessions = await database.collection('sessions')
    .find({ userId: req.userId })
    .sort({ lastActiveAt: -1, createdAt: -1 })
    .toArray();

  const active = rawSessions.filter((s: any) => {
    if (!s.expiresAt) return true;
    const exp = new Date(s.expiresAt).getTime();
    return Number.isNaN(exp) || exp > now;
  });

  const sessions = active.map((s: any) => {
    const id = String(s.sessionId || s._id);
    const createdIso = s.createdAt ? new Date(s.createdAt).toISOString() : new Date().toISOString();
    const lastActiveIso = (s.lastActiveAt || s.createdAt)
      ? new Date(s.lastActiveAt || s.createdAt).toISOString()
      : createdIso;
    const expiresIso = s.expiresAt ? new Date(s.expiresAt).toISOString() : null;
    return {
      id,
      sessionId: id,
      deviceName: s.deviceName || 'Cloudyte Client',
      userAgent: s.userAgent || '',
      createdAt: createdIso,
      lastActiveAt: lastActiveIso,
      expiresAt: expiresIso,
      isCurrent: Boolean(req.token && s.token === req.token),
    };
  });

  res.setHeader('Cache-Control', 'no-store');
  res.json(sessions);
});

app.delete('/api/sessions/:sessionId', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const targetId = String(req.params.sessionId || '').trim();
  if (!targetId) return apiError(res, 400, 'BAD_REQUEST', 'Session ID required', req.requestId);

  const orClauses: any[] = [{ sessionId: targetId }, { _id: targetId }];
  if (ObjectId.isValid(targetId)) orClauses.push({ _id: new ObjectId(targetId) });

  const query: any = { $or: orClauses };
  if (!req.isAdmin && req.userId) {
    query.userId = req.userId;
  }

  const targetSession = await database.collection('sessions').findOne(query);
  if (!targetSession) return apiError(res, 404, 'NOT_FOUND', 'Session not found', req.requestId);

  await database.collection('sessions').deleteOne({ _id: targetSession._id });
  if (targetSession.token) authCache.del(String(targetSession.token));

  res.json({ success: true, revokedSessionId: targetId });
});

app.delete('/api/sessions', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  if (!req.userId) return apiError(res, 401, 'AUTH_REQUIRED', 'Unauthorized', req.requestId);

  const filter: any = { userId: req.userId };
  if (req.token) {
    filter.token = { $ne: req.token };
  }
  const toRevoke = await database.collection('sessions').find(filter).toArray();
  for (const s of toRevoke) {
    if (s.token) authCache.del(String(s.token));
  }
  const delRes = await database.collection('sessions').deleteMany(filter);
  res.json({ success: true, revokedCount: delRes.deletedCount || toRevoke.length });
});

// ─── TG Drive – register a channel as an account ─────────────────────────────
app.post('/api/tgdrive/register', requireAuth, async (req: any, res: any) => {
  const { channelId, driveName } = req.body || {};
  if (typeof channelId !== 'string' || !channelId.trim()) {
    return res.status(400).json({ error: 'channelId is required' });
  }
  const cleanChannelId = channelId.trim();

  const userId   = req.userId ? String(req.userId) : '';
  if (!userId) return res.status(401).json({ error: 'Authenticated user context missing' });
  const database = req.db;
  const name     = (typeof driveName === 'string' ? driveName.trim() : '') || 'TG Drive';

  try {
    const admins = await bot!.telegram.getChatAdministrators(cleanChannelId);
    const botInfo = await bot!.telegram.getMe();
    const isBotAdmin = admins.some((a: any) => a.user.id === botInfo.id);
    if (!isBotAdmin) return res.status(400).json({ error: 'Bot is not an admin in this channel' });
  } catch (e: any) {
    return res.status(400).json({ error: `Cannot access channel: ${e.message}. Make sure the bot is an admin in the channel.` });
  }

  const existingAccount = await database.collection('accounts').findOne({ channelId: cleanChannelId, userId: { $ne: userId } });
  if (existingAccount) return res.status(400).json({ error: 'This channel is already linked to another Cloudyte account.' });

  await database.collection('accounts').updateOne(
    { userId, channelId: cleanChannelId, accountType: 'tgdrive' },
    { $set: { userId, channelId: cleanChannelId, accountType: 'tgdrive', name, linkedAt: new Date().toISOString() } },
    { upsert: true }
  );

  const acc = await database.collection('accounts').findOne({ userId, channelId: cleanChannelId, accountType: 'tgdrive' });
  const newAccountId = acc!._id;

  // Re-link orphaned files for this user & channel
  const existingAccountIds = (await database.collection('accounts').find({ userId }, { projection: { _id: 1 } }).toArray()).map((a: any) => a._id);
  await database.collection('tg_files').updateMany(
    { accountId: { $nin: existingAccountIds }, userId },
    { $set: { accountId: newAccountId } }
  );
  await database.collection('tg_folders').updateMany(
    { accountId: { $nin: existingAccountIds }, userId },
    { $set: { accountId: newAccountId } }
  );

  res.json({ success: true, id: newAccountId.toString(), channelId: cleanChannelId, name });
});

// ─── User settings ────────────────────────────────────────────────────────────
app.post('/api/user/settings', requireAuth, async (req: any, res: any) => {
  const { backupEnabled, backupAccId, isDefaultAccId } = req.body || {};
  const userId   = req.userId;
  const database = req.db;
  if (!userId) return res.status(401).json({ error: 'Authenticated user context missing' });

  const update: any = {};
  if (backupEnabled !== undefined) {
    if (typeof backupEnabled !== 'boolean') return res.status(400).json({ error: 'backupEnabled must be boolean' });
    update.backupEnabled = backupEnabled;
  }
  if (backupAccId !== undefined) {
    if (backupAccId === null || backupAccId === '') {
      update.backupAccId = null;
    } else {
      const { account: targetBackupAcc, accessDenied } = await resolveAuthorizedAccount(database, backupAccId, userId, req.isAdmin);
      if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to backup account', req.requestId);
      if (!targetBackupAcc) return res.status(404).json({ error: 'Backup account not found' });
      update.backupAccId = String(targetBackupAcc._id);
    }
  }

  if (Object.keys(update).length > 0) {
    await database.collection('users').updateOne({ _id: userId }, { $set: update });
  }

  if (isDefaultAccId) {
    const { account: defaultAcc, accessDenied } = await resolveAuthorizedAccount(database, isDefaultAccId, userId, req.isAdmin);
    if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to default account', req.requestId);
    if (!defaultAcc) return res.status(404).json({ error: 'Default account not found' });
    await database.collection('accounts').updateMany({ userId }, { $set: { isDefault: false } });
    await database.collection('accounts').updateOne({ _id: defaultAcc._id, userId }, { $set: { isDefault: true } });
  }
  clearUserAuthCache(String(userId));
  res.json({ success: true });
});

// ─── /api/me ──────────────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, async (req: any, res: any) => {
  if (req.isAdmin && !req.user) {
    return res.json({ 
      authenticated: true, 
      username: 'System Admin', 
      isAdmin: true,
      settings: { 
        username: 'admin', 
        backupEnabled: false, 
        backupAccId: null 
      } 
    });
  }
  const user = req.user;
  res.json({ 
    authenticated: true, 
    username: user.username, 
    isAdmin: !!user.isAdmin,
    settings: { 
      username: user.username, 
      backupEnabled: user.backupEnabled || false, 
      backupAccId: user.backupAccId || null 
    } 
  });
});

async function getAccountQuota(acc: any, database: any): Promise<{ quotaUsage: string; quotaLimit: string; displayName: string }> {
  const CACHE_TTL = 300000;
  const now       = Date.now();
  if (acc.quotaCachedAt && (now - new Date(acc.quotaCachedAt).getTime()) < CACHE_TTL && acc.quotaUsage !== undefined && acc.quotaLimit !== undefined) {
    return {
      quotaUsage:  String(acc.quotaUsage),
      quotaLimit:  String(acc.quotaLimit),
      displayName: acc.name,
    };
  }
  let quotaUsage = '0', quotaLimit = '0', displayName = acc.name;
  if (acc.accountType === 'onedrive') {
    const c = await getOneDriveClient(acc.tokens || acc.credentials, acc._id.toString());
    const d = await c.api('/me/drive').get();
    quotaUsage = String(d.quota?.used || 0);
    quotaLimit = String(d.quota?.total || 0);
    displayName = acc.name || 'OneDrive';
  } else {
    const drive  = await getDriveClient(acc.tokens || acc.credentials);
    const about  = await drive.about.get({ fields: 'storageQuota,user' });
    quotaUsage   = String(about.data.storageQuota?.usage || '0');
    quotaLimit   = String(about.data.storageQuota?.limit || '0');
    displayName  = about.data.user?.displayName || acc.name;
  }
  await database.collection('accounts').updateOne({ _id: acc._id }, { $set: { quotaUsage, quotaLimit, quotaCachedAt: new Date(), name: displayName } });
  return { quotaUsage, quotaLimit, displayName };
}

type StorageCategories = {
  images: number;
  videos: number;
  audio: number;
  documents: number;
  archives: number;
  other: number;
};

function emptyStorageCategories(): StorageCategories {
  return { images: 0, videos: 0, audio: 0, documents: 0, archives: 0, other: 0 };
}

function classifyFileCategory(mimeRaw: string, nameRaw: string, isEncrypted = false): keyof StorageCategories {
  if (isEncrypted) return 'other';
  const mime = (mimeRaw || '').toLowerCase();
  const name = (nameRaw || '').toLowerCase();
  if (mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|svg|heic|ico|tiff?|avif)$/i.test(name)) {
    return 'images';
  }
  if (mime.startsWith('video/') || /\.(mp4|mkv|mov|avi|webm|flv|wmv|m4v|3gp|mpe?g)$/i.test(name)) {
    return 'videos';
  }
  if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|flac|aac|m4a|wma|opus)$/i.test(name)) {
    return 'audio';
  }
  if (/(zip|rar|7z|tar|gz|gzip|bzip|xz|compressed)/i.test(mime) || /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst)$/i.test(name)) {
    return 'archives';
  }
  if (
    /(pdf|msword|wordprocessingml|ms-excel|spreadsheetml|ms-powerpoint|presentationml|opendocument|^text\/|rtf|csv|json|xml)/i.test(mime) ||
    /\.(pdf|docx?|xlsx?|pptx?|txt|rtf|csv|md|odt|ods|odp)$/i.test(name)
  ) {
    return 'documents';
  }
  return 'other';
}

async function computeSingleAccountStorageSummary(account: any, database: any) {
  const accIdStr = account._id.toString();
  const cacheKey = `storage_summary:${accIdStr}`;
  const cached = driveCache.get(cacheKey) as any;
  if (cached) return cached;

  return withCacheStampedeProtection(cacheKey, async () => {
    const secondCheck = driveCache.get(cacheKey) as any;
    if (secondCheck) return secondCheck;

  if (account.accountType === 'tgdrive') {
    const docs = await database.collection('tg_files')
      .find({ accountId: account._id, trashed: { $ne: true } })
      .toArray();
    const categories = emptyStorageCategories();
    let usedBytes = 0;
    for (const d of docs) {
      const sz = Number(d.encryptedSizeBytes ?? d.size ?? 0) || 0;
      usedBytes += sz;
      const cat = classifyFileCategory(d.mimeType || '', d.name || '', Boolean(d.isEncrypted));
      categories[cat] += sz;
    }
    const summary = {
      accountId:   accIdStr,
      accountType: 'tgdrive' as const,
      usedBytes,
      totalBytes:  null as number | null,
      fileCount:   docs.length,
      categories,
    };
    driveCache.set(cacheKey, summary, 60);
    return summary;
  }

  const { quotaUsage, quotaLimit } = await getAccountQuota(account, database);
  const categories = emptyStorageCategories();
  let fileCount = 0;
  let scannedBytes = 0;

  try {
    const encryptedDocs = await database.collection('tg_files')
      .find({ accountId: account._id, isEncrypted: true, trashed: { $ne: true } })
      .toArray();
    const encryptedIds = new Set<string>();
    const encryptedNames = new Set<string>();
    for (const ed of encryptedDocs) {
      if (ed.providerFileId) encryptedIds.add(String(ed.providerFileId));
      if (ed.opaqueRemoteName) encryptedNames.add(String(ed.opaqueRemoteName));
      if (ed.name) encryptedNames.add(String(ed.name));
    }

    if (account.accountType === 'onedrive') {
      const c = await getOneDriveClient(account.tokens || account.credentials, accIdStr);
      let items: any[] = [];
      try {
        const rootChildren = await c.api('/me/drive/root/children').get();
        items = Array.isArray(rootChildren?.value) ? rootChildren.value : [];
      } catch { /* ignore */ }
      for (const item of items) {
        if (item.folder || item.deleted) continue;
        const sz = Number(item.size) || 0;
        const isEnc = encryptedIds.has(String(item.id)) || encryptedNames.has(String(item.name));
        const cat = classifyFileCategory(item.file?.mimeType || '', item.name || '', isEnc);
        categories[cat] += sz;
        scannedBytes += sz;
        fileCount++;
      }
    } else {
      const drive = await getDriveClient(account.tokens || account.credentials);
      let pageToken: string | undefined = undefined;
      for (let page = 0; page < 5; page++) {
        const listRes: any = await drive.files.list({
          pageSize: 200,
          ...(pageToken ? { pageToken } : {}),
          q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
          fields: 'nextPageToken,files(id,name,mimeType,size)',
        });
        const files = Array.isArray(listRes?.data?.files) ? listRes.data.files : [];
        for (const f of files) {
          if (f.mimeType === 'application/vnd.google-apps.folder') continue;
          const sz = Number(f.size) || 0;
          const isEnc = encryptedIds.has(String(f.id)) || encryptedNames.has(String(f.name));
          const cat = classifyFileCategory(f.mimeType || '', f.name || '', isEnc);
          categories[cat] += sz;
          scannedBytes += sz;
          fileCount++;
        }
        pageToken = listRes?.data?.nextPageToken;
        if (!pageToken) break;
      }
    }
  } catch (scanErr) {
    console.warn(`[StorageSummary] Provider file scan fallback for ${accIdStr}:`, scanErr);
  }

  const effectiveUsedBytes = Math.max(Number(quotaUsage) || 0, scannedBytes);
  if (effectiveUsedBytes > scannedBytes) {
    categories.other += (effectiveUsedBytes - scannedBytes);
  }
  const limitNum = Number(quotaLimit) || 0;

  const summary = {
    accountId:   accIdStr,
    accountType: (account.accountType === 'onedrive' ? 'onedrive' : 'google') as 'google' | 'onedrive',
    usedBytes:   effectiveUsedBytes,
    totalBytes:  limitNum > 0 ? limitNum : null,
    fileCount,
    categories,
  };
  driveCache.set(cacheKey, summary, 60);
  return summary;
  });
}

// ─── /api/accounts ────────────────────────────────────────────────────────────
app.get('/api/accounts', requireAuth, async (req: any, res: any) => {
  const database = req.db;
  const { userId } = req.query;
  const query: any = {};
  
  if (req.isAdmin) {
    if (typeof userId === 'string' && userId.trim()) query.userId = userId.trim();
  } else {
    query.userId = req.userId;
  }

  const accounts = await database.collection('accounts').find(query).toArray();

  // Deduplicate: for tgdrive key is channelId, for others key is email
  const seen    = new Map();
  const unique  = accounts.filter((a: any) => {
    const key = a.accountType === 'tgdrive' ? `tgdrive:${a.channelId}` : (a.email || a._id.toString());
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });

  const enriched = await Promise.all(unique.map(async (acc: any) => {
    if (acc.accountType === 'tgdrive') {
      try {
        const summary = await computeSingleAccountStorageSummary(acc, database);
        const usedBytes = summary.usedBytes || 0;
        const fileCount = summary.fileCount || 0;
        return {
          id:          acc._id.toString(),
          name:        acc.name || 'TG Drive',
          email:       `Channel: ${acc.channelId}`,
          channelId:   acc.channelId,
          accountType: 'tgdrive',
          usage:       (usedBytes / (1024 ** 3)).toFixed(2) + ' GB',
          total:       '∞',
          percentage:  0,
          fileCount,
          isDefault:   acc.isDefault || false,
        };
      } catch {
        return { id: acc._id.toString(), name: acc.name || 'TG Drive', email: `Channel: ${acc.channelId}`, channelId: acc.channelId, accountType: 'tgdrive', usage: '0 GB', total: '∞', percentage: 0, fileCount: 0, error: false, isDefault: acc.isDefault || false };
      }
    }

    try {
      const { quotaUsage, quotaLimit, displayName } = await getAccountQuota(acc, database);
      const cachedSummary = driveCache.get(`storage_summary:${acc._id.toString()}`) as any;
      const usageNum = Math.max(Number(quotaUsage) || 0, Number(cachedSummary?.usedBytes) || 0);
      const limitNum = Number(quotaLimit) || 0;
      const pct = limitNum > 1 ? Math.min(100, Math.max(0, Math.round((usageNum / limitNum) * 100))) : 0;
      return {
        id: acc._id.toString(),
        name: displayName,
        email: acc.email,
        usage: (usageNum / (1024 ** 3)).toFixed(1) + ' GB',
        total: limitNum > 1 ? (limitNum / (1024 ** 3)).toFixed(0) + ' GB' : '∞',
        percentage: pct,
        ...(typeof cachedSummary?.fileCount === 'number' ? { fileCount: cachedSummary.fileCount } : {}),
        accountType: acc.accountType || 'google',
        isDefault: acc.isDefault || false,
      };
    } catch {
      return { id: acc._id.toString(), name: acc.name || 'Disconnected', email: acc.email || acc.channelId, error: true, percentage: 0, accountType: acc.accountType || 'google', isDefault: acc.isDefault || false };
    }
  }));
  res.json(enriched);
});

// ─── /api/storage/summary ─────────────────────────────────────────────────────
app.get('/api/storage/summary', requireAuth, async (req: any, res: any) => {
  const { accountId } = req.query;
  const database      = req.db;

  const isAllAccounts = !accountId || typeof accountId !== 'string' || accountId === 'all' || accountId === 'root';
  if (isAllAccounts) {
    const ownerKey = String(req.userId || 'admin');
    const allCacheKey = `storage_summary:all:${ownerKey}`;
    const cachedAll = driveCache.get(allCacheKey);
    if (cachedAll) return res.json(cachedAll);

    try {
      const query: any = {};
      if (!req.isAdmin || req.userId) {
        query.userId = req.userId;
      }
      const accounts = await database.collection('accounts').find(query).toArray();
      const seen = new Map();
      const unique = accounts.filter((a: any) => {
        const key = a.accountType === 'tgdrive' ? `tgdrive:${a.channelId}` : (a.email || a._id.toString());
        if (seen.has(key)) return false;
        seen.set(key, true);
        return true;
      });

      const summaries = await Promise.all(
        unique.map((acc: any) => computeSingleAccountStorageSummary(acc, database).catch(() => null))
      );

      const categories = emptyStorageCategories();
      let usedBytes = 0;
      let finiteTotalBytes = 0;
      let hasFiniteLimit = false;
      let fileCount = 0;

      for (const s of summaries) {
        if (!s) continue;
        usedBytes += Number(s.usedBytes) || 0;
        if (typeof s.totalBytes === 'number' && s.totalBytes > 0) {
          finiteTotalBytes += s.totalBytes;
          hasFiniteLimit = true;
        }
        fileCount += Number(s.fileCount) || 0;
        if (s.categories) {
          categories.images += Number(s.categories.images) || 0;
          categories.videos += Number(s.categories.videos) || 0;
          categories.audio += Number(s.categories.audio) || 0;
          categories.documents += Number(s.categories.documents) || 0;
          categories.archives += Number(s.categories.archives) || 0;
          categories.other += Number(s.categories.other) || 0;
        }
      }

      const aggregated = {
        accountId:   'all',
        accountType: 'all',
        usedBytes,
        totalBytes:  hasFiniteLimit ? finiteTotalBytes : null,
        fileCount,
        categories,
      };
      driveCache.set(allCacheKey, aggregated, 60);
      return res.json(aggregated);
    } catch (err: any) {
      console.error('All-accounts storage summary error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  const { account, accessDenied, invalidId } = await resolveAuthorizedAccount(database, accountId, req.userId, req.isAdmin);
  if (invalidId) return res.status(400).json({ error: 'Invalid accountId' });
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    const summary = await computeSingleAccountStorageSummary(account, database);
    return res.json(summary);
  } catch (err: any) {
    console.error('Storage summary error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', requireAuth, async (req: any, res: any) => {
  const { id }   = req.params;
  const database = req.db;
  if (!req.isAdmin && !req.userId) return res.status(401).json({ error: 'Auth context missing' });
  const { account, accessDenied } = await resolveAuthorizedAccount(database, id, req.userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);

  await database.collection('accounts').deleteOne({ _id: account._id });
  await database.collection('account_encryption_backups').deleteMany({ accountId: String(account._id) });
  await database.collection('upload_sessions').deleteMany({ accountId: String(account._id) });
  invalidateDriveCache(id);
  res.json({ success: true });
});

// ─── Key Backup Endpoints (Zero-Knowledge E2EE) ──────────────────────────────
app.put('/api/accounts/:accountId/encryption/key-backup', requireAuth, async (req: any, res: any) => {
  const { accountId } = req.params;
  const database = req.db;
  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, req.userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);

  const validation = validateKeyBackupInput(req.body);
  if (!validation.ok) {
    return apiError(res, validation.error.status, validation.error.code, validation.error.message, req.requestId);
  }

  const now = new Date();
  const userIdStr = String(account.userId || req.userId || '');
  const accountIdStr = String(account._id);
  const existing = await database.collection('account_encryption_backups').findOne({ accountId: accountIdStr, userId: userIdStr });
  const createdAt = existing?.createdAt || now;

  await database.collection('account_encryption_backups').updateOne(
    { accountId: accountIdStr, userId: userIdStr },
    {
      $set: {
        userId: userIdStr,
        accountId: accountIdStr,
        ...validation.backup,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt,
      },
    },
    { upsert: true }
  );

  return res.json({
    accountId: accountIdStr,
    ...validation.backup,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
    updatedAt: now.toISOString(),
  });
});

app.get('/api/accounts/:accountId/encryption/key-backup', requireAuth, async (req: any, res: any) => {
  const { accountId } = req.params;
  const database = req.db;
  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, req.userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);

  const userIdStr = String(account.userId || req.userId || '');
  const accountIdStr = String(account._id);
  const doc = await database.collection('account_encryption_backups').findOne({ accountId: accountIdStr, userId: userIdStr });
  if (!doc) {
    return apiError(res, 404, 'KEY_BACKUP_NOT_FOUND', 'Encryption key backup not found for this account', req.requestId);
  }

  return res.json({
    accountId: doc.accountId,
    backupVersion: doc.backupVersion,
    keyId: doc.keyId,
    kdfAlgorithm: doc.kdfAlgorithm,
    kdfIterations: doc.kdfIterations,
    salt: doc.salt,
    wrapAlgorithm: doc.wrapAlgorithm,
    nonce: doc.nonce,
    wrappedKey: doc.wrappedKey,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt),
  });
});

app.delete('/api/accounts/:accountId/encryption/key-backup', requireAuth, async (req: any, res: any) => {
  const { accountId } = req.params;
  const database = req.db;
  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, req.userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);

  const userIdStr = String(account.userId || req.userId || '');
  const accountIdStr = String(account._id);
  await database.collection('account_encryption_backups').deleteOne({ accountId: accountIdStr, userId: userIdStr });
  return res.status(204).end();
});

// ─── 3. NEW THUMBNAIL ENDPOINT ────────────────────────────────────────────────
app.get('/api/thumb/:accountId/:fileId', requireAuth, async (req: any, res: any) => {
  const { accountId, fileId } = req.params;
  const userId   = req.userId;
  const database = req.db;

  if (!isSafeProviderItemId(fileId)) {
    return apiError(res, 400, 'BAD_REQUEST', 'Invalid file identifier', req.requestId);
  }

  let s = parseInt(req.query.s as string, 10);
  if (isNaN(s)) s = 256;
  s = Math.max(64, Math.min(1280, s));

  try {
    const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, userId, req.isAdmin);
    if (accessDenied) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
    }
    if (!account) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.status(404).json({ error: 'Account not found' });
    }

    const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, account, fileId, userId, req.isAdmin);
    if (fileDenied) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this file', req.requestId);
    }
    if (meta?.isEncrypted === true) {
      res.setHeader('Cache-Control', 'no-store');
      return apiError(res, 409, 'ENCRYPTED_PREVIEW_UNAVAILABLE', 'Encrypted file preview is not available on the server', req.requestId);
    }

    const accIdStr = String(account._id);
    const etag = `"${accIdStr}_${fileId}_${s}"`;
    const thumbPath = buildThumbPath(accIdStr, fileId, s);

    // If exists on disk, serve it with res.sendFile
    if (fs.existsSync(thumbPath)) {
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      return res.sendFile(thumbPath);
    }

    // Limit concurrent thumbnail generation with p-limit(4) and deduplicate in-flight requests
    const inFlightKey = `${accIdStr}:${fileId}_${s}`;
    let thumbPromise = inFlightThumbs.get(inFlightKey);

    if (!thumbPromise) {
      thumbPromise = thumbLimit(async () => {
        try {
          return await generateThumbnail(account, fileId, s, thumbPath);
        } catch (err) {
          console.error('[Thumbs] Generation failure:', err);
          return null;
        }
      }).finally(() => {
        inFlightThumbs.delete(inFlightKey);
      });
      inFlightThumbs.set(inFlightKey, thumbPromise);
    }

    const generated = await thumbPromise;
    if (!generated || !fs.existsSync(generated)) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.status(404).json({ error: 'Thumbnail not available' });
    }

    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    return res.sendFile(generated);
  } catch (err: any) {
    console.error('[Thumbs] Endpoint error:', err);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(404).json({ error: 'Thumbnail not available' });
  }
});

// ─── /api/files ───────────────────────────────────────────────────────────────
app.get('/api/files', requireAuth, async (req: any, res: any) => {
  const { accountId, folderId, search, cursor } = req.query;
  const userId        = req.userId;
  const database      = req.db;
  if (!accountId || !database) return res.json([]);

  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId as string, userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folderCheck = validateSafeFolderId(folderId);
  if (!folderCheck.ok) {
    return apiError(res, folderCheck.error.status, folderCheck.error.code, folderCheck.error.message, req.requestId);
  }

  try {
    // ── TG Drive ──────────────────────────────────────────────────────────────
    if (account.accountType === 'tgdrive') {
      const currentFolder = folderCheck.folderId === 'root' ? '' : folderCheck.folderId;

      let limit = parseInt(req.query.limit as string, 10);
      if (isNaN(limit) || limit < 1) limit = 100;
      if (limit > 200) limit = 200;

      let cursorDate: number | null = null;
      let cursorId: ObjectId | null = null;

      if (cursor) {
        try {
          const decoded = Buffer.from(cursor as string, 'base64').toString('utf8');
          const idx = decoded.indexOf(':');
          if (idx !== -1) {
            cursorDate = parseInt(decoded.slice(0, idx), 10);
            cursorId = new ObjectId(decoded.slice(idx + 1));
          }
        } catch { /* ignore invalid cursor */ }
      }

      const fileFilter: any = { accountId: account._id, trashed: { $ne: true } };
      if (search) {
        const escaped = escapeRegex(search as string);
        // Never search inside encryptedMetadata; only match on name (which is opaque for encrypted files)
        fileFilter.name = new RegExp(escaped, 'i');
      } else {
        fileFilter.folder = currentFolder;
      }

      if (cursorDate !== null && cursorId !== null) {
        fileFilter.$or = [
          { date: { $lt: cursorDate } },
          { date: cursorDate, _id: { $lt: cursorId } }
        ];
      }

      // Fetch limit + 1 items to determine next cursor
      const rawTgFiles = await database.collection('tg_files')
        .find(fileFilter)
        .sort({ date: -1, _id: -1 })
        .limit(limit + 1)
        .toArray();

      if (rawTgFiles.length > limit) {
        rawTgFiles.pop();
        const lastItem = rawTgFiles[rawTgFiles.length - 1];
        const nextCursor = Buffer.from(`${lastItem.date}:${lastItem._id}`).toString('base64');
        res.setHeader('X-Next-Cursor', nextCursor);
      }

      // Return folders only when no cursor is supplied and no search
      let folders: any[] = [];
      if (!cursor && !search) {
        const escapedFolder = currentFolder ? escapeRegex(currentFolder) + '/' : '';
        const folderDocs = await database.collection('tg_folders')
          .find({
            accountId: account._id,
            path: { $regex: `^${escapedFolder}[^/]+$` }
          })
          .toArray();

        folders = folderDocs.map((f: any) => ({
          id:        `folder:${f.path}`,
          name:      f.name,
          type:      'folder',
          size:      '-',
          sizeBytes: 0,
          modified:  '-',
          createdAt: '-',
          folder:    f.path,
          isTgDrive: true,
          updatedAt: f.createdAt ? f.createdAt * 1000 : Date.now(),
          thumbUrl:  null,
        }));
      }

      const result = [...folders, ...rawTgFiles.map((f: any) => normaliseTgFile(f, accountId as string))];
      return sendJsonWithEtag(req, res, result);
    }

    // ── External Drives (OneDrive / Google Drive) ──────────────────────────
    const cursorStr = typeof cursor === 'string' && cursor.trim() ? cursor.trim() : null;
    const cacheKey = `api:${account.accountType}:${accountId}:${folderId || 'root'}:${search || 'none'}:${cursorStr || 'first'}`;
    const cached = search ? null : driveCache.get(cacheKey);
    if (cached) {
      const cachedCursor = driveCache.get(`${cacheKey}:cursor`) as string | undefined;
      if (cachedCursor) res.setHeader('X-Next-Cursor', cachedCursor);
      return sendJsonWithEtag(req, res, cached);
    }

    let rawFiles: any[] = [];
    let nextPageCursor: string | null = null;
    if (account.accountType === 'onedrive') {
      const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
      if (search) {
        const cleanSearch = String(search).replace(/[\r\n\0]/g, '').replace(/'/g, "''");
        const searchReq = c.api(`/me/drive/root/search(q='${cleanSearch}')`);
        const r = typeof searchReq.top === 'function' ? await searchReq.top(200).get() : await searchReq.get();
        rawFiles = (r.value || []).map((f: any) => ({ id: f.id, name: f.name, mimeType: f.folder ? 'folder' : (f.file?.mimeType || ''), size: f.size, modifiedTime: f.lastModifiedDateTime, createdTime: f.createdDateTime, webViewLink: f.webUrl }));
      } else {
        const effectiveFolderId = folderCheck.folderId || 'root';
        if (effectiveFolderId !== 'root' && !isSafeProviderItemId(effectiveFolderId)) {
          return apiError(res, 400, 'BAD_REQUEST', 'Invalid folder identifier', req.requestId);
        }
        const itemPath = effectiveFolderId === 'root' ? '/me/drive/root' : `/me/drive/items/${effectiveFolderId}`;
        const nextUrl = cursorStr ? Buffer.from(cursorStr, 'base64url').toString('utf8') : null;
        if (nextUrl && !isTrustedGraphNextLink(nextUrl)) {
          return apiError(res, 400, 'BAD_REQUEST', 'Invalid pagination cursor', req.requestId);
        }
        const childrenReq = c.api(`${itemPath}/children`);
        const r = nextUrl
          ? await c.api(nextUrl).get()
          : await (typeof childrenReq.top === 'function' ? childrenReq.top(200).get() : childrenReq.get());
        if (r['@odata.nextLink']) {
          nextPageCursor = Buffer.from(String(r['@odata.nextLink']), 'utf8').toString('base64url');
          res.setHeader('X-Next-Cursor', nextPageCursor);
        }
        rawFiles = (r.value || []).map((f: any) => ({ id: f.id, name: f.name, mimeType: f.folder ? 'folder' : (f.file?.mimeType || ''), size: f.size, modifiedTime: f.lastModifiedDateTime, createdTime: f.createdDateTime, webViewLink: f.webUrl }));
      }
      if (rawFiles.length > 0) {
        const trashedDocs = await database.collection('tg_files')
          .find({ accountId: account._id, trashed: true })
          .toArray();
        const trashedIds = new Set(trashedDocs.map((d: any) => String(d.providerFileId)).filter(Boolean));
        if (trashedIds.size > 0) {
          rawFiles = rawFiles.filter((f: any) => !trashedIds.has(String(f.id)));
        }
      }
    } else {
      // ── Google Drive ────────────────────────────────────────────────────────
      const drive = await getDriveClient(account.tokens || account.credentials);
      const qParts = ['trashed = false'];
      if (search) {
        qParts.push(`name contains '${escapeDriveQueryValue(String(search))}'`);
      } else {
        const effectiveFolderId = folderCheck.folderId || 'root';
        if (effectiveFolderId !== 'root' && !isSafeProviderItemId(effectiveFolderId)) {
          return apiError(res, 400, 'BAD_REQUEST', 'Invalid folder identifier', req.requestId);
        }
        qParts.push(`'${escapeDriveQueryValue(effectiveFolderId)}' in parents`);
      }
      const list = await drive.files.list({
        pageSize: 100,
        ...(cursorStr ? { pageToken: cursorStr } : {}),
        q: qParts.join(' and '),
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime,webViewLink)',
        orderBy: 'folder,name'
      });
      if (list.data.nextPageToken) {
        nextPageCursor = String(list.data.nextPageToken);
        res.setHeader('X-Next-Cursor', nextPageCursor);
      }
      rawFiles = list.data.files || [];
    }

    const rawIds = rawFiles.map((f: any) => String(f.id)).filter(Boolean);
    const rawNames = rawFiles.map((f: any) => String(f.name)).filter(Boolean);
    const encryptedRecords = rawFiles.length === 0
      ? []
      : await database.collection('tg_files')
          .find({
            accountId: account._id,
            isEncrypted: true,
            $or: [
              ...(rawIds.length ? [{ providerFileId: { $in: rawIds } }] : []),
              ...(rawNames.length ? [{ opaqueRemoteName: { $in: rawNames } }, { name: { $in: rawNames } }] : [])
            ]
          })
          .toArray();
    const encryptedByProviderId = new Map<string, any>();
    const encryptedByOpaqueName = new Map<string, any>();
    for (const rec of encryptedRecords) {
      if (rec.providerFileId) encryptedByProviderId.set(String(rec.providerFileId), rec);
      if (rec.opaqueRemoteName) encryptedByOpaqueName.set(String(rec.opaqueRemoteName), rec);
      if (rec.name) encryptedByOpaqueName.set(String(rec.name), rec);
    }

    const files = rawFiles.map((f: any) => {
      const encMeta = encryptedByProviderId.get(String(f.id)) || encryptedByOpaqueName.get(String(f.name));
      const updatedAt = f.modifiedTime ? new Date(f.modifiedTime).getTime() : Date.now();
      if (encMeta && encMeta.isEncrypted === true) {
        const encSize = Number(encMeta.encryptedSizeBytes ?? f.size ?? encMeta.size ?? 0);
        return {
          id: f.id,
          name: encMeta.opaqueRemoteName || f.name,
          type: 'other',
          mimeType: 'application/octet-stream',
          size: encSize ? (encSize / (1024 ** 2)).toFixed(1) + ' MB' : '0.0 MB',
          sizeBytes: encSize,
          encryptedSizeBytes: encSize,
          modified: f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : '-',
          createdAt: f.createdTime ? new Date(f.createdTime).toLocaleDateString() : '-',
          webViewLink: f.webViewLink,
          updatedAt,
          thumbUrl: null,
          isEncrypted: true,
          encryptionFormatVersion: encMeta.encryptionFormatVersion ?? 1,
          encryptionKeyId: encMeta.encryptionKeyId ?? null,
          encryptedChecksum: encMeta.encryptedChecksum ?? null,
          encryptedMetadata: encMeta.encryptedMetadata ?? null,
        };
      }

      const mime = f.mimeType || '';
      let type   = 'other';
      if (mime.includes('folder') || mime === 'folder') type = 'folder';
      else if (mime.includes('pdf'))    type = 'pdf';
      else if (mime.includes('image'))  type = 'image';
      else if (mime.includes('video'))  type = 'video';
      else if (mime.includes('audio'))  type = 'audio';
      else if (mime.includes('spreadsheet') || mime.includes('excel')) type = 'sheet';
      else if (mime.includes('document') || mime.includes('word'))     type = 'doc';
      else if (mime.includes('presentation') || mime.includes('powerpoint')) type = 'slide';
      else if (mime.includes('zip') || mime.includes('rar') || mime.includes('7z')) type = 'zip';

      const isMedia = type === 'image' || type === 'video';

      return {
        id: f.id,
        name: f.name,
        type,
        mimeType: mime || 'application/octet-stream',
        size: f.size ? (Number(f.size) / (1024 ** 2)).toFixed(1) + ' MB' : '-',
        sizeBytes: f.size ? Number(f.size) : 0,
        modified: f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : '-',
        createdAt: f.createdTime ? new Date(f.createdTime).toLocaleDateString() : '-',
        webViewLink: f.webViewLink,
        updatedAt,
        thumbUrl: isMedia ? `/api/thumb/${accountId}/${f.id}?s=256` : null,
        isEncrypted: false,
      };
    });

    if (!search) {
      driveCache.set(cacheKey, files, 60); // Cache for 60s
      if (nextPageCursor) driveCache.set(`${cacheKey}:cursor`, nextPageCursor, 60);
    }
    return sendJsonWithEtag(req, res, files);
  } catch (err: any) {
    console.error('Files API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete file (Soft-delete to Trash by default; ?permanent=true for hard delete) ───
async function permanentlyDeleteSingleFile(database: any, account: any, fileId: string, userId: any, isAdmin: boolean) {
  if (account.accountType === 'tgdrive') {
    const { meta, accessDenied } = await resolveFileMetadataForAccount(database, account, fileId, userId, isAdmin, true);
    if (accessDenied) {
      const err: any = new Error('Access denied to this file');
      err.status = 403;
      throw err;
    }
    if (!meta) {
      const err: any = new Error('File not found');
      err.status = 404;
      throw err;
    }
    const referenceCount = await database.collection('tg_files').countDocuments({
      messageId: meta.messageId,
      accountId: meta.accountId,
    });
    if (referenceCount <= 1) {
      const telegram = await getTgClient();
      const peer     = await resolvePeer(telegram, account.channelId);
      try { await telegram.deleteMessages(peer, [meta.messageId], { revoke: true }); } catch { /* message may already be gone */ }
    }
    await database.collection('tg_files').deleteOne({ _id: meta._id });
  } else if (account.accountType === 'onedrive') {
    const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
    try { await c.api(`/me/drive/items/${fileId}`).delete(); } catch { /* may already be deleted */ }
    await database.collection('tg_files').deleteMany({ accountId: account._id, providerFileId: String(fileId) });
  } else {
    const drive = await getDriveClient(account.tokens || account.credentials);
    await drive.files.delete({ fileId });
    await database.collection('tg_files').deleteMany({ accountId: account._id, providerFileId: String(fileId) });
  }
  deleteThumbFiles(fileId, String(account._id));
  invalidateDriveCache(String(account._id));
}

app.delete('/api/files/:fileId', requireAuth, async (req: any, res: any) => {
  const { fileId }    = req.params;
  const { accountId, permanent } = req.query;
  const userId        = req.userId;
  const database      = req.db;
  const isPermanent   = permanent === 'true' || permanent === '1';

  if (!isSafeProviderItemId(fileId)) {
    return apiError(res, 400, 'BAD_REQUEST', 'Invalid file identifier', req.requestId);
  }

  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId as string, userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    if (isPermanent) {
      try {
        await permanentlyDeleteSingleFile(database, account, fileId, userId, !!req.isAdmin);
      } catch (e: any) {
        if (e.status === 403) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', e.message, req.requestId);
        if (e.status === 404) return res.status(404).json({ error: e.message });
        throw e;
      }
      return res.json({ success: true, permanent: true });
    }

    // Soft-delete into Trash
    const now = new Date();
    if (account.accountType === 'tgdrive') {
      const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, account, fileId, userId, req.isAdmin, true);
      if (fileDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this file', req.requestId);
      if (!meta) return res.status(404).json({ error: 'File not found' });

      await database.collection('tg_files').updateOne(
        { _id: meta._id },
        { $set: { trashed: true, trashedAt: now, updatedAt: Date.now() } }
      );
    } else if (account.accountType === 'onedrive') {
      const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
      let itemMeta: any = null;
      try { itemMeta = await c.api(`/me/drive/items/${fileId}`).get(); } catch { /* ignore */ }
      await c.api(`/me/drive/items/${fileId}`).delete();
      const existingSidecar = await database.collection('tg_files').findOne({ accountId: account._id, providerFileId: String(fileId) });
      if (existingSidecar) {
        await database.collection('tg_files').updateOne(
          { _id: existingSidecar._id },
          { $set: { trashed: true, trashedAt: now, updatedAt: Date.now() } }
        );
      } else {
        await database.collection('tg_files').insertOne({
          accountId: account._id,
          ...(userId ? { userId: String(userId) } : {}),
          providerFileId: String(fileId),
          name: itemMeta?.name || String(fileId),
          mimeType: itemMeta?.file?.mimeType || (itemMeta?.folder ? 'folder' : 'application/octet-stream'),
          size: Number(itemMeta?.size) || 0,
          isEncrypted: false,
          trashed: true,
          trashedAt: now,
          date: Math.floor(now.getTime() / 1000),
          updatedAt: now.getTime(),
        });
      }
    } else {
      const drive = await getDriveClient(account.tokens || account.credentials);
      await drive.files.update({ fileId, requestBody: { trashed: true } });
      await database.collection('tg_files').updateMany(
        { accountId: account._id, providerFileId: String(fileId) },
        { $set: { trashed: true, trashedAt: now, updatedAt: Date.now() } }
      );
    }

    invalidateDriveCache(accountId as string);
    res.json({ success: true, trashed: true, fileId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Trash / Recycle Bin Endpoints ────────────────────────────────────────────
async function listTrashForAccount(database: any, account: any): Promise<any[]> {
  const accIdStr = String(account._id);
  if (account.accountType === 'tgdrive') {
    const raw = await database.collection('tg_files')
      .find({ accountId: account._id, trashed: true })
      .sort({ trashedAt: -1, date: -1 })
      .limit(200)
      .toArray();
    return raw.map((f: any) => ({
      ...normaliseTgFile(f, accIdStr),
      accountId: accIdStr,
      trashed: true,
      trashedAt: f.trashedAt ? new Date(f.trashedAt).getTime() : Date.now(),
    }));
  }

  if (account.accountType === 'google') {
    const drive = await getDriveClient(account.tokens || account.credentials);
    const listRes: any = await drive.files.list({
      pageSize: 100,
      q: "trashed = true and mimeType != 'application/vnd.google-apps.folder'",
      fields: 'files(id,name,mimeType,size,modifiedTime,createdTime,webViewLink)',
    });
    const gFiles = Array.isArray(listRes?.data?.files) ? listRes.data.files : [];
    const sidecars = await database.collection('tg_files')
      .find({ accountId: account._id, trashed: true })
      .toArray();
    const sidecarByProviderId = new Map<string, any>();
    for (const s of sidecars) {
      if (s.providerFileId) sidecarByProviderId.set(String(s.providerFileId), s);
    }

    return gFiles.map((f: any) => {
      const encMeta = sidecarByProviderId.get(String(f.id));
      const updatedAt = f.modifiedTime ? new Date(f.modifiedTime).getTime() : Date.now();
      if (encMeta && encMeta.isEncrypted === true) {
        const encSize = Number(encMeta.encryptedSizeBytes ?? f.size ?? encMeta.size ?? 0);
        return {
          id: f.id,
          accountId: accIdStr,
          name: encMeta.opaqueRemoteName || f.name,
          type: 'other',
          mimeType: 'application/octet-stream',
          size: encSize ? (encSize / (1024 ** 2)).toFixed(1) + ' MB' : '0.0 MB',
          sizeBytes: encSize,
          encryptedSizeBytes: encSize,
          modified: f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : '-',
          createdAt: f.createdTime ? new Date(f.createdTime).toLocaleDateString() : '-',
          updatedAt,
          thumbUrl: null,
          isEncrypted: true,
          encryptionFormatVersion: encMeta.encryptionFormatVersion ?? 1,
          encryptionKeyId: encMeta.encryptionKeyId ?? null,
          encryptedChecksum: encMeta.encryptedChecksum ?? null,
          encryptedMetadata: encMeta.encryptedMetadata ?? null,
          trashed: true,
          trashedAt: encMeta.trashedAt ? new Date(encMeta.trashedAt).getTime() : updatedAt,
        };
      }
      const sz = Number(f.size) || 0;
      return {
        id: f.id,
        accountId: accIdStr,
        name: f.name,
        type: 'other',
        mimeType: f.mimeType || 'application/octet-stream',
        size: sz ? (sz / (1024 ** 2)).toFixed(1) + ' MB' : '-',
        sizeBytes: sz,
        modified: f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : '-',
        createdAt: f.createdTime ? new Date(f.createdTime).toLocaleDateString() : '-',
        updatedAt,
        thumbUrl: null,
        isEncrypted: false,
        trashed: true,
        trashedAt: updatedAt,
      };
    });
  }

  // OneDrive: return tracked trashed items in tg_files merged with Graph recyclebin items if available
  const odTrashed = await database.collection('tg_files')
    .find({ accountId: account._id, trashed: true })
    .sort({ trashedAt: -1 })
    .toArray();
  const trackedItems = odTrashed.map((f: any) => ({
    ...normaliseTgFile(f, accIdStr),
    id: String(f.providerFileId || f._id),
    accountId: accIdStr,
    isTgDrive: false,
    trashed: true,
    trashedAt: f.trashedAt ? new Date(f.trashedAt).getTime() : Date.now(),
  }));
  const seenIds = new Set(trackedItems.map((it: any) => String(it.id)));
  try {
    const c = await getOneDriveClient(account.tokens || account.credentials, accIdStr);
    const rbReq = c.api('/me/drive/special/recyclebin/children');
    const rbRes = typeof rbReq?.get === 'function' ? await rbReq.get() : null;
    const rbList = Array.isArray(rbRes?.value) ? rbRes.value : [];
    for (const f of rbList) {
      const fid = String(f?.id || '');
      if (!fid || seenIds.has(fid)) continue;
      seenIds.add(fid);
      const sz = Number(f.size) || 0;
      const updatedAt = f.lastModifiedDateTime ? new Date(f.lastModifiedDateTime).getTime() : Date.now();
      trackedItems.push({
        id: fid,
        accountId: accIdStr,
        name: f.name || fid,
        type: f.folder ? 'folder' : 'other',
        mimeType: f.folder ? 'folder' : (f.file?.mimeType || 'application/octet-stream'),
        size: sz ? (sz / (1024 ** 2)).toFixed(1) + ' MB' : '-',
        sizeBytes: sz,
        modified: f.lastModifiedDateTime ? new Date(f.lastModifiedDateTime).toLocaleDateString() : '-',
        createdAt: f.createdDateTime ? new Date(f.createdDateTime).toLocaleDateString() : '-',
        updatedAt,
        thumbUrl: null,
        isEncrypted: false,
        isTgDrive: false,
        trashed: true,
        trashedAt: updatedAt,
      });
    }
  } catch { /* ignore if Graph recyclebin endpoint is unavailable */ }
  return trackedItems;
}

app.get('/api/trash', requireAuth, async (req: any, res: any) => {
  const { accountId } = req.query;
  const database      = req.db;
  const userId        = req.userId;

  try {
    if (!accountId || accountId === 'all' || accountId === 'root') {
      const accQuery: any = {};
      if (!req.isAdmin || userId) accQuery.userId = userId;
      const accounts = await database.collection('accounts').find(accQuery).toArray();
      const lists = await Promise.all(
        accounts.map((acc: any) => listTrashForAccount(database, acc).catch(() => []))
      );
      const merged = lists.flat().sort((a: any, b: any) => (b.trashedAt || 0) - (a.trashedAt || 0));
      return res.json(merged);
    }

    const { account, accessDenied, invalidId } = await resolveAuthorizedAccount(database, accountId as string, userId, req.isAdmin);
    if (invalidId) return apiError(res, 400, 'BAD_REQUEST', 'Invalid accountId', req.requestId);
    if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const items = await listTrashForAccount(database, account);
    return res.json(items);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/trash/restore', requireAuth, async (req: any, res: any) => {
  const { accountId, fileId } = req.body || {};
  const database              = req.db;
  const userId                = req.userId;

  if (!isSafeProviderItemId(fileId)) {
    return apiError(res, 400, 'BAD_REQUEST', 'Invalid file identifier', req.requestId);
  }

  const { account, accessDenied, invalidId } = await resolveAuthorizedAccount(database, accountId, userId, req.isAdmin);
  if (invalidId) return apiError(res, 400, 'BAD_REQUEST', 'Invalid accountId', req.requestId);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    if (account.accountType === 'tgdrive') {
      const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, account, fileId, userId, req.isAdmin, true);
      if (fileDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this file', req.requestId);
      if (!meta) return res.status(404).json({ error: 'File not found in trash' });

      await database.collection('tg_files').updateOne(
        { _id: meta._id },
        { $set: { trashed: false, updatedAt: Date.now() }, $unset: { trashedAt: '' } }
      );
    } else if (account.accountType === 'google') {
      const drive = await getDriveClient(account.tokens || account.credentials);
      await drive.files.update({ fileId, requestBody: { trashed: false } });
      await database.collection('tg_files').updateMany(
        { accountId: account._id, providerFileId: String(fileId) },
        { $set: { trashed: false, updatedAt: Date.now() }, $unset: { trashedAt: '' } }
      );
    } else if (account.accountType === 'onedrive') {
      const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
      try {
        const restoreReq = c.api(`/me/drive/items/${fileId}/restore`);
        if (typeof restoreReq.post === 'function') await restoreReq.post({});
      } catch { /* ignore if provider item already restored */ }
      await database.collection('tg_files').updateMany(
        { accountId: account._id, providerFileId: String(fileId) },
        { $set: { trashed: false, updatedAt: Date.now() }, $unset: { trashedAt: '' } }
      );
    }

    invalidateDriveCache(String(account._id));
    return res.json({ success: true, restored: true, fileId });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/trash/:fileId', requireAuth, async (req: any, res: any) => {
  const { fileId }    = req.params;
  const { accountId } = req.query;
  const database      = req.db;
  const userId        = req.userId;

  if (!isSafeProviderItemId(fileId)) {
    return apiError(res, 400, 'BAD_REQUEST', 'Invalid file identifier', req.requestId);
  }

  const { account, accessDenied, invalidId } = await resolveAuthorizedAccount(database, accountId as string, userId, req.isAdmin);
  if (invalidId) return apiError(res, 400, 'BAD_REQUEST', 'Invalid accountId', req.requestId);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    await permanentlyDeleteSingleFile(database, account, fileId, userId, !!req.isAdmin);
    return res.json({ success: true, deletedPermanently: true, fileId });
  } catch (e: any) {
    if (e.status === 403) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', e.message, req.requestId);
    if (e.status === 404) return res.status(404).json({ error: e.message });
    return res.status(500).json({ error: e.message });
  }
});

app.delete('/api/trash', requireAuth, async (req: any, res: any) => {
  const { accountId } = req.query;
  const database      = req.db;
  const userId        = req.userId;

  try {
    let targetAccounts: any[] = [];
    if (!accountId || accountId === 'all' || accountId === 'root') {
      const accQuery: any = {};
      if (!req.isAdmin || userId) accQuery.userId = userId;
      targetAccounts = await database.collection('accounts').find(accQuery).toArray();
    } else {
      const { account, accessDenied, invalidId } = await resolveAuthorizedAccount(database, accountId as string, userId, req.isAdmin);
      if (invalidId) return apiError(res, 400, 'BAD_REQUEST', 'Invalid accountId', req.requestId);
      if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
      if (!account) return res.status(404).json({ error: 'Account not found' });
      targetAccounts = [account];
    }

    let deletedCount = 0;
    for (const acc of targetAccounts) {
      const items = await listTrashForAccount(database, acc).catch(() => []);
      for (const item of items) {
        try {
          await permanentlyDeleteSingleFile(database, acc, String(item.id), userId, !!req.isAdmin);
          deletedCount++;
        } catch { /* ignore individual item failure during bulk empty */ }
      }
      invalidateDriveCache(String(acc._id));
    }
    return res.json({ success: true, deletedCount });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
async function sweepExpiredTrash() {
  const database = db || await connectToMongo();
  if (!database) return 0;
  const cutoff = new Date(Date.now() - TRASH_RETENTION_MS);
  const expired = await database.collection('tg_files')
    .find({ trashed: true, trashedAt: { $lte: cutoff } })
    .limit(100)
    .toArray();
  let purged = 0;
  for (const meta of expired) {
    try {
      const acc = await database.collection('accounts').findOne({ _id: meta.accountId });
      if (acc) {
        await permanentlyDeleteSingleFile(database, acc, String(meta.providerFileId || meta._id), meta.userId, true);
      } else {
        await database.collection('tg_files').deleteOne({ _id: meta._id });
      }
      purged++;
    } catch { /* ignore */ }
  }
  return purged;
}

// ─── Rename file ──────────────────────────────────────────────────────────────
app.patch('/api/files/:fileId', requireAuth, async (req: any, res: any) => {
  const { fileId }    = req.params;
  const { accountId } = req.query;
  const { name }      = req.body;
  const userId        = req.userId;
  const database      = req.db;

  if (!isSafeProviderItemId(fileId)) {
    return apiError(res, 400, 'BAD_REQUEST', 'Invalid file identifier', req.requestId);
  }

  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId as string, userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, account, fileId, userId, req.isAdmin);
  if (fileDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this file', req.requestId);

  if (meta?.isEncrypted === true) {
    const opaqueErr = validateOpaqueFilename(name);
    if (opaqueErr) return apiError(res, opaqueErr.status, opaqueErr.code, opaqueErr.message, req.requestId);
  } else {
    const plainErr = validatePlaintextFilename(name);
    if (!plainErr.ok) return apiError(res, plainErr.error.status, plainErr.error.code, plainErr.error.message, req.requestId);
  }

  try {
    if (account.accountType === 'tgdrive') {
      if (!meta) return res.status(404).json({ error: 'File not found' });
      const updateFields: any = { name, updatedAt: new Date() };
      if (meta.isEncrypted === true) updateFields.opaqueRemoteName = name;
      await database.collection('tg_files').updateOne({ _id: meta._id }, { $set: updateFields });
    } else if (account.accountType === 'onedrive') {
      const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
      await c.api(`/me/drive/items/${fileId}`).patch({ name });
      if (meta) {
        await database.collection('tg_files').updateOne({ _id: meta._id }, { $set: { name, opaqueRemoteName: name, updatedAt: new Date() } });
      }
    } else {
      const drive = await getDriveClient(account.tokens || account.credentials);
      await drive.files.update({ fileId, requestBody: { name } });
      if (meta) {
        await database.collection('tg_files').updateOne({ _id: meta._id }, { $set: { name, opaqueRemoteName: name, updatedAt: new Date() } });
      }
    }
    invalidateDriveCache(accountId as string);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create folder ────────────────────────────────────────────────────────────
app.post('/api/folders', requireAuth, async (req: any, res: any) => {
  const { accountId } = req.query;
  const { name, parentId } = req.body;
  const userId        = req.userId;
  const database      = req.db;

  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId as string, userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const nameErr = validatePlaintextFilename(name);
  if (!nameErr.ok) return apiError(res, nameErr.error.status, nameErr.error.code, nameErr.error.message, req.requestId);
  const folderCheck = validateSafeFolderId(parentId);
  if (!folderCheck.ok) return apiError(res, folderCheck.error.status, folderCheck.error.code, folderCheck.error.message, req.requestId);

  try {
    if (account.accountType === 'tgdrive') {
      const parentPath = folderCheck.folderId === 'root' ? '' : folderCheck.folderId;
      const folderPath = parentPath ? `${parentPath}/${name}` : name;
      await database.collection('tg_folders').updateOne(
        { accountId: account._id, path: folderPath },
        { $set: { accountId: account._id, userId: String(userId || account.userId || ''), name, path: folderPath, createdAt: Math.floor(Date.now() / 1000) } },
        { upsert: true }
      );
    } else {
      const safeParent = folderCheck.folderId || 'root';
      if (safeParent !== 'root' && !isSafeProviderItemId(safeParent)) {
        return apiError(res, 400, 'BAD_REQUEST', 'Invalid parent folder identifier', req.requestId);
      }
      if (account.accountType === 'onedrive') {
        const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
        const parentPath = safeParent === 'root' ? '/me/drive/root' : `/me/drive/items/${safeParent}`;
        await c.api(`${parentPath}/children`).post({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' });
      } else {
        const drive = await getDriveClient(account.tokens || account.credentials);
        await drive.files.create({ requestBody: { name, parents: [safeParent], mimeType: 'application/vnd.google-apps.folder' } });
      }
    }
    invalidateDriveCache(accountId as string);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

type ProviderUploadFile = {
  path: string;
  size: number;
  originalname: string;
  mimetype: string;
};

function isRetryableProviderError(err: any, status?: number | null): boolean {
  const code = String(err?.code || '');
  const httpStatus = status ?? Number(err?.response?.status || err?.status || 0);
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_SOCKET'
  ) {
    return true;
  }
  if (httpStatus === 429 || (httpStatus >= 500 && httpStatus < 600)) {
    return true;
  }
  if (httpStatus === 403) {
    const bodyStr = JSON.stringify(err?.response?.data || err?.errors || err?.message || '').toLowerCase();
    if (
      bodyStr.includes('ratelimitexceeded') ||
      bodyStr.includes('userratelimitexceeded') ||
      bodyStr.includes('quotaexceeded') ||
      bodyStr.includes('throttled') ||
      bodyStr.includes('too many requests')
    ) {
      return true;
    }
  }
  return false;
}

async function withTransientRetry<T>(
  operation: () => Promise<T>,
  shouldRetryStatus?: (res: T) => number | null,
  maxAttempts = 3,
  context?: { provider?: string; operation?: string }
): Promise<T> {
  let attempt = 0;
  let lastError: any;
  const startedAt = Date.now();
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const result = await operation();
      const status = shouldRetryStatus ? shouldRetryStatus(result) : null;
      const isQuota403 = status === 403 && isRetryableProviderError({ response: result }, 403);
      if (status !== null && (status === 429 || status >= 500 || isQuota403) && attempt < maxAttempts) {
        const retryAfterHeader = (result as any)?.headers?.['retry-after'];
        const jitter = Math.floor(Math.random() * 150);
        const retryMs = retryAfterHeader
          ? Math.min(10_000, Math.max(500, Number(retryAfterHeader) * 1000))
          : Math.min(10_000, 500 * (2 ** (attempt - 1)) + jitter);
        await new Promise(r => setTimeout(r, retryMs));
        continue;
      }
      if (context?.provider) {
        recordProviderCall(context.provider, context.operation || 'api_call', Date.now() - startedAt, status === null || status < 400, attempt - 1, status ?? 200);
      }
      return result;
    } catch (err: any) {
      lastError = err;
      const transient = isRetryableProviderError(err);
      if (!transient || attempt >= maxAttempts) {
        if (context?.provider) {
          recordProviderCall(context.provider, context.operation || 'api_call', Date.now() - startedAt, false, attempt - 1, err?.response?.status || err?.code || 'ERR');
        }
        throw err;
      }
      const jitter = Math.floor(Math.random() * 150);
      await new Promise(r => setTimeout(r, Math.min(10_000, 500 * (2 ** (attempt - 1)) + jitter)));
    }
  }
  throw lastError;
}

type PersistedProviderSession = { providerType?: string; uploadUrl?: string; nextOffset?: number; completed?: boolean };
async function uploadOneDriveResumable(
  account: any, accountId: string, file: ProviderUploadFile, folderId: string | undefined,
  prior: PersistedProviderSession | undefined, persist: (state: PersistedProviderSession) => Promise<void>
) {
  const c = await getOneDriveClient(account.tokens || account.credentials, accountId);
  const parentPath = (!folderId || folderId === 'root') ? '/me/drive/root' : `/me/drive/items/${folderId}`;
  const encodedName = encodeURIComponent(file.originalname);
  if (file.size === 0) {
    const resZero = await c.api(`${parentPath}:/${encodedName}:/content`).put(fs.createReadStream(file.path));
    await persist({ providerType: 'onedrive', completed: true, nextOffset: 0 });
    return resZero;
  }
  const createSession = async () => {
    const result = await c.api(`${parentPath}:/${encodedName}:/createUploadSession`).post({
      item: { '@microsoft.graph.conflictBehavior': 'replace', name: file.originalname }
    });
    if (!result?.uploadUrl || !isValidHttpsUrl(result.uploadUrl, true)) {
      throw new Error('OneDrive returned an invalid upload session URL');
    }
    const next = { providerType: 'onedrive', uploadUrl: result.uploadUrl, nextOffset: 0 };
    await persist(next);
    return next;
  };
  let state = (prior?.providerType === 'onedrive' && prior.uploadUrl && isValidHttpsUrl(prior.uploadUrl, true))
    ? prior
    : await createSession();
  const sessionStatus = async () => withTransientRetry(
    () => axios.get(state.uploadUrl!, { timeout: 30_000, validateStatus: () => true }),
    (r) => r.status
  );
  let status = await sessionStatus();
  if (status.status === 404 || status.status === 410) {
    state = await createSession();
    status = await sessionStatus();
  }
  if (status.status < 200 || status.status >= 300) throw new Error(`OneDrive upload session query failed (${status.status})`);
  const expected = Array.isArray(status.data?.nextExpectedRanges) ? status.data.nextExpectedRanges : [];
  let offset = parseOneDriveNextOffset(expected, file.size, Number(state.nextOffset || 0));
  if (!Number.isFinite(offset) || offset < 0 || offset > file.size) throw new Error('OneDrive returned an invalid nextExpectedRanges offset');
  const chunkSize = 320 * 1024 * 10; // Microsoft Graph requires non-final ranges in 320 KiB multiples.
  await persist({ ...state, nextOffset: offset });
  while (offset < file.size) {
    const length = Math.min(chunkSize, file.size - offset);
    const end = offset + length - 1;
    const response = await withTransientRetry(
      () => axios.put(state.uploadUrl!, fs.createReadStream(file.path, { start: offset, end }), {
        headers: { 'Content-Range': `bytes ${offset}-${end}/${file.size}`, 'Content-Length': length },
        timeout: 120_000, maxBodyLength: Infinity, maxContentLength: Infinity, validateStatus: () => true
      }),
      (r) => r.status
    );
    if (response.status === 200 || response.status === 201) {
      await persist({ providerType: 'onedrive', completed: true, nextOffset: file.size });
      return response.data;
    }
    if (response.status !== 202) {
      if (response.status === 404 || response.status === 410) {
        state = await createSession();
        status = await sessionStatus();
        const nextRanges = Array.isArray(status.data?.nextExpectedRanges) ? status.data.nextExpectedRanges : [];
        offset = parseOneDriveNextOffset(nextRanges, file.size, 0);
        await persist({ ...state, nextOffset: offset });
        continue;
      }
      throw new Error(`OneDrive chunk upload failed (${response.status}): ${JSON.stringify(response.data).slice(0, 500)}`);
    }
    const nextRanges = Array.isArray(response.data?.nextExpectedRanges) ? response.data.nextExpectedRanges : [];
    const nextOffset = parseOneDriveNextOffset(nextRanges, file.size, end + 1);
    if (!Number.isFinite(nextOffset) || nextOffset <= offset || nextOffset > file.size) throw new Error('OneDrive returned an invalid nextExpectedRanges offset');
    offset = nextOffset;
    await persist({ ...state, nextOffset: offset });
  }
  status = await sessionStatus();
  if (status.status === 200 && !Array.isArray(status.data?.nextExpectedRanges)) {
    await persist({ providerType: 'onedrive', completed: true, nextOffset: file.size });
    return status.data;
  }
  throw new Error('OneDrive upload session did not confirm completion');
}
async function uploadGoogleDriveResumable(
  account: any, file: ProviderUploadFile, folderId: string | undefined, prior: PersistedProviderSession | undefined,
  persist: (state: PersistedProviderSession) => Promise<void>, idempotencyKey?: string
) {
  const drive = await getDriveClient(account.tokens || account.credentials);
  const auth: any = (drive as any).context?._options?.auth;
  if (!auth?.getAccessToken) throw new Error('Google Drive auth client cannot provide a resumable-upload token');
  const getToken = async () => {
    const value = await auth.getAccessToken();
    const token = typeof value === 'string' ? value : value?.token;
    if (!token) throw new Error('Google Drive returned no access token');
    return token as string;
  };
  const appProperties = idempotencyKey ? { cloudyteTransferKey: idempotencyKey } : undefined;
  const findCompleted = async () => {
    if (!idempotencyKey) return null;
    const safeValue = escapeDriveQueryValue(idempotencyKey);
    const found = await drive.files.list({
      q: `appProperties has { key='cloudyteTransferKey' and value='${safeValue}' } and trashed = false`,
      fields: 'files(id,name)', pageSize: 1
    });
    return found.data.files?.[0] || null;
  };
  const existing = await findCompleted();
  if (existing) return existing;
  if (file.size === 0) {
    const response = await drive.files.create({
      requestBody: { name: file.originalname, parents: [folderId || 'root'], ...(appProperties ? { appProperties } : {}) },
      media: { mimeType: file.mimetype, body: fs.createReadStream(file.path) }, fields: 'id,name'
    });
    await persist({ providerType: 'google', completed: true, nextOffset: 0 });
    return response.data;
  }
  const createSession = async () => {
    const token = await getToken();
    const response = await withTransientRetry(
      () => axios.post(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name',
        { name: file.originalname, parents: [folderId || 'root'], ...(appProperties ? { appProperties } : {}) },
        {
          headers: {
            Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': file.mimetype, 'X-Upload-Content-Length': String(file.size)
          },
          timeout: 30_000, validateStatus: () => true
        }
      ),
      (r) => r.status
    );
    if (response.status < 200 || response.status >= 300) throw new Error(`Google Drive session creation failed (${response.status}): ${JSON.stringify(response.data).slice(0, 500)}`);
    const uploadUrl = response.headers.location || response.headers.Location;
    if (!uploadUrl || !isValidHttpsUrl(uploadUrl, true)) throw new Error('Google Drive returned an invalid resumable session URI');
    const state: PersistedProviderSession = { providerType: 'google', uploadUrl, nextOffset: 0 };
    await persist(state);
    return state;
  };
  let state = (prior?.providerType === 'google' && prior.uploadUrl && isValidHttpsUrl(prior.uploadUrl, true))
    ? prior
    : await createSession();
  const queryOffset = async () => {
    const token = await getToken();
    const response = await withTransientRetry(
      () => axios.put(state.uploadUrl!, Buffer.alloc(0), {
        headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0', 'Content-Range': `bytes */${file.size}` },
        timeout: 30_000, maxRedirects: 0, validateStatus: () => true
      }),
      (r) => r.status
    );
    if (response.status === 200 || response.status === 201) return { done: true, offset: file.size, data: response.data };
    if (response.status !== 308) {
      if (response.status === 404 || response.status === 410) return { done: false, offset: -1, data: null };
      throw new Error(`Google Drive offset query failed (${response.status})`);
    }
    const range = response.headers.range || response.headers.Range;
    return { done: false, offset: parseGoogleRangeOffset(range, file.size), data: null };
  };
  let status = await queryOffset();
  if (status.done) return status.data;
  if (status.offset < 0) {
    const completed = await findCompleted();
    if (completed) return completed;
    state = await createSession();
    status = await queryOffset();
  }
  let offset = status.offset;
  await persist({ ...state, nextOffset: offset });
  const chunkSize = 8 * 1024 * 1024; // Google resumable chunks are 256 KiB multiples.
  while (offset < file.size) {
    const length = Math.min(chunkSize, file.size - offset);
    const end = offset + length - 1;
    const token = await getToken();
    const response = await withTransientRetry(
      () => axios.put(state.uploadUrl!, fs.createReadStream(file.path, { start: offset, end }), {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.mimetype, 'Content-Length': String(length), 'Content-Range': `bytes ${offset}-${end}/${file.size}` },
        timeout: 120_000, maxBodyLength: Infinity, maxContentLength: Infinity, maxRedirects: 0, validateStatus: () => true
      }),
      (r) => r.status
    );
    if (response.status === 200 || response.status === 201) {
      await persist({ providerType: 'google', completed: true, nextOffset: file.size });
      return response.data;
    }
    if (response.status === 308) {
      const range = response.headers.range || response.headers.Range;
      const next = parseGoogleRangeOffset(range, file.size);
      if (next <= offset || next > file.size) throw new Error('Google Drive returned an invalid Range acknowledgement');
      offset = next;
      await persist({ ...state, nextOffset: offset });
      continue;
    }
    if (response.status === 404 || response.status === 410) {
      const completed = await findCompleted();
      if (completed) return completed;
      state = await createSession();
      const restarted = await queryOffset();
      if (restarted.done) return restarted.data;
      offset = restarted.offset;
      continue;
    }
    throw new Error(`Google Drive chunk upload failed (${response.status}): ${JSON.stringify(response.data).slice(0, 500)}`);
  }
  const confirmed = await queryOffset();
  if (confirmed.done) {
    await persist({ providerType: 'google', completed: true, nextOffset: file.size });
    return confirmed.data;
  }
  throw new Error('Google Drive resumable session did not confirm completion');
}

async function uploadFileToProvider(
  account: any, accountId: string, file: ProviderUploadFile, folderId?: string,
  providerSession?: PersistedProviderSession, persistProviderSession?: (state: PersistedProviderSession) => Promise<void>,
  idempotencyKey?: string, encryptionSpec?: ValidatedUploadSpec, userId?: string
) {
  const providerType = transferProviderType(account.accountType);
  if (!providerType) {
    const err: any = new Error(`Provider '${String(account.accountType || 'unknown')}' does not support upload`);
    err.code = 'UNSUPPORTED_PROVIDER_OPERATION';
    throw err;
  }
  return providerLimit(`upload:${providerType}:${accountId}`, providerType === 'telegram' ? 2 : 3)(async () => {
    const database = db || await connectToMongo();
    if (providerType === 'telegram') {
      const folder = (!folderId || folderId === 'root') ? '' : folderId;
      return await tgUploadFile(accountId, account.channelId, file.path, file.originalname, file.mimetype, folder, '', idempotencyKey, encryptionSpec, userId || account.userId);
    } else if (providerType === 'onedrive') {
      let result: any;
      if (persistProviderSession) {
        result = await uploadOneDriveResumable(account, accountId, file, folderId, providerSession, persistProviderSession);
      } else {
        const c = await getOneDriveClient(account.tokens || account.credentials, accountId);
        const parentPath = (!folderId || folderId === 'root') ? '/me/drive/root' : `/me/drive/items/${folderId}`;
        const encodedName = encodeURIComponent(file.originalname);
        if (file.size <= 4 * 1024 * 1024) {
          result = await c.api(`${parentPath}:/${encodedName}:/content`).put(fs.createReadStream(file.path));
        } else {
          const session = await c.api(`${parentPath}:/${encodedName}:/createUploadSession`).post({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: file.originalname } });
          if (!session?.uploadUrl || !isValidHttpsUrl(session.uploadUrl, true)) {
            throw new Error('OneDrive returned an invalid upload session URL');
          }
          const chunkSize = 320 * 1024 * 10;
          for (let start = 0; start < file.size; start += chunkSize) {
            const end = Math.min(start + chunkSize, file.size);
            const r = await withTransientRetry(() => axios.put(session.uploadUrl, fs.createReadStream(file.path, { start, end: end - 1 }), {
              headers: { 'Content-Range': `bytes ${start}-${end - 1}/${file.size}`, 'Content-Length': end - start },
              timeout: 120_000, maxBodyLength: Infinity, maxContentLength: Infinity
            }));
            if (r.data) result = r.data;
          }
        }
      }
      if (encryptionSpec?.isEncrypted) {
        const remoteId = String(result?.id || file.originalname);
        const now = new Date();
        await database.collection('tg_files').updateOne(
          { accountId: account._id, providerFileId: remoteId },
          {
            $set: {
              accountId: account._id,
              userId: String(userId || account.userId || ''),
              providerType: 'onedrive',
              providerFileId: remoteId,
              name: encryptionSpec.fileName,
              opaqueRemoteName: encryptionSpec.opaqueRemoteName,
              mimeType: 'application/octet-stream',
              size: file.size,
              folder: (!folderId || folderId === 'root') ? '' : folderId,
              date: Math.floor(Date.now() / 1000),
              isEncrypted: true,
              encryptionFormatVersion: encryptionSpec.encryptionFormatVersion,
              encryptionKeyId: encryptionSpec.encryptionKeyId,
              encryptedMetadata: encryptionSpec.encryptedMetadata,
              encryptedSizeBytes: file.size,
              encryptedChecksum: encryptionSpec.checksum,
              plaintextSizeBytes: null,
              plaintextChecksum: null,
              encryptedThumbnailObjectId: null,
              shareId: null,
              updatedAt: now,
            },
            $setOnInsert: { createdAt: now },
          },
          { upsert: true }
        );
      }
      return result;
    } else if (providerType === 'google_drive') {
      let result: any;
      if (persistProviderSession) {
        result = await uploadGoogleDriveResumable(account, file, folderId, providerSession, persistProviderSession, idempotencyKey);
      } else {
        const drive = await getDriveClient(account.tokens || account.credentials);
        const r = await drive.files.create({ requestBody: { name: file.originalname, parents: [folderId || 'root'] }, media: { mimeType: file.mimetype, body: fs.createReadStream(file.path) }, fields: 'id,name' });
        result = r.data;
      }
      if (encryptionSpec?.isEncrypted) {
        const remoteId = String(result?.id || file.originalname);
        const now = new Date();
        await database.collection('tg_files').updateOne(
          { accountId: account._id, providerFileId: remoteId },
          {
            $set: {
              accountId: account._id,
              userId: String(userId || account.userId || ''),
              providerType: 'google_drive',
              providerFileId: remoteId,
              name: encryptionSpec.fileName,
              opaqueRemoteName: encryptionSpec.opaqueRemoteName,
              mimeType: 'application/octet-stream',
              size: file.size,
              folder: (!folderId || folderId === 'root') ? '' : folderId,
              date: Math.floor(Date.now() / 1000),
              isEncrypted: true,
              encryptionFormatVersion: encryptionSpec.encryptionFormatVersion,
              encryptionKeyId: encryptionSpec.encryptionKeyId,
              encryptedMetadata: encryptionSpec.encryptedMetadata,
              encryptedSizeBytes: file.size,
              encryptedChecksum: encryptionSpec.checksum,
              plaintextSizeBytes: null,
              plaintextChecksum: null,
              encryptedThumbnailObjectId: null,
              shareId: null,
              updatedAt: now,
            },
            $setOnInsert: { createdAt: now },
          },
          { upsert: true }
        );
      }
      return result;
    } else {
      const err: any = new Error(`Provider '${String(account.accountType || 'unknown')}' does not support upload`);
      err.code = 'UNSUPPORTED_PROVIDER_OPERATION';
      throw err;
    }
  });
}

function transferProviderType(accountType: unknown): string | null {
  const value = String(accountType || '').trim().toLowerCase().replace(/[ -]/g, '_');
  if (['tgdrive', 'tg_drive', 'telegram', 'telegram_drive'].includes(value)) return 'telegram';
  if (['google', 'gdrive', 'google_drive', 'googledrive'].includes(value)) return 'google_drive';
  if (['onedrive', 'one_drive', 'microsoft_onedrive'].includes(value)) return 'onedrive';
  return null;
}
function uploadSessionId() {
  return `us_${Date.now()}_${nanoid(18)}`;
}

async function findUploadAccount(req: any, accountId: string) {
  return resolveAuthorizedAccount(req.db, accountId, req.userId, req.isAdmin);
}

// ─── Resumable upload sessions ────────────────────────────────────────────────
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const COMPLETED_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_COMPLETION_LEASE_MS = 10 * 60 * 1000;
async function sweepUploadSessions() {
  if (!db) return;
  const sessions = db.collection('upload_sessions');
  const now = new Date();
  const stale = await sessions.find({ status: { $in: ['active', 'paused', 'expired', 'cancelled'] }, expiresAt: { $lte: now } }).limit(500).toArray();
  for (const session of stale) {
    await withSessionLock(session.sessionId, async () => {
      if (session.tempPath) { try { fs.unlinkSync(session.tempPath); } catch (error: any) { if (error?.code !== 'ENOENT') console.error('[UploadSessions] Cleanup failed:', error); } }
      await sessions.updateOne({ sessionId: session.sessionId, status: { $in: ['active', 'paused'] }, expiresAt: { $lte: now } }, { $set: { status: 'expired', updatedAt: now } });
    });
  }
  // Recover stuck 'completing' sessions whose completion lease has expired
  await sessions.updateMany(
    { status: 'completing', completionLeaseExpiresAt: { $lte: Date.now() } },
    { $set: { status: 'active', updatedAt: now }, $unset: { completionLeaseExpiresAt: '' } }
  );
  await sessions.deleteMany({ status: 'completed', completedAt: { $lte: new Date(Date.now() - COMPLETED_SESSION_TTL_MS) } });
}

function publicUploadSession(session: any) {
  return {
    sessionId: session.sessionId,
    status: session.status,
    receivedBytes: session.receivedBytes,
    totalBytes: session.totalBytes,
    chunkSize: session.chunkSize,
    checksum: session.checksum,
    providerType: session.providerType,
    providerResumable: session.providerResumable,
    providerCancellable: session.providerCancellable,
    accountId: session.accountId,
    parentFolderId: session.folderId,
    providerMetadata: session.providerSession || null,
    expiresAt: session.expiresAt,
    isEncrypted: Boolean(session.isEncrypted),
    encryptionFormatVersion: session.isEncrypted ? (session.encryptionFormatVersion ?? 1) : null,
    encryptionKeyId: session.isEncrypted ? (session.encryptionKeyId ?? null) : null,
    encryptedMetadata: session.isEncrypted ? (session.encryptedMetadata ?? null) : null,
    opaqueRemoteName: session.isEncrypted ? (session.opaqueRemoteName ?? session.fileName) : null,
    encryptedSizeBytes: session.isEncrypted ? (session.encryptedSizeBytes ?? session.totalBytes) : null,
  };
}
async function resolveUploadSessionForRequest(req: any, sessionId: string): Promise<{ session: any | null; accessDenied: boolean }> {
  const session = await req.db.collection('upload_sessions').findOne({ sessionId });
  if (!session) return { session: null, accessDenied: false };
  if (!req.isAdmin && String(session.userId || '') !== String(req.userId || '')) {
    return { session: null, accessDenied: true };
  }
  return { session, accessDenied: false };
}
async function expireUploadSessionIfNeeded(sessions: any, session: any) {
  if (session.status === 'completed' && session.completedAt && Date.now() - new Date(session.completedAt).getTime() > COMPLETED_SESSION_TTL_MS) { await sessions.deleteOne({ sessionId: session.sessionId, status: 'completed' }); session.status = 'retained-expired'; }
  if ((session.status === 'active' || session.status === 'paused') && new Date(session.expiresAt || (new Date(session.createdAt).getTime() + UPLOAD_SESSION_TTL_MS)).getTime() <= Date.now()) {
    await sessions.updateOne({ sessionId: session.sessionId, status: { $in: ['active', 'paused'] } }, { $set: { status: 'expired', updatedAt: new Date() } });
    session.status = 'expired';
    if (session.tempPath && fs.existsSync(session.tempPath)) { try { fs.unlinkSync(session.tempPath); } catch { /* janitor will retry */ } }
  }
  return session;
}
app.post('/api/upload-sessions/:accountId', requireAuth, async (req: any, res: any) => {
  const { accountId } = req.params;
  const {
    fileName,
    mimeType = 'application/octet-stream',
    size: rawSize,
    totalBytes,
    folderId = 'root',
    checksum,
    idempotencyKey: rawIdempotencyKey,
    providerType: requestedProviderType,
    desiredChunkSize: rawDesiredChunkSize,
    chunkSize: rawChunkSize,
    isEncrypted,
    encryptionFormatVersion,
    encryptionKeyId,
    encryptedMetadata,
    opaqueRemoteName,
    encryptedSizeBytes,
  } = req.body || {};
  const size = rawSize ?? totalBytes;
  const desiredChunkSize = rawDesiredChunkSize ?? rawChunkSize;
  const idempotencyKey = rawIdempotencyKey || req.header('Idempotency-Key') || req.header('X-Idempotency-Key');

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    return apiError(res, 400, 'INVALID_UPLOAD_SESSION', 'fileName, size, and idempotencyKey are required', req.requestId);
  }

  const { account, accessDenied } = await findUploadAccount(req, accountId);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);

  const resolvedProviderType = transferProviderType(account.accountType);
  if (!resolvedProviderType) return apiError(res, 422, 'UNSUPPORTED_PROVIDER_OPERATION', `Provider '${String(account.accountType || 'unknown')}' cannot upload`, req.requestId);
  if (requestedProviderType && transferProviderType(requestedProviderType) !== resolvedProviderType) {
    return apiError(res, 409, 'ACCOUNT_PROVIDER_MISMATCH', 'Requested provider does not match the selected account', req.requestId);
  }

  const validation = validateUploadRequest({
    fileName,
    mimeType,
    size,
    folderId,
    checksum,
    isEncrypted,
    encryptionFormatVersion,
    encryptionKeyId,
    encryptedMetadata,
    opaqueRemoteName,
    encryptedSizeBytes,
  });
  if (!validation.ok) {
    return apiError(res, validation.error.status, validation.error.code, validation.error.message, req.requestId);
  }
  const spec = validation.spec;

  if (!hasTempDiskHeadroom(spec.size)) {
    return apiError(res, 507, 'INSUFFICIENT_STORAGE', 'Server temporary storage is too low for this upload', req.requestId);
  }

  const sessions = req.db.collection('upload_sessions');
  const existing = await sessions.findOne({ userId: String(req.userId || ''), accountId, idempotencyKey, status: { $in: ['active', 'paused', 'completed', 'completing'] } });
  if (existing) {
    await expireUploadSessionIfNeeded(sessions, existing);
    if (existing.status !== 'expired' && existing.status !== 'retained-expired') {
      if (
        existing.totalBytes !== spec.size ||
        existing.fileName !== spec.fileName ||
        Boolean(existing.isEncrypted) !== spec.isEncrypted ||
        (existing.checksum && spec.checksum && existing.checksum !== spec.checksum) ||
        (spec.isEncrypted && existing.encryptionKeyId !== spec.encryptionKeyId)
      ) {
        return apiError(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key is already bound to different upload metadata', req.requestId);
      }
      return res.json(publicUploadSession(existing));
    }
  }

  if (!req.isAdmin && req.userId && MAX_DAILY_UPLOAD_BYTES_PER_USER > 0) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentSessions = await sessions.find({
      userId: String(req.userId),
      createdAt: { $gt: dayAgo },
      status: { $in: ['active', 'paused', 'completing', 'completed'] },
    }).toArray();
    const usedToday = recentSessions.reduce((sum: number, s: any) => sum + (Number(s.totalBytes) || 0), 0);
    if (usedToday + spec.size > MAX_DAILY_UPLOAD_BYTES_PER_USER) {
      return apiError(res, 429, STANDARD_ERROR_CODES.RATE_LIMITED, 'Daily upload byte quota exceeded for this user', req.requestId, true);
    }
  }

  const requestedChunk = Number(desiredChunkSize);
  const chunkSize = Number.isFinite(requestedChunk) && requestedChunk > 0 ? Math.max(256 * 1024, Math.min(16 * 1024 * 1024, requestedChunk)) : 8 * 1024 * 1024;
  const session = {
    sessionId: uploadSessionId(),
    userId: String(req.userId || ''),
    accountId,
    folderId: spec.folderId,
    fileName: spec.fileName,
    mimeType: spec.mimeType,
    totalBytes: spec.size,
    receivedBytes: 0,
    chunkSize,
    checksum: spec.checksum,
    idempotencyKey,
    providerType: resolvedProviderType,
    providerSession: null,
    providerMetadata: req.body.providerMetadata || null,
    isEncrypted: spec.isEncrypted,
    encryptionFormatVersion: spec.encryptionFormatVersion,
    encryptionKeyId: spec.encryptionKeyId,
    encryptedMetadata: spec.encryptedMetadata,
    opaqueRemoteName: spec.opaqueRemoteName,
    encryptedSizeBytes: spec.encryptedSizeBytes,
    committedChunks: [],
    expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MS),
    providerResumable: resolvedProviderType !== 'telegram',
    providerCancellable: resolvedProviderType === 'onedrive',
    tempPath: path.join(TEMP_DIR, `transfer_${nanoid(18)}.part`),
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await sessions.insertOne(session);
  if (session.totalBytes === 0) {
    fs.mkdirSync(path.dirname(session.tempPath), { recursive: true });
    fs.writeFileSync(session.tempPath, Buffer.alloc(0));
  }
  return res.status(201).json(publicUploadSession(session));
});
app.get('/api/upload-sessions/:sessionId', requireAuth, async (req: any, res: any) => {
  const sessions = req.db.collection('upload_sessions');
  const { session, accessDenied } = await resolveUploadSessionForRequest(req, req.params.sessionId);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this upload session', req.requestId);
  if (!session) return apiError(res, 404, 'UPLOAD_SESSION_NOT_FOUND', 'Upload session not found', req.requestId);
  await expireUploadSessionIfNeeded(sessions, session);
  return res.json(publicUploadSession(session));
});
app.post('/api/upload-sessions/:sessionId/pause', requireAuth, async (req: any, res: any) => withSessionLock(req.params.sessionId, async () => {
  const sessions = req.db.collection('upload_sessions');
  const { session, accessDenied } = await resolveUploadSessionForRequest(req, req.params.sessionId);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this upload session', req.requestId);
  if (!session) return apiError(res, 404, 'UPLOAD_SESSION_NOT_FOUND', 'Upload session not found', req.requestId);
  await expireUploadSessionIfNeeded(sessions, session);
  if (session.status === 'paused') return res.json(publicUploadSession(session));
  if (session.status !== 'active') {
    return apiError(res, 409, 'UPLOAD_SESSION_NOT_ACTIVE', `Cannot pause upload session in '${session.status}' status`, req.requestId);
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + UPLOAD_SESSION_TTL_MS);
  await sessions.updateOne(
    { sessionId: session.sessionId, status: 'active' },
    { $set: { status: 'paused', expiresAt, updatedAt: now }, $unset: { chunkLeaseOwner: '', chunkLeaseExpiresAt: '' } }
  );
  session.status = 'paused';
  session.expiresAt = expiresAt;
  return res.json(publicUploadSession(session));
}));
app.post('/api/upload-sessions/:sessionId/resume', requireAuth, async (req: any, res: any) => withSessionLock(req.params.sessionId, async () => {
  const sessions = req.db.collection('upload_sessions');
  const { session, accessDenied } = await resolveUploadSessionForRequest(req, req.params.sessionId);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this upload session', req.requestId);
  if (!session) return apiError(res, 404, 'UPLOAD_SESSION_NOT_FOUND', 'Upload session not found', req.requestId);
  await expireUploadSessionIfNeeded(sessions, session);
  if (session.status === 'active') return res.json(publicUploadSession(session));
  if (session.status !== 'paused') {
    return apiError(res, 409, 'UPLOAD_SESSION_NOT_PAUSED', `Cannot resume upload session in '${session.status}' status`, req.requestId);
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + UPLOAD_SESSION_TTL_MS);
  await sessions.updateOne(
    { sessionId: session.sessionId, status: 'paused' },
    { $set: { status: 'active', expiresAt, updatedAt: now } }
  );
  session.status = 'active';
  session.expiresAt = expiresAt;
  return res.json(publicUploadSession(session));
}));
app.put('/api/upload-sessions/:sessionId/chunks', requireAuth, upload.single('chunk'), async (req: any, res: any) => withSessionLock(req.params.sessionId, async () => {
  const sessions = req.db.collection('upload_sessions');
  const { session, accessDenied } = await resolveUploadSessionForRequest(req, req.params.sessionId);
  const chunk = req.file;
  const contentType = String(req.header('Content-Type') || '').toLowerCase();
  const contentLengthHeader = Number(req.header('Content-Length') || 0);
  const isRawStream = !chunk && !contentType.includes('multipart/form-data') && Number.isFinite(contentLengthHeader) && contentLengthHeader > 0;
  const cleanupChunk = async () => {
    if (chunk?.path) {
      try { await fs.promises.unlink(chunk.path); } catch { /* ignore */ }
    }
  };
  req.on('aborted', () => { cleanupChunk().catch(() => {}); });
  if (accessDenied) {
    await cleanupChunk();
    return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this upload session', req.requestId);
  }
  if (!session) {
    await cleanupChunk();
    return apiError(res, 404, 'UPLOAD_SESSION_NOT_FOUND', 'Upload session not found', req.requestId);
  }
  await expireUploadSessionIfNeeded(sessions, session);
  if (session.status === 'expired') {
    await cleanupChunk();
    return apiError(res, 410, 'UPLOAD_SESSION_EXPIRED', 'Upload session expired', req.requestId, true);
  }
  if (session.status !== 'active') {
    await cleanupChunk();
    return apiError(res, 409, 'UPLOAD_SESSION_NOT_ACTIVE', `Upload session is ${session.status}`, req.requestId);
  }
  if (!chunk && !isRawStream) return apiError(res, 400, 'NO_CHUNK_UPLOADED', 'No chunk uploaded', req.requestId);
  const slot = acquireUserUploadSlot(String(req.userId || session.userId || 'anonymous'));
  if (!slot.ok) {
    await cleanupChunk();
    return apiError(res, 429, STANDARD_ERROR_CODES.RATE_LIMITED, slot.reason || 'Too many concurrent uploads', req.requestId, true);
  }
  const range = String(req.header('Content-Range') || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  const offsetHeaderOrBody = req.header('X-Chunk-Offset') ?? req.body?.offset;
  const start = range ? Number(range[1]) : Number(offsetHeaderOrBody);
  const incomingChunkSize = chunk ? chunk.size : (range ? (Number(range[2]) - Number(range[1]) + 1) : contentLengthHeader);
  const end = range ? Number(range[2]) : start + incomingChunkSize - 1;
  const total = range ? Number(range[3]) : session.totalBytes;
  let chunkLockOwner: string | null = null;
  try {
    if (!Number.isFinite(start) || !Number.isFinite(incomingChunkSize) || incomingChunkSize <= 0 || end < start || total !== session.totalBytes || end - start + 1 !== incomingChunkSize) {
      return apiError(res, 400, 'INVALID_CONTENT_RANGE', 'Content-Range does not match the uploaded chunk', req.requestId);
    }
    // Exact replay after a lost response is acknowledged only when streamed SHA-256 matches committed slice.
    if (start < session.receivedBytes) {
      let existingSize = -1;
      try { existingSize = (await fs.promises.stat(session.tempPath)).size; } catch { existingSize = -1; }
      if (end >= session.receivedBytes || existingSize < end + 1) {
        return apiError(res, 409, 'UPLOAD_SESSION_OFFSET_CONFLICT', `Expected offset ${session.receivedBytes}`, req.requestId);
      }
      const committed = (session.committedChunks || []).find((item: any) => item.offset === start && item.length === incomingChunkSize);
      if (!committed) return apiError(res, 409, 'UPLOAD_SESSION_OFFSET_CONFLICT', 'Repeated chunk does not match any committed range', req.requestId);
      const [incomingDigest, existingRangeDigest] = await Promise.all([
        chunk
          ? computeFileSha256(chunk.path)
          : (async () => {
              const h = crypto.createHash('sha256');
              let bytesRead = 0;
              for await (const buf of req) {
                bytesRead += buf.length;
                if (bytesRead > incomingChunkSize) break;
                h.update(buf);
              }
              return bytesRead === incomingChunkSize ? h.digest('hex') : '';
            })(),
        (async () => {
          const h = crypto.createHash('sha256');
          for await (const buf of fs.createReadStream(session.tempPath, { start, end, highWaterMark: 256 * 1024 })) h.update(buf);
          return h.digest('hex');
        })(),
      ]);
      if (committed.checksum !== incomingDigest || existingRangeDigest !== incomingDigest) {
        return apiError(res, 409, 'UPLOAD_SESSION_OFFSET_CONFLICT', 'Repeated chunk bytes differ from the committed chunk', req.requestId);
      }
      return res.json({ sessionId: session.sessionId, receivedBytes: session.receivedBytes, totalBytes: session.totalBytes, nextOffset: session.receivedBytes, complete: session.receivedBytes === session.totalBytes });
    }
    if (start !== session.receivedBytes) return apiError(res, 409, 'UPLOAD_SESSION_OFFSET_CONFLICT', `Expected offset ${session.receivedBytes}`, req.requestId);
    if (!hasTempDiskHeadroom(incomingChunkSize)) return apiError(res, 507, 'INSUFFICIENT_STORAGE', 'Server temporary storage is too low', req.requestId);
    chunkLockOwner = nanoid(16);
    const acquired = await sessions.updateOne({
      sessionId: session.sessionId, userId: String(session.userId || ''), status: 'active', receivedBytes: session.receivedBytes,
      $or: [{ chunkLeaseExpiresAt: { $exists: false } }, { chunkLeaseExpiresAt: { $lte: Date.now() } }]
    }, { $set: { chunkLeaseOwner: chunkLockOwner, chunkLeaseExpiresAt: Date.now() + 2 * 60 * 1000 } });
    if (acquired.modifiedCount !== 1) return apiError(res, 409, 'UPLOAD_SESSION_OFFSET_CONFLICT', 'Another chunk write is in progress', req.requestId);
    await fs.promises.mkdir(path.dirname(session.tempPath), { recursive: true });
    let existingSize = 0;
    try { existingSize = (await fs.promises.stat(session.tempPath)).size; } catch { existingSize = 0; }
    if (existingSize < session.receivedBytes) return apiError(res, 500, 'UPLOAD_STORAGE_CORRUPT', 'Staged file is shorter than its committed offset', req.requestId);
    if (existingSize > session.receivedBytes) await fs.promises.truncate(session.tempPath, session.receivedBytes);

    const chunkHash = crypto.createHash('sha256');
    let streamedBytes = 0;
    const appendStream = fs.createWriteStream(session.tempPath, { flags: 'a', highWaterMark: 256 * 1024 });
    if (chunk) {
      const readChunk = fs.createReadStream(chunk.path, { highWaterMark: 256 * 1024 });
      readChunk.on('data', (buf: Buffer) => {
        streamedBytes += buf.length;
        chunkHash.update(buf);
      });
      await stream.promises.pipeline(readChunk, appendStream);
    } else {
      const countAndHashTransform = new stream.Transform({
        transform(buf: Buffer, _enc, cb) {
          streamedBytes += buf.length;
          if (streamedBytes > incomingChunkSize) {
            cb(new Error('Chunk stream exceeded declared length'));
            return;
          }
          chunkHash.update(buf);
          cb(null, buf);
        },
      });
      await stream.promises.pipeline(req, countAndHashTransform, appendStream);
    }
    if (streamedBytes !== incomingChunkSize) {
      await fs.promises.truncate(session.tempPath, session.receivedBytes);
      return apiError(res, 400, 'INVALID_CONTENT_RANGE', 'Uploaded chunk size did not match declared range', req.requestId);
    }

    const receivedBytes = session.receivedBytes + incomingChunkSize;
    const chunkChecksum = chunkHash.digest('hex');
    const committedChunks = [...(session.committedChunks || []), { offset: start, length: incomingChunkSize, checksum: chunkChecksum }];
    const now = new Date();
    const updated = await sessions.updateOne(
      { sessionId: session.sessionId, userId: String(session.userId || ''), status: 'active', receivedBytes: session.receivedBytes, chunkLeaseOwner: chunkLockOwner },
      {
        $set: {
          receivedBytes,
          committedChunks,
          expiresAt: new Date(now.getTime() + UPLOAD_SESSION_TTL_MS),
          updatedAt: now,
        },
        $unset: { chunkLeaseOwner: '', chunkLeaseExpiresAt: '' }
      }
    );
    if (updated.modifiedCount !== 1) return apiError(res, 409, 'UPLOAD_SESSION_OFFSET_CONFLICT', 'Upload session changed while writing this chunk', req.requestId);
    chunkLockOwner = null;
    return res.json({ sessionId: session.sessionId, receivedBytes, totalBytes: session.totalBytes, nextOffset: receivedBytes, complete: receivedBytes === session.totalBytes });
  } finally {
    if (chunkLockOwner) {
      try {
        if (session.tempPath) await fs.promises.truncate(session.tempPath, session.receivedBytes);
      } catch (rollbackError) {
        console.error(JSON.stringify({ event: 'upload_chunk_rollback_failed', sessionId: session.sessionId, correlationId: req.requestId, error: String(rollbackError) }));
      }
      await sessions.updateOne({ sessionId: session.sessionId, chunkLeaseOwner: chunkLockOwner }, { $unset: { chunkLeaseOwner: '', chunkLeaseExpiresAt: '' } });
    }
    await cleanupChunk();
    slot.release();
  }
}));
app.post('/api/upload-sessions/:sessionId/complete', requireAuth, async (req: any, res: any) => withSessionLock(req.params.sessionId, async () => {
  const sessions = req.db.collection('upload_sessions');
  const resolved = await resolveUploadSessionForRequest(req, req.params.sessionId);
  if (resolved.accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this upload session', req.requestId);
  let session = resolved.session;
  if (!session) return apiError(res, 404, 'UPLOAD_SESSION_NOT_FOUND', 'Upload session not found', req.requestId);
  await expireUploadSessionIfNeeded(sessions, session);
  if (session.status === 'completed') return res.json(session.finalResult || { success: true, sessionId: session.sessionId, checksum: session.checksum });
  if (session.status === 'expired') return apiError(res, 410, 'UPLOAD_SESSION_EXPIRED', 'Upload session expired', req.requestId, true);
  if (session.status !== 'active' && session.status !== 'completing') return apiError(res, 409, 'UPLOAD_SESSION_NOT_ACTIVE', `Upload session is ${session.status}`, req.requestId);
  if (session.status === 'completing' && Number(session.completionLeaseExpiresAt || 0) > Date.now()) {
    return apiError(res, 503, 'UPLOAD_COMPLETION_IN_PROGRESS', 'Provider upload is already in progress; retry after the lease expires', req.requestId);
  }
  if (session.receivedBytes !== session.totalBytes || !fs.existsSync(session.tempPath) || fs.statSync(session.tempPath).size !== session.totalBytes) {
    const incompleteCode = session.isEncrypted ? 'ENCRYPTED_UPLOAD_INCOMPLETE' : 'UPLOAD_INCOMPLETE';
    return apiError(res, 409, incompleteCode, 'Upload is incomplete', req.requestId);
  }
  const { account, accessDenied } = await findUploadAccount(req, session.accountId);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);
  const claimNow = Date.now();
  const claimed = await sessions.updateOne({
    sessionId: session.sessionId, userId: String(session.userId || ''),
    $or: [
      { status: 'active' },
      { status: 'completing', $or: [{ completionLeaseExpiresAt: { $lte: claimNow } }, { completionLeaseExpiresAt: { $exists: false } }] }
    ]
  }, { $set: { status: 'completing', completionLeaseExpiresAt: claimNow + PROVIDER_COMPLETION_LEASE_MS, updatedAt: new Date(claimNow) } });
  if (claimed.modifiedCount !== 1) {
    const rechecked = await resolveUploadSessionForRequest(req, session.sessionId);
    session = rechecked.session;
    if (session?.status === 'completed') return res.json(session.finalResult || { success: true, sessionId: session.sessionId, checksum: session.checksum });
    return apiError(res, 503, 'UPLOAD_COMPLETION_IN_PROGRESS', 'Upload completion is already in progress; retry shortly', req.requestId);
  }
  try {
    const checksum = await computeFileSha256(session.tempPath);
    if (session.checksum && session.checksum.toLowerCase() !== checksum) {
      await sessions.updateOne({ sessionId: session.sessionId, status: 'completing' }, { $set: { status: 'active', updatedAt: new Date() }, $unset: { completionLeaseExpiresAt: '' } });
      const mismatchCode = session.isEncrypted ? 'ENCRYPTED_CHECKSUM_MISMATCH' : 'CHECKSUM_MISMATCH';
      return apiError(res, 422, mismatchCode, 'Upload checksum does not match', req.requestId);
    }
    const encryptionSpec: ValidatedUploadSpec = {
      isEncrypted: Boolean(session.isEncrypted),
      fileName: session.fileName,
      mimeType: session.isEncrypted ? 'application/octet-stream' : session.mimeType,
      size: session.totalBytes,
      folderId: session.folderId || 'root',
      checksum: session.checksum || checksum,
      encryptionFormatVersion: session.isEncrypted ? (session.encryptionFormatVersion ?? 1) : null,
      encryptionKeyId: session.isEncrypted ? (session.encryptionKeyId ?? null) : null,
      encryptedMetadata: session.isEncrypted ? (session.encryptedMetadata ?? null) : null,
      opaqueRemoteName: session.isEncrypted ? (session.opaqueRemoteName ?? session.fileName) : null,
      encryptedSizeBytes: session.isEncrypted ? (session.encryptedSizeBytes ?? session.totalBytes) : null,
    };
    await uploadFileToProvider(
      account, session.accountId,
      { path: session.tempPath, size: session.totalBytes, originalname: session.fileName, mimetype: encryptionSpec.mimeType },
      session.folderId, session.providerSession,
      async (providerSession) => {
        const saved = await sessions.updateOne(
          { sessionId: session.sessionId, userId: String(session.userId || ''), status: 'completing' },
          { $set: { providerSession, providerType: session.providerType || transferProviderType(account.accountType), completionLeaseExpiresAt: Date.now() + PROVIDER_COMPLETION_LEASE_MS, updatedAt: new Date() } }
        );
        if (saved.modifiedCount !== 1) throw new Error('Upload session ownership/state changed while saving provider checkpoint');
      },
      session.idempotencyKey,
      encryptionSpec,
      String(session.userId || req.userId || '')
    );
    const finalPayload = {
      success: true,
      sessionId: session.sessionId,
      checksum,
      isEncrypted: Boolean(session.isEncrypted),
      encryptionFormatVersion: session.isEncrypted ? (session.encryptionFormatVersion ?? 1) : null,
      encryptionKeyId: session.isEncrypted ? (session.encryptionKeyId ?? null) : null,
      encryptedSizeBytes: session.isEncrypted ? session.totalBytes : null,
    };
    await sessions.updateOne({ sessionId: session.sessionId, status: 'completing' }, { $set: { status: 'completed', checksum, completedAt: new Date(), finalResult: finalPayload, updatedAt: new Date() }, $unset: { completionLeaseExpiresAt: '' } });
    systemMetrics.uploadsCompleted++;
    invalidateDriveCache(session.accountId);
    if (fs.existsSync(session.tempPath)) { try { fs.unlinkSync(session.tempPath); } catch { /* janitor will retry */ } }
    return res.json(finalPayload);
  } catch (err: any) {
    systemMetrics.uploadsFailed++;
    console.error('Resumable upload completion error:', err);
    await sessions.updateOne({ sessionId: session.sessionId, status: 'completing' }, { $set: { status: 'active', updatedAt: new Date() }, $unset: { completionLeaseExpiresAt: '' } });
    if (err?.code === 'UNSUPPORTED_PROVIDER_OPERATION') return apiError(res, 422, err.code, err.message, req.requestId);
    return apiError(res, 502, 'PROVIDER_UPLOAD_FAILED', 'Provider upload failed', req.requestId);
  }
}));
app.post('/api/upload-sessions/:sessionId/cancel', requireAuth, (req: any, _res: any, next: any) => {
  req.method = 'DELETE';
  req.url = `/api/upload-sessions/${encodeURIComponent(req.params.sessionId)}`;
  next();
});
app.delete('/api/upload-sessions/:sessionId', requireAuth, async (req: any, res: any) => withSessionLock(req.params.sessionId, async () => {
  const sessions = req.db.collection('upload_sessions');
  const { session, accessDenied } = await resolveUploadSessionForRequest(req, req.params.sessionId);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this upload session', req.requestId);
  if (!session) return res.status(204).end();
  if (session.status === 'completed') return apiError(res, 409, 'UPLOAD_ALREADY_COMPLETED', 'Completed upload cannot be cancelled', req.requestId);
  const completing = session.status === 'completing';
  const nativeOneDrive = session.providerSession?.providerType === 'onedrive' && session.providerSession.uploadUrl;
  if (completing && !nativeOneDrive) {
    return apiError(res, 409, 'PROVIDER_CANCELLATION_UNSUPPORTED', 'The active provider upload cannot be safely cancelled; it may finish or expire upstream', req.requestId);
  }
  const allowed = completing ? ['completing'] : ['active', 'paused', 'expired', 'cancelled'];
  const fenced = await sessions.updateOne({
    sessionId: session.sessionId, userId: String(session.userId || ''), status: { $in: allowed },
    $or: [{ chunkLeaseExpiresAt: { $exists: false } }, { chunkLeaseExpiresAt: { $lte: Date.now() } }]
  }, { $set: { status: 'cancelling', updatedAt: new Date() }, $unset: { completionLeaseExpiresAt: '', chunkLeaseOwner: '', chunkLeaseExpiresAt: '' } });
  if (fenced.matchedCount !== 1) return apiError(res, 409, 'UPLOAD_CANCELLATION_CONFLICT', 'Upload state changed before cancellation could be fenced', req.requestId);
  if (nativeOneDrive) {
    try {
      const abort = await axios.delete(session.providerSession.uploadUrl, { validateStatus: () => true });
      if (![200, 202, 204].includes(abort.status)) {
        await sessions.updateOne({ sessionId: session.sessionId, status: 'cancelling' }, { $set: { status: completing ? 'completing' : 'active', updatedAt: new Date() } });
        return apiError(res, 502, 'PROVIDER_CANCEL_FAILED', `OneDrive cancellation was not confirmed (${abort.status})`, req.requestId);
      }
    } catch (error: any) {
      await sessions.updateOne({ sessionId: session.sessionId, status: 'cancelling' }, { $set: { status: completing ? 'completing' : 'active', updatedAt: new Date() } });
      return apiError(res, 502, 'PROVIDER_CANCEL_FAILED', error?.message || 'OneDrive cancellation failed', req.requestId);
    }
  }
  await sessions.updateOne({ sessionId: session.sessionId, status: 'cancelling' }, { $set: { status: 'cancelled', updatedAt: new Date() } });
  if (session.tempPath && fs.existsSync(session.tempPath)) { try { fs.unlinkSync(session.tempPath); } catch { /* janitor will retry */ } }
  return res.status(204).end();
}));
// ─── 6. Upload ─────────────────────────────────────────────────────────────────
app.post('/api/upload/:accountId', requireAuth, upload.single('file'), async (req: any, res: any) => {
  const { accountId } = req.params;
  const body          = req.body || {};
  const file          = req.file;
  const userId        = req.userId;
  const database      = req.db;

  if (!file) return apiError(res, 400, 'NO_FILE_UPLOADED', 'No file uploaded', req.requestId);

  const cleanupTemp = () => {
    if (file?.path && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    }
  };
  req.on('aborted', cleanupTemp);

  if (!hasTempDiskHeadroom(file.size)) {
    cleanupTemp();
    return apiError(res, 507, 'INSUFFICIENT_STORAGE', 'Server temporary storage is too low for this upload', req.requestId);
  }

  const slot = acquireUserUploadSlot(String(userId || 'anonymous'));
  if (!slot.ok) {
    cleanupTemp();
    return apiError(res, 429, STANDARD_ERROR_CODES.RATE_LIMITED, slot.reason || 'Too many concurrent uploads', req.requestId, true);
  }

  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, userId, req.isAdmin);
  if (accessDenied) {
    cleanupTemp();
    slot.release();
    return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  }
  if (!account) {
    cleanupTemp();
    slot.release();
    return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);
  }

  const queryFolderId = typeof req.query?.folderId === 'string' ? req.query.folderId : undefined;
  const headerChecksum = typeof req.header('x-file-checksum') === 'string' ? req.header('x-file-checksum') : undefined;
  const headerIdempotencyKey = typeof req.header('idempotency-key') === 'string' && req.header('idempotency-key').trim()
    ? req.header('idempotency-key').trim()
    : undefined;
  const effectiveFolderId = body.folderId || body.parentId || queryFolderId || 'root';
  const effectiveChecksum = body.checksum || body.encryptedChecksum || headerChecksum;
  const effectiveIdempotencyKey = (typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim())
    ? body.idempotencyKey.trim()
    : headerIdempotencyKey;

  const validation = validateUploadRequest({
    fileName: body.fileName || file.originalname,
    mimeType: body.mimeType || file.mimetype,
    size: file.size,
    folderId: effectiveFolderId,
    checksum: effectiveChecksum,
    isEncrypted: body.isEncrypted,
    encryptionFormatVersion: body.encryptionFormatVersion,
    encryptionKeyId: body.encryptionKeyId,
    encryptedMetadata: body.encryptedMetadata,
    opaqueRemoteName: body.opaqueRemoteName,
    encryptedSizeBytes: body.encryptedSizeBytes !== undefined ? body.encryptedSizeBytes : (body.size !== undefined ? body.size : undefined),
  });
  if (!validation.ok) {
    cleanupTemp();
    slot.release();
    return apiError(res, validation.error.status, validation.error.code, validation.error.message, req.requestId);
  }
  const spec = validation.spec;

  try {
    if (spec.checksum) {
      const actualHash = await computeFileSha256(file.path);
      if (actualHash !== spec.checksum.toLowerCase()) {
        cleanupTemp();
        const mismatchCode = spec.isEncrypted ? 'ENCRYPTED_CHECKSUM_MISMATCH' : 'CHECKSUM_MISMATCH';
        return apiError(res, 422, mismatchCode, 'Uploaded file SHA-256 checksum does not match', req.requestId);
      }
    }

    const uploadResult: any = await uploadFileToProvider(
      account,
      accountId,
      {
        path: file.path,
        size: file.size,
        originalname: spec.fileName,
        mimetype: spec.mimeType,
      },
      spec.folderId,
      undefined,
      undefined,
      effectiveIdempotencyKey,
      spec,
      String(userId || account.userId || '')
    );
    systemMetrics.uploadsCompleted++;
    invalidateDriveCache(accountId);
    res.json({
      success: true,
      fileId: uploadResult?.id ? String(uploadResult.id) : (uploadResult?._id ? String(uploadResult._id) : null),
      isEncrypted: spec.isEncrypted,
      encryptionFormatVersion: spec.encryptionFormatVersion,
      encryptionKeyId: spec.encryptionKeyId,
      encryptedChecksum: spec.isEncrypted ? spec.checksum : null,
      encryptedSizeBytes: spec.isEncrypted ? spec.size : null,
    });
  } catch (err: any) {
    systemMetrics.uploadsFailed++;
    console.error('Upload error:', err);
    if (err?.code === 'UNSUPPORTED_PROVIDER_OPERATION') return apiError(res, 422, err.code, err.message, req.requestId);
    apiError(res, 502, 'PROVIDER_UPLOAD_FAILED', 'Provider upload failed', req.requestId);
  } finally {
    slot.release();
    cleanupTemp();
  }
});

app.get('/api/media-link/:accountId/:fileId', requireAuth, async (req: any, res: any) => {
  const { accountId, fileId } = req.params;
  const database = req.db;
  if (!isSafeProviderItemId(fileId)) {
    return apiError(res, 400, 'BAD_REQUEST', 'Invalid file identifier', req.requestId);
  }
  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, req.userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);

  const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, account, fileId, req.userId, req.isAdmin);
  if (fileDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this file', req.requestId);
  if (account.accountType === 'tgdrive' && !meta) {
    return apiError(res, 404, 'NOT_FOUND', 'File not found', req.requestId);
  }
  if (meta?.isEncrypted === true) {
    return apiError(res, 409, 'ENCRYPTED_PREVIEW_UNAVAILABLE', 'Encrypted media link is not available', req.requestId);
  }

  const expiresAt = Date.now() + 10 * 60 * 1000;
  const sig = signMediaRequest(accountId, fileId, expiresAt);
  const envBase = (process.env.APP_URL || '').replace(/\/$/, '');
  const reqHost = req.get('host');
  const resolvedBaseUrl = envBase || (reqHost ? `${req.protocol}://${reqHost}` : '');
  res.json({ url: `${resolvedBaseUrl}/api/download/${encodeURIComponent(accountId)}/${encodeURIComponent(fileId)}?exp=${expiresAt}&sig=${encodeURIComponent(sig)}`, expiresAt });
});

// ─── 4. Download (authed) ─────────────────────────────────────────────────────
async function handleDownloadRequest(req: any, res: any, isHead = false) {
  const { accountId, fileId } = req.params;
  const userId                = req.userId;
  const database              = req.db || db || await connectToMongo();

  if (!isSafeProviderItemId(fileId)) {
    return res.status(400).send('Invalid file identifier');
  }

  let downloadSlot = { ok: true, release: () => {} };
  if (!isHead) {
    downloadSlot = acquireUserDownloadSlot(String(userId || req.ip || 'anonymous'));
    if (!downloadSlot.ok) {
      return apiError(res, 429, STANDARD_ERROR_CODES.RATE_LIMITED, 'Too many concurrent downloads for this user', req.requestId, true);
    }
    res.once('close', downloadSlot.release);
    res.once('finish', downloadSlot.release);
  }

  try {
    let account: any = null;
    const isSigned = Boolean(req.mediaSigned || req.isSignedMedia);
    if (isSigned) {
      if (!ObjectId.isValid(accountId)) return res.status(400).send('Invalid account identifier');
      account = await database.collection('accounts').findOne({ _id: new ObjectId(accountId) });
    } else {
      const resolved = await resolveAuthorizedAccount(database, accountId, userId, req.isAdmin);
      if (resolved.accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
      account = resolved.account;
    }
    if (!account) return res.status(404).send('Account not found');

    const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, account, fileId, userId, req.isAdmin || isSigned);
    if (fileDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this file', req.requestId);

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', (req.query.preview === '1' && !meta?.isEncrypted) ? 'private, max-age=86400' : 'private, no-cache');
    const dispositionType = (meta?.isEncrypted === true) ? 'attachment' : (req.query.preview === '1' ? 'inline' : 'attachment');

    if (account.accountType === 'tgdrive') {
      if (!meta) return res.status(404).send('File not found');

      const etag = meta.isEncrypted && meta.encryptedChecksum
        ? `"${meta.encryptedChecksum}"`
        : `"${meta._id}-${meta.size}"`;
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      const downloadName = meta.isEncrypted ? (meta.opaqueRemoteName || meta.name) : meta.name;
      res.setHeader('Content-Disposition', `${dispositionType}; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
      if (isHead) {
        res.setHeader('Content-Type', meta.isEncrypted ? 'application/octet-stream' : (meta.mimeType || 'application/octet-stream'));
        const tgSize = meta.isEncrypted ? Number(meta.encryptedSizeBytes ?? meta.size ?? 0) : Number(meta.size || 0);
        if (tgSize) res.setHeader('Content-Length', tgSize);
        return res.status(200).end();
      }
      await tgStreamFile(meta.messageId, account.channelId, req, res, meta);
      return;
    }

    if (account.accountType === 'onedrive') {
      const c    = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
      const item = await c.api(`/me/drive/items/${fileId}`).get();
      const dlUrl = item['@microsoft.graph.downloadUrl'];
      if (!dlUrl) return res.status(404).send('Download link not available');

      const isEncrypted = meta?.isEncrypted === true;
      const downloadName = isEncrypted ? (meta.opaqueRemoteName || item.name) : item.name;
      const odEtag = (isEncrypted && meta?.encryptedChecksum) ? `"${meta.encryptedChecksum}"` : `"${account._id}-${fileId}-${item.size || 0}"`;
      res.setHeader('ETag', odEtag);
      res.setHeader('Content-Disposition', `${dispositionType}; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
      res.setHeader('Content-Type', isEncrypted ? 'application/octet-stream' : (item.file?.mimeType || 'application/octet-stream'));
      if (isHead) {
        if (item.size) res.setHeader('Content-Length', item.size);
        return res.status(200).end();
      }
      const response = await axios.get(dlUrl, {
        responseType: 'stream',
        timeout: PROVIDER_API_TIMEOUT_MS,
        headers: req.headers.range ? { Range: req.headers.range } : undefined,
        validateStatus: (status: number) => status === 200 || status === 206 || status === 416
      });
      if (response.status === 416) {
        if (response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
        return res.status(416).end();
      }
      if (response.status === 206) res.status(206);
      for (const header of ['content-range', 'content-length', 'accept-ranges']) {
        if (response.headers[header]) res.setHeader(header, response.headers[header]);
      }
      pipeUpstreamWithAbort(response.data, req, res);
      return;
    }

    const drive    = await getDriveClient(account.tokens || account.credentials);
    const file     = await drive.files.get({ fileId, fields: 'name,mimeType,size' });
    const isEncrypted = meta?.isEncrypted === true;
    const fileName = isEncrypted ? (meta.opaqueRemoteName || file.data.name || 'file') : (file.data.name || 'file');
    const gdEtag = (isEncrypted && meta?.encryptedChecksum) ? `"${meta.encryptedChecksum}"` : `"${account._id}-${fileId}-${file.data.size || 0}"`;
    res.setHeader('ETag', gdEtag);
    res.setHeader('Content-Disposition', `${dispositionType}; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Content-Type', isEncrypted ? 'application/octet-stream' : (file.data.mimeType || 'application/octet-stream'));
    if (isHead) {
      if (file.data.size) res.setHeader('Content-Length', file.data.size);
      return res.status(200).end();
    }
    const response = await drive.files.get(
      { fileId, alt: 'media' },
      {
        responseType: 'stream',
        headers: req.headers.range ? { Range: req.headers.range } : undefined,
        validateStatus: (status: number) => status === 200 || status === 206 || status === 416
      } as any
    );
    if (response.status === 416) {
      const contentRange = response.headers?.['content-range'] || (file.data.size ? `bytes */${file.data.size}` : undefined);
      if (contentRange) res.setHeader('Content-Range', contentRange);
      return res.status(416).end();
    }
    if (response.status === 206) res.status(206);
    for (const header of ['content-range', 'content-length', 'accept-ranges']) {
      const value = response.headers?.[header];
      if (value) res.setHeader(header, value);
    }
    pipeUpstreamWithAbort(response.data, req, res);
  } catch (err: any) {
    downloadSlot.release();
    console.error('Download error:', err);
    if (!res.headersSent) res.status(500).send(err.message);
  }
}

app.head('/api/download/:accountId/:fileId', requireAuthOrSignedMedia, (req: any, res: any) => handleDownloadRequest(req, res, true));
app.get('/api/download/:accountId/:fileId', requireAuthOrSignedMedia, (req: any, res: any) => handleDownloadRequest(req, res, false));

// ─── Share ────────────────────────────────────────────────────────────────────
app.post('/api/share', requireAuth, async (req: any, res: any) => {
  const { accountId, fileId } = req.body || {};
  const userId                = req.userId;
  const database              = req.db;

  if (!isSafeProviderItemId(fileId)) {
    return apiError(res, 400, 'BAD_REQUEST', 'Invalid file identifier', req.requestId);
  }

  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const envBase = (process.env.APP_URL || '').replace(/\/$/, '');
  const reqHost = req.get('host');
  const shareBase = envBase || (reqHost ? `${req.protocol}://${reqHost}` : '');

  try {
    const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, account, fileId, userId, req.isAdmin);
    if (fileDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this file', req.requestId);
    if (meta?.isEncrypted === true) {
      return apiError(res, 409, 'ENCRYPTED_SHARE_UNSUPPORTED', 'Encrypted file sharing is not supported', req.requestId);
    }

    if (account.accountType === 'tgdrive') {
      if (!meta) return res.status(404).json({ error: 'File not found' });
      let { shareId } = meta;
      if (!shareId) {
        shareId = nanoid(6);
        await database.collection('tg_files').updateOne({ _id: meta._id }, { $set: { shareId } });
      }
      return res.json({ success: true, shareUrl: `${shareBase}/s/${shareId}` });
    }

    const shareId = nanoid(6);
    await database.collection('shares').insertOne({ shareId, accountId: account._id, fileId, createdAt: new Date().toISOString() });
    res.json({ success: true, shareUrl: `${shareBase}/s/${shareId}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Move ────────────────────────────────────────────────────────────────────
app.post('/api/files/move', requireAuth, async (req: any, res: any) => {
  const { sourceAccountId, fileId, targetAccountId, targetFolderId } = req.body || {};
  const userId = req.userId;
  const database = req.db;

  if (!isSafeProviderItemId(fileId)) {
    return apiError(res, 400, 'BAD_REQUEST', 'Invalid file identifier', req.requestId);
  }
  const folderCheck = validateSafeFolderId(targetFolderId);
  if (!folderCheck.ok) {
    return apiError(res, folderCheck.error.status, folderCheck.error.code, folderCheck.error.message, req.requestId);
  }

  const { account: sourceAccount, accessDenied: sourceDenied } = await resolveAuthorizedAccount(database, sourceAccountId, userId, req.isAdmin);
  if (sourceDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to source account', req.requestId);
  if (!sourceAccount) return res.status(404).json({ error: 'Account not found' });

  const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, sourceAccount, fileId, userId, req.isAdmin);
  if (fileDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this file', req.requestId);

  if (sourceAccountId !== targetAccountId) {
    const { account: targetAccount, accessDenied: targetDenied } = await resolveAuthorizedAccount(database, targetAccountId, userId, req.isAdmin);
    if (targetDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to target account', req.requestId);
    if (!targetAccount) return res.status(404).json({ error: 'Target account not found' });

    if (req.query.async === 'true' || req.query.async === '1') {
      const job = await enqueueTransferJob(database, { sourceAccountId, fileId, targetAccountId, targetFolderId: folderCheck.folderId, userId: userId ? String(userId) : null, isAdmin: !!req.isAdmin, isMove: true });
      return res.status(202).json({ success: true, async: true, jobId: String(job._id), status: job.status });
    }
    try {
      await providerLimit(`transfer:${sourceAccountId}:${targetAccountId}`, 1)(() =>
        crossAccountTransfer(sourceAccountId, fileId, targetAccountId, folderCheck.folderId, userId, req.isAdmin, database, true)
      );
      invalidateDriveCache(sourceAccountId);
      invalidateDriveCache(targetAccountId);
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  }

  const account = sourceAccount;

  try {
    if (account.accountType === 'tgdrive') {
      if (!meta) return res.status(404).json({ error: 'File not found' });
      const realTargetId = folderCheck.folderId === 'root' ? '' : folderCheck.folderId;
      await database.collection('tg_files').updateOne(
        { _id: meta._id },
        { $set: { folder: realTargetId, updatedAt: new Date() } }
      );
      invalidateDriveCache(sourceAccountId);
      return res.json({ success: true });
    } else if (account.accountType === 'google') {
      const realTargetId = folderCheck.folderId || 'root';
      if (realTargetId !== 'root' && !isSafeProviderItemId(realTargetId)) {
        return apiError(res, 400, 'BAD_REQUEST', 'Invalid target folder identifier', req.requestId);
      }
      const drive = await getDriveClient(account.tokens || account.credentials);
      const file = await drive.files.get({ fileId, fields: 'parents' });
      const previousParents = file.data.parents?.join(',') || '';
      await drive.files.update({
        fileId,
        addParents: realTargetId,
        removeParents: previousParents,
        fields: 'id, parents'
      });
      if (meta) {
        await database.collection('tg_files').updateOne(
          { _id: meta._id },
          { $set: { folder: realTargetId === 'root' ? '' : realTargetId, updatedAt: new Date() } }
        );
      }
      invalidateDriveCache(sourceAccountId);
      return res.json({ success: true });
    } else if (account.accountType === 'onedrive') {
      const realTargetId = folderCheck.folderId || 'root';
      if (realTargetId !== 'root' && !isSafeProviderItemId(realTargetId)) {
        return apiError(res, 400, 'BAD_REQUEST', 'Invalid target folder identifier', req.requestId);
      }
      const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
      const resolvedParentId = realTargetId === 'root' ? (await c.api('/me/drive/root').get()).id : realTargetId;
      await c.api(`/me/drive/items/${fileId}`).patch({
        parentReference: { id: resolvedParentId }
      });
      if (meta) {
        await database.collection('tg_files').updateOne(
          { _id: meta._id },
          { $set: { folder: realTargetId === 'root' ? '' : realTargetId, updatedAt: new Date() } }
        );
      }
      invalidateDriveCache(sourceAccountId);
      return res.json({ success: true });
    }
    res.status(400).json({ error: 'Unsupported account type' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Copy file ────────────────────────────────────────────────────────────────
app.post('/api/files/copy', requireAuth, async (req: any, res: any) => {
  const { sourceAccountId, fileId, targetAccountId, targetFolderId } = req.body || {};
  const userId = req.userId;
  const database = req.db;

  if (!isSafeProviderItemId(fileId)) {
    return apiError(res, 400, 'BAD_REQUEST', 'Invalid file identifier', req.requestId);
  }
  const folderCheck = validateSafeFolderId(targetFolderId);
  if (!folderCheck.ok) {
    return apiError(res, folderCheck.error.status, folderCheck.error.code, folderCheck.error.message, req.requestId);
  }

  const { account: sourceAccount, accessDenied: sourceDenied } = await resolveAuthorizedAccount(database, sourceAccountId, userId, req.isAdmin);
  if (sourceDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to source account', req.requestId);
  if (!sourceAccount) return res.status(404).json({ error: 'Account not found' });

  const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, sourceAccount, fileId, userId, req.isAdmin);
  if (fileDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this file', req.requestId);

  if (sourceAccountId !== targetAccountId) {
    const { account: targetAccount, accessDenied: targetDenied } = await resolveAuthorizedAccount(database, targetAccountId, userId, req.isAdmin);
    if (targetDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to target account', req.requestId);
    if (!targetAccount) return res.status(404).json({ error: 'Target account not found' });

    if (req.query.async === 'true' || req.query.async === '1') {
      const job = await enqueueTransferJob(database, { sourceAccountId, fileId, targetAccountId, targetFolderId: folderCheck.folderId, userId: userId ? String(userId) : null, isAdmin: !!req.isAdmin, isMove: false });
      return res.status(202).json({ success: true, async: true, jobId: String(job._id), status: job.status });
    }
    try {
      await providerLimit(`transfer:${sourceAccountId}:${targetAccountId}`, 1)(() =>
        crossAccountTransfer(sourceAccountId, fileId, targetAccountId, folderCheck.folderId, userId, req.isAdmin, database, false)
      );
      invalidateDriveCache(sourceAccountId);
      invalidateDriveCache(targetAccountId);
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  }

  const account = sourceAccount;

  try {
    if (account.accountType === 'tgdrive') {
      if (!meta) return res.status(404).json({ error: 'File not found' });
      
      const realTargetId = folderCheck.folderId === 'root' ? '' : folderCheck.folderId;
      const now = new Date();
      const newMeta = { ...meta };
      delete newMeta._id;
      newMeta.folder = realTargetId;
      newMeta.date = Math.floor(Date.now() / 1000);
      newMeta.createdAt = now;
      newMeta.updatedAt = now;
      newMeta.shareId = meta.isEncrypted ? null : nanoid(6);
      
      if (!meta.isEncrypted && meta.folder === realTargetId) {
        newMeta.name = newMeta.name.replace(/(\.[^.]+)$|$/, ' - Copy$1');
      }

      await database.collection('tg_files').insertOne(newMeta);
      invalidateDriveCache(sourceAccountId);
      return res.json({ success: true });
    } else if (account.accountType === 'google') {
      const realTargetId = folderCheck.folderId || 'root';
      if (realTargetId !== 'root' && !isSafeProviderItemId(realTargetId)) {
        return apiError(res, 400, 'BAD_REQUEST', 'Invalid target folder identifier', req.requestId);
      }
      const drive = await getDriveClient(account.tokens || account.credentials);
      const copied = await drive.files.copy({
        fileId,
        requestBody: {
          parents: [realTargetId],
          ...(meta?.isEncrypted ? { name: meta.opaqueRemoteName || meta.name } : {})
        },
        fields: 'id,name'
      });
      if (meta?.isEncrypted && copied?.data?.id) {
        const now = new Date();
        const clonedMeta = { ...meta };
        delete clonedMeta._id;
        clonedMeta.providerFileId = String(copied.data.id);
        clonedMeta.folder = realTargetId === 'root' ? '' : realTargetId;
        clonedMeta.date = Math.floor(Date.now() / 1000);
        clonedMeta.createdAt = now;
        clonedMeta.updatedAt = now;
        clonedMeta.shareId = null;
        await database.collection('tg_files').insertOne(clonedMeta);
      }
      invalidateDriveCache(sourceAccountId);
      return res.json({ success: true });
    } else if (account.accountType === 'onedrive') {
      const targetFolder = folderCheck.folderId || 'root';
      if (targetFolder !== 'root' && !isSafeProviderItemId(targetFolder)) {
        return apiError(res, 400, 'BAD_REQUEST', 'Invalid target folder identifier', req.requestId);
      }
      const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
      let realTargetId = targetFolder;
      if (targetFolder === 'root') {
        const rootRes = await c.api('/me/drive/root').get();
        realTargetId = rootRes.id;
      }
      const copyRes = await c.api(`/me/drive/items/${fileId}/copy`).post({
        parentReference: { id: realTargetId },
        ...(meta?.isEncrypted ? { name: meta.opaqueRemoteName || meta.name } : {})
      });
      if (meta?.isEncrypted) {
        const now = new Date();
        const clonedMeta = { ...meta };
        delete clonedMeta._id;
        const copiedId = copyRes?.id || copyRes?.data?.id;
        if (copiedId) clonedMeta.providerFileId = String(copiedId);
        clonedMeta.folder = targetFolder === 'root' ? '' : targetFolder;
        clonedMeta.date = Math.floor(Date.now() / 1000);
        clonedMeta.createdAt = now;
        clonedMeta.updatedAt = now;
        clonedMeta.shareId = null;
        await database.collection('tg_files').insertOne(clonedMeta);
      }
      invalidateDriveCache(sourceAccountId);
      return res.json({ success: true });
    }
    res.status(400).json({ error: 'Unsupported account type' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Public download (no auth) ────────────────────────────────────────────────
app.get('/api/public/download/:shareId', async (req: any, res: any) => {
  const { shareId } = req.params;
  const database    = db || await connectToMongo();

  if (typeof shareId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(shareId)) {
    return res.status(400).send('Invalid share link');
  }

  try {
    res.setHeader('Accept-Ranges', 'bytes');

    // Check TG Drive files first
    const tgMeta = await database.collection('tg_files').findOne({ shareId });
    if (tgMeta) {
      if (tgMeta.isEncrypted === true) {
        return apiError(res, 409, 'ENCRYPTED_SHARE_UNSUPPORTED', 'Encrypted file sharing is not supported', req.requestId);
      }
      const account = await database.collection('accounts').findOne({ _id: tgMeta.accountId });
      if (!account) return res.status(404).send('Account disconnected');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(tgMeta.name)}`);
      res.setHeader('Content-Type', tgMeta.mimeType || 'application/octet-stream');
      await tgStreamFile(tgMeta.messageId, account.channelId, req, res, tgMeta);
      return;
    }

    // Fallback to cloud shares
    const share   = await database.collection('shares').findOne({ shareId });
    if (!share) return res.status(404).send('Share link expired');
    if (!isSafeProviderItemId(String(share.fileId))) return res.status(400).send('Invalid shared file');
    const account = await database.collection('accounts').findOne({ _id: share.accountId });
    if (!account) return res.status(404).send('Account disconnected');

    const { meta } = await resolveFileMetadataForAccount(database, account, String(share.fileId), null, true);
    if (meta?.isEncrypted === true) {
      return apiError(res, 409, 'ENCRYPTED_SHARE_UNSUPPORTED', 'Encrypted file sharing is not supported', req.requestId);
    }

    if (account.accountType === 'onedrive') {
      const c    = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
      const item = await c.api(`/me/drive/items/${share.fileId}`).get();
      const dlUrl = item['@microsoft.graph.downloadUrl'];
      if (!dlUrl) return res.status(404).send('Download link not available');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`);
      res.setHeader('Content-Type', item.file?.mimeType || 'application/octet-stream');
      const r = await axios.get(dlUrl, { responseType: 'stream', headers: req.headers.range ? { Range: req.headers.range } : undefined, validateStatus: (status: number) => status === 200 || status === 206 });
      if (r.status === 206) res.status(206);
      for (const header of ['content-range', 'content-length', 'accept-ranges']) if (r.headers[header]) res.setHeader(header, r.headers[header]);
      pipeUpstreamWithAbort(r.data, req, res);
      return;
    }

    const drive    = await getDriveClient(account.tokens || account.credentials);
    const file     = await drive.files.get({ fileId: share.fileId, fields: 'name,mimeType' });
    const fileName = file.data.name || 'file';
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Content-Type', file.data.mimeType || 'application/octet-stream');
    const response = await drive.files.get({ fileId: share.fileId, alt: 'media' }, { responseType: 'stream', headers: req.headers.range ? { Range: req.headers.range } : undefined });
    if (response.status === 206) res.status(206);
    for (const header of ['content-range', 'content-length', 'accept-ranges']) { const value = response.headers?.[header]; if (value) res.setHeader(header, value); }
    pipeUpstreamWithAbort(response.data, req, res);
  } catch {
    if (!res.headersSent) res.status(500).send('Download failed');
  }
});

// ─── Public share page ────────────────────────────────────────────────────────
app.get('/s/:shareId', async (req: any, res: any) => {
  const { shareId } = req.params;
  const database    = db || await connectToMongo();

  if (typeof shareId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(shareId)) {
    return res.status(400).send('Invalid share link');
  }
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline' https://cdn.tailwindcss.com; script-src https://cdn.tailwindcss.com; img-src 'self' https: data:; frame-ancestors 'none'; base-uri 'none'");

  try {
    const tgMeta = await database.collection('tg_files').findOne({ shareId, trashed: { $ne: true } });
    if (tgMeta) {
      if (tgMeta.isEncrypted === true) {
        return apiError(res, 409, 'ENCRYPTED_SHARE_UNSUPPORTED', 'Encrypted file sharing is not supported', req.requestId);
      }
      const sizeMB = tgMeta.size ? (Number(tgMeta.size) / (1024 ** 2)).toFixed(2) + ' MB' : 'Unknown size';
      const isMedia = tgMeta.mimeType?.startsWith('image/') || tgMeta.mimeType?.startsWith('video/');
      const thumb = isMedia ? `/api/thumb/${tgMeta.accountId}/${tgMeta._id}?s=256` : null;
      return res.send(buildSharePage(tgMeta.name, sizeMB, tgMeta.mimeType || '', thumb, shareId, true));
    }

    const share = await database.collection('shares').findOne({ shareId });
    if (!share) return res.status(404).send('Share link expired or invalid');
    if (!isSafeProviderItemId(String(share.fileId))) return res.status(400).send('Invalid shared file');
    const account = await database.collection('accounts').findOne({ _id: share.accountId });
    if (!account) return res.status(404).send('Account disconnected');

    const { meta } = await resolveFileMetadataForAccount(database, account, String(share.fileId), null, true);
    if (meta?.isEncrypted === true) {
      return apiError(res, 409, 'ENCRYPTED_SHARE_UNSUPPORTED', 'Encrypted file sharing is not supported', req.requestId);
    }

    if (account.accountType === 'tgdrive') {
      if (!ObjectId.isValid(String(share.fileId))) return res.status(404).send('Share link expired or invalid');
      const tgDoc = await database.collection('tg_files').findOne({ _id: new ObjectId(String(share.fileId)), accountId: account._id, trashed: { $ne: true } });
      if (!tgDoc) return res.status(404).send('File no longer exists');
      const sizeMB = tgDoc.size ? (Number(tgDoc.size) / (1024 ** 2)).toFixed(2) + ' MB' : 'Unknown size';
      const isMedia = tgDoc.mimeType?.startsWith('image/') || tgDoc.mimeType?.startsWith('video/');
      const thumb = isMedia ? `/api/thumb/${tgDoc.accountId}/${tgDoc._id}?s=256` : null;
      return res.send(buildSharePage(tgDoc.name, sizeMB, tgDoc.mimeType || '', thumb, shareId, true));
    }

    if (account.accountType === 'onedrive') {
      const c    = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
      const item = await c.api(`/me/drive/items/${share.fileId}`).get();
      const sizeMB = item.size ? (Number(item.size) / (1024 ** 2)).toFixed(2) + ' MB' : 'Unknown size';
      return res.send(buildSharePage(item.name, sizeMB, item.file?.mimeType || '', null, shareId, false));
    }

    const drive  = await getDriveClient(account.tokens || account.credentials);
    const file   = await drive.files.get({ fileId: share.fileId, fields: 'name,mimeType,size,thumbnailLink' });
    const sizeMB = file.data.size ? (Number(file.data.size) / (1024 ** 2)).toFixed(2) + ' MB' : 'Unknown size';
    const thumb  = file.data.mimeType?.startsWith('image/') ? file.data.thumbnailLink?.replace('=s220', '=s1000') || null : null;
    return res.send(buildSharePage(file.data.name!, sizeMB, file.data.mimeType!, thumb, shareId, false));
  } catch {
    res.status(500).send('Error loading shared file');
  }
});

const escapeHTML = (str: string) => {
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m as keyof { '&': string; '<': string; '>': string; '"': string; "'": string }] || m);
};

function sanitizeThumbUrl(thumb: string | null): string | null {
  if (!thumb || typeof thumb !== 'string') return null;
  if (thumb.startsWith('/api/thumb/')) return thumb;
  try {
    const parsed = new URL(thumb);
    return parsed.protocol === 'https:' ? thumb : null;
  } catch {
    return null;
  }
}

function buildSharePage(name: string, size: string, mimeType: string, thumb: string | null, shareId: string, isTg: boolean) {
  const safeThumb = sanitizeThumbUrl(thumb);
  const safeShareId = encodeURIComponent(shareId);
  const icon = isTg
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="white"><path d="m20.303 2.38-18 7a.5.5 0 0 0 .076.953l4.382.972 1.818 5.454a.5.5 0 0 0 .844.157l2.425-2.888 4.854 3.56a.5.5 0 0 0 .784-.288L21 2.9a.5.5 0 0 0-.697-.52zm-1.19 1.71-9.452 9.2-2.113-6.337L19.113 4.09z"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M17.5 19.5h-11a3 3 0 0 1-3-3V6.5a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3Z"/><path d="M7.5 11h9"/><path d="M7.5 15h9"/><path d="M7.5 7h9"/></svg>`;
  return `
    <html>
      <head><title>${escapeHTML(name)} - Cloudyte Share</title><meta name="viewport" content="width=device-width, initial-scale=1"><script src="https://cdn.tailwindcss.com"></script></head>
      <body class="bg-slate-950 text-white flex items-center justify-center min-h-screen p-6 font-sans">
        <div class="max-w-lg w-full bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-2xl text-center space-y-6">
          <div class="w-20 h-20 bg-indigo-600 rounded-2xl flex items-center justify-center mx-auto shadow-lg shadow-indigo-500/20">${icon}</div>
          <div>
            <h1 class="text-2xl font-black truncate" title="${escapeHTML(name)}">${escapeHTML(name)}</h1>
            <p class="text-slate-500 font-bold uppercase tracking-widest text-[10px] mt-2">${escapeHTML(size)} • ${escapeHTML(mimeType || 'file')}</p>
            ${isTg ? '<p class="text-indigo-400 text-[10px] font-bold uppercase tracking-widest mt-1">📡 Telegram Storage</p>' : ''}
          </div>
          ${safeThumb ? `<img src="${escapeHTML(safeThumb)}" class="rounded-xl w-full aspect-video object-cover border border-slate-800" referrerPolicy="no-referrer" />` : ''}
          <a href="/api/public/download/${escapeHTML(safeShareId)}" class="block w-full bg-white text-black py-4 rounded-2xl font-black text-lg hover:bg-slate-100 transition-all active:scale-[0.98]">Download File</a>
          <p class="text-[10px] text-slate-600 font-bold uppercase tracking-widest">Shared via Cloudyte</p>
        </div>
      </body>
    </html>`;
}

// ─── OAuth routes (Google + Microsoft) ───────────────────────────────────────
const baseUrl     = (process.env.APP_URL || '').replace(/\/$/, '');
const redirectUri = `${baseUrl}/auth/google/callback`;
const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri);

async function createOAuthState(database: any, userId: string, provider: 'google' | 'microsoft') {
  const state = crypto.randomBytes(32).toString('base64url');
  const stateHash = crypto.createHash('sha256').update(state).digest('hex');
  await database.collection('oauth_states').insertOne({
    stateHash,
    userId: String(userId),
    provider,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return state;
}

async function consumeOAuthState(database: any, state: string, provider: 'google' | 'microsoft') {
  if (!state) return null;
  const stateHash = crypto.createHash('sha256').update(state).digest('hex');
  const result = await database.collection('oauth_states').findOneAndDelete({
    stateHash,
    provider,
    expiresAt: { $gt: new Date() },
  }) as any;
  return result?.value ?? result ?? null;
}

app.get('/api/auth/drive-link', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const userId = req.isAdmin && !req.userId ? 'admin' : String(req.userId || '');
  if (!userId) return res.status(401).json({ error: 'Authenticated user missing' });
  const state = await createOAuthState(database, userId, 'google');
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'], state, prompt: 'consent' });
  res.json({ url });
});

app.get('/auth/link', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const userId = req.isAdmin && !req.userId ? 'admin' : String(req.userId || '');
  if (!userId) return res.status(401).json({ error: 'Authenticated user missing' });
  const state = await createOAuthState(database, userId, 'google');
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'], state, prompt: 'consent' });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const database        = db || await connectToMongo();
  try {
    if (!code || typeof code !== 'string' || typeof state !== 'string' || !state.trim()) {
      return res.status(400).send('Invalid OAuth callback.');
    }
    const oauthState = await consumeOAuthState(database, state, 'google');
    const userId = oauthState?.userId ? String(oauthState.userId) : null;
    if (!userId) return res.status(401).send('OAuth session expired or invalid. Please try again.');
    if (userId !== 'admin') {
      const user = await database.collection('users').findOne({ _id: userId });
      if (!user || user.isActive === false) return res.status(401).send('OAuth user inactive or missing.');
    }
    const { tokens } = await oauth2Client.getToken(code);
    const authClient = new google.auth.OAuth2(); authClient.setCredentials(tokens);
    const about = await google.drive({ version: 'v3', auth: authClient }).about.get({ fields: 'user' });
    const ui    = about.data.user;
    if (database && ui) {
      await database.collection('accounts').updateOne(
        { userId: String(userId), email: ui.emailAddress },
        { $set: { tokens, linkedAt: new Date().toISOString(), name: ui.displayName, accountType: 'google' } },
        { upsert: true }
      );
    }
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    res.send(oauthSuccessPage('Google Drive'));
  } catch { res.status(500).send('Authentication failed'); }
});

app.get('/api/auth/onedrive-link', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const userId = req.isAdmin && !req.userId ? 'admin' : String(req.userId || '');
  if (!userId) return res.status(401).json({ error: 'Authenticated user missing' });
  const state = await createOAuthState(database, userId, 'microsoft');
  const url = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${MICROSOFT_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(MICROSOFT_REDIRECT_URI)}&response_mode=query&scope=${encodeURIComponent('files.readwrite.all User.Read offline_access')}&state=${encodeURIComponent(state)}&prompt=select_account`;
  res.json({ url });
});
app.get('/auth/microsoft/callback', async (req, res) => {
  const { code, state } = req.query;
  const database        = db || await connectToMongo();
  try {
    if (!code || typeof code !== 'string' || typeof state !== 'string' || !state.trim()) {
      return res.status(400).send('Invalid OAuth callback.');
    }
    const oauthState = await consumeOAuthState(database, state, 'microsoft');
    const userId = oauthState?.userId ? String(oauthState.userId) : null;
    if (!userId) return res.status(401).send('OAuth session expired or invalid. Please try again.');
    if (userId !== 'admin') {
      const user = await database.collection('users').findOne({ _id: userId });
      if (!user || user.isActive === false) return res.status(401).send('OAuth user inactive or missing.');
    }
    const r        = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', new URLSearchParams({ client_id: MICROSOFT_CLIENT_ID!, client_secret: MICROSOFT_CLIENT_SECRET!, code, redirect_uri: MICROSOFT_REDIRECT_URI, grant_type: 'authorization_code' }));
    const rawTokens = r.data;
    const tokens    = { ...rawTokens, expiry_date: Date.now() + Number(rawTokens.expires_in || 3600) * 1000 };
    const msc  = Client.init({ authProvider: (done) => done(null, tokens.access_token) });
    const user = await msc.api('/me').get();
    if (database && user) {
      await database.collection('accounts').updateOne(
        { userId: String(userId), email: user.userPrincipalName || user.mail },
        { $set: { tokens, linkedAt: new Date().toISOString(), name: user.displayName, accountType: 'onedrive' } },
        { upsert: true }
      );
    }
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    res.send(oauthSuccessPage('OneDrive'));
  } catch { res.status(500).send('Authentication failed'); }
});

function oauthSuccessPage(service: string) {
  return `<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;background:#f8fafc;margin:0"><div style="background:white;padding:2.5rem;border-radius:1.5rem;box-shadow:0 20px 25px -5px rgba(0,0,0,.1);text-align:center;max-width:400px;width:90%"><span style="font-size:32px">✅</span><h2 style="color:#1e1b4b;margin:.75rem 0;font-size:1.5rem">Success!</h2><p style="color:#64748b;margin-bottom:2rem">${escapeHTML(service)} linked to Cloudyte.</p><button onclick="window.close()" style="background:#4f46e5;color:white;border:none;padding:.75rem 2rem;border-radius:9999px;font-weight:600;cursor:pointer">Done</button></div><script>setTimeout(()=>window.close(),4000)</script></body></html>`;
}

// ─── Cross Account File Transfer & Batch Backup Helpers ───────────────────────
type TransferProgressInfo = {
  stage: string;
  bytesProcessed: number;
  totalBytes: number;
  progressPct: number;
};

type ConflictStrategy = 'overwrite' | 'rename' | 'skip' | 'error';

function buildConflictCopyName(originalName: string, index = 1): string {
  const extIdx = originalName.lastIndexOf('.');
  const suffix = index <= 1 ? ' (conflict copy)' : ` (conflict copy ${index})`;
  if (extIdx > 0) {
    return `${originalName.slice(0, extIdx)}${suffix}${originalName.slice(extIdx)}`;
  }
  return `${originalName}${suffix}`;
}

async function checkDestinationFileExists(
  database: any,
  targetAccount: any,
  targetFolderId: string,
  candidateName: string
): Promise<boolean> {
  const folder = (!targetFolderId || targetFolderId === 'root') ? '' : targetFolderId;
  if (targetAccount.accountType === 'tgdrive') {
    const existing = await database.collection('tg_files').findOne({
      accountId: targetAccount._id,
      folder,
      name: candidateName,
      trashed: { $ne: true },
    });
    return Boolean(existing);
  }
  const existingMeta = await database.collection('tg_files').findOne({
    accountId: targetAccount._id,
    folder,
    $or: [{ name: candidateName }, { opaqueRemoteName: candidateName }],
    trashed: { $ne: true },
  });
  if (existingMeta) return true;
  if (targetAccount.accountType === 'onedrive') {
    try {
      const c = await getOneDriveClient(targetAccount.tokens || targetAccount.credentials, String(targetAccount._id));
      const parentPath = (!targetFolderId || targetFolderId === 'root') ? '/me/drive/root' : `/me/drive/items/${targetFolderId}`;
      const children = await c.api(`${parentPath}/children`).get();
      const items = Array.isArray(children?.value) ? children.value : [];
      return items.some((it: any) => !it.deleted && String(it.name || '') === candidateName);
    } catch {
      return false;
    }
  }
  if (targetAccount.accountType === 'google') {
    try {
      const drive = await getDriveClient(targetAccount.tokens || targetAccount.credentials);
      const safeName = escapeDriveQueryValue(candidateName);
      const safeParent = escapeDriveQueryValue(targetFolderId || 'root');
      const res = await drive.files.list({
        q: `name = '${safeName}' and '${safeParent}' in parents and trashed = false`,
        fields: 'files(id,name)',
        pageSize: 1,
      });
      return Array.isArray(res?.data?.files) && res.data.files.length > 0;
    } catch {
      return false;
    }
  }
  return false;
}

async function resolveNonConflictingFileName(
  database: any,
  targetAccount: any,
  targetFolderId: string,
  desiredName: string,
  conflictStrategy: ConflictStrategy = 'overwrite'
): Promise<{ resolvedName: string; conflictDetected: boolean; skipped: boolean }> {
  if (conflictStrategy === 'overwrite') {
    return { resolvedName: desiredName, conflictDetected: false, skipped: false };
  }
  const exists = await checkDestinationFileExists(database, targetAccount, targetFolderId, desiredName);
  if (!exists) {
    return { resolvedName: desiredName, conflictDetected: false, skipped: false };
  }
  if (conflictStrategy === 'skip') {
    return { resolvedName: desiredName, conflictDetected: true, skipped: true };
  }
  if (conflictStrategy === 'error') {
    const err: any = new Error(`File '${desiredName}' already exists in destination folder`);
    err.code = STANDARD_ERROR_CODES.CONFLICT;
    err.status = 409;
    throw err;
  }
  for (let i = 1; i <= 50; i++) {
    const candidate = buildConflictCopyName(desiredName, i);
    const taken = await checkDestinationFileExists(database, targetAccount, targetFolderId, candidate);
    if (!taken) {
      return { resolvedName: candidate, conflictDetected: true, skipped: false };
    }
  }
  return { resolvedName: `${Date.now()}_${desiredName}`, conflictDetected: true, skipped: false };
}

async function crossAccountTransfer(
  sourceAccountId: string,
  fileId: string,
  targetAccountId: string,
  targetFolderId: string,
  userId: any,
  isAdmin: boolean,
  database: any,
  isMove: boolean,
  onProgress?: (info: TransferProgressInfo) => Promise<void> | void,
  jobId?: string,
  shouldCancel?: () => Promise<boolean> | boolean,
  conflictStrategy: ConflictStrategy = 'overwrite'
) {
  const checkCancelled = async () => {
    if (shouldCancel && await shouldCancel()) {
      const err: any = new Error('Transfer job was cancelled');
      err.code = 'JOB_CANCELLED';
      throw err;
    }
  };

  await checkCancelled();

  const { account: sourceAccount, accessDenied: srcDenied } = await resolveAuthorizedAccount(database, sourceAccountId, userId, isAdmin);
  if (srcDenied) throw new Error('Access denied to source account');
  if (!sourceAccount) throw new Error('Source account not found');

  const { account: targetAccount, accessDenied: tgtDenied } = await resolveAuthorizedAccount(database, targetAccountId, userId, isAdmin);
  if (tgtDenied) throw new Error('Access denied to target account');
  if (!targetAccount) throw new Error('Target account not found');

  const { meta: sourceMeta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, sourceAccount, fileId, userId, isAdmin);
  if (fileDenied) throw new Error('Access denied to source file');

  const transferIdempotencyKey = jobId
    ? `transfer_job_${jobId}`
    : `transfer_${sourceAccountId}_${fileId}_${targetAccountId}_${targetFolderId || 'root'}_${Date.now()}`;
  const manifestKey = jobId || transferIdempotencyKey;

  // Check if a previous attempt for this job already verified destination upload or saved a provider checkpoint
  const priorManifest = jobId
    ? await database.collection('transfer_manifests').findOne({ jobId: manifestKey })
    : null;
  const existingManifest = (priorManifest && (priorManifest.status === 'destination_verified' || priorManifest.status === 'completed'))
    ? priorManifest
    : null;

  let verifiedBytes = Number(existingManifest?.sizeBytes || 0);
  let resolvedFileName = String(existingManifest?.fileName || '');
  let destinationFileId = String(existingManifest?.destinationFileId || '');
  let conflictDetected = Boolean(existingManifest?.conflictDetected);

  if (!existingManifest) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const tmpPath = path.join(TEMP_DIR, `transfer_${Date.now()}_${nanoid(6)}`);
    const writeStream = fs.createWriteStream(tmpPath);

    let fileName = sourceMeta?.isEncrypted ? (sourceMeta.opaqueRemoteName || sourceMeta.name) : 'unknown';
    let mimeType = sourceMeta?.isEncrypted ? 'application/octet-stream' : 'application/octet-stream';
    let expectedBytes = Number(sourceMeta?.encryptedSizeBytes ?? sourceMeta?.size ?? 0) || 0;

    try {
      if (!hasTempDiskHeadroom(expectedBytes)) {
        const storageErr: any = new Error('Server temporary storage is too low for this transfer');
        storageErr.code = STANDARD_ERROR_CODES.INSUFFICIENT_STORAGE;
        throw storageErr;
      }

      await onProgress?.({ stage: 'downloading', bytesProcessed: 0, totalBytes: expectedBytes, progressPct: 5 });

      if (sourceAccount.accountType === 'tgdrive') {
        const meta = sourceMeta;
        if (!meta) throw new Error('File not found in TG');
        fileName = meta.isEncrypted ? (meta.opaqueRemoteName || meta.name) : meta.name;
        mimeType = meta.isEncrypted ? 'application/octet-stream' : meta.mimeType;
        expectedBytes = Number(meta.encryptedSizeBytes ?? meta.size ?? 0) || 0;

        const telegram = await getTgClient();
        const peer = await resolvePeer(telegram, sourceAccount.channelId);
        const messages = await telegram.getMessages(peer, { ids: [meta.messageId] });
        if (!messages || !messages[0] || !messages[0].media) throw new Error('Message not found');

        let downloaded = 0;
        for await (const chunk of telegram.iterDownload({ file: messages[0].media, requestSize: 1024 * 1024 })) {
          await checkCancelled();
          downloaded += chunk.length;
          if (!writeStream.write(chunk)) {
            await new Promise<void>((res, rej) => {
              const onDrain = () => { cleanup(); res(); };
              const onErr = (e: any) => { cleanup(); rej(e); };
              const cleanup = () => { writeStream.off('drain', onDrain); writeStream.off('error', onErr); };
              writeStream.once('drain', onDrain);
              writeStream.once('error', onErr);
            });
          }
          const pct = expectedBytes > 0 ? Math.min(50, 5 + Math.round((downloaded / expectedBytes) * 45)) : 25;
          await onProgress?.({ stage: 'downloading', bytesProcessed: downloaded, totalBytes: expectedBytes, progressPct: pct });
        }
        writeStream.end();
        await new Promise<void>((res, rej) => { writeStream.on('finish', () => res()); writeStream.on('error', rej); });
      } else if (sourceAccount.accountType === 'onedrive') {
        const c = await getOneDriveClient(sourceAccount.tokens || sourceAccount.credentials, sourceAccount._id.toString());
        const item = await c.api(`/me/drive/items/${fileId}`).get();
        if (!sourceMeta?.isEncrypted) {
          fileName = item.name;
          mimeType = item.file?.mimeType || mimeType;
        }
        expectedBytes = Number(item.size) || expectedBytes;

        const dlUrl = item['@microsoft.graph.downloadUrl'];
        if (!dlUrl) throw new Error('Download link not available');
        const response = await axios.get(dlUrl, { responseType: 'stream', timeout: PROVIDER_API_TIMEOUT_MS });
        await stream.promises.pipeline(response.data, writeStream);
      } else if (sourceAccount.accountType === 'google') {
        const drive = await getDriveClient(sourceAccount.tokens || sourceAccount.credentials);
        const file = await drive.files.get({ fileId, fields: 'name,mimeType,size' });
        if (!sourceMeta?.isEncrypted) {
          fileName = file.data.name || 'unknown';
          mimeType = file.data.mimeType || mimeType;
        }
        expectedBytes = Number(file.data.size) || expectedBytes;

        const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
        await stream.promises.pipeline(response.data, writeStream);
      }

      await checkCancelled();
      const stat = await fs.promises.stat(tmpPath);
      if (expectedBytes > 0 && stat.size !== expectedBytes) {
        throw new Error(`Downloaded size (${stat.size}) does not match expected source size (${expectedBytes})`);
      }
      verifiedBytes = stat.size;
      const transferChecksum = sourceMeta?.encryptedChecksum || await computeFileSha256(tmpPath);

      const conflictResolution = await resolveNonConflictingFileName(
        database,
        targetAccount,
        targetFolderId,
        fileName,
        conflictStrategy
      );
      if (conflictResolution.skipped) {
        const skippedNow = new Date();
        await database.collection('transfer_manifests').updateOne(
          { jobId: manifestKey },
          {
            $set: {
              jobId: manifestKey,
              userId: userId ? String(userId) : null,
              sourceAccountId: String(sourceAccountId),
              sourceFileId: String(fileId),
              targetAccountId: String(targetAccountId),
              targetFolderId: String(targetFolderId || 'root'),
              fileName,
              resolvedFileName: fileName,
              conflictDetected: true,
              skipped: true,
              sizeBytes: stat.size,
              checksum: transferChecksum,
              isMove: false,
              status: 'skipped_conflict',
              completedAt: skippedNow,
              updatedAt: skippedNow,
            },
            $setOnInsert: { createdAt: skippedNow },
          },
          { upsert: true }
        );
        await onProgress?.({ stage: 'completed', bytesProcessed: stat.size, totalBytes: stat.size, progressPct: 100 });
        return { skipped: true, conflictDetected: true, fileName, resolvedFileName: fileName };
      }

      resolvedFileName = conflictResolution.resolvedName;
      conflictDetected = conflictResolution.conflictDetected;

      await onProgress?.({ stage: 'uploading', bytesProcessed: 0, totalBytes: stat.size, progressPct: 55 });

      const encryptionSpec: ValidatedUploadSpec | undefined = sourceMeta?.isEncrypted ? {
        isEncrypted: true,
        fileName: resolvedFileName,
        mimeType: 'application/octet-stream',
        size: stat.size,
        folderId: (!targetFolderId || targetFolderId === 'root') ? 'root' : targetFolderId,
        checksum: transferChecksum,
        encryptionFormatVersion: sourceMeta.encryptionFormatVersion ?? 1,
        encryptionKeyId: sourceMeta.encryptionKeyId ?? null,
        encryptedMetadata: sourceMeta.encryptedMetadata ?? null,
        opaqueRemoteName: resolvedFileName,
        encryptedSizeBytes: stat.size,
      } : undefined;

      // Persist upstream provider resumable upload session (OneDrive nextExpectedRanges / Google resumable URI)
      const priorProviderSession: PersistedProviderSession | undefined = priorManifest?.providerSession || undefined;
      const persistProviderSession = async (sessionState: PersistedProviderSession) => {
        await checkCancelled();
        const checkpointNow = new Date();
        await database.collection('transfer_manifests').updateOne(
          { jobId: manifestKey },
          {
            $set: {
              jobId: manifestKey,
              userId: userId ? String(userId) : null,
              sourceAccountId: String(sourceAccountId),
              sourceFileId: String(fileId),
              targetAccountId: String(targetAccountId),
              targetFolderId: String(targetFolderId || 'root'),
              fileName,
              resolvedFileName,
              conflictDetected,
              sizeBytes: stat.size,
              checksum: transferChecksum,
              isMove: Boolean(isMove),
              providerSession: sessionState,
              status: 'uploading',
              updatedAt: checkpointNow,
            },
            $setOnInsert: { createdAt: checkpointNow },
          },
          { upsert: true }
        );
        const uploadedBytes = Math.min(stat.size, Number(sessionState.nextOffset || 0));
        const pct = stat.size > 0 ? Math.min(90, 55 + Math.round((uploadedBytes / stat.size) * 35)) : 75;
        await onProgress?.({ stage: 'uploading', bytesProcessed: uploadedBytes, totalBytes: stat.size, progressPct: pct });
      };

      const useResumableProviderSession = Boolean(priorProviderSession) || stat.size > 4 * 1024 * 1024;
      const uploadResult: any = await uploadFileToProvider(
        targetAccount,
        String(targetAccount._id),
        { path: tmpPath, size: stat.size, originalname: resolvedFileName, mimetype: mimeType },
        targetFolderId,
        useResumableProviderSession ? priorProviderSession : undefined,
        useResumableProviderSession ? persistProviderSession : undefined,
        transferIdempotencyKey,
        encryptionSpec,
        String(userId || targetAccount.userId || '')
      );

      // Verify destination success before ever deleting source on move
      const destinationConfirmed = uploadResult !== undefined && uploadResult !== null && (
        Boolean(uploadResult.id) ||
        Boolean(uploadResult._id) ||
        Boolean(uploadResult.messageId) ||
        uploadResult.success === true ||
        typeof uploadResult === 'object'
      );
      if (!destinationConfirmed) {
        throw new Error('Destination provider did not confirm file upload completion');
      }

      destinationFileId = String(uploadResult?.id || uploadResult?._id || uploadResult?.messageId || resolvedFileName);
      const manifestNow = new Date();
      await database.collection('transfer_manifests').updateOne(
        { jobId: manifestKey },
        {
          $set: {
            jobId: manifestKey,
            userId: userId ? String(userId) : null,
            sourceAccountId: String(sourceAccountId),
            sourceFileId: String(fileId),
            targetAccountId: String(targetAccountId),
            targetFolderId: String(targetFolderId || 'root'),
            destinationFileId,
            fileName,
            resolvedFileName,
            conflictDetected,
            sizeBytes: stat.size,
            checksum: transferChecksum,
            isMove: Boolean(isMove),
            status: 'destination_verified',
            verified: true,
            verifiedAt: manifestNow,
            updatedAt: manifestNow,
          },
          $setOnInsert: { createdAt: manifestNow },
        },
        { upsert: true }
      );

      await onProgress?.({ stage: 'uploading', bytesProcessed: stat.size, totalBytes: stat.size, progressPct: 90 });
    } finally {
      try { writeStream.destroy(); } catch { /* ignore */ }
      try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    }
  }

  if (isMove) {
    await checkCancelled();
    await onProgress?.({ stage: 'finalizing', bytesProcessed: verifiedBytes, totalBytes: verifiedBytes, progressPct: 95 });
    deleteThumbFiles(fileId, String(sourceAccount._id));
    if (sourceAccount.accountType === 'tgdrive') {
      if (sourceMeta) {
        const telegram = await getTgClient();
        const peer = await resolvePeer(telegram, sourceAccount.channelId);
        try { await telegram.deleteMessages(peer, [sourceMeta.messageId], { revoke: true }); } catch { /* ignore */ }
        await database.collection('tg_files').deleteOne({ _id: sourceMeta._id });
      }
    } else if (sourceAccount.accountType === 'onedrive') {
      const c = await getOneDriveClient(sourceAccount.tokens || sourceAccount.credentials, sourceAccount._id.toString());
      await c.api(`/me/drive/items/${fileId}`).delete();
      if (sourceMeta) await database.collection('tg_files').deleteOne({ _id: sourceMeta._id });
    } else if (sourceAccount.accountType === 'google') {
      const drive = await getDriveClient(sourceAccount.tokens || sourceAccount.credentials);
      await drive.files.delete({ fileId });
      if (sourceMeta) await database.collection('tg_files').deleteOne({ _id: sourceMeta._id });
    }
  }

  if (jobId) {
    await database.collection('transfer_manifests').updateOne(
      { jobId },
      { $set: { status: 'completed', completedAt: new Date(), updatedAt: new Date() } }
    );
  }
  await onProgress?.({ stage: 'completed', bytesProcessed: verifiedBytes, totalBytes: verifiedBytes, progressPct: 100 });
  return {
    skipped: false,
    conflictDetected,
    destinationFileId,
    resolvedFileName,
    sizeBytes: verifiedBytes,
  };
}

async function verifySingleBackupItem(database: any, targetAccount: any, item: any): Promise<boolean> {
  if (!item || item.skipped) return true;
  if (targetAccount.accountType === 'tgdrive') {
    const query: any = { accountId: targetAccount._id, trashed: { $ne: true } };
    if (item.destinationFileId && ObjectId.isValid(item.destinationFileId)) {
      query._id = new ObjectId(item.destinationFileId);
    } else {
      query.name = item.resolvedFileName || item.fileName;
    }
    const doc = await database.collection('tg_files').findOne(query);
    if (!doc) return false;
    const docSize = Number(doc.encryptedSizeBytes ?? doc.size ?? 0);
    return item.sizeBytes > 0 ? docSize === Number(item.sizeBytes) : true;
  }
  return Boolean(item.destinationFileId);
}

async function executeBatchBackupOrRestore(
  job: any,
  database: any,
  shouldCancel: () => Promise<boolean>
) {
  const p = job.payload || {};
  const sourceAccountId = String(p.sourceAccountId || '');
  const targetAccountId = String(p.targetAccountId || '');
  const targetFolderId = String(p.targetFolderId || 'root');
  const fileIds: string[] = Array.isArray(p.fileIds) ? p.fileIds.map(String) : [];
  const conflictStrategy: ConflictStrategy = p.conflictStrategy || 'rename';
  const jobId = String(job._id);

  const { account: targetAccount } = await resolveAuthorizedAccount(database, targetAccountId, p.userId, p.isAdmin);
  if (!targetAccount) throw new Error('Target account not found');

  const priorManifest = await database.collection('transfer_manifests').findOne({ jobId });
  const completedMap = new Map<string, any>();
  if (Array.isArray(priorManifest?.items)) {
    for (const it of priorManifest.items) {
      if (it?.sourceFileId && (it.status === 'completed' || it.status === 'skipped_conflict')) {
        completedMap.set(String(it.sourceFileId), it);
      }
    }
  }

  const items: any[] = [];
  const failedFiles: any[] = [];
  const totalFiles = Math.max(1, fileIds.length);

  for (let idx = 0; idx < fileIds.length; idx++) {
    if (await shouldCancel()) {
      const err: any = new Error('Batch job was cancelled');
      err.code = 'JOB_CANCELLED';
      throw err;
    }
    const fId = fileIds[idx];
    if (completedMap.has(fId)) {
      items.push(completedMap.get(fId));
      continue;
    }
    const subJobKey = `${jobId}_item_${idx}_${fId}`;
    try {
      const res = await crossAccountTransfer(
        sourceAccountId,
        fId,
        targetAccountId,
        targetFolderId,
        p.userId,
        Boolean(p.isAdmin),
        database,
        false,
        undefined,
        subJobKey,
        shouldCancel,
        conflictStrategy
      );
      const subManifest = await database.collection('transfer_manifests').findOne({ jobId: subJobKey });
      const itemRecord = {
        sourceFileId: fId,
        destinationFileId: res?.destinationFileId || subManifest?.destinationFileId || null,
        fileName: subManifest?.fileName || fId,
        resolvedFileName: res?.resolvedFileName || subManifest?.resolvedFileName || subManifest?.fileName || fId,
        conflictDetected: Boolean(res?.conflictDetected || subManifest?.conflictDetected),
        skipped: Boolean(res?.skipped),
        sizeBytes: Number(res?.sizeBytes ?? subManifest?.sizeBytes ?? 0),
        checksum: subManifest?.checksum || null,
        status: res?.skipped ? 'skipped_conflict' : 'completed',
      };
      const verified = await verifySingleBackupItem(database, targetAccount, itemRecord);
      items.push({ ...itemRecord, verified });
      if (!verified) {
        failedFiles.push({ fileId: fId, error: 'Post-backup destination verification failed' });
      }
    } catch (itemErr: any) {
      if (itemErr?.code === 'JOB_CANCELLED') throw itemErr;
      // Partial-failure resilience: record individual file failure and continue the batch
      failedFiles.push({
        fileId: fId,
        error: itemErr?.message || 'File backup failed',
        code: itemErr?.code || STANDARD_ERROR_CODES.TRANSFER_FAILED,
      });
      items.push({
        sourceFileId: fId,
        status: 'failed',
        error: itemErr?.message || 'File backup failed',
        verified: false,
      });
    }

    const progressPct = Math.min(95, Math.round(((idx + 1) / totalFiles) * 95));
    const now = new Date();
    await database.collection('jobs').updateOne(
      { _id: job._id, status: 'running' },
      {
        $set: {
          stage: `processed_${idx + 1}_of_${fileIds.length}`,
          progressPct,
          leaseUntil: new Date(Date.now() + JOB_LEASE_MS),
          updatedAt: now,
        },
      }
    );
    await database.collection('transfer_manifests').updateOne(
      { jobId },
      {
        $set: {
          jobId,
          type: job.type,
          userId: p.userId ? String(p.userId) : null,
          sourceAccountId,
          targetAccountId,
          targetFolderId,
          conflictStrategy,
          items,
          failedFiles,
          succeededCount: items.filter((i) => i.status === 'completed' || i.status === 'skipped_conflict').length,
          failedCount: failedFiles.length,
          verified: failedFiles.length === 0 && items.every((i) => i.verified !== false),
          verifiedAt: new Date(),
          status: failedFiles.length === 0 ? 'completed' : (items.some((i) => i.status === 'completed') ? 'completed_with_errors' : 'failed'),
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
  }

  invalidateDriveCache(sourceAccountId);
  invalidateDriveCache(targetAccountId);
}

async function enqueueTransferJob(database: any, payload: any, jobType: 'cross_account_transfer' | 'batch_backup' | 'batch_restore' = 'cross_account_transfer') {
  const activeCount = await database.collection('jobs').countDocuments({ status: { $in: ['queued', 'running'] } });
  if (activeCount >= MAX_JOB_QUEUE_DEPTH) {
    const err: any = new Error('Background transfer queue is currently full; please try again shortly');
    err.status = 503;
    err.code = STANDARD_ERROR_CODES.RATE_LIMITED;
    throw err;
  }
  const now = new Date();
  const job = {
    _id: nanoid(32),
    type: jobType,
    status: 'queued',
    stage: 'queued',
    priority: Number(payload?.priority || 0),
    progressPct: 0,
    bytesProcessed: 0,
    totalBytes: 0,
    attempts: 0,
    maxAttempts: JOB_MAX_ATTEMPTS,
    deadLettered: false,
    cancelRequested: false,
    leaseOwner: null,
    payload,
    createdAt: now,
    updatedAt: now,
    nextRunAt: now,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };
  await database.collection('jobs').insertOne(job);
  return job;
}

function publicJob(job: any) {
  return {
    id: String(job._id),
    type: job.type,
    status: job.status,
    stage: job.stage || job.status,
    priority: job.priority || 0,
    progressPct: typeof job.progressPct === 'number' ? job.progressPct : (job.status === 'completed' ? 100 : 0),
    bytesProcessed: job.bytesProcessed || 0,
    totalBytes: job.totalBytes || 0,
    attempts: job.attempts || 0,
    maxAttempts: job.maxAttempts || JOB_MAX_ATTEMPTS,
    deadLettered: Boolean(job.deadLettered),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
  };
}

const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 3));
let activeJobWorkers = 0;
async function runJobWorker() {
  if (activeJobWorkers >= MAX_CONCURRENT_JOBS || isShuttingDown || !db) return;
  activeJobWorkers++;
  try {
    const now = new Date();
    const claimedResult = await db.collection('jobs').findOneAndUpdate(
      {
        type: { $in: ['cross_account_transfer', 'batch_backup', 'batch_restore'] },
        $or: [
          { status: 'queued', nextRunAt: { $lte: now } },
          { status: 'running', leaseUntil: { $lt: now } },
        ],
      },
      {
        $set: {
          status: 'running',
          stage: 'starting',
          leaseOwner: WORKER_ID,
          startedAt: now,
          updatedAt: now,
          leaseUntil: new Date(Date.now() + JOB_LEASE_MS),
        },
        $inc: { attempts: 1 },
      },
      { sort: { priority: -1, createdAt: 1 }, returnDocument: 'after' }
    ) as any;
    const job = claimedResult?.value ?? claimedResult;
    if (!job) return;
    if (activeJobWorkers < MAX_CONCURRENT_JOBS && !isShuttingDown) {
      Promise.resolve().then(() => runJobWorker()).catch(() => {});
    }

    try {
      const p = job.payload;
      let lastUpdateMs = 0;
      const shouldCancel = async () => {
        if (isShuttingDown) return false;
        const current = await db.collection('jobs').findOne({ _id: job._id });
        return !current || current.status === 'cancelled' || current.cancelRequested === true;
      };
      if (job.type === 'batch_backup' || job.type === 'batch_restore') {
        await providerLimit(`transfer:${p.sourceAccountId}:${p.targetAccountId}`, 1)(() =>
          executeBatchBackupOrRestore(job, db, shouldCancel)
        );
      } else {
        await providerLimit(`transfer:${p.sourceAccountId}:${p.targetAccountId}`, 1)(() =>
          crossAccountTransfer(
            p.sourceAccountId,
            p.fileId,
            p.targetAccountId,
            p.targetFolderId,
            p.userId,
            p.isAdmin,
            db,
            p.isMove,
            async (info) => {
              const nowMs = Date.now();
              if (info.progressPct < 100 && nowMs - lastUpdateMs < 200) return;
              lastUpdateMs = nowMs;
              await db.collection('jobs').updateOne(
                { _id: job._id, status: 'running' },
                {
                  $set: {
                    stage: info.stage,
                    progressPct: info.progressPct,
                    bytesProcessed: info.bytesProcessed,
                    totalBytes: info.totalBytes,
                    leaseUntil: new Date(nowMs + JOB_LEASE_MS),
                    updatedAt: new Date(nowMs),
                  },
                }
              );
            },
            String(job._id),
            shouldCancel,
            p.conflictStrategy || 'overwrite'
          )
        );
      }
      systemMetrics.transfersCompleted++;
      invalidateDriveCache(p.sourceAccountId);
      invalidateDriveCache(p.targetAccountId);
      await db.collection('jobs').updateOne(
        { _id: job._id, status: 'running' },
        {
          $set: {
            status: 'completed',
            stage: 'completed',
            progressPct: 100,
            completedAt: new Date(),
            updatedAt: new Date(),
          },
          $unset: { leaseUntil: '', leaseOwner: '' },
        }
      );
    } catch (err: any) {
      if (err?.code === 'JOB_CANCELLED') {
        await db.collection('jobs').updateOne(
          { _id: job._id },
          {
            $set: { status: 'cancelled', stage: 'cancelled', error: 'Job cancelled by user', updatedAt: new Date() },
            $unset: { leaseUntil: '', leaseOwner: '' },
          }
        );
        return;
      }
      const attempts = Number(job.attempts || 1);
      const maxAttempts = Number(job.maxAttempts || JOB_MAX_ATTEMPTS);
      const retry = attempts < maxAttempts;
      if (!retry) {
        systemMetrics.transfersFailed++;
        systemMetrics.jobsDeadLettered++;
      }
      await db.collection('jobs').updateOne(
        { _id: job._id, status: 'running' },
        retry
          ? {
              $set: {
                status: 'queued',
                stage: 'retrying',
                error: err.message || 'Transfer failed',
                nextRunAt: new Date(Date.now() + Math.min(60, 2 ** attempts) * 1000),
                updatedAt: new Date(),
              },
              $unset: { leaseUntil: '', leaseOwner: '' },
            }
          : {
              $set: {
                status: 'failed',
                stage: 'failed',
                deadLettered: true,
                deadLetteredAt: new Date(),
                error: err.message || 'Transfer failed',
                updatedAt: new Date(),
              },
              $unset: { leaseUntil: '', leaseOwner: '' },
            }
      );
    }
  } catch (err) {
    console.error('[Jobs] Worker error:', err);
  } finally {
    activeJobWorkers = Math.max(0, activeJobWorkers - 1);
  }
}

// ─── Batch Backup, Verification, and Non-Destructive Restore Endpoints ────────
app.post('/api/backups/batch', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const { sourceAccountId, targetAccountId, targetFolderId, fileIds, conflictStrategy } = req.body || {};
  if (!sourceAccountId || !targetAccountId || !Array.isArray(fileIds) || fileIds.length === 0) {
    return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'sourceAccountId, targetAccountId, and non-empty fileIds array are required', req.requestId);
  }
  const { account: srcAcc, accessDenied: srcDenied } = await resolveAuthorizedAccount(database, String(sourceAccountId), req.userId, req.isAdmin);
  if (srcDenied) return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Access denied to source account', req.requestId);
  if (!srcAcc) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Source account not found', req.requestId);

  const { account: tgtAcc, accessDenied: tgtDenied } = await resolveAuthorizedAccount(database, String(targetAccountId), req.userId, req.isAdmin);
  if (tgtDenied) return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Access denied to target account', req.requestId);
  if (!tgtAcc) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Target account not found', req.requestId);

  try {
    const job = await enqueueTransferJob(database, {
      sourceAccountId: String(sourceAccountId),
      targetAccountId: String(targetAccountId),
      targetFolderId: String(targetFolderId || 'root'),
      fileIds: fileIds.map(String),
      conflictStrategy: (['rename', 'skip', 'overwrite', 'error'].includes(conflictStrategy) ? conflictStrategy : 'rename') as ConflictStrategy,
      userId: req.userId,
      isAdmin: req.isAdmin,
    }, 'batch_backup');
    runJobWorker().catch(() => {});
    return res.status(202).json({ success: true, async: true, jobId: job._id, status: job.status });
  } catch (err: any) {
    return apiError(res, err.status || 500, err.code || STANDARD_ERROR_CODES.INTERNAL_ERROR, err.message || 'Failed to enqueue batch backup', req.requestId);
  }
});

app.post('/api/backups/:jobId/verify', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const manifest = await database.collection('transfer_manifests').findOne({ jobId: req.params.jobId });
  if (!manifest) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Backup manifest not found', req.requestId);
  if (!req.isAdmin && String(manifest.userId || '') !== String(req.userId || '')) {
    return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Access denied to this backup manifest', req.requestId);
  }
  const { account: targetAccount } = await resolveAuthorizedAccount(database, String(manifest.targetAccountId), req.userId, req.isAdmin);
  if (!targetAccount) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Target account not found', req.requestId);

  const items: any[] = Array.isArray(manifest.items)
    ? manifest.items
    : [{
        sourceFileId: manifest.sourceFileId,
        destinationFileId: manifest.destinationFileId,
        fileName: manifest.fileName,
        resolvedFileName: manifest.resolvedFileName || manifest.fileName,
        sizeBytes: manifest.sizeBytes,
        status: manifest.status,
      }];

  let verifiedCount = 0;
  const failedVerifications: any[] = [];
  for (const item of items) {
    if (item.status === 'failed') {
      failedVerifications.push({ fileId: item.sourceFileId, reason: item.error || 'Upload failed during backup' });
      continue;
    }
    const ok = await verifySingleBackupItem(database, targetAccount, item);
    if (ok) verifiedCount++;
    else failedVerifications.push({ fileId: item.sourceFileId, destinationFileId: item.destinationFileId, reason: 'Destination file missing or size mismatch' });
  }

  const allVerified = failedVerifications.length === 0 && verifiedCount === items.length;
  const verifiedAt = new Date();
  await database.collection('transfer_manifests').updateOne(
    { jobId: req.params.jobId },
    { $set: { verified: allVerified, verifiedAt, updatedAt: verifiedAt } }
  );

  return res.json({
    jobId: req.params.jobId,
    verified: allVerified,
    totalItems: items.length,
    verifiedCount,
    failedVerifications,
    verifiedAt: verifiedAt.toISOString(),
  });
});

app.post('/api/backups/:jobId/restore', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const manifest = await database.collection('transfer_manifests').findOne({ jobId: req.params.jobId });
  if (!manifest) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Backup manifest not found', req.requestId);
  if (!req.isAdmin && String(manifest.userId || '') !== String(req.userId || '')) {
    return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Access denied to this backup manifest', req.requestId);
  }
  const restoreTargetAccountId = String(req.body?.targetAccountId || manifest.sourceAccountId);
  const restoreTargetFolderId = String(req.body?.targetFolderId || 'root');
  // Never overwrite existing files silently during restore: default to 'rename' (conflict copies)
  const conflictStrategy: ConflictStrategy = (['rename', 'skip', 'error', 'overwrite'].includes(req.body?.conflictStrategy)
    ? req.body.conflictStrategy
    : 'rename') as ConflictStrategy;

  const items: any[] = Array.isArray(manifest.items)
    ? manifest.items.filter((i: any) => i.destinationFileId && i.status === 'completed')
    : (manifest.destinationFileId ? [{ destinationFileId: manifest.destinationFileId }] : []);
  const restoreFileIds = items.map((i: any) => String(i.destinationFileId));
  if (restoreFileIds.length === 0) {
    return apiError(res, 409, STANDARD_ERROR_CODES.CONFLICT, 'No completed backup files available to restore', req.requestId);
  }

  try {
    const job = await enqueueTransferJob(database, {
      sourceAccountId: String(manifest.targetAccountId),
      targetAccountId: restoreTargetAccountId,
      targetFolderId: restoreTargetFolderId,
      fileIds: restoreFileIds,
      conflictStrategy,
      userId: req.userId,
      isAdmin: req.isAdmin,
    }, 'batch_restore');
    runJobWorker().catch(() => {});
    return res.status(202).json({
      success: true,
      async: true,
      jobId: job._id,
      status: job.status,
      conflictStrategy,
    });
  } catch (err: any) {
    return apiError(res, err.status || 500, err.code || STANDARD_ERROR_CODES.INTERNAL_ERROR, err.message || 'Failed to enqueue restore job', req.requestId);
  }
});

app.get('/api/jobs', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const query: any = {};
  if (!req.isAdmin && req.userId) query['payload.userId'] = String(req.userId);
  if (typeof req.query.status === 'string' && req.query.status.trim()) {
    query.status = req.query.status.trim();
  }
  const jobs = await database.collection('jobs').find(query).sort({ createdAt: -1 }).limit(50).toArray();
  res.json(jobs.map(publicJob));
});

app.get('/api/jobs/:jobId', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const query: any = { _id: req.params.jobId };
  if (!req.isAdmin && req.userId) query['payload.userId'] = String(req.userId);
  const job = await database.collection('jobs').findOne(query);
  if (!job) return apiError(res, 404, 'JOB_NOT_FOUND', 'Job not found', req.requestId);
  res.json(publicJob(job));
});

app.post('/api/jobs/:jobId/cancel', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const query: any = { _id: req.params.jobId };
  if (!req.isAdmin && req.userId) query['payload.userId'] = String(req.userId);
  const existing = await database.collection('jobs').findOne(query);
  if (!existing) return apiError(res, 404, 'JOB_NOT_FOUND', 'Job not found', req.requestId);
  if (existing.status === 'completed') {
    return apiError(res, 409, STANDARD_ERROR_CODES.CONFLICT, 'Completed job cannot be cancelled', req.requestId);
  }
  const now = new Date();
  await database.collection('jobs').updateOne(
    { _id: existing._id },
    {
      $set: {
        status: 'cancelled',
        stage: 'cancelled',
        cancelRequested: true,
        error: 'Job cancelled by user',
        updatedAt: now,
      },
      $unset: { leaseUntil: '', leaseOwner: '' },
    }
  );
  const updated = await database.collection('jobs').findOne({ _id: existing._id });
  res.json(publicJob(updated || { ...existing, status: 'cancelled', stage: 'cancelled' }));
});

app.get('/api/jobs/:jobId/stream', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const query: any = { _id: req.params.jobId };
  if (!req.isAdmin && req.userId) query['payload.userId'] = String(req.userId);
  const initialJob = await database.collection('jobs').findOne(query);
  if (!initialJob) return apiError(res, 404, 'JOB_NOT_FOUND', 'Job not found', req.requestId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let closed = false;
  const sendEvent = (jobDoc: any) => {
    if (closed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(publicJob(jobDoc))}\n\n`);
  };

  sendEvent(initialJob);
  if (initialJob.status === 'completed' || initialJob.status === 'failed' || initialJob.status === 'cancelled') {
    return res.end();
  }

  // Trigger worker immediately if job is queued
  if (initialJob.status === 'queued') {
    runJobWorker().catch(() => {});
  }

  let lastSnapshot = `${initialJob.status}:${initialJob.stage}:${initialJob.progressPct}`;
  const pollTimer = setInterval(async () => {
    if (closed || res.writableEnded) {
      clearInterval(pollTimer);
      return;
    }
    try {
      const current = await database.collection('jobs').findOne(query);
      if (!current) {
        clearInterval(pollTimer);
        if (!res.writableEnded) res.end();
        return;
      }
      if (current.status === 'queued' && activeJobWorkers < MAX_CONCURRENT_JOBS) {
        runJobWorker().catch(() => {});
      }
      const snap = `${current.status}:${current.stage}:${current.progressPct}`;
      if (snap !== lastSnapshot) {
        lastSnapshot = snap;
        sendEvent(current);
      }
      if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
        clearInterval(pollTimer);
        if (!res.writableEnded) res.end();
      }
    } catch {
      clearInterval(pollTimer);
      if (!res.writableEnded) res.end();
    }
  }, 150);

  req.on('close', () => {
    closed = true;
    clearInterval(pollTimer);
  });
});

app.post('/api/jobs/:jobId/retry', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const query: any = { _id: req.params.jobId, status: { $in: ['failed', 'cancelled'] } };
  if (!req.isAdmin && req.userId) query['payload.userId'] = String(req.userId);
  const result = await database.collection('jobs').findOneAndUpdate(
    query,
    {
      $set: {
        status: 'queued',
        stage: 'queued',
        progressPct: 0,
        deadLettered: false,
        cancelRequested: false,
        nextRunAt: new Date(),
        updatedAt: new Date(),
      },
      $unset: { error: '', leaseUntil: '', leaseOwner: '', deadLetteredAt: '' },
    },
    { returnDocument: 'after' }
  ) as any;
  const job = result?.value ?? result;
  if (!job) return apiError(res, 404, 'JOB_NOT_RETRYABLE', 'Job is not found or is not failed', req.requestId);
  res.json(publicJob(job));
});

// ─── Telegram Bot Initialization ──────────────────────────────────────────────
const bot = process.env.CLOUDYTE_TEST_MODE === '1' ? null : initBot({
  connectToMongo,
  getUserIdByTg,
  getDriveClient,
  getOneDriveClient,
  getTgClient,
  resolvePeer,
  driveCache,
  invalidateDriveCache,
  deleteThumbFiles,
  nanoid,
  nanoid12,
  oauth2Client,
  createOAuthState,
  MICROSOFT_CLIENT_ID,
  MICROSOFT_REDIRECT_URI,
});

// ─── Vite / Static Middleware ────────────────────────────────────────────────
if (process.env.CLOUDYTE_TEST_MODE !== '1') {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/s/')) {
        return next();
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}

// ─── 7. ROBUSTNESS: Final Express Error Handler ───────────────────────────────
app.use((err: any, req: any, res: any, next: any) => {
  const isMulterLimit = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
  const status = isMulterLimit ? 413 : (Number(err?.status || err?.statusCode) || 500);
  const code = isMulterLimit ? STANDARD_ERROR_CODES.BAD_REQUEST : (err?.code && typeof err.code === 'string' && status < 500 ? err.code : errorCode(status));
  console.error(JSON.stringify({
    event: 'unhandled_express_error',
    requestId: req?.requestId || 'unknown',
    userId: req?.userId ? String(req.userId) : null,
    method: req?.method,
    route: req?.originalUrl || req?.url,
    status,
    code,
    message: err?.message || 'Unknown error',
    stack: err?.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : undefined,
  }));
  if (res.headersSent) {
    return next(err);
  }
  const clientMessage = status >= 500
    ? 'Internal Server Error'
    : (isMulterLimit ? 'Uploaded file exceeds maximum allowed size' : (err?.message || 'Bad Request'));
  apiError(res, status, code, clientMessage, req?.requestId, status >= 500 || status === 429);
});

// ─── 7. ROBUSTNESS: Process Unhandled Listeners ────────────────────────────────
process.on('unhandledRejection', (reason: any) => {
  systemMetrics.unhandledRejections++;
  console.error(JSON.stringify({
    event: 'unhandled_rejection',
    message: reason?.message || String(reason),
    stack: reason?.stack ? String(reason.stack).split('\n').slice(0, 8).join('\n') : undefined,
  }));
});

process.on('uncaughtException', (err: any) => {
  systemMetrics.uncaughtExceptions++;
  console.error(JSON.stringify({
    event: 'uncaught_exception',
    message: err?.message || String(err),
    stack: err?.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : undefined,
  }));
});

// ─── 7. ROBUSTNESS: Graceful Shutdown on SIGTERM & SIGINT ─────────────────────
let server: any = null;
const backgroundIntervals: NodeJS.Timeout[] = [];

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(JSON.stringify({ event: 'shutdown_initiated', signal, workerId: WORKER_ID, timeoutMs: SHUTDOWN_TIMEOUT_MS }));

  const forceTimer = setTimeout(() => {
    console.error(JSON.stringify({ event: 'shutdown_forced_timeout', signal, workerId: WORKER_ID }));
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref?.();

  for (const interval of backgroundIntervals) clearInterval(interval);
  backgroundIntervals.length = 0;

  try { bot?.stop(signal); } catch { /* ignore */ }

  if (server) {
    await new Promise<void>((resolve) => {
      server.close((err: any) => {
        if (err) console.error('[Server] Error closing server:', err);
        resolve();
      });
    });
  }

  // Safely release active job leases owned by this worker so another instance can resume them
  if (db) {
    try {
      await db.collection('jobs').updateMany(
        { status: 'running', leaseOwner: WORKER_ID },
        { $set: { status: 'queued', stage: 'queued_after_shutdown', nextRunAt: new Date(), updatedAt: new Date() }, $unset: { leaseUntil: '', leaseOwner: '' } }
      );
    } catch { /* ignore */ }
  }

  if (tgClient) {
    try { await tgClient.disconnect(); } catch { /* ignore */ }
  }

  try {
    await client.close();
  } catch (err) {
    console.error('[Mongo] Error closing connection:', err);
  }
  clearTimeout(forceTimer);
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Startup ──────────────────────────────────────────────────────────────────
if (process.env.CLOUDYTE_TEST_MODE !== '1') {
  try {
    await connectToMongo();
  } catch (err) {
    console.error('[Startup] Initial MongoDB connection failed:', err);
  }
  pruneThumbDir(THUMB_DIR);
  pruneTempFiles();
  backgroundIntervals.push(setInterval(() => pruneThumbDir(THUMB_DIR), 3600000));
  backgroundIntervals.push(setInterval(() => pruneTempFiles(), 3600000));
  backgroundIntervals.push(setInterval(() => sweepUploadSessions().catch(err => console.error('[UploadSessions] Sweep failed:', err)), 5 * 60 * 1000));
  backgroundIntervals.push(setInterval(() => sweepExpiredTrash().catch(err => console.error('[Trash] Sweep failed:', err)), 60 * 60 * 1000));
  let lastLoopTick = Date.now();
  backgroundIntervals.push(setInterval(() => {
    const now = Date.now();
    systemMetrics.eventLoopLagMs = Math.max(0, now - lastLoopTick - 1000);
    lastLoopTick = now;
  }, 1000));
  runJobWorker();
  backgroundIntervals.push(setInterval(() => runJobWorker(), 2000));
  server = app.listen(Number(PORT), '0.0.0.0', () => console.log(`Cloudyte running at http://localhost:${PORT}`));
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
}

export { sweepUploadSessions, sweepExpiredTrash, runJobWorker, pruneTempFiles, pruneThumbDir, TEMP_DIR };
export default app;

