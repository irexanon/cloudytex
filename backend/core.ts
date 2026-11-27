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
} from './protocol.ts';

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
const TEMP_DROP_DIR = process.env.TEMP_DROP_DIR || path.join(TEMP_DIR, 'temp-drop-area');
for (const dir of [THUMB_DIR, TEMP_DIR, TEMP_DROP_DIR]) {
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
  uploadBytesTotal: 0,
  downloadBytesTotal: 0,
  transfersCompleted: 0,
  transfersFailed: 0,
  jobsDeadLettered: 0,
  oauthRefreshFailures: 0,
  lastWorkerHeartbeatAt: 0,
  workerHeartbeats: 0,
  eventLoopLagMs: 0,
  mongoConnected: false,
  mongoReconnects: 0,
  providerCalls: {
    google: { calls: 0, errors: 0, consecutiveFailures: 0, retries: 0, totalDurationMs: 0, lastErrorAt: null } as ProviderMetricBucket,
    onedrive: { calls: 0, errors: 0, consecutiveFailures: 0, retries: 0, totalDurationMs: 0, lastErrorAt: null } as ProviderMetricBucket,
    telegram: { calls: 0, errors: 0, consecutiveFailures: 0, retries: 0, totalDurationMs: 0, lastErrorAt: null } as ProviderMetricBucket,
  } as Record<string, ProviderMetricBucket>,
};

/**
 * Records a structured security/operational audit event to stdout and non-blockingly persists it to MongoDB `audit_logs`.
 */
export function recordAuditEvent(event: string, details: Record<string, any> = {}) {
  const now = new Date();
  const safeDetails = { ...details };
  // Never log tokens, passwords, or secrets
  delete safeDetails.token;
  delete safeDetails.password;
  delete safeDetails.refreshToken;
  delete safeDetails.accessToken;
  delete safeDetails.sessionString;
  const payload = {
    event: 'audit_log',
    action: event,
    timestamp: now.toISOString(),
    ...safeDetails,
  };
  console.log(JSON.stringify(payload));
  if (db && typeof db.collection === 'function') {
    try {
      const col = db.collection('audit_logs');
      if (col && typeof col.insertOne === 'function') {
        Promise.resolve(
          col.insertOne({
            action: event,
            ...safeDetails,
            createdAt: now,
            expiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
          })
        ).catch(() => {});
      }
    } catch {
      /* ignore audit write errors */
    }
  }
}

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
const failedThumbCache = new NodeCache({ stdTTL: 600, checkperiod: 120, maxKeys: 2000, useClones: true });

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
    try {
      await db.collection('tg_files').updateMany(
        { shareId: null },
        { $unset: { shareId: '' } }
      );
    } catch { /* ignore */ }
    try {
      const tgFileIndexes = typeof db.collection('tg_files').indexes === 'function'
        ? await db.collection('tg_files').indexes()
        : [];
      const existingShareIdx = Array.isArray(tgFileIndexes)
        ? tgFileIndexes.find((idx: any) => idx?.name === 'shareId_1')
        : null;
      if (existingShareIdx && !existingShareIdx.partialFilterExpression) {
        await db.collection('tg_files').dropIndex('shareId_1');
      }
    } catch { /* ignore */ }
    try {
      await db.collection('tg_files').createIndex(
        { shareId: 1 },
        { unique: true, partialFilterExpression: { shareId: { $type: 'string' } } }
      );
    } catch { /* ignore */ }
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
    try { await db.collection('api_tokens').createIndex({ token: 1 }, { unique: true }); } catch { /* ignore */ }
    try { await db.collection('api_tokens').createIndex({ tokenId: 1 }, { unique: true }); } catch { /* ignore */ }
    try { await db.collection('api_tokens').createIndex({ userId: 1, createdAt: -1 }); } catch { /* ignore */ }
    try { await db.collection('api_tokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); } catch { /* ignore */ }
    try { await db.collection('download_tickets').createIndex({ ticket: 1 }, { unique: true }); } catch { /* ignore */ }
    try { await db.collection('download_tickets').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); } catch { /* ignore */ }
    try { await db.collection('audit_logs').createIndex({ action: 1, createdAt: -1 }); } catch { /* ignore */ }
    try { await db.collection('audit_logs').createIndex({ userId: 1, createdAt: -1 }); } catch { /* ignore */ }
    try { await db.collection('audit_logs').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); } catch { /* ignore */ }
    try { await db.collection('temp_rooms').createIndex({ roomCode: 1 }, { unique: true }); } catch { /* ignore */ }
    try { await db.collection('temp_rooms').createIndex({ ownerUserId: 1, createdAt: -1 }); } catch { /* ignore */ }
    try { await db.collection('temp_rooms').createIndex({ expiresAt: 1 }); } catch { /* ignore */ }
    try { await db.collection('temp_files').createIndex({ roomCode: 1, createdAt: -1 }); } catch { /* ignore */ }
    try { await db.collection('temp_files').createIndex({ expiresAt: 1 }); } catch { /* ignore */ }

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
    await database.collection('tg_files').updateMany(
      { shareId: null },
      { $unset: { shareId: '' } }
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

// ─── Login Throttling, Progressive Delay & Temporary Lockout ──────────────────
type LoginAttemptState = {
  count: number;
  firstFailedAt: number;
  lastFailedAt: number;
  lockedUntil: number | null;
};
const LOGIN_MAX_ATTEMPTS = Math.max(3, Number(process.env.LOGIN_MAX_ATTEMPTS || 8));
const LOGIN_LOCKOUT_MS = Math.max(60_000, Number(process.env.LOGIN_LOCKOUT_MS || 15 * 60 * 1000));
const LOGIN_WINDOW_MS = Math.max(60_000, Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000));
const loginAttemptsByKey = new Map<string, LoginAttemptState>();

