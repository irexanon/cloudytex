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

import { TelegramClient } from 'telegram';
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
const AUTH_TOKEN     = Buffer.from(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).toString('base64');

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const MICROSOFT_REDIRECT_URI = `${process.env.APP_URL}/auth/microsoft/callback`;
const MEDIA_SIGNING_SECRET = process.env.MEDIA_SIGNING_SECRET || crypto.randomBytes(32).toString('hex');
if (isProduction && !process.env.MEDIA_SIGNING_SECRET) {
  throw new Error('MEDIA_SIGNING_SECRET is required in production');
}
const JOB_MAX_ATTEMPTS = Number(process.env.JOB_MAX_ATTEMPTS || 3);
const JOB_LEASE_MS = 10 * 60 * 1000;

const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;

// ─── Thumbnail & Disk Cache Configuration ─────────────────────────────────────
const THUMB_DIR = process.env.THUMB_DIR || path.join(os.tmpdir(), 'cloudyte-thumbs');
if (!fs.existsSync(THUMB_DIR)) {
  try { fs.mkdirSync(THUMB_DIR, { recursive: true }); } catch { /* ignore */ }
}

const thumbLimit = pLimit(12);
const inFlightThumbs = new Map<string, Promise<string | null>>();
const providerLimits = new Map<string, ReturnType<typeof pLimit>>();
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_TEMP_FREE_BYTES = Number(process.env.MIN_TEMP_FREE_BYTES || 5 * 1024 * 1024 * 1024);

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
  return res.status(status).json({
    error: message,
    code,
    requestId: requestId || null,
    retryable,
    correlationId: requestId || null,
  });
}

function errorCode(status: number) {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'ACCOUNT_ACCESS_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 507) return 'INSUFFICIENT_STORAGE';
  return 'INTERNAL_ERROR';
}