export function resetLoginAttemptsForTest() {
  loginAttemptsByKey.clear();
}

export function getClientIp(req: any): string {
  const xff = typeof req?.headers?.['x-forwarded-for'] === 'string'
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : '';
  return xff || req?.ip || req?.socket?.remoteAddress || 'unknown';
}

export function checkLoginAllowed(username: string, ip: string): { allowed: boolean; retryAfterSec: number; failures: number } {
  const now = Date.now();
  const keys = [`user:${username.toLowerCase()}`, `ip:${ip}`];
  let maxFailures = 0;
  for (const key of keys) {
    const entry = loginAttemptsByKey.get(key);
    if (!entry) continue;
    if (entry.lockedUntil && entry.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000)),
        failures: entry.count,
      };
    }
    if (now - entry.lastFailedAt > LOGIN_WINDOW_MS) {
      loginAttemptsByKey.delete(key);
      continue;
    }
    if (entry.count > maxFailures) maxFailures = entry.count;
  }
  return { allowed: true, retryAfterSec: 0, failures: maxFailures };
}

export async function recordLoginFailure(username: string, ip: string): Promise<{ locked: boolean; retryAfterSec: number; failures: number }> {
  const now = Date.now();
  const keys = [`user:${username.toLowerCase()}`, `ip:${ip}`];
  let maxCount = 0;
  let lockedUntil: number | null = null;
  for (const key of keys) {
    const prev = loginAttemptsByKey.get(key);
    const expired = !prev || (now - prev.lastFailedAt > LOGIN_WINDOW_MS);
    const count = expired ? 1 : prev.count + 1;
    const nextLockedUntil = count >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_LOCKOUT_MS : null;
    loginAttemptsByKey.set(key, {
      count,
      firstFailedAt: expired ? now : prev.firstFailedAt,
      lastFailedAt: now,
      lockedUntil: nextLockedUntil,
    });
    if (count > maxCount) maxCount = count;
    if (nextLockedUntil && (!lockedUntil || nextLockedUntil > lockedUntil)) {
      lockedUntil = nextLockedUntil;
    }
  }
  // Progressive delay on failed login (skip during unit tests for fast execution)
  if (process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
    const delayMs = Math.min(2000, maxCount * 200);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return {
    locked: Boolean(lockedUntil),
    retryAfterSec: lockedUntil ? Math.max(1, Math.ceil((lockedUntil - now) / 1000)) : 0,
    failures: maxCount,
  };
}

export function recordLoginSuccess(username: string, ip: string) {
  loginAttemptsByKey.delete(`user:${username.toLowerCase()}`);
  loginAttemptsByKey.delete(`ip:${ip}`);
}

// ─── Origin Verification Middleware ──────────────────────────────────────────
export function originGuardMiddleware(req: any, res: any, next: any) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const allowedEnv = (process.env.ALLOWED_ORIGINS || '').trim();
  if (!allowedEnv) return next();
  const origin = typeof req.headers?.origin === 'string' ? req.headers.origin.trim().replace(/\/$/, '') : '';
  if (!origin) return next();
  const allowedSet = new Set(
    allowedEnv
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean)
  );
  if (baseUrl) allowedSet.add(baseUrl.replace(/\/$/, ''));
  const hostHeader = typeof req.headers?.host === 'string' ? req.headers.host.trim() : '';
  if (hostHeader) {
    allowedSet.add(`http://${hostHeader}`);
    allowedSet.add(`https://${hostHeader}`);
  }
  if (!allowedSet.has(origin)) {
    recordAuditEvent('origin_rejected', { origin, path: req.path, method, ip: getClientIp(req) });
    return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Cross-origin request denied by ALLOWED_ORIGINS policy', req.requestId, false);
  }
  return next();
}

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

/**
 * Enforces API-token scope ('read' | 'write' | 'delete' | 'share') and optional accountId / rootFolderId confinement.
 */
function enforceTokenScopeAndConfinement(req: any, res: any): boolean {
  const fullPath = String(req.originalUrl || req.url || req.path || '');
  const pathOnly = fullPath.split('?')[0];
  if (pathOnly === '/mcp' || pathOnly === '/api/mcp') {
    return true;
  }

  const scopes: string[] | undefined = req.tokenScopes;
  if (Array.isArray(scopes)) {
    const method = String(req.method || 'GET').toUpperCase();
    let requiredScope = 'read';
    if (/^\/api\/share/i.test(fullPath) && method !== 'GET' && method !== 'HEAD') {
      requiredScope = 'share';
    } else if (pathOnly === '/api/archive/zip-ticket' || pathOnly === '/api/download-tickets') {
      requiredScope = 'read';
    } else if (method === 'DELETE' || /\/(delete|trash\/empty|permanent)/i.test(fullPath)) {
      requiredScope = 'delete';
    } else if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      requiredScope = 'write';
    }
    if (!scopes.includes(requiredScope) && !scopes.includes('*')) {
      recordAuditEvent('auth_scope_denied', {
        userId: req.userId,
        tokenId: req.tokenId,
        requiredScope,
        scopes,
        path: fullPath,
        method,
      });
      apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, `Personal access token missing required '${requiredScope}' scope`, req.requestId, false);
      return false;
    }
  }

  const confinement = req.tokenConfinement;
  if (confinement) {
    if (confinement.accountId) {
      const candidateAccountIds = [
        req.params?.accountId,
        req.query?.accountId,
        req.body?.accountId,
        req.body?.sourceAccountId,
        req.body?.targetAccountId,
      ].filter((v) => typeof v === 'string' && v.trim() !== '' && v !== 'all');
      for (const accId of candidateAccountIds) {
        if (String(accId) !== String(confinement.accountId)) {
          recordAuditEvent('auth_confinement_denied', {
            userId: req.userId,
            tokenId: req.tokenId,
            confinedAccountId: confinement.accountId,
            requestedAccountId: accId,
          });
          apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Token is confined to a different storage account', req.requestId, false);
          return false;
        }
      }
    }
    if (confinement.rootFolderId) {
      const rootFolder = String(confinement.rootFolderId);
      const candidateFolders = [
        req.query?.folderId,
        req.body?.folderId,
        req.body?.parentId,
        req.body?.targetFolderId,
      ].filter((v) => typeof v === 'string' && v.trim() !== '');
      for (const folder of candidateFolders) {
        const f = String(folder);
        if (f !== rootFolder && !f.startsWith(`${rootFolder}/`)) {
          recordAuditEvent('auth_confinement_denied', {
            userId: req.userId,
            tokenId: req.tokenId,
            confinedRootFolderId: rootFolder,
            requestedFolderId: f,
          });
          apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Token is confined to a specific root folder', req.requestId, false);
          return false;
        }
      }
    }
  }
  return true;
}