function getFreeBytes(dir = os.tmpdir()) {
  try {
    const stat = fs.statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

function hasTempDiskHeadroom(requiredBytes = 0) {
  const freeBytes = getFreeBytes();
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

function pruneTempFiles(dir = os.tmpdir()) {
  const cutoff = Date.now() - TEMP_FILE_MAX_AGE_MS;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!TEMP_FILE_PREFIXES.some(prefix => name.startsWith(prefix))) continue;
      const fullPath = path.join(dir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(fullPath);
      } catch { /* another request may have removed or be using the file */ }
    }
  } catch (err) {
    console.error('[TempFiles] Cleanup error:', err);
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

function deleteThumbFiles(fileId: string) {
  try {
    if (!fs.existsSync(THUMB_DIR)) return;
    const files = fs.readdirSync(THUMB_DIR);
    for (const f of files) {
      if (f.startsWith(`${fileId}_`) || f.startsWith(`tg_preview_${fileId}`)) {
        try { fs.unlinkSync(path.join(THUMB_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    console.error(`[Thumbs] Delete error for file ${fileId}:`, err);
  }
}

// ─── Caches ───────────────────────────────────────────────────────────────────
const driveCache            = new NodeCache({ stdTTL: 60, checkperiod: 120 }); // 60s cache for drive listings
const authCache             = new NodeCache({ stdTTL: 60, checkperiod: 120 }); // 60s cache for token -> user auth
const accountCache          = new NodeCache({ stdTTL: 60, checkperiod: 120 }); // 60s cache for account lookups
const fileMetaCache         = new NodeCache({ stdTTL: 120, checkperiod: 180 }); // 2m cache for file metadata lookups
const providerDownloadCache = new NodeCache({ stdTTL: 120, checkperiod: 120 }); // 2m cache for OneDrive URLs / GDrive meta
const tgPeerCache           = new NodeCache({ stdTTL: 600, checkperiod: 300 }); // 10m cache for resolved Telegram peers
const tgMediaCache          = new NodeCache({ stdTTL: 300, checkperiod: 300 }); // 5m cache for Telegram message.media refs
const oneDriveTokenCache    = new Map<string, any>();
const oneDriveRefreshLocks  = new Map<string, Promise<any>>();

function deletePrefixedKeys(cache: NodeCache, prefix: string) {
  const keys = cache.keys().filter(k => k.startsWith(prefix));
  if (keys.length > 0) cache.del(keys);
}

function invalidateDriveCache(accountId: string) {
  if (!accountId) return;
  const keys = driveCache.keys();
  // Cache keys are namespaced as ...:<accountId>:...; avoid broad substring matches.
  const boundary = `:${accountId}:`;
  const toDelete = keys.filter(k => k.includes(boundary) || k.endsWith(`:${accountId}`));
  if (toDelete.length > 0) driveCache.del(toDelete);
  accountCache.del(accountId);
  oneDriveTokenCache.delete(accountId);
  deletePrefixedKeys(fileMetaCache, `${accountId}:`);
  deletePrefixedKeys(providerDownloadCache, `${accountId}:`);
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

// Multer configured with diskStorage in os.tmpdir() with 2 GB limit
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `upload_${Date.now()}_${nanoid(6)}_${safeName}`);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// ─── MongoDB ─────────────────────────────────────────────────────────────────
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const client   = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
let db: any = null;

async function connectToMongo() {
  if (db) return db;
  try {
    await client.connect();
    db = client.db('cloudyte');

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
    try { await db.collection('tg_folders').createIndex({ accountId: 1, path: 1 }); } catch { /* ignore */ }

    // Upload sessions & encryption key backups indexes
    try { await db.collection('upload_sessions').createIndex({ status: 1, expiresAt: 1 }); } catch { /* ignore */ }
    try { await db.collection('upload_sessions').createIndex({ userId: 1, accountId: 1, idempotencyKey: 1 }); } catch { /* ignore */ }
    try { await db.collection('account_encryption_backups').createIndex({ accountId: 1, userId: 1 }, { unique: true }); } catch { /* ignore */ }

    // Additional collection indexes
    try { await db.collection('sessions').createIndex({ createdAt: 1 }, { expireAfterSeconds: 2592000 }); } catch { /* ignore */ }
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
    try { await db.collection('tg_folders').createIndex({ userId: 1 }); } catch { /* ignore */ }
    try { await db.collection('jobs').createIndex({ status: 1, nextRunAt: 1, createdAt: 1 }); } catch { /* ignore */ }
    try { await db.collection('jobs').createIndex({ userId: 1, createdAt: -1 }); } catch { /* ignore */ }
    try { await db.collection('jobs').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); } catch { /* ignore */ }

    await runMigration(db);
    await runEncryptionMigration(db);
    await checkAdmin(db);
    await ensureDefaultSettings(db);
    await runIndexDiagnostics(db);

    return db;
  } catch (err) {
    console.error('MongoDB error:', err);
    throw err;
  }
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

// ─── Auth Middleware with NodeCache ──────────────────────────────────────────
const requireAuth = async (req: any, res: any, next: any) => {
  req.db = db;
  const authHeader     = req.headers.authorization;
  const tokenFromQuery = req.query.token as string | undefined;

  if (authHeader === `Basic ${AUTH_TOKEN}`) {
    req.isAdmin = true;
    return next();
  }

  // Keep ?token= query auth working, but prefer Authorization header
  const token = (authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null) || tokenFromQuery;
  if (token) {
    const cachedAuth = authCache.get(token) as any;
    if (cachedAuth) {
      req.userId  = cachedAuth.userId;
      req.isAdmin = cachedAuth.isAdmin;
      req.user    = cachedAuth.user;
      return next();
    }

    if (req.db) {
      const session = await req.db.collection('sessions').findOne({ token });
      if (session) {
        const user = await req.db.collection('users').findOne({ _id: session.userId });
        if (user && user.isActive !== false) {
          const authData = { userId: user._id, isAdmin: !!user.isAdmin, user };
          authCache.set(token, authData);
          req.userId  = user._id;
          req.isAdmin = !!user.isAdmin;
          req.user    = user;
          return next();
        }
      }
    }
  }
  res.status(401).json({ error: 'Unauthorized' });
};

const requireAuthOrSignedMedia = async (req: any, res: any, next: any) => {
  const { exp, sig } = req.query;
  if (typeof exp === 'string' && typeof sig === 'string' && isValidMediaRequest(req.params.accountId, req.params.fileId, exp, sig)) {
    req.isSignedMedia = true;
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
    accountCache.flushAll();
    fileMetaCache.flushAll();
    providerDownloadCache.flushAll();
    tgPeerCache.flushAll();
    tgMediaCache.flushAll();
    oneDriveTokenCache.clear();
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
  accountCache.flushAll();
  fileMetaCache.flushAll();
  providerDownloadCache.flushAll();
  tgPeerCache.flushAll();
  tgMediaCache.flushAll();
  oneDriveTokenCache.clear();
}

async function getDriveClient(tokens: any) {
  if (testDriveClientFactory) return testDriveClientFactory(tokens);
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials(tokens);
  return google.drive({ version: 'v3', auth });
}

async function getOneDriveClient(tokens: any, accountId?: string) {
  if (testOneDriveClientFactory) return testOneDriveClientFactory(tokens, accountId);
  let activeTokens = (accountId && oneDriveTokenCache.get(accountId)) || tokens;
  if (!activeTokens.expiry_date && activeTokens.expires_in) {
    activeTokens = { ...activeTokens, expiry_date: Date.now() + Number(activeTokens.expires_in) * 1000 };
  }
  if (accountId) oneDriveTokenCache.set(accountId, activeTokens);

  const c = Client.init({
    authProvider: async (done) => {
      try {
        let current = (accountId && oneDriveTokenCache.get(accountId)) || activeTokens;
        const isExpired = !current.expiry_date || Date.now() > current.expiry_date - 300000;
        if (isExpired && current.refresh_token) {
          const lockKey = accountId || current.refresh_token;
          let refreshPromise = oneDriveRefreshLocks.get(lockKey);
          if (!refreshPromise) {
            refreshPromise = (async () => {
              const r = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token',
                new URLSearchParams({
                  client_id: MICROSOFT_CLIENT_ID!, client_secret: MICROSOFT_CLIENT_SECRET!,
                  grant_type: 'refresh_token', refresh_token: current.refresh_token,
                }));
              const refreshed = {
                ...current,
                access_token: r.data.access_token,
                refresh_token: r.data.refresh_token || current.refresh_token,
                expires_in: r.data.expires_in,
                expiry_date: Date.now() + Number(r.data.expires_in) * 1000
              };
              if (accountId) {
                oneDriveTokenCache.set(accountId, refreshed);
                accountCache.del(accountId);
                const d = db || await connectToMongo();
                await d.collection('accounts').updateOne({ _id: new ObjectId(accountId) }, { $set: { tokens: refreshed } });
              }
              return refreshed;
            })().finally(() => {
              oneDriveRefreshLocks.delete(lockKey);
            });
            oneDriveRefreshLocks.set(lockKey, refreshPromise);
          }
          current = await refreshPromise;
          activeTokens = current;
        }
        done(null, current.access_token);
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
  let account = accountCache.get(accountId) as any;
  if (!account) {
    account = await d.collection('accounts').findOne({ _id: new ObjectId(accountId) });
    if (account) accountCache.set(accountId, account);
  }
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
  isAdmin?: boolean
): Promise<{ meta: any | null; accessDenied: boolean }> {
  const d = database || db || await connectToMongo();
  const accIdStr = String(account._id);
  const metaCacheKey = `${accIdStr}:${fileId}`;

  if (account.accountType === 'tgdrive') {
    if (!ObjectId.isValid(fileId)) return { meta: null, accessDenied: false };
    let meta = fileMetaCache.get(metaCacheKey) as any;
    if (meta === undefined) {
      meta = (await d.collection('tg_files').findOne({ _id: new ObjectId(fileId) })) || null;
      fileMetaCache.set(metaCacheKey, meta);
    }
    if (!meta) return { meta: null, accessDenied: false };
    if (String(meta.accountId) !== accIdStr) return { meta: null, accessDenied: true };
    if (!isAdmin && meta.userId && userId && String(meta.userId) !== String(userId)) {
      return { meta: null, accessDenied: true };
    }
    return { meta, accessDenied: false };
  }

  let meta = fileMetaCache.get(metaCacheKey) as any;
  if (meta === undefined) {
    const orClauses: any[] = [{ providerFileId: fileId }];
    if (ObjectId.isValid(fileId)) orClauses.push({ _id: new ObjectId(fileId) });
    meta = (await d.collection('tg_files').findOne({ $or: orClauses })) || null;
    fileMetaCache.set(metaCacheKey, meta);
  }
  if (!meta) return { meta: null, accessDenied: false };
  if (String(meta.accountId) !== accIdStr) return { meta: null, accessDenied: true };
  if (!isAdmin && meta.userId && userId && String(meta.userId) !== String(userId)) {
    return { meta: null, accessDenied: true };
  }
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
    const telegram   = await getTgClient();
    const peerEntity = await resolvePeer(telegram, channelId);
    const result     = await telegram.sendFile(peerEntity, {
      file: filePath,
      caption: effectiveCaption,
      forceDocument: true,
      attributes: [new Api.DocumentAttributeFilename({ fileName: effectiveName })],
    }) as any;
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
      await database.collection('tg_files').insertOne(record);
      return record;
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
    await database.collection('tg_files').insertOne(record);
    return record;
  });
}

async function getCachedTgPeer(telegram: any, channelId: string) {
  if (testResolvePeer) return resolvePeer(telegram, channelId);
  let peer = tgPeerCache.get(channelId);
  if (!peer) {
    peer = await resolvePeer(telegram, channelId);
    if (peer) tgPeerCache.set(channelId, peer);
  }
  return peer;
}

async function getCachedTgMessage(telegram: any, channelId: string, messageId: number, forceRefresh = false) {
  const mediaKey = `${channelId}:${messageId}`;
  if (!forceRefresh && !testTgClientFactory) {
    const cached = tgMediaCache.get(mediaKey);
    if (cached) return cached;
  }
  try {
    const peer = await getCachedTgPeer(telegram, channelId);
    const messages = await telegram.getMessages(peer, { ids: [messageId] });
    if (!messages || !messages[0] || !messages[0].media) throw new Error('Message not found');
    if (!testTgClientFactory) tgMediaCache.set(mediaKey, messages[0], 60); // 60s TTL to prevent stale file references
    return messages[0];
  } catch (err) {
    tgMediaCache.del(mediaKey);
    throw err;
  }
}

// Stream a TG file to an HTTP response (supports Range headers and 1 MB MTProto chunks with robust file reference retry).
async function tgStreamFile(messageId: number, channelId: string, req: any, res: any, meta: any) {
  let clientAborted = false;
  const onClose = () => { clientAborted = true; };
  res.on('close', onClose);

  try {
    const telegram = await getTgClient();
    const mediaKey = `${channelId}:${messageId}`;
    let msg = await getCachedTgMessage(telegram, channelId, messageId);
    let media = msg.media as any;

    const isEncrypted = meta?.isEncrypted === true;
    let totalSize: number = isEncrypted ? Number(meta?.encryptedSizeBytes ?? meta?.size ?? 0) : Number(meta?.size || 0);
    if (!totalSize && media?.document?.size) totalSize = Number(media.document.size);
    const contentType = isEncrypted ? 'application/octet-stream' : (meta?.mimeType || 'application/octet-stream');

    const streamWithRetry = async (opts: any, onChunk: (chunk: Buffer) => Promise<void>) => {
      let attempts = 0;
      while (attempts < 2) {
        attempts++;
        try {
          for await (const rawChunk of telegram.iterDownload({ file: media, ...opts })) {
            if (clientAborted) return;
            await onChunk(rawChunk);
          }
          return;
        } catch (err: any) {
          const errMsg = String(err?.errorMessage || err?.message || '');
          if (attempts < 2 && (errMsg.includes('FILE_REFERENCE') || errMsg.includes('FILE_ID_INVALID') || errMsg.includes('MSG_ID_INVALID'))) {
            tgMediaCache.del(mediaKey);
            msg = await getCachedTgMessage(telegram, channelId, messageId, true);
            media = msg.media as any;
            continue;
          }
          throw err;
        }
      }
    };

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
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   contentType,
      });
      let downloaded = 0;
      await streamWithRetry({ requestSize: 1024 * 1024, offset: BigInt(start) as any }, async (rawChunk) => {
        if (clientAborted) return;
        const remaining = chunkSize - downloaded;
        if (remaining <= 0) return;
        const chunk = rawChunk.length > remaining ? rawChunk.subarray(0, remaining) : rawChunk;
        downloaded += chunk.length;
        const canContinue = res.write(chunk);
        if (!canContinue) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      });
      if (!clientAborted) res.end();
    } else {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      if (totalSize) res.setHeader('Content-Length', totalSize);

      await streamWithRetry({ requestSize: 1024 * 1024 }, async (chunk) => {
        if (clientAborted) return;
        const canContinue = res.write(chunk);
        if (!canContinue) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      });
      if (!clientAborted) res.end();
    }
  } catch (err: any) {
    if (!clientAborted) {
      console.error('tgStreamFile error:', err);
      if (!res.headersSent) res.status(500).send('Streaming error');
    }
  } finally {
    res.off('close', onClose);
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
    const msg = await getCachedTgMessage(telegram, account.channelId, meta.messageId);
    if (!msg || !msg.media) return null;

    const media: any = msg.media;
    const rawThumbs: any[] = (media.document && media.document.thumbs) || (media.photo && media.photo.sizes) || [];

    // Smallest thumb that is >= s px
    const eligibleThumbs = rawThumbs.filter((t: any) => {
      const dim = Math.max(t.w || 0, t.h || 0);
      return dim >= s;
    });
    eligibleThumbs.sort((a: any, b: any) => {
      const dimA = Math.max(a.w || 0, a.h || 0);
      const dimB = Math.max(b.w || 0, b.h || 0);
      return dimA - dimB;
    });

    let sourceBuffer: Buffer | null = null;
    if (eligibleThumbs.length > 0) {
      const chosenThumb = eligibleThumbs[0];
      try {
        const downloaded = await telegram.downloadMedia(msg, { thumb: chosenThumb }) as any;
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
          const downloaded = await telegram.downloadMedia(msg) as any;
          if (downloaded && Buffer.isBuffer(downloaded)) {
            sourceBuffer = downloaded;
          }
        } catch (e) {
          console.warn('[Thumbs] Error downloading image media for thumb:', e);
        }
      }
    }

    if (!sourceBuffer) return null;

    await sharp(sourceBuffer)
      .rotate()
      .resize(s, s, { fit: 'cover' })
      .jpeg({ quality: 75 })
      .toFile(thumbPath);

    return thumbPath;
  } else if (account.accountType === 'google') {
    const drive = await getDriveClient(account.tokens || account.credentials);
    const fileRes = await drive.files.get({ fileId, fields: 'thumbnailLink' });
    let link = fileRes.data.thumbnailLink;
    if (!link) return null;
    link = link.replace(/=s\d+$/, `=s${s}`);

    const resp = await axios.get(link, { responseType: 'arraybuffer' });
    await sharp(Buffer.from(resp.data))
      .rotate()
      .resize(s, s, { fit: 'cover' })
      .jpeg({ quality: 75 })
      .toFile(thumbPath);

    return thumbPath;
  } else if (account.accountType === 'onedrive') {
    const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
    const thumbsRes = await c.api(`/me/drive/items/${fileId}/thumbnails`).get();
    const thumbSet = thumbsRes.value?.[0];
    const thumbUrl = thumbSet?.large?.url || thumbSet?.medium?.url;
    if (!thumbUrl) return null;

    const resp = await axios.get(thumbUrl, { responseType: 'arraybuffer' });
    await sharp(Buffer.from(resp.data))
      .rotate()
      .resize(s, s, { fit: 'cover' })
      .jpeg({ quality: 75 })
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
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-ID');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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
  res.once('finish', () => {
    console.log(JSON.stringify({
      event: 'http_request',
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      userId: req.userId ? String(req.userId) : undefined,
    }));
  });
  next();
});
// Liveness only checks that the process is running; readiness also requires MongoDB.
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/readyz', (_req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: 'Database not ready' });
  res.json({ ok: true });
});

// 7. ROBUSTNESS: Rate limiter for login & register (10 requests/min per IP)
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.UPLOAD_REQUESTS_PER_WINDOW || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Upload rate limit exceeded.', code: 'RATE_LIMITED' },
});

app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/upload', uploadLimiter);
app.use('/api/upload-sessions', uploadLimiter);

// ─── Auth routes ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  
  const database = db || await connectToMongo();
  const globalReg = await database.collection('settings').findOne({ key: 'registrationEnabled' });
  const webReg    = await database.collection('settings').findOne({ key: 'webRegistrationEnabled' });
  
  if (globalReg?.value === false || webReg?.value === false) {
    return res.status(403).json({ error: 'Registration is currently disabled.' });
  }

  const existing = await database.collection('users').findOne({ username });
  if (existing) return res.status(400).json({ error: 'Username already taken' });

  try {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    await database.collection('users').insertOne({
      _id: nanoid() as any,
      username,
      password: hashedPassword,
      tgIds: [],
      isAdmin: false,
      isActive: true,
      createdAt: new Date(),
      createdVia: 'web'
    });
    res.json({ success: true });
  } catch (err: any) {
    if (err.code === 11000) return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/public/settings', async (_req, res) => {
  const database = db || await connectToMongo();
  const settings = await database.collection('settings').find({}).toArray();
  const publicSettings: any = {};
  settings.forEach((s: any) => {
    if (s.key === 'registrationEnabled' || s.key === 'webRegistrationEnabled' || s.key === 'botRegistrationEnabled') {
      publicSettings[s.key] = s.value;
    }
  });
  res.json(publicSettings);
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const database = db || await connectToMongo();
  
  const user = await database.collection('users').findOne({ username });
  if (!user || !user.isActive) return res.status(401).json({ error: 'Invalid credentials or account disabled' });
  
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });
  
  const sessionToken = nanoid(32);
  await database.collection('sessions').insertOne({ 
    token: sessionToken, 
    userId: user._id, 
    username: user.username, 
    createdAt: new Date() 
  });
  
  // Prime auth cache
  authCache.set(sessionToken, { userId: user._id, isAdmin: !!user.isAdmin, user });

  res.json({ success: true, token: sessionToken, username: user.username, isAdmin: !!user.isAdmin });
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
  const userFiles = await database.collection('tg_files').find({ userId: req.params.id }, { projection: { _id: 1 } }).toArray();
  for (const f of userFiles) {
    deleteThumbFiles(String(f._id));
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
  accountCache.flushAll();
  oneDriveTokenCache.clear();
  res.json({ success: true });
});