// ─── Auth Middleware with NodeCache (Sessions + Plaintext Personal Access Tokens) ──
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
    const clientIp = getClientIp(req);
    const cachedAuth = authCache.get(token) as any;
    if (cachedAuth) {
      const nowMs = Date.now();
      if (cachedAuth.revokedAt) {
        authCache.del(token);
        return res.status(401).json({ error: 'Session or token revoked' });
      }
      if (cachedAuth.expiresAt && cachedAuth.expiresAt < nowMs) {
        authCache.del(token);
        if (req.db && !cachedAuth.isPat) {
          try { await req.db.collection('sessions').deleteOne({ token }); } catch { /* ignore */ }
        }
        return res.status(401).json({ error: 'Session expired' });
      }
      if (!cachedAuth.lastTouchedAt || nowMs - cachedAuth.lastTouchedAt >= SESSION_TOUCH_INTERVAL_MS) {
        const newNow = new Date(nowMs);
        if (cachedAuth.isPat) {
          const updatedAuth = { ...cachedAuth, lastTouchedAt: nowMs };
          authCache.set(token, updatedAuth);
          if (req.db) {
            req.db.collection('api_tokens').updateOne(
              { token },
              { $set: { lastUsedAt: newNow, lastUsedIp: clientIp } }
            ).catch(() => {});
          }
        } else {
          const newExp = new Date(nowMs + SESSION_TTL_MS);
          const ipHistory = Array.isArray(cachedAuth.ipHistory) ? [...cachedAuth.ipHistory] : [];
          if (clientIp && !ipHistory.includes(clientIp)) {
            ipHistory.push(clientIp);
            if (ipHistory.length > 10) ipHistory.shift();
          }
          const updatedAuth = { ...cachedAuth, lastTouchedAt: nowMs, expiresAt: newExp.getTime(), ipHistory };
          authCache.set(token, updatedAuth);
          if (req.db) {
            req.db.collection('sessions').updateOne(
              { token },
              { $set: { lastActiveAt: newNow, lastUsedAt: newNow, ip: clientIp, ipHistory, expiresAt: newExp } }
            ).catch(() => {});
          }
        }
      }
      req.userId           = cachedAuth.userId;
      req.isAdmin          = cachedAuth.isAdmin;
      req.user             = cachedAuth.user;
      req.sessionId        = cachedAuth.sessionId;
      req.token            = token;
      req.tokenId          = cachedAuth.tokenId;
      req.tokenScopes      = cachedAuth.tokenScopes;
      req.tokenConfinement = cachedAuth.tokenConfinement;
      if (!enforceTokenScopeAndConfinement(req, res)) return;
      return next();
    }

    if (req.db) {
      // 1. Check server-side sessions collection (plaintext token)
      const session = await req.db.collection('sessions').findOne({ token });
      if (session) {
        if (session.revokedAt) {
          authCache.del(token);
          return res.status(401).json({ error: 'Session revoked' });
        }
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
          const ipHistory = Array.isArray(session.ipHistory) ? [...session.ipHistory] : (session.ip ? [String(session.ip)] : []);
          if (clientIp && !ipHistory.includes(clientIp)) {
            ipHistory.push(clientIp);
            if (ipHistory.length > 10) ipHistory.shift();
          }
          if (!lastActiveMs || nowMs - lastActiveMs >= SESSION_TOUCH_INTERVAL_MS) {
            const newNow = new Date(nowMs);
            const newExp = new Date(nowMs + SESSION_TTL_MS);
            nextExpMs = newExp.getTime();
            lastTouchedAt = nowMs;
            req.db.collection('sessions').updateOne(
              { _id: session._id },
              { $set: { sessionId, lastActiveAt: newNow, lastUsedAt: newNow, ip: clientIp, ipHistory, expiresAt: newExp } }
            ).catch(() => {});
          }
          const authData = { userId: user._id, isAdmin: !!user.isAdmin, user, sessionId, expiresAt: nextExpMs, lastTouchedAt, ipHistory };
          authCache.set(token, authData);
          req.userId    = user._id;
          req.isAdmin   = !!user.isAdmin;
          req.user      = user;
          req.sessionId = sessionId;
          req.token     = token;
          return next();
        }
      }

      // 2. Check Personal Access Tokens (`api_tokens` collection, plaintext token as requested)
      const pat = typeof req.db.collection === 'function'
        ? await req.db.collection('api_tokens').findOne({ token })
        : null;
      if (pat) {
        if (pat.revokedAt) {
          authCache.del(token);
          return res.status(401).json({ error: 'API token has been revoked' });
        }
        const expMs = pat.expiresAt ? new Date(pat.expiresAt).getTime() : null;
        if (expMs !== null && !Number.isNaN(expMs) && expMs < Date.now()) {
          authCache.del(token);
          return res.status(401).json({ error: 'API token has expired' });
        }
        const user = await req.db.collection('users').findOne({ _id: pat.userId });
        if (user && user.isActive !== false) {
          const nowMs = Date.now();
          const newNow = new Date(nowMs);
          req.db.collection('api_tokens').updateOne(
            { _id: pat._id },
            { $set: { lastUsedAt: newNow, lastUsedIp: clientIp } }
          ).catch(() => {});
          const tokenScopes = Array.isArray(pat.scopes) ? pat.scopes : ['read', 'write'];
          const tokenConfinement = (pat.accountId || pat.rootFolderId)
            ? { accountId: pat.accountId || null, rootFolderId: pat.rootFolderId || null }
            : null;
          const authData = {
            userId: user._id,
            isAdmin: !!user.isAdmin,
            user,
            sessionId: `pat:${pat.tokenId || pat._id}`,
            tokenId: String(pat.tokenId || pat._id),
            isPat: true,
            tokenScopes,
            tokenConfinement,
            expiresAt: expMs,
            lastTouchedAt: nowMs,
          };
          authCache.set(token, authData);
          req.userId           = user._id;
          req.isAdmin          = !!user.isAdmin;
          req.user             = user;
          req.sessionId        = authData.sessionId;
          req.token            = token;
          req.tokenId          = authData.tokenId;
          req.tokenScopes      = tokenScopes;
          req.tokenConfinement = tokenConfinement;
          if (!enforceTokenScopeAndConfinement(req, res)) return;
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

const optionalAuth = async (req: any, _res: any, next: any) => {
  req.db = db;
  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const tokenFromQuery = typeof req.query.token === 'string' ? req.query.token : undefined;
  if (!authHeader && !tokenFromQuery) return next();
  let advanced = false;
  const finishAnonymous = () => {
    if (advanced) return;
    advanced = true;
    delete req.userId;
    delete req.isAdmin;
    delete req.user;
    next();
  };
  const noopRes: any = {
    status: () => noopRes,
    json: () => { finishAnonymous(); return noopRes; },
    send: () => { finishAnonymous(); return noopRes; },
  };
  try {
    await requireAuth(req, noopRes, () => {
      if (!advanced) {
        advanced = true;
        next();
      }
    });
  } catch {
    finishAnonymous();
  }
};


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


export function setDb(nextDb: any) {
  db = nextDb;
}
export function incrementActiveHttpConnections() {
  activeHttpConnections++;
}
export function decrementActiveHttpConnections() {
  activeHttpConnections = Math.max(0, activeHttpConnections - 1);
}
export function setShuttingDown(nextVal: boolean) {
  isShuttingDown = nextVal;
}

export {
  PORT,
  SALT_ROUNDS,
  isProduction,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  BASIC_AUTH_ENABLED,
  AUTH_TOKEN,
  timingSafeEqualStrings,
  MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET,
  MICROSOFT_REDIRECT_URI,
  MEDIA_SIGNING_SECRET,
  JOB_MAX_ATTEMPTS,
  JOB_LEASE_MS,
  API_ID,
  API_HASH,
  THUMB_DIR,
  TEMP_DIR,
  TEMP_DROP_DIR,
  SHUTDOWN_TIMEOUT_MS,
  SLOW_REQUEST_MS,
  PROVIDER_API_TIMEOUT_MS,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  MAX_CONCURRENT_UPLOADS_PER_USER,
  MAX_GLOBAL_CONCURRENT_UPLOADS,
  MAX_DAILY_UPLOAD_BYTES_PER_USER,
  MAX_CONCURRENT_DOWNLOADS_PER_USER,
  MAX_JOB_QUEUE_DEPTH,
  WORKER_ID,
  thumbLimit,
  inFlightThumbs,
  inFlightCacheLoads,
  providerLimits,
  MAX_UPLOAD_BYTES,
  MIN_TEMP_FREE_BYTES,
  activeUploadsByUser,
  activeGlobalUploads,
  activeDownloadsByUser,
  activeHttpConnections,
  isShuttingDown,
  systemMetrics,
  recordProviderCall,
  getOpenFileDescriptorCount,
  getTempDirStats,
  acquireUserUploadSlot,
  acquireUserDownloadSlot,
  providerLimit,
  apiError,
  errorCode,
  getFreeBytes,
  hasTempDiskHeadroom,
  signMediaRequest,
  isValidMediaRequest,
  TEMP_FILE_MAX_AGE_MS,
  TEMP_FILE_PREFIXES,
  pruneTempFiles,
  pruneThumbDir,
  buildThumbPath,
  deleteThumbFiles,
  driveCache,
  authCache,
  failedThumbCache,
  withCacheStampedeProtection,
  invalidateDriveCache,
  clearUserAuthCache,
  nanoid12,
  nanoid6,
  nanoid32,
  nanoid,
  escapeRegex,
  upload,
  mongoUri,
  MONGODB_QUERY_TIMEOUT_MS,
  client,
  db,
  wrapDbWithQueryTimeout,
  connectToMongo,
  runIndexDiagnostics,
  runMigration,
  checkAdmin,
  ensureDefaultSettings,
  getUserIdByTg,
  SESSION_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
  parseDeviceNameFromRequest,
  requireAuth,
  requireAuthOrSignedMedia,
  optionalAuth,
  baseUrl,
  redirectUri,
  oauth2Client,
  createOAuthState,
  consumeOAuthState,
};