app.get('/api/admin/users/:id', requireAuth, async (req: any, res: any) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const database = req.db;
  const { id } = req.params;

  const user = await database.collection('users').findOne({ _id: id });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const accounts = await database.collection('accounts').find({ userId: id }).toArray();
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

app.post('/api/admin/settings', requireAuth, async (req: any, res: any) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const database = req.db;
  const { key, value } = req.body;
  await database.collection('settings').updateOne({ key }, { $set: { value } }, { upsert: true });
  res.json({ success: true });
});

app.post('/api/logout', async (req, res) => {
  const authHeader     = req.headers.authorization;
  const tokenFromQuery = req.query.token as string | undefined;
  const token = (authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null) || tokenFromQuery;
  if (token) {
    authCache.del(token);
    const database = db || await connectToMongo();
    await database.collection('sessions').deleteOne({ token });
  }
  res.json({ success: true });
});

// ─── TG Drive – register a channel as an account ─────────────────────────────
app.post('/api/tgdrive/register', requireAuth, async (req: any, res: any) => {
  const { channelId, driveName } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId is required' });

  const userId   = req.userId;
  const database = req.db;
  const name     = (driveName || '').trim() || 'TG Drive';

  try {
    const admins = await bot!.telegram.getChatAdministrators(channelId);
    const botInfo = await bot!.telegram.getMe();
    const isBotAdmin = admins.some((a: any) => a.user.id === botInfo.id);
    if (!isBotAdmin) return res.status(400).json({ error: 'Bot is not an admin in this channel' });
  } catch (e: any) {
    return res.status(400).json({ error: `Cannot access channel: ${e.message}. Make sure the bot is an admin in the channel.` });
  }

  const existingAccount = await database.collection('accounts').findOne({ channelId, userId: { $ne: userId } });
  if (existingAccount) return res.status(400).json({ error: 'This channel is already linked to another Cloudyte account.' });

  await database.collection('accounts').updateOne(
    { userId, channelId, accountType: 'tgdrive' },
    { $set: { userId, channelId, accountType: 'tgdrive', name, linkedAt: new Date().toISOString() } },
    { upsert: true }
  );

  const acc = await database.collection('accounts').findOne({ userId, channelId, accountType: 'tgdrive' });
  const newAccountId = acc!._id;

  // Re-link orphaned files if any (from old account ids but same channel)
  const existingAccountIds = (await database.collection('accounts').find({}, { projection: { _id: 1 } }).toArray()).map((a: any) => a._id);
  await database.collection('tg_files').updateMany(
    { accountId: { $nin: existingAccountIds }, userId: userId },
    { $set: { accountId: newAccountId } }
  );
  await database.collection('tg_folders').updateMany(
    { accountId: { $nin: existingAccountIds }, userId: userId },
    { $set: { accountId: newAccountId } }
  );

  res.json({ success: true, id: newAccountId.toString(), channelId, name });
});

// ─── User settings ────────────────────────────────────────────────────────────
app.post('/api/user/settings', requireAuth, async (req: any, res: any) => {
  const { backupEnabled, backupAccId, isDefaultAccId } = req.body;
  const userId   = req.userId;
  const database = req.db;

  const update: any = {};
  if (backupEnabled !== undefined) update.backupEnabled = backupEnabled;
  if (backupAccId !== undefined) update.backupAccId = backupAccId;
  
  if (Object.keys(update).length > 0) {
    await database.collection('users').updateOne({ _id: userId }, { $set: update });
  }

  if (isDefaultAccId) {
    await database.collection('accounts').updateMany({ userId }, { $set: { isDefault: false } });
    await database.collection('accounts').updateOne({ _id: new ObjectId(isDefaultAccId), userId }, { $set: { isDefault: true } });
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
  let quotaUsage = '0', quotaLimit = '1', displayName = acc.name;
  if (acc.accountType === 'onedrive') {
    const c = await getOneDriveClient(acc.tokens || acc.credentials, acc._id.toString());
    const d = await c.api('/me/drive').get();
    quotaUsage = String(d.quota.used || 0);
    quotaLimit = String(d.quota.total || 1);
    displayName = acc.name || 'OneDrive';
  } else {
    const drive  = await getDriveClient(acc.tokens || acc.credentials);
    const about  = await drive.about.get({ fields: 'storageQuota,user' });
    quotaUsage   = String(about.data.storageQuota?.usage || '0');
    quotaLimit   = String(about.data.storageQuota?.limit || '1');
    displayName  = about.data.user?.displayName || acc.name;
  }
  await database.collection('accounts').updateOne({ _id: acc._id }, { $set: { quotaUsage, quotaLimit, quotaCachedAt: new Date(), name: displayName } });
  return { quotaUsage, quotaLimit, displayName };
}

// ─── /api/accounts ────────────────────────────────────────────────────────────
app.get('/api/accounts', requireAuth, async (req: any, res: any) => {
  const database = req.db;
  const { userId } = req.query;
  const query: any = {};
  
  if (req.isAdmin) {
    if (userId) query.userId = String(userId);
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
        const pipeline = [
          { $match: { accountId: acc._id } },
          { $group: { _id: null, total: { $sum: { $ifNull: ['$encryptedSizeBytes', '$size'] } }, count: { $sum: 1 } } },
        ];
        const [agg] = await database.collection('tg_files').aggregate(pipeline).toArray();
        const usedBytes = agg?.total || 0;
        return {
          id:          acc._id.toString(),
          name:        acc.name || 'TG Drive',
          email:       `Channel: ${acc.channelId}`,
          channelId:   acc.channelId,
          accountType: 'tgdrive',
          usage:       (usedBytes / (1024 ** 3)).toFixed(2) + ' GB',
          total:       '∞',
          percentage:  0,
          fileCount:   agg?.count || 0,
          isDefault:   acc.isDefault || false,
        };
      } catch {
        return { id: acc._id.toString(), name: acc.name || 'TG Drive', email: `Channel: ${acc.channelId}`, channelId: acc.channelId, accountType: 'tgdrive', usage: '0 GB', total: '∞', percentage: 0, error: false };
      }
    }

    try {
      const { quotaUsage, quotaLimit, displayName } = await getAccountQuota(acc, database);
      return { id: acc._id.toString(), name: displayName, email: acc.email, usage: (Number(quotaUsage) / (1024 ** 3)).toFixed(1) + ' GB', total: (Number(quotaLimit) / (1024 ** 3)).toFixed(0) + ' GB', percentage: Math.round((Number(quotaUsage) / Number(quotaLimit)) * 100), accountType: acc.accountType || 'google' };
    } catch {
      return { id: acc._id.toString(), name: acc.name || 'Disconnected', email: acc.email || acc.channelId, error: true, percentage: 0, accountType: acc.accountType || 'google' };
    }
  }));
  res.json(enriched);
});

// ─── /api/storage/summary ─────────────────────────────────────────────────────
app.get('/api/storage/summary', requireAuth, async (req: any, res: any) => {
  const { accountId } = req.query;
  const database      = req.db;

  if (!accountId || typeof accountId !== 'string') {
    return res.status(400).json({ error: 'accountId is required' });
  }

  const { account, accessDenied, invalidId } = await resolveAuthorizedAccount(database, accountId, req.userId, req.isAdmin);
  if (invalidId) return res.status(400).json({ error: 'Invalid accountId' });
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const cacheKey = `storage_summary:${accountId}`;
  const cached = driveCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    if (account.accountType === 'tgdrive') {
      const sizeExpr = { $ifNull: ['$encryptedSizeBytes', { $ifNull: ['$size', 0] }] };
      const mimeExpr = { $ifNull: ['$mimeType', ''] };
      const nameExpr = { $ifNull: ['$name', ''] };
      const isEncryptedExpr = { $eq: ['$isEncrypted', true] };

      const isImage = {
        $and: [
          { $not: [isEncryptedExpr] },
          {
            $or: [
              { $regexMatch: { input: mimeExpr, regex: '^image/', options: 'i' } },
              { $regexMatch: { input: nameExpr, regex: '\\.(jpe?g|png|gif|webp|bmp|svg|heic|ico|tiff?|avif)$', options: 'i' } },
            ],
          },
        ],
      };
      const isVideo = {
        $and: [
          { $not: [isEncryptedExpr] },
          { $not: [isImage] },
          {
            $or: [
              { $regexMatch: { input: mimeExpr, regex: '^video/', options: 'i' } },
              { $regexMatch: { input: nameExpr, regex: '\\.(mp4|mkv|mov|avi|webm|flv|wmv|m4v|3gp|mpe?g)$', options: 'i' } },
            ],
          },
        ],
      };
      const isAudio = {
        $and: [
          { $not: [isEncryptedExpr] },
          { $not: [{ $or: [isImage, isVideo] }] },
          {
            $or: [
              { $regexMatch: { input: mimeExpr, regex: '^audio/', options: 'i' } },
              { $regexMatch: { input: nameExpr, regex: '\\.(mp3|wav|ogg|flac|aac|m4a|wma|opus)$', options: 'i' } },
            ],
          },
        ],
      };
      const isArchive = {
        $and: [
          { $not: [isEncryptedExpr] },
          { $not: [{ $or: [isImage, isVideo, isAudio] }] },
          {
            $or: [
              { $regexMatch: { input: mimeExpr, regex: '(zip|rar|7z|tar|gz|gzip|bzip|xz|compressed)', options: 'i' } },
              { $regexMatch: { input: nameExpr, regex: '\\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst)$', options: 'i' } },
            ],
          },
        ],
      };
      const isDocument = {
        $and: [
          { $not: [isEncryptedExpr] },
          { $not: [{ $or: [isImage, isVideo, isAudio, isArchive] }] },
          {
            $or: [
              { $regexMatch: { input: mimeExpr, regex: '(pdf|msword|wordprocessingml|ms-excel|spreadsheetml|ms-powerpoint|presentationml|opendocument|^text/|rtf|csv|json|xml)', options: 'i' } },
              { $regexMatch: { input: nameExpr, regex: '\\.(pdf|docx?|xlsx?|pptx?|txt|rtf|csv|md|odt|ods|odp)$', options: 'i' } },
            ],
          },
        ],
      };
      const isOther = {
        $or: [
          isEncryptedExpr,
          { $not: [{ $or: [isImage, isVideo, isAudio, isArchive, isDocument] }] },
        ],
      };

      const pipeline = [
        { $match: { accountId: account._id } },
        {
          $group: {
            _id:       null,
            usedBytes: { $sum: sizeExpr },
            fileCount: { $sum: 1 },
            images:    { $sum: { $cond: [isImage, sizeExpr, 0] } },
            videos:    { $sum: { $cond: [isVideo, sizeExpr, 0] } },
            audio:     { $sum: { $cond: [isAudio, sizeExpr, 0] } },
            documents: { $sum: { $cond: [isDocument, sizeExpr, 0] } },
            archives:  { $sum: { $cond: [isArchive, sizeExpr, 0] } },
            other:     { $sum: { $cond: [isOther, sizeExpr, 0] } },
          },
        },
      ];

      const [agg] = await database.collection('tg_files').aggregate(pipeline).toArray();
      const summary = {
        accountId:   account._id.toString(),
        accountType: 'tgdrive' as const,
        usedBytes:   agg?.usedBytes || 0,
        totalBytes:  null,
        fileCount:   agg?.fileCount || 0,
        categories: {
          images:    agg?.images || 0,
          videos:    agg?.videos || 0,
          audio:     agg?.audio || 0,
          documents: agg?.documents || 0,
          archives:  agg?.archives || 0,
          other:     agg?.other || 0,
        },
      };
      driveCache.set(cacheKey, summary, 60);
      return res.json(summary);
    }

    const { quotaUsage, quotaLimit } = await getAccountQuota(account, database);
    const summary = {
      accountId:   account._id.toString(),
      accountType: (account.accountType === 'onedrive' ? 'onedrive' : 'google') as 'google' | 'onedrive',
      usedBytes:   Number(quotaUsage) || 0,
      totalBytes:  Number(quotaLimit) || 0,
      fileCount:   null,
      categories:  null,
    };
    driveCache.set(cacheKey, summary, 60);
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

    const etag = `"${fileId}_${s}"`;
    const thumbFile = `${fileId}_${s}.jpg`;
    const thumbPath = path.join(THUMB_DIR, thumbFile);

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
    const inFlightKey = `${fileId}_${s}`;
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

      const fileFilter: any = { accountId: account._id };
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
        const r = await c.api(`/me/drive/root/search(q='${(search as string).replace(/'/g, "''")}')`).get();
        rawFiles = r.value.map((f: any) => ({ id: f.id, name: f.name, mimeType: f.folder ? 'folder' : (f.file?.mimeType || ''), size: f.size, modifiedTime: f.lastModifiedDateTime, createdTime: f.createdDateTime, webViewLink: f.webUrl }));
      } else {
        const effectiveFolderId = (folderId as string) || 'root';
        const itemPath = effectiveFolderId === 'root' ? '/me/drive/root' : `/me/drive/items/${effectiveFolderId}`;
        const nextUrl = cursorStr ? Buffer.from(cursorStr, 'base64url').toString('utf8') : null;
        const r = (nextUrl && nextUrl.startsWith('https://graph.microsoft.com/'))
          ? await c.api(nextUrl).get()
          : await c.api(`${itemPath}/children`).top(200).get();
        if (r['@odata.nextLink']) {
          nextPageCursor = Buffer.from(String(r['@odata.nextLink']), 'utf8').toString('base64url');
          res.setHeader('X-Next-Cursor', nextPageCursor);
        }
        rawFiles = (r.value || []).map((f: any) => ({ id: f.id, name: f.name, mimeType: f.folder ? 'folder' : (f.file?.mimeType || ''), size: f.size, modifiedTime: f.lastModifiedDateTime, createdTime: f.createdDateTime, webViewLink: f.webUrl }));
      }
    } else {
      // ── Google Drive ────────────────────────────────────────────────────────
      const drive = await getDriveClient(account.tokens || account.credentials);
      const qParts = ['trashed = false'];
      if (search) qParts.push(`name contains '${(search as string).replace(/'/g, "\\'")}'`);
      else qParts.push(`'${folderId || 'root'}' in parents`);
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

// ─── Delete file ──────────────────────────────────────────────────────────────
app.delete('/api/files/:fileId', requireAuth, async (req: any, res: any) => {
  const { fileId }    = req.params;
  const { accountId } = req.query;
  const userId        = req.userId;
  const database      = req.db;

  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId as string, userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    if (account.accountType === 'tgdrive') {
      const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, account, fileId, userId, req.isAdmin);
      if (fileDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this file', req.requestId);
      if (!meta) return res.status(404).json({ error: 'File not found' });
      
      const referenceCount = await database.collection('tg_files').countDocuments({ messageId: meta.messageId, accountId: meta.accountId });
      
      if (referenceCount <= 1) {
        const telegram = await getTgClient();
        const peer     = await resolvePeer(telegram, account.channelId);
        try { await telegram.deleteMessages(peer, [meta.messageId], { revoke: true }); } catch { /* message may already be gone */ }
      }
      
      await database.collection('tg_files').deleteOne({ _id: meta._id });
    } else if (account.accountType === 'onedrive') {
      const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
      await c.api(`/me/drive/items/${fileId}`).delete();
      await database.collection('tg_files').deleteMany({ accountId: account._id, providerFileId: String(fileId) });
    } else {
      const drive = await getDriveClient(account.tokens || account.credentials);
      await drive.files.delete({ fileId });
      await database.collection('tg_files').deleteMany({ accountId: account._id, providerFileId: String(fileId) });
    }

    deleteThumbFiles(fileId);
    invalidateDriveCache(accountId as string);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Rename file ──────────────────────────────────────────────────────────────
app.patch('/api/files/:fileId', requireAuth, async (req: any, res: any) => {
  const { fileId }    = req.params;
  const { accountId } = req.query;
  const { name }      = req.body;
  const userId        = req.userId;
  const database      = req.db;

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
    if (plainErr) return apiError(res, plainErr.status, plainErr.code, plainErr.message, req.requestId);
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
  if (nameErr) return apiError(res, nameErr.status, nameErr.code, nameErr.message, req.requestId);
  const folderCheck = validateSafeFolderId(parentId);
  if (!folderCheck.ok) return apiError(res, folderCheck.error.status, folderCheck.error.code, folderCheck.error.message, req.requestId);

  try {
    if (account.accountType === 'tgdrive') {
      const parentPath = folderCheck.folderId === 'root' ? '' : folderCheck.folderId;
      const folderPath = parentPath ? `${parentPath}/${name}` : name;
      await database.collection('tg_folders').updateOne(
        { accountId: account._id, path: folderPath },
        { $set: { accountId: account._id, name, path: folderPath, createdAt: Math.floor(Date.now() / 1000) } },
        { upsert: true }
      );
    } else if (account.accountType === 'onedrive') {
      const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
      const parentPath = (!parentId || parentId === 'root') ? '/me/drive/root' : `/me/drive/items/${parentId}`;
      await c.api(`${parentPath}/children`).post({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' });
    } else {
      const drive = await getDriveClient(account.tokens || account.credentials);
      await drive.files.create({ requestBody: { name, parents: [parentId || 'root'], mimeType: 'application/vnd.google-apps.folder' } });
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
    if (!result?.uploadUrl) throw new Error('OneDrive did not return an upload session URL');
    const next = { providerType: 'onedrive', uploadUrl: result.uploadUrl, nextOffset: 0 };
    await persist(next);
    return next;
  };
  let state = prior?.providerType === 'onedrive' && prior.uploadUrl ? prior : await createSession();
  const sessionStatus = async () => axios.get(state.uploadUrl!, { validateStatus: () => true });
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
    const response = await axios.put(state.uploadUrl!, fs.createReadStream(file.path, { start: offset, end }), {
      headers: { 'Content-Range': `bytes ${offset}-${end}/${file.size}`, 'Content-Length': length },
      maxBodyLength: Infinity, maxContentLength: Infinity, validateStatus: () => true
    });
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
  // A final 202 means the provider still has work; query once to confirm commit rather than
  // treating all input bytes as proof that the remote item is durable.
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
    const safeValue = idempotencyKey.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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
    const response = await axios.post(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name',
      { name: file.originalname, parents: [folderId || 'root'], ...(appProperties ? { appProperties } : {}) },
      { headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': file.mimetype, 'X-Upload-Content-Length': String(file.size)
      }, validateStatus: () => true }
    );
    if (response.status < 200 || response.status >= 300) throw new Error(`Google Drive session creation failed (${response.status}): ${JSON.stringify(response.data).slice(0, 500)}`);
    const uploadUrl = response.headers.location || response.headers.Location;
    if (!uploadUrl) throw new Error('Google Drive did not return a resumable session URI');
    const state: PersistedProviderSession = { providerType: 'google', uploadUrl, nextOffset: 0 };
    await persist(state);
    return state;
  };
  let state = prior?.providerType === 'google' && prior.uploadUrl ? prior : await createSession();
  const queryOffset = async () => {
    const token = await getToken();
    const response = await axios.put(state.uploadUrl!, Buffer.alloc(0), {
      headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0', 'Content-Range': `bytes */${file.size}` },
      maxRedirects: 0, validateStatus: () => true
    });
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
    const response = await axios.put(state.uploadUrl!, fs.createReadStream(file.path, { start: offset, end }), {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.mimetype, 'Content-Length': String(length), 'Content-Range': `bytes ${offset}-${end}/${file.size}` },
      maxBodyLength: Infinity, maxContentLength: Infinity, maxRedirects: 0, validateStatus: () => true
    });
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
          const chunkSize = 320 * 1024 * 10;
          for (let start = 0; start < file.size; start += chunkSize) {
            const end = Math.min(start + chunkSize, file.size);
            const r = await axios.put(session.uploadUrl, fs.createReadStream(file.path, { start, end: end - 1 }), {
              headers: { 'Content-Range': `bytes ${start}-${end - 1}/${file.size}`, 'Content-Length': end - start }
            });
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
  const stale = await sessions.find({ status: { $in: ['active', 'expired', 'cancelled'] }, expiresAt: { $lte: now } }).limit(500).toArray();
  for (const session of stale) {
    await withSessionLock(session.sessionId, async () => {
      if (session.tempPath) { try { fs.unlinkSync(session.tempPath); } catch (error: any) { if (error?.code !== 'ENOENT') console.error('[UploadSessions] Cleanup failed:', error); } }
      await sessions.updateOne({ sessionId: session.sessionId, status: 'active', expiresAt: { $lte: now } }, { $set: { status: 'expired', updatedAt: now } });
    });
  }
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
  if (session.status === 'active' && new Date(session.expiresAt || (new Date(session.createdAt).getTime() + UPLOAD_SESSION_TTL_MS)).getTime() <= Date.now()) {
    await sessions.updateOne({ sessionId: session.sessionId, status: 'active' }, { $set: { status: 'expired', updatedAt: new Date() } });
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
    size,
    folderId = 'root',
    checksum,
    idempotencyKey,
    providerType: requestedProviderType,
    desiredChunkSize,
    isEncrypted,
    encryptionFormatVersion,
    encryptionKeyId,
    encryptedMetadata,
    opaqueRemoteName,
    encryptedSizeBytes,
  } = req.body || {};

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

  const sessions = req.db.collection('upload_sessions');
  const existing = await sessions.findOne({ userId: String(req.userId || ''), accountId, idempotencyKey, status: { $in: ['active', 'completed', 'completing'] } });
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
    tempPath: path.join(os.tmpdir(), `transfer_${nanoid(18)}.part`),
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
app.put('/api/upload-sessions/:sessionId/chunks', requireAuth, upload.single('chunk'), async (req: any, res: any) => withSessionLock(req.params.sessionId, async () => {
  const sessions = req.db.collection('upload_sessions');
  const { session, accessDenied } = await resolveUploadSessionForRequest(req, req.params.sessionId);
  const chunk = req.file;
  if (accessDenied) {
    if (chunk?.path && fs.existsSync(chunk.path)) { try { fs.unlinkSync(chunk.path); } catch { /* ignore */ } }
    return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this upload session', req.requestId);
  }
  if (!session) {
    if (chunk?.path && fs.existsSync(chunk.path)) { try { fs.unlinkSync(chunk.path); } catch { /* ignore */ } }
    return apiError(res, 404, 'UPLOAD_SESSION_NOT_FOUND', 'Upload session not found', req.requestId);
  }
  await expireUploadSessionIfNeeded(sessions, session);
  if (session.status === 'expired') return apiError(res, 410, 'UPLOAD_SESSION_EXPIRED', 'Upload session expired', req.requestId, true);
  if (session.status !== 'active') return apiError(res, 409, 'UPLOAD_SESSION_NOT_ACTIVE', `Upload session is ${session.status}`, req.requestId);
  if (!chunk) return apiError(res, 400, 'NO_CHUNK_UPLOADED', 'No chunk uploaded', req.requestId);
  const range = String(req.header('Content-Range') || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  const start = range ? Number(range[1]) : Number(req.header('X-Chunk-Offset'));
  const end = range ? Number(range[2]) : start + chunk.size - 1;
  const total = range ? Number(range[3]) : session.totalBytes;
  let chunkLockOwner: string | null = null;
  try {
    if (!Number.isFinite(start) || end < start || total !== session.totalBytes || end - start + 1 !== chunk.size) {
      return apiError(res, 400, 'INVALID_CONTENT_RANGE', 'Content-Range does not match the uploaded chunk', req.requestId);
    }
    // Exact replay after a lost response is acknowledged only when bytes match the durable file.
    if (start < session.receivedBytes) {
      if (end >= session.receivedBytes || !fs.existsSync(session.tempPath) || fs.statSync(session.tempPath).size < end + 1) {
        return apiError(res, 409, 'UPLOAD_SESSION_OFFSET_CONFLICT', `Expected offset ${session.receivedBytes}`, req.requestId);
      }
      const existing = Buffer.alloc(chunk.size);
      const fd = fs.openSync(session.tempPath, 'r');
      try { fs.readSync(fd, existing, 0, existing.length, start); } finally { fs.closeSync(fd); }
      const incoming = fs.readFileSync(chunk.path);
      const committed = (session.committedChunks || []).find((item: any) => item.offset === start && item.length === chunk.size);
      const incomingDigest = crypto.createHash('sha256').update(incoming).digest('hex');
      if (!committed || committed.checksum !== incomingDigest || !existing.equals(incoming)) return apiError(res, 409, 'UPLOAD_SESSION_OFFSET_CONFLICT', 'Repeated chunk bytes differ from the committed chunk', req.requestId);
      return res.json({ sessionId: session.sessionId, receivedBytes: session.receivedBytes, totalBytes: session.totalBytes, nextOffset: session.receivedBytes, complete: session.receivedBytes === session.totalBytes });
    }
    if (start !== session.receivedBytes) return apiError(res, 409, 'UPLOAD_SESSION_OFFSET_CONFLICT', `Expected offset ${session.receivedBytes}`, req.requestId);
    if (!hasTempDiskHeadroom(chunk.size)) return apiError(res, 507, 'INSUFFICIENT_STORAGE', 'Server temporary storage is too low', req.requestId);
    chunkLockOwner = nanoid(16);
    const acquired = await sessions.updateOne({
      sessionId: session.sessionId, userId: String(session.userId || ''), status: 'active', receivedBytes: session.receivedBytes,
      $or: [{ chunkLeaseExpiresAt: { $exists: false } }, { chunkLeaseExpiresAt: { $lte: Date.now() } }]
    }, { $set: { chunkLeaseOwner: chunkLockOwner, chunkLeaseExpiresAt: Date.now() + 2 * 60 * 1000 } });
    if (acquired.modifiedCount !== 1) return apiError(res, 409, 'UPLOAD_SESSION_OFFSET_CONFLICT', 'Another chunk write is in progress', req.requestId);
    fs.mkdirSync(path.dirname(session.tempPath), { recursive: true });
    const existingSize = fs.existsSync(session.tempPath) ? fs.statSync(session.tempPath).size : 0;
    if (existingSize < session.receivedBytes) return apiError(res, 500, 'UPLOAD_STORAGE_CORRUPT', 'Staged file is shorter than its committed offset', req.requestId);
    if (existingSize > session.receivedBytes) fs.truncateSync(session.tempPath, session.receivedBytes);
    fs.appendFileSync(session.tempPath, fs.readFileSync(chunk.path));
    const receivedBytes = session.receivedBytes + chunk.size;
    const chunkChecksum = crypto.createHash('sha256').update(fs.readFileSync(chunk.path)).digest('hex');
    const committedChunks = [...(session.committedChunks || []), { offset: start, length: chunk.size, checksum: chunkChecksum }];
    const updated = await sessions.updateOne({ sessionId: session.sessionId, userId: String(session.userId || ''), status: 'active', receivedBytes: session.receivedBytes, chunkLeaseOwner: chunkLockOwner }, { $set: { receivedBytes, committedChunks, updatedAt: new Date() }, $unset: { chunkLeaseOwner: '', chunkLeaseExpiresAt: '' } });
    if (updated.modifiedCount !== 1) return apiError(res, 409, 'UPLOAD_SESSION_OFFSET_CONFLICT', 'Upload session changed while writing this chunk', req.requestId);
    chunkLockOwner = null;
    return res.json({ sessionId: session.sessionId, receivedBytes, totalBytes: session.totalBytes, nextOffset: receivedBytes, complete: receivedBytes === session.totalBytes });
  } finally {
    if (chunkLockOwner) {
      try { if (session.tempPath && fs.existsSync(session.tempPath)) fs.truncateSync(session.tempPath, session.receivedBytes); } catch (rollbackError) { console.error(JSON.stringify({ event: 'upload_chunk_rollback_failed', sessionId: session.sessionId, correlationId: req.requestId, error: String(rollbackError) })); }
      await sessions.updateOne({ sessionId: session.sessionId, chunkLeaseOwner: chunkLockOwner }, { $unset: { chunkLeaseOwner: '', chunkLeaseExpiresAt: '' } });
    }
    if (chunk?.path && fs.existsSync(chunk.path)) { try { fs.unlinkSync(chunk.path); } catch { /* janitor will retry */ } }
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
    invalidateDriveCache(session.accountId);
    if (fs.existsSync(session.tempPath)) { try { fs.unlinkSync(session.tempPath); } catch { /* janitor will retry */ } }
    return res.json(finalPayload);
  } catch (err: any) {
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
  const allowed = completing ? ['completing'] : ['active', 'expired', 'cancelled'];
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

  if (!hasTempDiskHeadroom(file.size)) {
    cleanupTemp();
    return apiError(res, 507, 'INSUFFICIENT_STORAGE', 'Server temporary storage is too low for this upload', req.requestId);
  }

  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, userId, req.isAdmin);
  if (accessDenied) {
    cleanupTemp();
    return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  }
  if (!account) {
    cleanupTemp();
    return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);
  }

  const validation = validateUploadRequest({
    fileName: body.fileName || file.originalname,
    mimeType: body.mimeType || file.mimetype,
    size: file.size,
    folderId: body.folderId || 'root',
    checksum: body.checksum || body.encryptedChecksum,
    isEncrypted: body.isEncrypted,
    encryptionFormatVersion: body.encryptionFormatVersion,
    encryptionKeyId: body.encryptionKeyId,
    encryptedMetadata: body.encryptedMetadata,
    opaqueRemoteName: body.opaqueRemoteName,
    encryptedSizeBytes: body.encryptedSizeBytes !== undefined ? body.encryptedSizeBytes : (body.size !== undefined ? body.size : undefined),
  });
  if (!validation.ok) {
    cleanupTemp();
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

    await uploadFileToProvider(
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
      body.idempotencyKey,
      spec,
      String(userId || account.userId || '')
    );
    invalidateDriveCache(accountId);
    res.json({
      success: true,
      isEncrypted: spec.isEncrypted,
      encryptionFormatVersion: spec.encryptionFormatVersion,
      encryptionKeyId: spec.encryptionKeyId,
      encryptedChecksum: spec.isEncrypted ? spec.checksum : null,
      encryptedSizeBytes: spec.isEncrypted ? spec.size : null,
    });
  } catch (err: any) {
    console.error('Upload error:', err);
    if (err?.code === 'UNSUPPORTED_PROVIDER_OPERATION') return apiError(res, 422, err.code, err.message, req.requestId);
    apiError(res, 502, 'PROVIDER_UPLOAD_FAILED', 'Provider upload failed', req.requestId);
  } finally {
    cleanupTemp();
  }
});

app.get('/api/media-link/:accountId/:fileId', requireAuth, async (req: any, res: any) => {
  const { accountId, fileId } = req.params;
  const database = req.db;
  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, req.userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const sig = signMediaRequest(accountId, fileId, expiresAt);
  const baseUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  res.json({ url: `${baseUrl}/api/download/${encodeURIComponent(accountId)}/${encodeURIComponent(fileId)}?exp=${expiresAt}&sig=${encodeURIComponent(sig)}`, expiresAt });
});

// ─── 4. Download (authed) ─────────────────────────────────────────────────────
async function handleDownloadRequest(req: any, res: any, isHead = false) {
  const { accountId, fileId } = req.params;
  const userId                = req.userId;
  const database              = req.db;

  try {
    let account: any = null;
    if (req.isSignedMedia) {
      const resolved = await resolveAuthorizedAccount(database, accountId, null, true);
      account = resolved.account;
    } else {
      const resolved = await resolveAuthorizedAccount(database, accountId, userId, req.isAdmin);
      if (resolved.accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
      account = resolved.account;
    }
    if (!account) return res.status(404).send('Account not found');

    const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, account, fileId, userId, req.isAdmin || Boolean(req.isSignedMedia));
    if (fileDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this file', req.requestId);

    res.setHeader('Accept-Ranges', 'bytes');
    const isPreview = req.query.preview === '1';
    const dispositionType = (meta?.isEncrypted === true) ? 'attachment' : (isPreview ? 'inline' : 'attachment');

    if (account.accountType === 'tgdrive') {
      if (!meta) return res.status(404).send('File not found');

      const etag = meta.isEncrypted && meta.encryptedChecksum
        ? `"${meta.encryptedChecksum}"`
        : `"${meta._id}-${meta.size}"`;
      res.setHeader('ETag', etag);
      if (isPreview && !meta.isEncrypted) {
        res.setHeader('Cache-Control', 'private, max-age=86400');
      }
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      const downloadName = meta.isEncrypted ? (meta.opaqueRemoteName || meta.name) : meta.name;
      res.setHeader('Content-Disposition', `${dispositionType}; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
      res.setHeader('Content-Type', meta.isEncrypted ? 'application/octet-stream' : (meta.mimeType || 'application/octet-stream'));
      const tgSize = meta.isEncrypted ? Number(meta.encryptedSizeBytes ?? meta.size ?? 0) : Number(meta.size || 0);
      if (isHead) {
        if (tgSize) res.setHeader('Content-Length', tgSize);
        return res.status(200).end();
      }
      await tgStreamFile(meta.messageId, account.channelId, req, res, meta);
      return;
    }

    if (account.accountType === 'onedrive') {
      const odCacheKey = `${account._id}:${fileId}`;
      let item = providerDownloadCache.get(odCacheKey) as any;
      if (!item) {
        const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
        item = await c.api(`/me/drive/items/${fileId}`).get();
        if (item && item['@microsoft.graph.downloadUrl']) {
          providerDownloadCache.set(odCacheKey, item);
        }
      }
      const dlUrl = item?.['@microsoft.graph.downloadUrl'];
      if (!dlUrl) return res.status(404).send('Download link not available');

      const isEncrypted = meta?.isEncrypted === true;
      const downloadName = isEncrypted ? (meta.opaqueRemoteName || item.name) : item.name;
      const etag = isEncrypted && meta?.encryptedChecksum
        ? `"${meta.encryptedChecksum}"`
        : (item.eTag ? `"${String(item.eTag).replace(/"/g, '')}"` : `"od-${fileId}-${item.size || 0}"`);
      res.setHeader('ETag', etag);
      if (isPreview && !isEncrypted) {
        res.setHeader('Cache-Control', 'private, max-age=86400');
      }
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      // Direct CDN redirect for unencrypted OneDrive downloads/streams (eliminates double-hop proxy latency).
      if (!isEncrypted && !isHead && req.query.proxy !== '1' && req.query.redirect !== '0') {
        return res.redirect(302, dlUrl);
      }

      res.setHeader('Content-Disposition', `${dispositionType}; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
      res.setHeader('Content-Type', isEncrypted ? 'application/octet-stream' : (item.file?.mimeType || 'application/octet-stream'));
      if (isHead) {
        if (item.size) res.setHeader('Content-Length', item.size);
        return res.status(200).end();
      }

      let response = await axios.get(dlUrl, {
        responseType: 'stream',
        headers: req.headers.range ? { Range: req.headers.range } : undefined,
        validateStatus: (status: number) => status === 200 || status === 206 || status === 416 || status === 401 || status === 403
      });
      // If cached pre-signed URL expired early, refresh once and retry.
      if (response.status === 401 || response.status === 403) {
        providerDownloadCache.del(odCacheKey);
        const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
        item = await c.api(`/me/drive/items/${fileId}`).get();
        const freshUrl = item?.['@microsoft.graph.downloadUrl'];
        if (!freshUrl) return res.status(404).send('Download link not available');
        providerDownloadCache.set(odCacheKey, item);
        response = await axios.get(freshUrl, {
          responseType: 'stream',
          headers: req.headers.range ? { Range: req.headers.range } : undefined,
          validateStatus: (status: number) => status === 200 || status === 206 || status === 416
        });
      }
      if (response.status === 416) {
        if (response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
        return res.status(416).end();
      }
      if (response.status === 206) res.status(206);
      for (const header of ['content-range', 'content-length', 'accept-ranges']) {
        if (response.headers[header]) res.setHeader(header, response.headers[header]);
      }
      return response.data.pipe(res);
    }

    const drive = await getDriveClient(account.tokens || account.credentials);
    const gdCacheKey = `${account._id}:${fileId}`;
    let fileMeta = providerDownloadCache.get(gdCacheKey) as any;
    if (!fileMeta) {
      const file = await drive.files.get({ fileId, fields: 'name,mimeType,size,modifiedTime,md5Checksum' });
      fileMeta = file.data;
      providerDownloadCache.set(gdCacheKey, fileMeta, 300);
    }

    const isEncrypted = meta?.isEncrypted === true;
    const fileName = isEncrypted ? (meta.opaqueRemoteName || fileMeta.name || 'file') : (fileMeta.name || 'file');
    const etag = isEncrypted && meta?.encryptedChecksum
      ? `"${meta.encryptedChecksum}"`
      : `"gd-${fileId}-${fileMeta.md5Checksum || fileMeta.modifiedTime || fileMeta.size || 0}"`;
    res.setHeader('ETag', etag);
    if (isPreview && !isEncrypted) {
      res.setHeader('Cache-Control', 'private, max-age=86400');
    }
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Disposition', `${dispositionType}; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Content-Type', isEncrypted ? 'application/octet-stream' : (fileMeta.mimeType || 'application/octet-stream'));
    if (isHead) {
      if (fileMeta.size) res.setHeader('Content-Length', fileMeta.size);
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
      const contentRange = response.headers?.['content-range'] || (fileMeta.size ? `bytes */${fileMeta.size}` : undefined);
      if (contentRange) res.setHeader('Content-Range', contentRange);
      return res.status(416).end();
    }
    if (response.status === 206) res.status(206);
    for (const header of ['content-range', 'content-length', 'accept-ranges']) {
      const value = response.headers?.[header];
      if (value) res.setHeader(header, value);
    }
    response.data.pipe(res);
  } catch (err: any) {
    console.error('Download error:', err);
    const upstreamStatus = err?.response?.status || err?.code;
    if (!res.headersSent) {
      if (upstreamStatus === 416) {
        const cr = err?.response?.headers?.['content-range'];
        if (cr) res.setHeader('Content-Range', cr);
        return res.status(416).end();
      }
      if (upstreamStatus === 404) return res.status(404).send('File not found');
      if (upstreamStatus === 401 || upstreamStatus === 403) return res.status(upstreamStatus).send(err.message);
      res.status(500).send(err.message);
    }
  }
}

app.head('/api/download/:accountId/:fileId', requireAuthOrSignedMedia, (req: any, res: any) => handleDownloadRequest(req, res, true));
app.get('/api/download/:accountId/:fileId', requireAuthOrSignedMedia, (req: any, res: any) => handleDownloadRequest(req, res, false));

// ─── Share ────────────────────────────────────────────────────────────────────
app.post('/api/share', requireAuth, async (req: any, res: any) => {
  const { accountId, fileId } = req.body;
  const userId                = req.userId;
  const database              = req.db;

  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

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
      return res.json({ success: true, shareUrl: `${process.env.APP_URL}/s/${shareId}` });
    }

    const shareId = nanoid(6);
    await database.collection('shares').insertOne({ shareId, accountId: account._id, fileId, createdAt: new Date().toISOString() });
    res.json({ success: true, shareUrl: `${process.env.APP_URL}/s/${shareId}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Move ────────────────────────────────────────────────────────────────────
app.post('/api/files/move', requireAuth, async (req: any, res: any) => {
  const { sourceAccountId, fileId, targetAccountId, targetFolderId } = req.body;
  const userId = req.userId;
  const database = req.db;

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
      const drive = await getDriveClient(account.tokens || account.credentials);
      const file = await drive.files.get({ fileId, fields: 'parents' });
      const previousParents = file.data.parents?.join(',') || '';
      const realTargetId = folderCheck.folderId === 'root' ? 'root' : folderCheck.folderId;
      
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
      const token = account.tokens?.access_token || account.credentials?.access_token;
      const realTargetId = folderCheck.folderId === 'root' ? 'root' : folderCheck.folderId;
      const url = `https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`;
      await axios.patch(url, {
        parentReference: {
          id: realTargetId === 'root' ? (await axios.get('https://graph.microsoft.com/v1.0/me/drive/root', { headers: { Authorization: `Bearer ${token}` } })).data.id : realTargetId
        }
      }, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
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
  const { sourceAccountId, fileId, targetAccountId, targetFolderId } = req.body;
  const userId = req.userId;
  const database = req.db;

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
      const drive = await getDriveClient(account.tokens || account.credentials);
      const realTargetId = folderCheck.folderId === 'root' ? 'root' : folderCheck.folderId;
      
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
      const token = account.tokens?.access_token || account.credentials?.access_token;
      let realTargetId = folderCheck.folderId;
      if (folderCheck.folderId === 'root') {
         const rootRes = await axios.get('https://graph.microsoft.com/v1.0/me/drive/root', { headers: { Authorization: `Bearer ${token}` } });
         realTargetId = rootRes.data.id;
      }
      const url = `https://graph.microsoft.com/v1.0/me/drive/items/${fileId}/copy`;
      const copyRes = await axios.post(url, {
        parentReference: {
          id: realTargetId
        },
        ...(meta?.isEncrypted ? { name: meta.opaqueRemoteName || meta.name } : {})
      }, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      if (meta?.isEncrypted) {
        const now = new Date();
        const clonedMeta = { ...meta };
        delete clonedMeta._id;
        if (copyRes?.data?.id) clonedMeta.providerFileId = String(copyRes.data.id);
        clonedMeta.folder = folderCheck.folderId === 'root' ? '' : folderCheck.folderId;
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
      return r.data.pipe(res);
    }

    const drive    = await getDriveClient(account.tokens || account.credentials);
    const file     = await drive.files.get({ fileId: share.fileId, fields: 'name,mimeType' });
    const fileName = file.data.name || 'file';
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Content-Type', file.data.mimeType || 'application/octet-stream');
    const response = await drive.files.get({ fileId: share.fileId, alt: 'media' }, { responseType: 'stream', headers: req.headers.range ? { Range: req.headers.range } : undefined });
    if (response.status === 206) res.status(206);
    for (const header of ['content-range', 'content-length', 'accept-ranges']) { const value = response.headers?.[header]; if (value) res.setHeader(header, value); }
    response.data.pipe(res);
  } catch (err: any) {
    if (!res.headersSent) res.status(500).send('Download failed');
  }
});

// ─── Public share page ────────────────────────────────────────────────────────
app.get('/s/:shareId', async (req: any, res: any) => {
  const { shareId } = req.params;
  const database    = db || await connectToMongo();

  try {
    const tgMeta = await database.collection('tg_files').findOne({ shareId });
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
    const account = await database.collection('accounts').findOne({ _id: share.accountId });
    if (!account) return res.status(404).send('Account disconnected');

    const { meta } = await resolveFileMetadataForAccount(database, account, String(share.fileId), null, true);
    if (meta?.isEncrypted === true) {
      return apiError(res, 409, 'ENCRYPTED_SHARE_UNSUPPORTED', 'Encrypted file sharing is not supported', req.requestId);
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
  return str.replace(/[&<>"']/g, (m) =>({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m as keyof { '&': string; '<': string; '>': string; '"': string; "'": string }] || m);
};

function buildSharePage(name: string, size: string, mimeType: string, thumb: string | null, shareId: string, isTg: boolean) {
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
          ${thumb ? `<img src="${thumb}" class="rounded-xl w-full aspect-video object-cover border border-slate-800" referrerPolicy="no-referrer" />` : ''}
          <a href="/api/public/download/${shareId}" class="block w-full bg-white text-black py-4 rounded-2xl font-black text-lg hover:bg-slate-100 transition-all active:scale-[0.98]">Download File</a>
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

app.get('/auth/link', (req, res) => {
  const tgId = req.query.tgId as string;
  const url  = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'], state: JSON.stringify({ tgId }), prompt: 'consent' });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const database        = db || await connectToMongo();
  try {
    if (!code || typeof state !== 'string') return res.status(400).send('Invalid OAuth callback.');
    let userId: string | null = null;
    if (state.startsWith('{')) {
      try {
        const p = JSON.parse(state);
        if (p.tgId) userId = String(await getUserIdByTg(p.tgId, database) || '');
        if (p.userId) userId = String(p.userId);
      } catch { /* invalid legacy bot state */ }
    } else {
      const oauthState = await consumeOAuthState(database, state, 'google');
      userId = oauthState?.userId ? String(oauthState.userId) : null;
    }
    if (!userId) return res.status(401).send('OAuth session expired. Please try again.');
    const { tokens } = await oauth2Client.getToken(code as string);
    const authClient = new google.auth.OAuth2(); authClient.setCredentials(tokens);
    const about = await google.drive({ version: 'v3', auth: authClient }).about.get({ fields: 'user' });
    const ui    = about.data.user;
    if (userId && database && ui) {
      await database.collection('accounts').updateOne(
        { userId: String(userId), email: ui.emailAddress },
        { $set: { tokens, linkedAt: new Date().toISOString(), name: ui.displayName, accountType: 'google' } },
        { upsert: true }
      );
      accountCache.flushAll();
    }
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
    if (!code || typeof state !== 'string') return res.status(400).send('Invalid OAuth callback.');
    let userId: string | null = null;
    if (state.startsWith('{')) {
      try {
        const p = JSON.parse(state);
        if (p.tgId) userId = String(await getUserIdByTg(p.tgId, database) || '');
        if (p.userId) userId = String(p.userId);
      } catch { /* invalid legacy bot state */ }
    } else {
      const oauthState = await consumeOAuthState(database, state, 'microsoft');
      userId = oauthState?.userId ? String(oauthState.userId) : null;
    }
    if (!userId) return res.status(401).send('OAuth session expired. Please try again.');
    const r        = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', new URLSearchParams({ client_id: MICROSOFT_CLIENT_ID!, client_secret: MICROSOFT_CLIENT_SECRET!, code: code as string, redirect_uri: MICROSOFT_REDIRECT_URI, grant_type: 'authorization_code' }));
    const rawTokens = r.data;
    const tokens    = { ...rawTokens, expiry_date: Date.now() + Number(rawTokens.expires_in || 3600) * 1000 };
    const msc  = Client.init({ authProvider: (done) => done(null, tokens.access_token) });
    const user = await msc.api('/me').get();
    if (userId && database && user) {
      await database.collection('accounts').updateOne(
        { userId: String(userId), email: user.userPrincipalName || user.mail },
        { $set: { tokens, linkedAt: new Date().toISOString(), name: user.displayName, accountType: 'onedrive' } },
        { upsert: true }
      );
      accountCache.flushAll();
      oneDriveTokenCache.clear();
    }
    res.send(oauthSuccessPage('OneDrive'));
  } catch { res.status(500).send('Authentication failed'); }
});

function oauthSuccessPage(service: string) {
  return `<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;background:#f8fafc;margin:0"><div style="background:white;padding:2.5rem;border-radius:1.5rem;box-shadow:0 20px 25px -5px rgba(0,0,0,.1);text-align:center;max-width:400px;width:90%"><span style="font-size:32px">✅</span><h2 style="color:#1e1b4b;margin:.75rem 0;font-size:1.5rem">Success!</h2><p style="color:#64748b;margin-bottom:2rem">${service} linked to Cloudyte.</p><button onclick="window.close()" style="background:#4f46e5;color:white;border:none;padding:.75rem 2rem;border-radius:9999px;font-weight:600;cursor:pointer">Done</button></div><script>setTimeout(()=>window.close(),4000)</script></body></html>`;
}

// ─── Cross Account File Transfer Helper ───────────────────────────────────────
async function crossAccountTransfer(
  sourceAccountId: string,
  fileId: string,
  targetAccountId: string,
  targetFolderId: string,
  userId: any,
  isAdmin: boolean,
  database: any,
  isMove: boolean
) {
  const { account: sourceAccount, accessDenied: srcDenied } = await resolveAuthorizedAccount(database, sourceAccountId, userId, isAdmin);
  if (srcDenied) throw new Error('Access denied to source account');
  if (!sourceAccount) throw new Error('Source account not found');

  const { account: targetAccount, accessDenied: tgtDenied } = await resolveAuthorizedAccount(database, targetAccountId, userId, isAdmin);
  if (tgtDenied) throw new Error('Access denied to target account');
  if (!targetAccount) throw new Error('Target account not found');

  const { meta: sourceMeta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, sourceAccount, fileId, userId, isAdmin);
  if (fileDenied) throw new Error('Access denied to source file');

  const tmpPath = path.join(os.tmpdir(), `transfer_${Date.now()}_${nanoid(6)}`);
  const writeStream = fs.createWriteStream(tmpPath);
  
  let fileName = sourceMeta?.isEncrypted ? (sourceMeta.opaqueRemoteName || sourceMeta.name) : 'unknown';
  let mimeType = sourceMeta?.isEncrypted ? 'application/octet-stream' : 'application/octet-stream';

  try {
    if (sourceAccount.accountType === 'tgdrive') {
      const meta = sourceMeta;
      if (!meta) throw new Error('File not found in TG');
      fileName = meta.isEncrypted ? (meta.opaqueRemoteName || meta.name) : meta.name;
      mimeType = meta.isEncrypted ? 'application/octet-stream' : meta.mimeType;
      
      const telegram = await getTgClient();
      const peer = await resolvePeer(telegram, sourceAccount.channelId);
      const messages = await telegram.getMessages(peer, { ids: [meta.messageId] });
      if (!messages || !messages[0] || !messages[0].media) throw new Error('Message not found');
      
      for await (const chunk of telegram.iterDownload({ file: messages[0].media, requestSize: 1024 * 1024 })) {
        writeStream.write(chunk);
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

      const dlUrl = item['@microsoft.graph.downloadUrl'];
      if (!dlUrl) throw new Error('Download link not available');
      const response = await axios.get(dlUrl, { responseType: 'stream' });
      response.data.pipe(writeStream);
      await new Promise<void>((res, rej) => { writeStream.on('finish', () => res()); writeStream.on('error', rej); });
    } else if (sourceAccount.accountType === 'google') {
      const drive = await getDriveClient(sourceAccount.tokens || sourceAccount.credentials);
      const file = await drive.files.get({ fileId, fields: 'name,mimeType' });
      if (!sourceMeta?.isEncrypted) {
        fileName = file.data.name || 'unknown';
        mimeType = file.data.mimeType || mimeType;
      }
      
      const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
      response.data.pipe(writeStream);
      await new Promise<void>((res, rej) => { writeStream.on('finish', () => res()); writeStream.on('error', rej); });
    }

    const stat = fs.statSync(tmpPath);
    const encryptionSpec: ValidatedUploadSpec | undefined = sourceMeta?.isEncrypted ? {
      isEncrypted: true,
      fileName: sourceMeta.opaqueRemoteName || sourceMeta.name,
      mimeType: 'application/octet-stream',
      size: stat.size,
      folderId: (!targetFolderId || targetFolderId === 'root') ? 'root' : targetFolderId,
      checksum: sourceMeta.encryptedChecksum || await computeFileSha256(tmpPath),
      encryptionFormatVersion: sourceMeta.encryptionFormatVersion ?? 1,
      encryptionKeyId: sourceMeta.encryptionKeyId ?? null,
      encryptedMetadata: sourceMeta.encryptedMetadata ?? null,
      opaqueRemoteName: sourceMeta.opaqueRemoteName || sourceMeta.name,
      encryptedSizeBytes: stat.size,
    } : undefined;

    await uploadFileToProvider(
      targetAccount,
      String(targetAccount._id),
      { path: tmpPath, size: stat.size, originalname: fileName, mimetype: mimeType },
      targetFolderId,
      undefined,
      undefined,
      undefined,
      encryptionSpec,
      String(userId || targetAccount.userId || '')
    );

    if (isMove) {
      deleteThumbFiles(fileId);
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
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

async function enqueueTransferJob(database: any, payload: any) {
  const now = new Date();
  const job = {
    _id: nanoid(32),
    type: 'cross_account_transfer',
    status: 'queued',
    attempts: 0,
    maxAttempts: JOB_MAX_ATTEMPTS,
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
    attempts: job.attempts || 0,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
  };
}

let jobWorkerRunning = false;
async function runJobWorker() {
  if (jobWorkerRunning || !db) return;
  jobWorkerRunning = true;
  try {
    const now = new Date();
    const claimedResult = await db.collection('jobs').findOneAndUpdate(
      {
        type: 'cross_account_transfer',
        $or: [
          { status: 'queued', nextRunAt: { $lte: now } },
          { status: 'running', leaseUntil: { $lt: now } },
        ],
      },
      {
        $set: { status: 'running', startedAt: now, updatedAt: now, leaseUntil: new Date(Date.now() + JOB_LEASE_MS) },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1 }, returnDocument: 'after' }
    ) as any;
    const job = claimedResult?.value ?? claimedResult;
    if (!job) return;

    try {
      const p = job.payload;
      await providerLimit(`transfer:${p.sourceAccountId}:${p.targetAccountId}`, 1)(() =>
        crossAccountTransfer(p.sourceAccountId, p.fileId, p.targetAccountId, p.targetFolderId, p.userId, p.isAdmin, db, p.isMove)
      );
      invalidateDriveCache(p.sourceAccountId);
      invalidateDriveCache(p.targetAccountId);
      await db.collection('jobs').updateOne(
        { _id: job._id, status: 'running' },
        { $set: { status: 'completed', completedAt: new Date(), updatedAt: new Date() }, $unset: { leaseUntil: '' } }
      );
    } catch (err: any) {
      const attempts = Number(job.attempts || 1);
      const retry = attempts < Number(job.maxAttempts || JOB_MAX_ATTEMPTS);
      await db.collection('jobs').updateOne(
        { _id: job._id, status: 'running' },
        retry
          ? { $set: { status: 'queued', error: err.message || 'Transfer failed', nextRunAt: new Date(Date.now() + Math.min(60, 2 ** attempts) * 1000), updatedAt: new Date() }, $unset: { leaseUntil: '' } }
          : { $set: { status: 'failed', error: err.message || 'Transfer failed', updatedAt: new Date() }, $unset: { leaseUntil: '' } }
      );
    }
  } catch (err) {
    console.error('[Jobs] Worker error:', err);
  } finally {
    jobWorkerRunning = false;
  }
}

app.get('/api/jobs/:jobId', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const query: any = { _id: req.params.jobId };
  if (!req.isAdmin && req.userId) query['payload.userId'] = String(req.userId);
  const job = await database.collection('jobs').findOne(query);
  if (!job) return apiError(res, 404, 'JOB_NOT_FOUND', 'Job not found', req.requestId);
  res.json(publicJob(job));
});

app.post('/api/jobs/:jobId/retry', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const query: any = { _id: req.params.jobId, status: 'failed' };
  if (!req.isAdmin && req.userId) query['payload.userId'] = String(req.userId);
  const result = await database.collection('jobs').findOneAndUpdate(
    query,
    { $set: { status: 'queued', nextRunAt: new Date(), updatedAt: new Date() }, $unset: { error: '', leaseUntil: '' } },
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
  console.error(`[Express] Unhandled error [${req.requestId || 'unknown'}]:`, err);
  if (res.headersSent) {
    return next(err);
  }
  const status = Number(err.status) || 500;
  apiError(res, status, err.code || errorCode(status), err.message || 'Internal Server Error', req.requestId);
});

// ─── 7. ROBUSTNESS: Process Unhandled Listeners ────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
});

// ─── 7. ROBUSTNESS: Graceful Shutdown on SIGTERM & SIGINT ─────────────────────
let server: any = null;

async function gracefulShutdown(signal: string) {
  console.log(`[Process] Received ${signal}. Closing gracefully...`);
  if (server) {
    await new Promise<void>((resolve) => {
      server.close((err: any) => {
        if (err) console.error('[Server] Error closing server:', err);
        else console.log('[Server] Server closed.');
        resolve();
      });
    });
  }
  try {
    await client.close();
    console.log('[Mongo] Connection closed.');
  } catch (err) {
    console.error('[Mongo] Error closing connection:', err);
  }
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
  setInterval(() => pruneThumbDir(THUMB_DIR), 3600000);
  setInterval(() => pruneTempFiles(), 3600000);
  setInterval(() => sweepUploadSessions().catch(err => console.error('[UploadSessions] Sweep failed:', err)), 5 * 60 * 1000);
  runJobWorker();
  setInterval(() => runJobWorker(), 2000);
  server = app.listen(Number(PORT), '0.0.0.0', () => console.log(`Cloudyte running at http://localhost:${PORT}`));
}

export { sweepUploadSessions, pruneTempFiles, pruneThumbDir };
export default app;

