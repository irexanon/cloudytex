import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import stream from 'stream';
import axios from 'axios';
import express from 'express';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import bcrypt from 'bcrypt';
import { ObjectId } from 'mongodb';
import { google } from 'googleapis';
import { Client } from '@microsoft/microsoft-graph-client';
import { Api } from 'telegram/tl/index.js';
import { createServer as createViteServer } from 'vite';

import { initBot } from './telegram.ts';
import { registerAiBridgeRoutes } from './ai-bridge.ts';
import { registerTempDropRoutes, sweepExpiredTempDrop } from './temp-drop.ts';
import {
  withSessionLock,
  validateUploadRequest,
  validateKeyBackupInput,
  validateOpaqueFilename,
  validatePlaintextFilename,
  validateSafeFolderId,
  computeFileSha256,
  normalizeSafeFilename,
  sniffMagicMimeType,
  buildSafeContentDisposition,
  parseHttpByteRange,
  shouldHonorRangeHeader,
  isSafeProviderItemId,
  escapeDriveQueryValue,
  isTrustedGraphNextLink,
  isValidHttpsUrl,
  TELEGRAM_ENCRYPTED_CAPTION_MARKER,
  type ValidatedUploadSpec,
} from './protocol.ts';

import {
  PORT,
  SALT_ROUNDS,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  BASIC_AUTH_ENABLED,
  timingSafeEqualStrings,
  MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET,
  MICROSOFT_REDIRECT_URI,
  THUMB_DIR,
  TEMP_DIR,
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
  MAX_UPLOAD_BYTES,
  MIN_TEMP_FREE_BYTES,
  activeUploadsByUser,
  activeGlobalUploads,
  activeDownloadsByUser,
  activeHttpConnections,
  incrementActiveHttpConnections,
  decrementActiveHttpConnections,
  isShuttingDown,
  setShuttingDown,
  STANDARD_ERROR_CODES,
  systemMetrics,
  recordAuditEvent,
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
  nanoid,
  escapeRegex,
  upload,
  client,
  db,
  connectToMongo,
  runEncryptionMigration,
  getUserIdByTg,
  SESSION_TTL_MS,
  resetLoginAttemptsForTest,
  getClientIp,
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  originGuardMiddleware,
  parseDeviceNameFromRequest,
  requireAuth,
  requireAuthOrSignedMedia,
  oauth2Client,
  createOAuthState,
  consumeOAuthState,
} from './core.ts';

import {
  checkTgChannelAccess,
  clearTgChannelAccessCache,
  isTgChannelAccessError,
  formatTgChannelError,
  markTgChannelInaccessible,
  resolvePeer,
  tgClient,
  getTgClient,
  getTgBotPoolStatus,
  setTestDependencies,
  getDriveClient,
  getOneDriveClient,
  resolveAuthorizedAccount,
  resolveFileMetadataForAccount,
  waitForDrainOrClose,
  pipeUpstreamWithAbort,
  tgStreamFile,
  normaliseTgFile,
  sendJsonWithEtag,
  generateThumbnail,
  getAccountQuota,
  emptyStorageCategories,
  computeSingleAccountStorageSummary,
  permanentlyDeleteSingleFile,
  listTrashForAccount,
  withTransientRetry,
  uploadOneDriveResumable,
  uploadGoogleDriveResumable,
  uploadFileToProvider,
  transferProviderType,
  uploadSessionId,
  findUploadAccount,
} from './provider.ts';

import {
  sweepExpiredTrash,
  UPLOAD_SESSION_TTL_MS,
  PROVIDER_COMPLETION_LEASE_MS,
  sweepUploadSessions,
  publicUploadSession,
  resolveUploadSessionForRequest,
  expireUploadSessionIfNeeded,
  type ConflictStrategy,
  checkDestinationFileExists,
  crossAccountTransfer,
  verifySingleBackupItem,
  collectAccountManifest,
  enqueueTransferJob,
  publicJob,
  MAX_CONCURRENT_JOBS,
  SUPPORTED_JOB_TYPES,
  activeJobWorkers,
  runJobWorker,
} from './jobs.ts';
import { registerArchiveRoutes } from './archive.ts';

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
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-ID, Idempotency-Key, X-File-Checksum, X-Chunk-Offset, X-Chunk-Sha256, X-Share-Pin, X-Device-Name, X-Temp-Creator-Token, X-Temp-Passcode');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// 1. DEPENDENCIES: Add compression before routes (bypass binary/file downloads so Content-Length & byte ranges stay intact)
app.use(compression({
  filter: (req, res) => {
    if (
      req.path.startsWith('/api/download') ||
      req.path.startsWith('/api/public/download') ||
      (req.path.startsWith('/api/temp-rooms/') && (req.path.endsWith('/download') || req.path.endsWith('/zip')))
    ) {
      return false;
    }
    if (res.getHeader('Content-Range')) return false;
    return compression.filter(req, res);
  },
}));
app.use('/api/tgdrive/:accountId/import', express.json({ limit: '15mb' }));
app.use('/api/ai/upload-text', express.json({ limit: '12mb' }));
app.use('/mcp', express.json({ limit: '12mb' }));
app.use('/api/mcp', express.json({ limit: '12mb' }));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
app.use(originGuardMiddleware);
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
  incrementActiveHttpConnections();
  let connDecremented = false;
  const decConn = () => {
    if (!connDecremented) {
      connDecremented = true;
      decrementActiveHttpConnections();
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

app.post('/api/login', async (req: any, res: any) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password must be strings' });
  }
  const cleanUsername = username.trim();
  if (!cleanUsername || cleanUsername.length > 128 || !password || password.length > 1024) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const clientIp = getClientIp(req);
  const loginCheck = checkLoginAllowed(cleanUsername, clientIp);
  if (!loginCheck.allowed) {
    res.setHeader('Retry-After', String(loginCheck.retryAfterSec));
    recordAuditEvent('login_locked', { username: cleanUsername, ip: clientIp, retryAfterSec: loginCheck.retryAfterSec });
    return apiError(
      res,
      429,
      STANDARD_ERROR_CODES.RATE_LIMITED,
      `Too many failed login attempts. Try again in ${loginCheck.retryAfterSec} seconds.`,
      req.requestId,
      true
    );
  }

  const database = db || await connectToMongo();

  const user = await database.collection('users').findOne({ username: cleanUsername });
  if (!user || !user.isActive) {
    const fail = await recordLoginFailure(cleanUsername, clientIp);
    recordAuditEvent('login_failed', { username: cleanUsername, ip: clientIp, reason: 'invalid_user_or_disabled', failures: fail.failures, locked: fail.locked });
    return res.status(401).json({ error: 'Invalid credentials or account disabled' });
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    const fail = await recordLoginFailure(cleanUsername, clientIp);
    recordAuditEvent('login_failed', { username: cleanUsername, userId: String(user._id), ip: clientIp, reason: 'bad_password', failures: fail.failures, locked: fail.locked });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  recordLoginSuccess(cleanUsername, clientIp);

  const sessionToken = nanoid(32);
  const sessionId = nanoid(12);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const deviceName = parseDeviceNameFromRequest(req);
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 256) : '';

  await database.collection('sessions').insertOne({
    sessionId,
    token: sessionToken, // Stored in plaintext in DB as requested
    userId: user._id,
    username: user.username,
    deviceName,
    userAgent,
    ip: clientIp,
    ipHistory: [clientIp],
    createdAt: now,
    lastActiveAt: now,
    lastUsedAt: now,
    expiresAt,
    revokedAt: null,
  });

  // Prime auth cache
  authCache.set(sessionToken, {
    userId: user._id,
    isAdmin: !!user.isAdmin,
    user,
    sessionId,
    ipHistory: [clientIp],
    expiresAt: expiresAt.getTime(),
  });

  recordAuditEvent('login_succeeded', { userId: String(user._id), username: user.username, sessionId, deviceName, ip: clientIp });

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

  const driveStats = driveCache.getStats();
  const authStats = authCache.getStats();

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
      activeWorkers: activeJobWorkers,
      maxConcurrentWorkers: MAX_CONCURRENT_JOBS,
      lastWorkerHeartbeatAt: systemMetrics.lastWorkerHeartbeatAt || null,
    },
    uploads: {
      activeSessions: activeUploadSessions,
      completedTotal: systemMetrics.uploadsCompleted,
      failedTotal: systemMetrics.uploadsFailed,
      uploadBytesTotal: systemMetrics.uploadBytesTotal,
      downloadBytesTotal: systemMetrics.downloadBytesTotal,
    },
    cache: {
      driveCacheKeys: driveCache.keys().length,
      driveCacheHits: driveStats.hits,
      driveCacheMisses: driveStats.misses,
      authCacheKeys: authCache.keys().length,
      authCacheHits: authStats.hits,
      authCacheMisses: authStats.misses,
    },
    oauthRefreshFailures: systemMetrics.oauthRefreshFailures,
    telegramBotPool: getTgBotPoolStatus(),
    metrics: systemMetrics,
    alerts,
  });
});

app.get('/api/admin/audit-logs', requireAuth, async (req: any, res: any) => {
  if (!req.isAdmin) return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Forbidden', req.requestId);
  const database = req.db || db || await connectToMongo();
  const filter: any = {};
  if (typeof req.query.action === 'string' && req.query.action.trim()) {
    filter.action = req.query.action.trim();
  }
  if (typeof req.query.userId === 'string' && req.query.userId.trim()) {
    filter.userId = req.query.userId.trim();
  }
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
  const logs = await database.collection('audit_logs').find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ logs });
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

// ─── Active Sessions, Device Management & Personal Access Tokens ─────────────
app.get('/api/sessions', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  if (!req.userId) return res.json([]);
  const now = Date.now();
  const rawSessions = await database.collection('sessions')
    .find({ userId: req.userId })
    .sort({ lastActiveAt: -1, createdAt: -1 })
    .toArray();

  const active = rawSessions.filter((s: any) => {
    if (s.revokedAt) return false;
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
    const lastUsedIso = (s.lastUsedAt || s.lastActiveAt || s.createdAt)
      ? new Date(s.lastUsedAt || s.lastActiveAt || s.createdAt).toISOString()
      : lastActiveIso;
    const expiresIso = s.expiresAt ? new Date(s.expiresAt).toISOString() : null;
    return {
      id,
      sessionId: id,
      deviceName: s.deviceName || 'Cloudyte Client',
      userAgent: s.userAgent || '',
      ip: s.ip || null,
      ipHistory: Array.isArray(s.ipHistory) ? s.ipHistory : (s.ip ? [s.ip] : []),
      createdAt: createdIso,
      lastActiveAt: lastActiveIso,
      lastUsedAt: lastUsedIso,
      expiresAt: expiresIso,
      revokedAt: s.revokedAt ? new Date(s.revokedAt).toISOString() : null,
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
  recordAuditEvent('session_revoked', { userId: String(req.userId || targetSession.userId || ''), sessionId: targetId });

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
  recordAuditEvent('sessions_bulk_revoked', { userId: String(req.userId), revokedCount: delRes.deletedCount || toRevoke.length });
  res.json({ success: true, revokedCount: delRes.deletedCount || toRevoke.length });
});

// ─── Personal Access Tokens (stored in plaintext in DB as requested) ──────────
const ALLOWED_PAT_SCOPES = new Set(['read', 'write', 'delete', 'share']);

app.get('/api/tokens', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  if (!req.userId) return res.json([]);
  const docs = await database.collection('api_tokens')
    .find({ userId: req.userId, revokedAt: null })
    .sort({ createdAt: -1 })
    .toArray();
  const tokens = docs.map((t: any) => ({
    id: String(t.tokenId || t._id),
    tokenId: String(t.tokenId || t._id),
    name: t.name,
    token: t.token,
    scopes: Array.isArray(t.scopes) ? t.scopes : ['read', 'write'],
    accountId: t.accountId || null,
    rootFolderId: t.rootFolderId || null,
    createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : null,
    lastUsedAt: t.lastUsedAt ? new Date(t.lastUsedAt).toISOString() : null,
    expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : null,
  }));
  res.setHeader('Cache-Control', 'no-store');
  res.json(tokens);
});

app.post('/api/tokens', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  if (!req.userId) return apiError(res, 401, STANDARD_ERROR_CODES.UNAUTHORIZED, 'User context required', req.requestId);
  const { name, scopes: rawScopes, accountId, rootFolderId, expiresInDays } = req.body || {};
  const cleanName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : 'Personal Access Token';
  let scopes = ['read', 'write'];
  if (Array.isArray(rawScopes) && rawScopes.length > 0) {
    const filtered = rawScopes.map((s: any) => String(s).trim().toLowerCase()).filter((s: string) => ALLOWED_PAT_SCOPES.has(s));
    if (filtered.length === 0) {
      return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid token scopes; allowed: read, write, delete, share', req.requestId);
    }
    scopes = Array.from(new Set(filtered));
  }
  if (accountId !== undefined && accountId !== null && accountId !== '') {
    const { account, accessDenied } = await resolveAuthorizedAccount(database, String(accountId), req.userId, req.isAdmin);
    if (accessDenied) return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Access denied to confined account', req.requestId);
    if (!account) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Confined account not found', req.requestId);
  }
  if (rootFolderId !== undefined && rootFolderId !== null && rootFolderId !== '') {
    const folderCheck = validateSafeFolderId(rootFolderId);
    if (!folderCheck.ok) {
      return apiError(res, folderCheck.error.status, folderCheck.error.code, folderCheck.error.message, req.requestId);
    }
  }

  const now = new Date();
  const days = Number(expiresInDays);
  const expiresAt = Number.isFinite(days) && days > 0
    ? new Date(now.getTime() + Math.min(365, days) * 24 * 60 * 60 * 1000)
    : new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const tokenId = nanoid(12);
  const plaintextToken = `pat_${nanoid(32)}`;

  const doc = {
    tokenId,
    token: plaintextToken, // Stored in plaintext in DB per user instruction
    userId: req.userId,
    name: cleanName,
    scopes,
    accountId: accountId ? String(accountId) : null,
    rootFolderId: rootFolderId ? String(rootFolderId) : null,
    createdAt: now,
    lastUsedAt: null,
    expiresAt,
    revokedAt: null,
  };
  await database.collection('api_tokens').insertOne(doc);
  recordAuditEvent('api_token_created', { userId: String(req.userId), tokenId, name: cleanName, scopes, accountId: doc.accountId, rootFolderId: doc.rootFolderId });

  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({
    id: tokenId,
    tokenId,
    token: plaintextToken,
    name: cleanName,
    scopes,
    accountId: doc.accountId,
    rootFolderId: doc.rootFolderId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
});

app.delete('/api/tokens/:tokenId', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const targetId = String(req.params.tokenId || '').trim();
  if (!targetId) return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'tokenId required', req.requestId);
  const query: any = { tokenId: targetId };
  if (!req.isAdmin && req.userId) query.userId = req.userId;
  const existing = await database.collection('api_tokens').findOne(query);
  if (!existing) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Token not found', req.requestId);
  await database.collection('api_tokens').updateOne(
    { _id: existing._id },
    { $set: { revokedAt: new Date() } }
  );
  if (existing.token) authCache.del(String(existing.token));
  recordAuditEvent('api_token_revoked', { userId: String(req.userId || existing.userId || ''), tokenId: targetId });
  res.json({ success: true, revokedTokenId: targetId });
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

  let isForum = false;
  let chatType = 'channel';
  try {
    const [admins, botInfo, chatInfo] = await Promise.all([
      bot!.telegram.getChatAdministrators(cleanChannelId),
      bot!.telegram.getMe(),
      bot!.telegram.getChat(cleanChannelId).catch(() => null),
    ]);
    const isBotAdmin = admins.some((a: any) => a.user.id === botInfo.id);
    if (!isBotAdmin) return res.status(400).json({ error: 'Bot is not an admin in this channel or group' });
    if (chatInfo) {
      isForum = Boolean((chatInfo as any).is_forum);
      chatType = String((chatInfo as any).type || 'channel');
    }
  } catch (e: any) {
    return res.status(400).json({ error: `Cannot access channel/group: ${e.message}. Make sure the bot is an admin.` });
  }

  const existingAccount = await database.collection('accounts').findOne({ channelId: cleanChannelId, userId: { $ne: userId } });
  if (existingAccount) return res.status(400).json({ error: 'This channel or group is already linked to another Cloudyte account.' });

  await database.collection('accounts').updateOne(
    { userId, channelId: cleanChannelId, accountType: 'tgdrive' },
    { $set: { userId, channelId: cleanChannelId, accountType: 'tgdrive', name, isForum, chatType, linkedAt: new Date().toISOString() } },
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

  clearTgChannelAccessCache(cleanChannelId);
  res.json({ success: true, id: newAccountId.toString(), channelId: cleanChannelId, name, isForum, chatType });
});

// ─── TG Drive JSON Bulk Import (Forum Topics as Folders + Old Media Messages) ─
function inferMimeTypeFromName(name: string): string {
  const ext = String(name || '').split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    mp4: 'video/mp4', mkv: 'video/x-matroska', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
    pdf: 'application/pdf', zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
    txt: 'text/plain', json: 'application/json', csv: 'text/csv',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] || 'application/octet-stream';
}

function sanitizeImportedSegment(raw: unknown, fallback: string): string {
  const cleaned = String(raw ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/]+/g, ' - ')
    .replace(/\.\./g, '.')
    .trim()
    .slice(0, 180);
  return cleaned && cleaned !== '.' ? cleaned : fallback;
}

function parseImportUnixSeconds(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const asNum = Number(raw.trim());
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum > 1e12 ? Math.floor(asNum / 1000) : Math.floor(asNum);
    }
    const ms = Date.parse(raw.trim());
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

app.post('/api/tgdrive/:accountId/import', requireAuth, async (req: any, res: any) => {
  const { accountId } = req.params;
  const userId = req.userId;
  const database = req.db;

  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Account not found', req.requestId);
  if (account.accountType !== 'tgdrive') {
    return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'JSON import is only supported for Telegram Drive accounts', req.requestId);
  }

  const body = req.body;
  const rawTopics: any[] = Array.isArray(body?.topics)
    ? body.topics
    : (Array.isArray(body?.threads) ? body.threads : (Array.isArray(body?.folders) ? body.folders : []));
  const rawFiles: any[] = Array.isArray(body)
    ? body
    : (Array.isArray(body?.files)
        ? body.files
        : (Array.isArray(body?.messages) ? body.messages : (Array.isArray(body?.media) ? body.media : [])));

  if (rawTopics.length === 0 && rawFiles.length === 0) {
    return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Import payload must include a non-empty "topics" or "files" array', req.requestId);
  }
  if (rawTopics.length > 2000) {
    return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Too many topics in one batch (maximum 2,000 per import)', req.requestId);
  }
  if (rawFiles.length > 25000) {
    return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Too many files in one batch (maximum 25,000 per import — split into batches)', req.requestId);
  }

  try {
    const ownerUserId = String(account.userId || userId || '');
    const existingFolders = await database.collection('tg_folders').find({ accountId: account._id }).toArray();
    const threadIdToPath = new Map<number, string>();
    const existingPaths = new Set<string>();
    for (const f of existingFolders) {
      if (f.path) existingPaths.add(String(f.path));
      if (Number.isInteger(Number(f.threadId)) && Number(f.threadId) > 0 && f.path) {
        threadIdToPath.set(Number(f.threadId), String(f.path));
      }
    }

    let importedTopics = 0;
    let updatedTopics = 0;
    let hasForumTopics = Boolean(body?.isForum);

    // 1. Import Forum Topics -> tg_folders
    for (const rawTopic of rawTopics) {
      if (!rawTopic || typeof rawTopic !== 'object') continue;
      const rawTid = rawTopic.threadId ?? rawTopic.topicId ?? rawTopic.topic_id ?? rawTopic.message_thread_id ?? rawTopic.id;
      const tid = Number(rawTid);
      const validTid = Number.isSafeInteger(tid) && tid > 1 ? tid : null;
      const rawName = rawTopic.name ?? rawTopic.title ?? (validTid ? `Topic ${validTid}` : '');
      const cleanName = sanitizeImportedSegment(rawName, validTid ? `Topic ${validTid}` : 'Untitled Folder');

      // General topic (threadId === 1) maps to Root (''), no subfolder needed unless explicitly named otherwise
      if (tid === 1) {
        hasForumTopics = true;
        continue;
      }
      if (validTid) hasForumTopics = true;

      let targetPath = cleanName;
      if (validTid && threadIdToPath.has(validTid)) {
        targetPath = threadIdToPath.get(validTid)!;
        await database.collection('tg_folders').updateOne(
          { accountId: account._id, threadId: validTid },
          { $set: { name: cleanName, updatedAt: Math.floor(Date.now() / 1000) } }
        );
        updatedTopics++;
      } else {
        // Avoid colliding with a different topic that shares the exact same title
        if (validTid && existingPaths.has(targetPath)) {
          targetPath = `${cleanName} (${validTid})`;
        }
        await database.collection('tg_folders').updateOne(
          { accountId: account._id, path: targetPath },
          {
            $set: {
              accountId: account._id,
              userId: ownerUserId,
              name: cleanName,
              path: targetPath,
              ...(validTid ? { threadId: validTid } : {}),
              createdAt: parseImportUnixSeconds(rawTopic.date ?? rawTopic.createdAt),
            },
          },
          { upsert: true }
        );
        existingPaths.add(targetPath);
        if (validTid) threadIdToPath.set(validTid, targetPath);
        importedTopics++;
      }
    }

    // 2. Load existing messageIds for fast idempotent deduplication
    const existingFiles = await database.collection('tg_files')
      .find({ accountId: account._id }, { projection: { messageId: 1 } })
      .toArray();
    const existingMessageIds = new Set<number>(
      existingFiles
        .map((f: any) => Number(f.messageId))
        .filter((n: number) => Number.isSafeInteger(n) && n > 0)
    );

    let importedFiles = 0;
    let skippedDuplicates = 0;
    let invalidCount = 0;

    for (const rawFile of rawFiles) {
      if (!rawFile || typeof rawFile !== 'object') {
        invalidCount++;
        continue;
      }
      const msgId = Number(rawFile.messageId ?? rawFile.message_id ?? rawFile.id);
      if (!Number.isSafeInteger(msgId) || msgId <= 0) {
        invalidCount++;
        continue;
      }
      if (existingMessageIds.has(msgId)) {
        skippedDuplicates++;
        continue;
      }

      const rawTid = rawFile.threadId ?? rawFile.topicId ?? rawFile.topic_id ?? rawFile.message_thread_id;
      const parsedTid = Number(rawTid);
      const validTid = Number.isSafeInteger(parsedTid) && parsedTid > 1 ? parsedTid : null;
      if (validTid) hasForumTopics = true;

      let folderPath = '';
      if (validTid) {
        if (!threadIdToPath.has(validTid)) {
          // Auto-create folder if file references a threadId not listed in topics[]
          const fallbackName = sanitizeImportedSegment(rawFile.topicName ?? rawFile.topic_name ?? rawFile.folder, `Topic ${validTid}`);
          const autoPath = existingPaths.has(fallbackName) ? `${fallbackName} (${validTid})` : fallbackName;
          await database.collection('tg_folders').updateOne(
            { accountId: account._id, path: autoPath },
            {
              $set: {
                accountId: account._id,
                userId: ownerUserId,
                name: fallbackName,
                path: autoPath,
                threadId: validTid,
                createdAt: Math.floor(Date.now() / 1000),
              },
            },
            { upsert: true }
          );
          existingPaths.add(autoPath);
          threadIdToPath.set(validTid, autoPath);
          importedTopics++;
        }
        folderPath = threadIdToPath.get(validTid)!;
      } else if (typeof (rawFile.folder ?? rawFile.path) === 'string' && String(rawFile.folder ?? rawFile.path).trim()) {
        const segments = String(rawFile.folder ?? rawFile.path)
          .split('/')
          .map((s) => sanitizeImportedSegment(s, ''))
          .filter(Boolean);
        folderPath = segments.join('/');
        if (folderPath && !existingPaths.has(folderPath)) {
          await database.collection('tg_folders').updateOne(
            { accountId: account._id, path: folderPath },
            {
              $set: {
                accountId: account._id,
                userId: ownerUserId,
                name: segments[segments.length - 1],
                path: folderPath,
                createdAt: Math.floor(Date.now() / 1000),
              },
            },
            { upsert: true }
          );
          existingPaths.add(folderPath);
          importedTopics++;
        }
      }

      const rawNoteText = rawFile.text ?? rawFile.message ?? rawFile.content ?? rawFile.body;
      const hasNoteText = typeof rawNoteText === 'string';
      const noteText = hasNoteText ? rawNoteText.slice(0, 512 * 1024) : '';
      const isNote = Boolean(
        rawFile.isNote === true ||
        rawFile.type === 'note' ||
        rawFile.kind === 'note' ||
        (hasNoteText && !(rawFile.mimeType ?? rawFile.mime_type ?? rawFile.mime))
      );

      let explicitName = rawFile.name ?? rawFile.fileName ?? rawFile.file_name ?? rawFile.title;
      if ((!explicitName || !String(explicitName).trim()) && isNote && noteText.trim()) {
        const firstLine = noteText.split(/\r?\n/).map((l: string) => l.trim()).find(Boolean) || '';
        const baseTitle = sanitizeImportedSegment(firstLine.slice(0, 60), `note_${msgId}`);
        explicitName = /\.[a-z0-9]{1,8}$/i.test(baseTitle) ? baseTitle : `${baseTitle}.txt`;
      }
      let fileName = sanitizeImportedSegment(explicitName, isNote ? `note_${msgId}.txt` : `file_${msgId}`);
      if (isNote && !/\.[a-z0-9]{1,8}$/i.test(fileName)) {
        fileName = `${fileName.slice(0, 175)}.txt`;
      }

      const rawSizeNum = Number(rawFile.size ?? rawFile.fileSize ?? rawFile.file_size ?? rawFile.sizeBytes ?? 0) || 0;
      const sizeNum = rawSizeNum > 0
        ? Math.floor(rawSizeNum)
        : (hasNoteText ? Buffer.byteLength(noteText, 'utf8') : 0);
      const rawMime = typeof (rawFile.mimeType ?? rawFile.mime_type ?? rawFile.mime) === 'string'
        ? String(rawFile.mimeType ?? rawFile.mime_type ?? rawFile.mime).trim()
        : '';
      const mimeType = isNote
        ? (rawMime && rawMime !== 'application/octet-stream' ? rawMime : 'text/plain')
        : (rawMime && rawMime !== 'application/octet-stream' ? rawMime : inferMimeTypeFromName(fileName));
      const dateSec = parseImportUnixSeconds(rawFile.date ?? rawFile.timestamp);
      const caption = typeof rawFile.caption === 'string' ? rawFile.caption.slice(0, 1024) : '';

      await database.collection('tg_files').insertOne({
        accountId: account._id,
        userId: ownerUserId,
        messageId: msgId,
        ...(validTid ? { threadId: validTid } : {}),
        shareId: nanoid(6),
        name: fileName,
        size: sizeNum,
        mimeType,
        folder: folderPath,
        caption,
        ...(isNote ? { isNote: true } : {}),
        ...(hasNoteText ? { textContent: noteText } : {}),
        isEncrypted: false,
        date: dateSec,
        updatedAt: dateSec * 1000,
      });
      existingMessageIds.add(msgId);
      importedFiles++;
    }

    if (hasForumTopics && !account.isForum) {
      await database.collection('accounts').updateOne(
        { _id: account._id },
        { $set: { isForum: true, chatType: account.chatType || 'supergroup' } }
      );
    }

    invalidateDriveCache(String(account._id));
    recordAuditEvent('tgdrive_json_imported', {
      userId: ownerUserId,
      accountId: String(account._id),
      importedTopics,
      updatedTopics,
      importedFiles,
      skippedDuplicates,
      invalidCount,
    });

    res.json({
      success: true,
      isForum: hasForumTopics || Boolean(account.isForum),
      importedTopics,
      updatedTopics,
      importedFiles,
      skippedDuplicates,
      invalidCount,
      totalFiles: existingMessageIds.size,
    });
  } catch (err: any) {
    console.error('TG Drive JSON import error:', err);
    return apiError(res, 500, STANDARD_ERROR_CODES.INTERNAL_ERROR, err.message || 'Import failed', req.requestId);
  }
});

// ─── TG Drive JSON Export (Backup topics, files & notes for future re-import) ─
app.get('/api/tgdrive/:accountId/export', requireAuth, async (req: any, res: any) => {
  const { accountId } = req.params;
  const userId = req.userId;
  const database = req.db;

  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Account not found', req.requestId);
  if (account.accountType !== 'tgdrive') {
    return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'JSON export is only supported for Telegram Drive accounts', req.requestId);
  }

  try {
    const [folderDocs, fileDocs] = await Promise.all([
      database.collection('tg_folders').find({ accountId: account._id }).sort({ createdAt: 1, path: 1 }).toArray(),
      database.collection('tg_files').find({ accountId: account._id, trashed: { $ne: true } }).sort({ date: 1, messageId: 1 }).toArray(),
    ]);

    const topics = folderDocs.map((folder: any) => ({
      ...(Number.isSafeInteger(Number(folder.threadId)) && Number(folder.threadId) > 0 ? { threadId: Number(folder.threadId) } : {}),
      name: String(folder.name || folder.path || 'Folder'),
      path: String(folder.path || folder.name || ''),
      ...(folder.createdAt ? { createdAt: Number(folder.createdAt) } : {}),
    }));

    const files = fileDocs
      .filter((f: any) => !f.isEncrypted && Number.isSafeInteger(Number(f.messageId)) && Number(f.messageId) > 0)
      .map((f: any) => ({
        messageId: Number(f.messageId),
        ...(Number.isSafeInteger(Number(f.threadId)) && Number(f.threadId) > 0 ? { threadId: Number(f.threadId) } : {}),
        ...(f.folder ? { folder: String(f.folder) } : {}),
        name: String(f.name || `file_${f.messageId}`),
        size: Number(f.size || 0),
        mimeType: String(f.mimeType || 'application/octet-stream'),
        ...(f.date ? { date: Number(f.date) } : {}),
        ...(f.caption ? { caption: String(f.caption) } : {}),
        ...(f.isNote ? { type: 'note', isNote: true } : {}),
        ...(f.isNote && typeof f.textContent === 'string' ? { text: f.textContent } : {}),
      }));

    const payload = {
      exportedAt: new Date().toISOString(),
      driveName: String(account.name || 'TG Drive'),
      channelId: String(account.channelId || ''),
      isForum: Boolean(account.isForum) || topics.some((t: any) => Number(t.threadId) > 1),
      topics,
      files,
    };

    const safeBaseName = sanitizeImportedSegment(account.name || 'tgdrive', 'tgdrive')
      .replace(/\s+/g, '-')
      .toLowerCase();
    const downloadFileName = `${safeBaseName}-export.json`;

    recordAuditEvent('tgdrive_json_exported', {
      userId: String(userId || ''),
      accountId: String(account._id),
      topicCount: topics.length,
      fileCount: files.length,
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', buildSafeContentDisposition('attachment', downloadFileName));
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(payload, null, 2));
  } catch (err: any) {
    console.error('TG Drive JSON export error:', err);
    return apiError(res, 500, STANDARD_ERROR_CODES.INTERNAL_ERROR, err.message || 'Export failed', req.requestId);
  }
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

  const forceRefreshAccess = req.query.refresh === '1' || req.query.refresh === 'true';
  const enriched = await Promise.all(unique.map(async (acc: any) => {
    if (acc.accountType === 'tgdrive') {
      const channelAccess = await checkTgChannelAccess(acc.channelId, bot, forceRefreshAccess);
      try {
        const summary = await computeSingleAccountStorageSummary(acc, database);
        const usedBytes = summary.usedBytes || 0;
        const fileCount = summary.fileCount || 0;
        return {
          id:          acc._id.toString(),
          name:        acc.name || 'TG Drive',
          email:       `${acc.isForum ? 'Forum Group' : (acc.chatType === 'supergroup' || acc.chatType === 'group' ? 'Group' : 'Channel')}: ${acc.channelId}`,
          channelId:   acc.channelId,
          isForum:     Boolean(acc.isForum),
          chatType:    acc.chatType || 'channel',
          accountType: 'tgdrive',
          usage:       (usedBytes / (1024 ** 3)).toFixed(2) + ' GB',
          total:       '∞',
          percentage:  0,
          fileCount,
          error:       !channelAccess.ok,
          ...(channelAccess.ok ? {} : { errorCode: channelAccess.code || 'TG_CHANNEL_ACCESS_DENIED', errorMessage: channelAccess.message }),
          isDefault:   acc.isDefault || false,
        };
      } catch {
        return {
          id: acc._id.toString(),
          name: acc.name || 'TG Drive',
          email: `${acc.isForum ? 'Forum Group' : (acc.chatType === 'supergroup' || acc.chatType === 'group' ? 'Group' : 'Channel')}: ${acc.channelId}`,
          channelId: acc.channelId,
          isForum: Boolean(acc.isForum),
          chatType: acc.chatType || 'channel',
          accountType: 'tgdrive',
          usage: '0 GB',
          total: '∞',
          percentage: 0,
          fileCount: 0,
          error: !channelAccess.ok,
          ...(channelAccess.ok ? {} : { errorCode: channelAccess.code || 'TG_CHANNEL_ACCESS_DENIED', errorMessage: channelAccess.message }),
          isDefault: acc.isDefault || false,
        };
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
      return {
        id: acc._id.toString(),
        name: acc.name || 'Disconnected',
        email: acc.email || acc.channelId,
        error: true,
        errorMessage: 'Drive connection expired or revoked. Please reconnect this account.',
        percentage: 0,
        accountType: acc.accountType || 'google',
        isDefault: acc.isDefault || false,
      };
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

    // Fast-fail if thumbnail generation repeatedly failed recently for this file
    if (Number(failedThumbCache.get(`${accIdStr}:${fileId}`) || 0) >= 2) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.status(404).json({ error: 'Thumbnail not available' });
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
    let createdFolder: { id: string; name: string } = { id: '', name };
    if (account.accountType === 'tgdrive') {
      const parentPath = folderCheck.folderId === 'root' ? '' : folderCheck.folderId;
      const folderPath = parentPath ? `${parentPath}/${name}` : name;
      let createdThreadId: number | null = null;
      if (account.isForum && !parentPath && bot?.telegram) {
        try {
          const topic = await (bot.telegram as any).createForumTopic(account.channelId, name);
          if (topic && Number.isInteger(Number(topic.message_thread_id))) {
            createdThreadId = Number(topic.message_thread_id);
          }
        } catch (topicErr: any) {
          console.warn(`[TG Drive] Failed to create forum topic "${name}" in ${account.channelId}:`, topicErr?.message);
        }
      }
      await database.collection('tg_folders').updateOne(
        { accountId: account._id, path: folderPath },
        {
          $set: {
            accountId: account._id,
            userId: String(userId || account.userId || ''),
            name,
            path: folderPath,
            ...(createdThreadId ? { threadId: createdThreadId } : {}),
            createdAt: Math.floor(Date.now() / 1000),
          },
        },
        { upsert: true }
      );
      createdFolder = { id: folderPath, name };
    } else {
      const safeParent = folderCheck.folderId || 'root';
      if (safeParent !== 'root' && !isSafeProviderItemId(safeParent)) {
        return apiError(res, 400, 'BAD_REQUEST', 'Invalid parent folder identifier', req.requestId);
      }
      if (account.accountType === 'onedrive') {
        const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
        const parentPath = safeParent === 'root' ? '/me/drive/root' : `/me/drive/items/${safeParent}`;
        const odRes = await c.api(`${parentPath}/children`).post({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' });
        createdFolder = { id: String(odRes?.id || ''), name: String(odRes?.name || name) };
      } else {
        const drive = await getDriveClient(account.tokens || account.credentials);
        const gdRes = await drive.files.create({
          requestBody: { name, parents: [safeParent], mimeType: 'application/vnd.google-apps.folder' },
          fields: 'id,name',
        });
        createdFolder = { id: String(gdRes?.data?.id || ''), name: String(gdRes?.data?.name || name) };
      }
    }
    invalidateDriveCache(accountId as string);
    res.json({ success: true, folder: createdFolder });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


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

  // Reserve/check provider account quota headroom when finite quota is cached on the account
  const accQuotaLimit = Number(account.quotaLimit || 0);
  const accQuotaUsage = Number(account.quotaUsage || 0);
  if (accQuotaLimit > 0 && accQuotaUsage + spec.size > accQuotaLimit) {
    return apiError(res, 507, STANDARD_ERROR_CODES.INSUFFICIENT_STORAGE, 'Target storage account does not have enough free quota for this upload', req.requestId);
  }

  // Optional duplicate upload detection when client passes deduplicate: true and checksum
  if (req.body?.deduplicate === true && spec.checksum && req.db) {
    const dupQuery: any = {
      accountId: account._id,
      trashed: { $ne: true },
      $or: [
        { encryptedChecksum: spec.checksum.toLowerCase() },
        { plaintextChecksum: spec.checksum.toLowerCase() },
        { checksum: spec.checksum.toLowerCase() },
      ],
    };
    const duplicateDoc = await req.db.collection('tg_files').findOne(dupQuery);
    if (duplicateDoc) {
      return apiError(res, 409, STANDARD_ERROR_CODES.CONFLICT, 'Duplicate file with identical SHA-256 checksum already exists in this account', req.requestId);
    }
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
    const expectedChunkHash = typeof req.header('X-Chunk-Sha256') === 'string'
      ? req.header('X-Chunk-Sha256').trim().toLowerCase()
      : (typeof req.body?.chunkChecksum === 'string' ? req.body.chunkChecksum.trim().toLowerCase() : '');
    if (expectedChunkHash && expectedChunkHash !== chunkChecksum) {
      await fs.promises.truncate(session.tempPath, session.receivedBytes);
      return apiError(res, 422, 'CHUNK_CHECKSUM_MISMATCH', 'Uploaded chunk SHA-256 checksum does not match X-Chunk-Sha256', req.requestId);
    }
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
    return res.json({ sessionId: session.sessionId, receivedBytes, totalBytes: session.totalBytes, nextOffset: receivedBytes, chunkChecksum, complete: receivedBytes === session.totalBytes });
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
    if (!session.isEncrypted) {
      const sniffed = await sniffMagicMimeType(session.tempPath);
      if (sniffed.suspiciousArchive) {
        await sessions.updateOne({ sessionId: session.sessionId, status: 'completing' }, { $set: { status: 'failed', updatedAt: new Date() }, $unset: { completionLeaseExpiresAt: '' } });
        return apiError(res, 422, 'SUSPICIOUS_ARCHIVE_DETECTED', 'Uploaded archive has an abnormal compression ratio and was rejected', req.requestId);
      }
    }
    const encryptionSpec: ValidatedUploadSpec = {
      isEncrypted: Boolean(session.isEncrypted),
      fileName: session.isEncrypted ? session.fileName : normalizeSafeFilename(session.fileName),
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
      { path: session.tempPath, size: session.totalBytes, originalname: encryptionSpec.fileName, mimetype: encryptionSpec.mimeType },
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
    systemMetrics.uploadBytesTotal += Number(session.totalBytes || 0);
    recordAuditEvent('file_uploaded', {
      userId: String(session.userId || req.userId || ''),
      accountId: session.accountId,
      sessionId: session.sessionId,
      sizeBytes: session.totalBytes,
      isEncrypted: Boolean(session.isEncrypted),
    });
    invalidateDriveCache(session.accountId);
    if (fs.existsSync(session.tempPath)) { try { fs.unlinkSync(session.tempPath); } catch { /* janitor will retry */ } }
    return res.json(finalPayload);
  } catch (err: any) {
    systemMetrics.uploadsFailed++;
    recordAuditEvent('file_upload_failed', {
      userId: String(session.userId || req.userId || ''),
      accountId: session.accountId,
      sessionId: session.sessionId,
      error: err?.message || 'Upload completion failed',
    });
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

    if (!spec.isEncrypted) {
      const sniffed = await sniffMagicMimeType(file.path);
      if (sniffed.suspiciousArchive) {
        cleanupTemp();
        return apiError(res, 422, 'SUSPICIOUS_ARCHIVE_DETECTED', 'Uploaded archive has an abnormal compression ratio and was rejected', req.requestId);
      }
    }

    const uploadResult: any = await uploadFileToProvider(
      account,
      accountId,
      {
        path: file.path,
        size: file.size,
        originalname: spec.isEncrypted ? spec.fileName : normalizeSafeFilename(spec.fileName),
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
    systemMetrics.uploadBytesTotal += Number(file.size || 0);
    recordAuditEvent('file_uploaded', {
      userId: String(userId || account.userId || ''),
      accountId,
      sizeBytes: file.size,
      isEncrypted: spec.isEncrypted,
    });
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
    recordAuditEvent('file_upload_failed', {
      userId: String(userId || account.userId || ''),
      accountId,
      error: err?.message || 'Upload failed',
    });
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
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader(
      'Cache-Control',
      (req.query.preview === '1' && !meta?.isEncrypted)
        ? 'private, max-age=86400, no-transform'
        : 'private, no-cache, no-transform'
    );
    const dispositionType = (meta?.isEncrypted === true) ? 'attachment' : (req.query.preview === '1' ? 'inline' : 'attachment');

    if (account.accountType === 'tgdrive') {
      if (!meta) return res.status(404).send('File not found');

      const tgSize = (meta.isNote === true && typeof meta.textContent === 'string')
        ? Buffer.byteLength(meta.textContent, 'utf8')
        : (meta.isEncrypted ? Number(meta.encryptedSizeBytes ?? meta.size ?? 0) : Number(meta.size || 0));
      const etag = meta.isEncrypted && meta.encryptedChecksum
        ? `"${meta.encryptedChecksum}"`
        : `"${meta._id}-${tgSize}"`;
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag && !req.headers.range) {
        return res.status(304).end();
      }

      const downloadName = meta.isEncrypted ? (meta.opaqueRemoteName || meta.name) : meta.name;
      res.setHeader('Content-Disposition', buildSafeContentDisposition(dispositionType, downloadName));
      if (isHead) {
        const resolvedHeadMime = meta.isEncrypted
          ? 'application/octet-stream'
          : (meta.mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : (meta.mimeType || 'application/octet-stream'));
        res.setHeader('Content-Type', resolvedHeadMime);
        const effectiveRange = shouldHonorRangeHeader(req.headers, etag) ? req.headers.range : undefined;
        const parsedRange = parseHttpByteRange(effectiveRange, tgSize);
        if (parsedRange.kind === 'invalid') {
          res.setHeader('Content-Range', `bytes */${tgSize}`);
          return res.status(416).end();
        }
        if (parsedRange.kind === 'range') {
          res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${tgSize}`);
          res.setHeader('Content-Length', String(parsedRange.length));
          return res.status(206).end();
        }
        if (tgSize >= 0) res.setHeader('Content-Length', String(tgSize));
        return res.status(200).end();
      }
      systemMetrics.downloadBytesTotal += tgSize;
      recordAuditEvent('file_downloaded', { userId: userId ? String(userId) : null, accountId, fileId, provider: 'tgdrive' });
      await tgStreamFile(meta.messageId, account.channelId, req, res, meta);
      return;
    }

    if (account.accountType === 'onedrive') {
      const c    = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
      const item = await c.api(`/me/drive/items/${fileId}`).get();
      const dlUrl = item['@microsoft.graph.downloadUrl'];
      if (!dlUrl) return res.status(404).send('Download link not available');

      const totalSize = Number(item.size || 0);
      const isEncrypted = meta?.isEncrypted === true;
      const downloadName = isEncrypted ? (meta.opaqueRemoteName || item.name) : item.name;
      const odEtag = (isEncrypted && meta?.encryptedChecksum) ? `"${meta.encryptedChecksum}"` : `"${account._id}-${fileId}-${totalSize}"`;
      res.setHeader('ETag', odEtag);
      res.setHeader('Content-Disposition', buildSafeContentDisposition(dispositionType, downloadName));
      res.setHeader('Content-Type', isEncrypted ? 'application/octet-stream' : (item.file?.mimeType || 'application/octet-stream'));

      const effectiveRange = shouldHonorRangeHeader(req.headers, odEtag) ? req.headers.range : undefined;
      const parsedRange = parseHttpByteRange(effectiveRange, totalSize);
      if (parsedRange.kind === 'invalid') {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }

      if (isHead) {
        if (parsedRange.kind === 'range') {
          res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`);
          res.setHeader('Content-Length', String(parsedRange.length));
          return res.status(206).end();
        }
        if (totalSize > 0) res.setHeader('Content-Length', String(totalSize));
        return res.status(200).end();
      }

      systemMetrics.downloadBytesTotal += parsedRange.kind === 'range' ? parsedRange.length : totalSize;
      recordAuditEvent('file_downloaded', { userId: userId ? String(userId) : null, accountId, fileId, provider: 'onedrive' });
      const upstreamHeaders: Record<string, string> = { 'Accept-Encoding': 'identity' };
      if (parsedRange.kind === 'range') upstreamHeaders.Range = parsedRange.header;

      const response = await axios.get(dlUrl, {
        responseType: 'stream',
        timeout: PROVIDER_API_TIMEOUT_MS,
        headers: upstreamHeaders,
        decompress: false,
        validateStatus: (status: number) => status === 200 || status === 206 || status === 416
      });
      if (response.status === 416) {
        res.setHeader('Content-Range', response.headers['content-range'] || (totalSize > 0 ? `bytes */${totalSize}` : 'bytes */*'));
        return res.status(416).end();
      }
      if (response.status === 206) res.status(206);
      for (const header of ['content-range', 'content-length', 'accept-ranges']) {
        if (response.headers[header]) res.setHeader(header, response.headers[header]);
      }
      if (!res.getHeader('Content-Length')) {
        if (response.status === 206 && parsedRange.kind === 'range') {
          res.setHeader('Content-Length', String(parsedRange.length));
        } else if (response.status === 200 && totalSize > 0) {
          res.setHeader('Content-Length', String(totalSize));
        }
      }
      if (response.status === 206 && !res.getHeader('Content-Range') && parsedRange.kind === 'range') {
        res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`);
      }
      res.setHeader('Accept-Ranges', 'bytes');
      pipeUpstreamWithAbort(response.data, req, res);
      return;
    }

    const drive    = await getDriveClient(account.tokens || account.credentials);
    const file     = await drive.files.get({ fileId, fields: 'name,mimeType,size' });
    const totalSize = Number(file.data.size || 0);
    const isEncrypted = meta?.isEncrypted === true;
    const fileName = isEncrypted ? (meta.opaqueRemoteName || file.data.name || 'file') : (file.data.name || 'file');
    const gdEtag = (isEncrypted && meta?.encryptedChecksum) ? `"${meta.encryptedChecksum}"` : `"${account._id}-${fileId}-${totalSize}"`;
    res.setHeader('ETag', gdEtag);
    res.setHeader('Content-Disposition', buildSafeContentDisposition(dispositionType, fileName));
    res.setHeader('Content-Type', isEncrypted ? 'application/octet-stream' : (file.data.mimeType || 'application/octet-stream'));

    const effectiveRange = shouldHonorRangeHeader(req.headers, gdEtag) ? req.headers.range : undefined;
    const parsedRange = parseHttpByteRange(effectiveRange, totalSize);
    if (parsedRange.kind === 'invalid') {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      return res.status(416).end();
    }

    if (isHead) {
      if (parsedRange.kind === 'range') {
        res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`);
        res.setHeader('Content-Length', String(parsedRange.length));
        return res.status(206).end();
      }
      if (totalSize > 0) res.setHeader('Content-Length', String(totalSize));
      return res.status(200).end();
    }

    systemMetrics.downloadBytesTotal += parsedRange.kind === 'range' ? parsedRange.length : totalSize;
    recordAuditEvent('file_downloaded', { userId: userId ? String(userId) : null, accountId, fileId, provider: 'google' });
    const gdHeaders: Record<string, string> = { 'Accept-Encoding': 'identity' };
    if (parsedRange.kind === 'range') gdHeaders.Range = parsedRange.header;

    const response = await drive.files.get(
      { fileId, alt: 'media' },
      {
        responseType: 'stream',
        headers: gdHeaders,
        validateStatus: (status: number) => status === 200 || status === 206 || status === 416
      } as any
    );
    if (response.status === 416) {
      const contentRange = response.headers?.['content-range'] || (totalSize > 0 ? `bytes */${totalSize}` : undefined);
      if (contentRange) res.setHeader('Content-Range', contentRange);
      return res.status(416).end();
    }
    if (response.status === 206) res.status(206);
    for (const header of ['content-range', 'content-length', 'accept-ranges']) {
      const value = response.headers?.[header];
      if (value) res.setHeader(header, value);
    }
    if (!res.getHeader('Content-Length')) {
      if (response.status === 206 && parsedRange.kind === 'range') {
        res.setHeader('Content-Length', String(parsedRange.length));
      } else if (response.status === 200 && totalSize > 0) {
        res.setHeader('Content-Length', String(totalSize));
      }
    }
    if (response.status === 206 && !res.getHeader('Content-Range') && parsedRange.kind === 'range') {
      res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`);
    }
    res.setHeader('Accept-Ranges', 'bytes');
    pipeUpstreamWithAbort(response.data, req, res);
  } catch (err: any) {
    downloadSlot.release();
    console.error('Download error:', err);
    if (!res.headersSent) res.status(500).send(err.message);
  }
}

// ─── One-Time / Short-Lived Download Tickets ──────────────────────────────────
app.post('/api/download-tickets', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const { accountId, fileId, singleUse = true, ttlSeconds = 300 } = req.body || {};
  if (!isSafeProviderItemId(fileId)) {
    return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid file identifier', req.requestId);
  }
  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, req.userId, req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);

  const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, account, fileId, req.userId, req.isAdmin);
  if (fileDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this file', req.requestId);
  if (account.accountType === 'tgdrive' && !meta) {
    return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'File not found', req.requestId);
  }
  if (account.accountType === 'tgdrive') {
    const channelAccess = await checkTgChannelAccess(account.channelId, bot);
    if (!channelAccess.ok) {
      return apiError(res, 403, 'TG_CHANNEL_ACCESS_DENIED', channelAccess.message || formatTgChannelError(new Error('CHANNEL_INVALID'), account.channelId), req.requestId);
    }
  }

  const now = new Date();
  const boundedTtl = Math.min(3600, Math.max(15, Number(ttlSeconds) || 300));
  const expiresAt = new Date(now.getTime() + boundedTtl * 1000);
  const ticket = `dlt_${nanoid(32)}`;
  await database.collection('download_tickets').insertOne({
    ticket,
    userId: req.userId ? String(req.userId) : null,
    accountId: String(account._id),
    fileId: String(fileId),
    singleUse: Boolean(singleUse),
    usedCount: 0,
    revoked: false,
    createdAt: now,
    expiresAt,
  });
  recordAuditEvent('download_ticket_created', { userId: req.userId ? String(req.userId) : null, accountId: String(account._id), fileId: String(fileId), singleUse: Boolean(singleUse) });
  const envBase = (process.env.APP_URL || '').replace(/\/$/, '');
  const reqHost = req.get('host');
  const resolvedBaseUrl = envBase || (reqHost ? `${req.protocol}://${reqHost}` : '');
  res.status(201).json({
    ticket,
    downloadUrl: `${resolvedBaseUrl}/api/download/ticket/${encodeURIComponent(ticket)}`,
    singleUse: Boolean(singleUse),
    expiresAt: expiresAt.toISOString(),
  });
});

app.delete('/api/download-tickets/:ticket', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const ticket = String(req.params.ticket || '').trim();
  const query: any = { ticket };
  if (!req.isAdmin && req.userId) query.userId = String(req.userId);
  const existing = await database.collection('download_tickets').findOne(query);
  if (!existing) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Download ticket not found', req.requestId);
  await database.collection('download_tickets').updateOne({ _id: existing._id }, { $set: { revoked: true, revokedAt: new Date() } });
  recordAuditEvent('download_ticket_revoked', { userId: req.userId ? String(req.userId) : null, ticket });
  res.json({ success: true, revokedTicket: ticket });
});

async function handleTicketDownload(req: any, res: any, isHead = false) {
  const database = db || await connectToMongo();
  const ticket = String(req.params.ticket || '').trim();
  if (!/^dlt_[A-Za-z0-9_-]{8,128}$/.test(ticket)) {
    return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Download ticket is invalid or revoked', req.requestId);
  }
  const doc = await database.collection('download_tickets').findOne({ ticket });
  if (!doc || doc.revoked) {
    return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Download ticket is invalid or revoked', req.requestId);
  }
  if (doc.expiresAt && new Date(doc.expiresAt).getTime() <= Date.now()) {
    return apiError(res, 410, STANDARD_ERROR_CODES.NOT_FOUND, 'Download ticket has expired', req.requestId);
  }
  if (doc.singleUse && Number(doc.usedCount || 0) >= 1) {
    return apiError(res, 410, STANDARD_ERROR_CODES.CONFLICT, 'One-time download ticket has already been used', req.requestId);
  }
  // Do not burn download tickets on HEAD metadata probes from browsers / download managers
  if (!isHead) {
    await database.collection('download_tickets').updateOne(
      { _id: doc._id },
      { $inc: { usedCount: 1 }, $set: { lastUsedAt: new Date() } }
    );
  }
  req.db = database;
  req.params.accountId = String(doc.accountId);
  req.params.fileId = String(doc.fileId);
  req.userId = doc.userId;
  req.mediaSigned = true;
  req.isSignedMedia = true;
  return handleDownloadRequest(req, res, isHead);
}

app.head('/api/download/ticket/:ticket', (req: any, res: any) => handleTicketDownload(req, res, true));
app.get('/api/download/ticket/:ticket', (req: any, res: any) => handleTicketDownload(req, res, false));

app.head('/api/download/:accountId/:fileId', requireAuthOrSignedMedia, (req: any, res: any) => handleDownloadRequest(req, res, true));
app.get('/api/download/:accountId/:fileId', requireAuthOrSignedMedia, (req: any, res: any) => handleDownloadRequest(req, res, false));


// ─── Share (with Expiry, MaxDownloads, PIN, Revocation & 7-Point Validation) ─
app.post('/api/share', requireAuth, async (req: any, res: any) => {
  const { accountId, fileId, expiresAt: rawExpiresAt, expiresInHours, maxDownloads, pin, allowDownload = true } = req.body || {};
  const userId   = req.userId;
  const database = req.db;

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

    let expiresAt: Date | null = null;
    if (rawExpiresAt) {
      const parsed = new Date(rawExpiresAt);
      if (!Number.isNaN(parsed.getTime())) expiresAt = parsed;
    } else if (Number.isFinite(Number(expiresInHours)) && Number(expiresInHours) > 0) {
      expiresAt = new Date(Date.now() + Number(expiresInHours) * 3600 * 1000);
    }
    const cleanMaxDownloads = Number.isFinite(Number(maxDownloads)) && Number(maxDownloads) > 0 ? Math.floor(Number(maxDownloads)) : null;
    const cleanPin = typeof pin === 'string' && pin.trim() ? pin.trim().slice(0, 32) : null;

    if (account.accountType === 'tgdrive') {
      if (!meta) return res.status(404).json({ error: 'File not found' });
      let { shareId } = meta;
      if (!shareId) {
        shareId = nanoid(6);
        await database.collection('tg_files').updateOne({ _id: meta._id }, { $set: { shareId } });
      }
      await database.collection('shares').updateOne(
        { shareId },
        {
          $set: {
            shareId,
            userId: userId ? String(userId) : null,
            accountId: account._id,
            fileId: String(meta._id),
            active: true,
            revoked: false,
            allowDownload: Boolean(allowDownload),
            expiresAt,
            maxDownloads: cleanMaxDownloads,
            pin: cleanPin,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            downloadCount: 0,
            createdAt: new Date().toISOString(),
          },
        },
        { upsert: true }
      );
      recordAuditEvent('share_created', { userId: userId ? String(userId) : null, accountId: String(account._id), fileId: String(meta._id), shareId });
      return res.json({ success: true, shareId, shareUrl: `${shareBase}/s/${shareId}`, expiresAt: expiresAt ? expiresAt.toISOString() : null, maxDownloads: cleanMaxDownloads });
    }

    const shareId = nanoid(6);
    await database.collection('shares').insertOne({
      shareId,
      userId: userId ? String(userId) : null,
      accountId: account._id,
      fileId,
      active: true,
      revoked: false,
      allowDownload: Boolean(allowDownload),
      expiresAt,
      maxDownloads: cleanMaxDownloads,
      downloadCount: 0,
      pin: cleanPin,
      createdAt: new Date().toISOString(),
    });
    recordAuditEvent('share_created', { userId: userId ? String(userId) : null, accountId: String(account._id), fileId: String(fileId), shareId });
    res.json({ success: true, shareId, shareUrl: `${shareBase}/s/${shareId}`, expiresAt: expiresAt ? expiresAt.toISOString() : null, maxDownloads: cleanMaxDownloads });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shares', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const query: any = { revoked: { $ne: true } };
  if (!req.isAdmin && req.userId) query.userId = String(req.userId);
  const shares = await database.collection('shares').find(query).sort({ createdAt: -1 }).limit(100).toArray();
  res.json(shares.map((s: any) => ({
    shareId: s.shareId,
    accountId: String(s.accountId),
    fileId: String(s.fileId),
    active: s.active !== false && s.revoked !== true,
    allowDownload: s.allowDownload !== false,
    expiresAt: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
    maxDownloads: s.maxDownloads ?? null,
    downloadCount: s.downloadCount || 0,
    hasPin: Boolean(s.pin),
    createdAt: s.createdAt,
  })));
});

app.delete('/api/share/:shareId', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const shareId = String(req.params.shareId || '').trim();
  const share = await database.collection('shares').findOne({ shareId });
  const tgMeta = await database.collection('tg_files').findOne({ shareId });
  if (!share && !tgMeta) {
    return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Share not found', req.requestId);
  }
  const ownerId = share?.userId || tgMeta?.userId;
  if (!req.isAdmin && ownerId && String(ownerId) !== String(req.userId || '')) {
    return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Access denied to this share', req.requestId);
  }
  if (share) {
    await database.collection('shares').updateOne(
      { _id: share._id },
      { $set: { active: false, revoked: true, revokedAt: new Date() } }
    );
  }
  if (tgMeta) {
    await database.collection('tg_files').updateOne(
      { _id: tgMeta._id },
      { $unset: { shareId: '' } }
    );
  }
  recordAuditEvent('share_revoked', { userId: req.userId ? String(req.userId) : null, shareId });
  res.json({ success: true, revokedShareId: shareId });
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
      if (meta.isEncrypted) delete newMeta.shareId;
      else newMeta.shareId = nanoid(6);
      
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
        delete clonedMeta.shareId;
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
        delete clonedMeta.shareId;
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

// ─── 7-Point Public Share Validation Helper ──────────────────────────────────
async function validatePublicShareState(
  database: any,
  shareId: string,
  req: any,
  requireDownloadPermission: boolean
): Promise<{
  ok: boolean;
  share?: any | null;
  tgMeta?: any | null;
  account?: any;
  status?: number;
  code?: string;
  message?: string;
  isJsonError?: boolean;
}> {
  const share = await database.collection('shares').findOne({ shareId });
  const tgMeta = await database.collection('tg_files').findOne({ shareId });

  // 1. Share exists
  if (!share && !tgMeta) {
    return { ok: false, status: 404, message: 'Share link expired or invalid' };
  }

  // 2. Share is active (not revoked / disabled)
  if (share && (share.revoked === true || share.active === false)) {
    return { ok: false, status: 410, message: 'Share link has been revoked' };
  }

  // 3. Share is not expired & within maxDownloads limit
  if (share?.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) {
    return { ok: false, status: 410, message: 'Share link has expired' };
  }
  if (requireDownloadPermission && share?.maxDownloads && Number(share.downloadCount || 0) >= Number(share.maxDownloads)) {
    return { ok: false, status: 410, message: 'Share download limit reached' };
  }

  // Optional PIN check if share has a PIN configured
  if (share?.pin) {
    const suppliedPin = typeof req.query?.pin === 'string'
      ? req.query.pin.trim()
      : (typeof req.headers?.['x-share-pin'] === 'string' ? req.headers['x-share-pin'].trim() : '');
    if (suppliedPin !== String(share.pin)) {
      return { ok: false, status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN, message: 'Valid share PIN required', isJsonError: true };
    }
  }

  // 4. Share permissions allow download
  if (requireDownloadPermission && share && share.allowDownload === false) {
    return { ok: false, status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN, message: 'Downloads are disabled for this share', isJsonError: true };
  }

  // 5. File is not trashed (for TG Drive metadata)
  if (tgMeta && tgMeta.trashed === true) {
    return { ok: false, status: 404, message: 'Shared file has been moved to trash' };
  }

  // 6. Account exists and is active
  const accountId = tgMeta ? tgMeta.accountId : share.accountId;
  const account = await database.collection('accounts').findOne({ _id: accountId });
  if (!account || account.disabled === true || account.status === 'disabled') {
    return { ok: false, status: 404, message: 'Account disconnected or disabled' };
  }

  return { ok: true, share, tgMeta, account };
}

// ─── Public download (no auth, 7-point validation, HEAD + byte-range resume) ──
async function handlePublicDownloadRequest(req: any, res: any, isHead = false) {
  const { shareId } = req.params;
  const database    = db || await connectToMongo();

  if (typeof shareId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(shareId)) {
    return res.status(400).send('Invalid share link');
  }

  try {
    const check = await validatePublicShareState(database, shareId, req, true);
    if (!check.ok) {
      recordAuditEvent('public_share_denied', { shareId, reason: check.message, status: check.status, ip: getClientIp(req) });
      if (check.isJsonError) {
        return apiError(res, check.status, check.code || STANDARD_ERROR_CODES.FORBIDDEN, check.message, req.requestId);
      }
      return res.status(check.status).send(check.message);
    }

    const { share, tgMeta, account } = check;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'private, no-cache, no-transform');

    const shouldCountDownload = (parsedRange: ReturnType<typeof parseHttpByteRange>) =>
      !isHead && (parsedRange.kind === 'none' || (parsedRange.kind === 'range' && parsedRange.start === 0));

    // Check TG Drive files first
    if (tgMeta) {
      if (tgMeta.isEncrypted === true) {
        return apiError(res, 409, 'ENCRYPTED_SHARE_UNSUPPORTED', 'Encrypted file sharing is not supported', req.requestId);
      }
      const tgSize = Number(tgMeta.size || 0);
      const etag = `"${tgMeta._id}-${tgSize}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Content-Disposition', buildSafeContentDisposition('attachment', tgMeta.name));
      res.setHeader('Content-Type', tgMeta.mimeType || 'application/octet-stream');
      const effectiveRange = shouldHonorRangeHeader(req.headers, etag) ? req.headers.range : undefined;
      const parsedRange = parseHttpByteRange(effectiveRange, tgSize);
      if (parsedRange.kind === 'invalid') {
        res.setHeader('Content-Range', `bytes */${tgSize}`);
        return res.status(416).end();
      }
      if (isHead) {
        if (parsedRange.kind === 'range') {
          res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${tgSize}`);
          res.setHeader('Content-Length', String(parsedRange.length));
          return res.status(206).end();
        }
        if (tgSize > 0) res.setHeader('Content-Length', String(tgSize));
        return res.status(200).end();
      }
      if (share && shouldCountDownload(parsedRange)) {
        await database.collection('shares').updateOne({ _id: share._id }, { $inc: { downloadCount: 1 }, $set: { lastAccessedAt: new Date() } });
      }
      recordAuditEvent('public_share_downloaded', { shareId, accountId: String(account._id), fileId: String(tgMeta._id), ip: getClientIp(req) });
      await tgStreamFile(tgMeta.messageId, account.channelId, req, res, tgMeta);
      return;
    }

    if (!share || !isSafeProviderItemId(String(share.fileId))) return res.status(400).send('Invalid shared file');

    const { meta } = await resolveFileMetadataForAccount(database, account, String(share.fileId), null, true);
    if (meta?.isEncrypted === true) {
      return apiError(res, 409, 'ENCRYPTED_SHARE_UNSUPPORTED', 'Encrypted file sharing is not supported', req.requestId);
    }
    if (meta?.trashed === true) {
      return res.status(404).send('Shared file has been moved to trash');
    }

    if (account.accountType === 'tgdrive') {
      if (!ObjectId.isValid(String(share.fileId))) return res.status(404).send('File not found');
      const tgDoc = await database.collection('tg_files').findOne({ _id: new ObjectId(String(share.fileId)), accountId: account._id });
      if (!tgDoc || tgDoc.trashed === true) return res.status(404).send('Shared file no longer exists');
      const tgSize = Number(tgDoc.size || 0);
      const etag = `"${tgDoc._id}-${tgSize}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Content-Disposition', buildSafeContentDisposition('attachment', tgDoc.name));
      res.setHeader('Content-Type', tgDoc.mimeType || 'application/octet-stream');
      const effectiveRange = shouldHonorRangeHeader(req.headers, etag) ? req.headers.range : undefined;
      const parsedRange = parseHttpByteRange(effectiveRange, tgSize);
      if (parsedRange.kind === 'invalid') {
        res.setHeader('Content-Range', `bytes */${tgSize}`);
        return res.status(416).end();
      }
      if (isHead) {
        if (parsedRange.kind === 'range') {
          res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${tgSize}`);
          res.setHeader('Content-Length', String(parsedRange.length));
          return res.status(206).end();
        }
        if (tgSize > 0) res.setHeader('Content-Length', String(tgSize));
        return res.status(200).end();
      }
      if (shouldCountDownload(parsedRange)) {
        await database.collection('shares').updateOne({ _id: share._id }, { $inc: { downloadCount: 1 }, $set: { lastAccessedAt: new Date() } });
      }
      recordAuditEvent('public_share_downloaded', { shareId, accountId: String(account._id), fileId: String(tgDoc._id), ip: getClientIp(req) });
      await tgStreamFile(tgDoc.messageId, account.channelId, req, res, tgDoc);
      return;
    }

    if (account.accountType === 'onedrive') {
      const c    = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
      const item = await c.api(`/me/drive/items/${share.fileId}`).get();
      if (!item || item.deleted) return res.status(404).send('Shared file has been deleted');
      const dlUrl = item['@microsoft.graph.downloadUrl'];
      if (!dlUrl) return res.status(404).send('Download link not available');
      const totalSize = Number(item.size || 0);
      const etag = `"${account._id}-${share.fileId}-${totalSize}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Content-Disposition', buildSafeContentDisposition('attachment', item.name));
      res.setHeader('Content-Type', item.file?.mimeType || 'application/octet-stream');
      const effectiveRange = shouldHonorRangeHeader(req.headers, etag) ? req.headers.range : undefined;
      const parsedRange = parseHttpByteRange(effectiveRange, totalSize);
      if (parsedRange.kind === 'invalid') {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }
      if (isHead) {
        if (parsedRange.kind === 'range') {
          res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`);
          res.setHeader('Content-Length', String(parsedRange.length));
          return res.status(206).end();
        }
        if (totalSize > 0) res.setHeader('Content-Length', String(totalSize));
        return res.status(200).end();
      }
      if (shouldCountDownload(parsedRange)) {
        await database.collection('shares').updateOne({ _id: share._id }, { $inc: { downloadCount: 1 }, $set: { lastAccessedAt: new Date() } });
      }
      recordAuditEvent('public_share_downloaded', { shareId, accountId: String(account._id), fileId: String(share.fileId), ip: getClientIp(req) });
      const upstreamHeaders: Record<string, string> = { 'Accept-Encoding': 'identity' };
      if (parsedRange.kind === 'range') upstreamHeaders.Range = parsedRange.header;
      const r = await axios.get(dlUrl, {
        responseType: 'stream',
        headers: upstreamHeaders,
        decompress: false,
        validateStatus: (status: number) => status === 200 || status === 206 || status === 416
      });
      if (r.status === 416) {
        res.setHeader('Content-Range', r.headers['content-range'] || (totalSize > 0 ? `bytes */${totalSize}` : 'bytes */*'));
        return res.status(416).end();
      }
      if (r.status === 206) res.status(206);
      for (const header of ['content-range', 'content-length', 'accept-ranges']) if (r.headers[header]) res.setHeader(header, r.headers[header]);
      if (!res.getHeader('Content-Length')) {
        if (r.status === 206 && parsedRange.kind === 'range') res.setHeader('Content-Length', String(parsedRange.length));
        else if (r.status === 200 && totalSize > 0) res.setHeader('Content-Length', String(totalSize));
      }
      if (r.status === 206 && !res.getHeader('Content-Range') && parsedRange.kind === 'range') {
        res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`);
      }
      res.setHeader('Accept-Ranges', 'bytes');
      pipeUpstreamWithAbort(r.data, req, res);
      return;
    }

    const drive    = await getDriveClient(account.tokens || account.credentials);
    const file     = await drive.files.get({ fileId: share.fileId, fields: 'name,mimeType,size,trashed' });
    if (!file?.data || file.data.trashed === true) return res.status(404).send('Shared file has been trashed or deleted');
    const totalSize = Number(file.data.size || 0);
    const etag = `"${account._id}-${share.fileId}-${totalSize}"`;
    const fileName = file.data.name || 'file';
    res.setHeader('ETag', etag);
    res.setHeader('Content-Disposition', buildSafeContentDisposition('attachment', fileName));
    res.setHeader('Content-Type', file.data.mimeType || 'application/octet-stream');
    const effectiveRange = shouldHonorRangeHeader(req.headers, etag) ? req.headers.range : undefined;
    const parsedRange = parseHttpByteRange(effectiveRange, totalSize);
    if (parsedRange.kind === 'invalid') {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      return res.status(416).end();
    }
    if (isHead) {
      if (parsedRange.kind === 'range') {
        res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`);
        res.setHeader('Content-Length', String(parsedRange.length));
        return res.status(206).end();
      }
      if (totalSize > 0) res.setHeader('Content-Length', String(totalSize));
      return res.status(200).end();
    }
    if (shouldCountDownload(parsedRange)) {
      await database.collection('shares').updateOne({ _id: share._id }, { $inc: { downloadCount: 1 }, $set: { lastAccessedAt: new Date() } });
    }
    recordAuditEvent('public_share_downloaded', { shareId, accountId: String(account._id), fileId: String(share.fileId), ip: getClientIp(req) });
    const gdHeaders: Record<string, string> = { 'Accept-Encoding': 'identity' };
    if (parsedRange.kind === 'range') gdHeaders.Range = parsedRange.header;
    const response = await drive.files.get(
      { fileId: share.fileId, alt: 'media' },
      {
        responseType: 'stream',
        headers: gdHeaders,
        validateStatus: (status: number) => status === 200 || status === 206 || status === 416
      } as any
    );
    if (response.status === 416) {
      res.setHeader('Content-Range', response.headers?.['content-range'] || (totalSize > 0 ? `bytes */${totalSize}` : 'bytes */*'));
      return res.status(416).end();
    }
    if (response.status === 206) res.status(206);
    for (const header of ['content-range', 'content-length', 'accept-ranges']) { const value = response.headers?.[header]; if (value) res.setHeader(header, value); }
    if (!res.getHeader('Content-Length')) {
      if (response.status === 206 && parsedRange.kind === 'range') res.setHeader('Content-Length', String(parsedRange.length));
      else if (response.status === 200 && totalSize > 0) res.setHeader('Content-Length', String(totalSize));
    }
    if (response.status === 206 && !res.getHeader('Content-Range') && parsedRange.kind === 'range') {
      res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`);
    }
    res.setHeader('Accept-Ranges', 'bytes');
    pipeUpstreamWithAbort(response.data, req, res);
  } catch {
    if (!res.headersSent) res.status(500).send('Download failed');
  }
}

app.head('/api/public/download/:shareId', (req: any, res: any) => handlePublicDownloadRequest(req, res, true));
app.get('/api/public/download/:shareId', (req: any, res: any) => handlePublicDownloadRequest(req, res, false));

// ─── Public share page (7-point validation) ───────────────────────────────────
app.get('/s/:shareId', async (req: any, res: any) => {
  const { shareId } = req.params;
  const database    = db || await connectToMongo();

  if (typeof shareId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(shareId)) {
    return res.status(400).send('Invalid share link');
  }
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline' https://cdn.tailwindcss.com; script-src https://cdn.tailwindcss.com; img-src 'self' https: data:; frame-ancestors 'none'; base-uri 'none'");

  try {
    const check = await validatePublicShareState(database, shareId, req, false);
    if (!check.ok) {
      if (check.isJsonError) {
        return apiError(res, check.status, check.code || STANDARD_ERROR_CODES.FORBIDDEN, check.message, req.requestId);
      }
      return res.status(check.status).send(check.message);
    }

    const { share, tgMeta, account } = check;
    if (tgMeta) {
      if (tgMeta.isEncrypted === true) {
        return apiError(res, 409, 'ENCRYPTED_SHARE_UNSUPPORTED', 'Encrypted file sharing is not supported', req.requestId);
      }
      const sizeMB = tgMeta.size ? (Number(tgMeta.size) / (1024 ** 2)).toFixed(2) + ' MB' : 'Unknown size';
      const isMedia = tgMeta.mimeType?.startsWith('image/') || tgMeta.mimeType?.startsWith('video/');
      const thumb = isMedia ? `/api/thumb/${tgMeta.accountId}/${tgMeta._id}?s=256` : null;
      return res.send(buildSharePage(tgMeta.name, sizeMB, tgMeta.mimeType || '', thumb, shareId, true));
    }

    if (!share || !isSafeProviderItemId(String(share.fileId))) return res.status(400).send('Invalid shared file');

    const { meta } = await resolveFileMetadataForAccount(database, account, String(share.fileId), null, true);
    if (meta?.isEncrypted === true) {
      return apiError(res, 409, 'ENCRYPTED_SHARE_UNSUPPORTED', 'Encrypted file sharing is not supported', req.requestId);
    }
    if (meta?.trashed === true) {
      return res.status(404).send('File no longer exists');
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
      if (!item || item.deleted) return res.status(404).send('File no longer exists');
      const sizeMB = item.size ? (Number(item.size) / (1024 ** 2)).toFixed(2) + ' MB' : 'Unknown size';
      return res.send(buildSharePage(item.name, sizeMB, item.file?.mimeType || '', null, shareId, false));
    }

    const drive  = await getDriveClient(account.tokens || account.credentials);
    const file   = await drive.files.get({ fileId: share.fileId, fields: 'name,mimeType,size,thumbnailLink,trashed' });
    if (!file?.data || file.data.trashed === true) return res.status(404).send('File no longer exists');
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

// ─── Whole-Drive / Subfolder Recursive Manifest (for native Android downloads) ─
app.get('/api/accounts/:accountId/manifest', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const accountId = String(req.params.accountId || '').trim();
  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, req.userId, !!req.isAdmin);
  if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
  if (!account) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Account not found', req.requestId);

  const rawFolderId = typeof req.query.folderId === 'string' ? req.query.folderId.trim() : '';
  let cleanFolderId = '';
  if (rawFolderId && rawFolderId !== 'root') {
    const folderCheck = validateSafeFolderId(rawFolderId);
    if (!folderCheck.ok) {
      return apiError(res, folderCheck.error.status, folderCheck.error.code, folderCheck.error.message, req.requestId);
    }
    cleanFolderId = folderCheck.folderId === 'root' ? '' : folderCheck.folderId;
  }

  const parsedLimit = parseInt(String(req.query.maxFiles || '25000'), 10);
  const maxFiles = Number.isFinite(parsedLimit) ? Math.min(25000, Math.max(1, parsedLimit)) : 25000;

  try {
    const manifest = await collectAccountManifest(database, account, cleanFolderId, maxFiles, false);
    res.setHeader('Cache-Control', 'no-store');
    return res.json(manifest);
  } catch (err: any) {
    return apiError(res, err?.status || 500, err?.code || STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Failed to build drive manifest', req.requestId);
  }
});

// ─── Server-Side Whole-Drive / Subfolder Copy & Move ──────────────────────────
app.post('/api/transfers/drive', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const {
    sourceAccountId,
    targetAccountId,
    sourceFolderId,
    targetFolderId,
    isMove,
    conflictStrategy: rawConflict,
  } = req.body || {};

  if (typeof sourceAccountId !== 'string' || !sourceAccountId.trim() || typeof targetAccountId !== 'string' || !targetAccountId.trim()) {
    return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'sourceAccountId and targetAccountId are required', req.requestId);
  }

  const cleanSourceId = sourceAccountId.trim();
  const cleanTargetId = targetAccountId.trim();

  const srcFolderCheck = validateSafeFolderId(sourceFolderId);
  if (!srcFolderCheck.ok) {
    return apiError(res, srcFolderCheck.error.status, srcFolderCheck.error.code, srcFolderCheck.error.message, req.requestId);
  }
  const dstFolderCheck = validateSafeFolderId(targetFolderId);
  if (!dstFolderCheck.ok) {
    return apiError(res, dstFolderCheck.error.status, dstFolderCheck.error.code, dstFolderCheck.error.message, req.requestId);
  }

  if (cleanSourceId === cleanTargetId && srcFolderCheck.folderId === dstFolderCheck.folderId) {
    return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Source and destination locations cannot be identical', req.requestId);
  }

  const { account: sourceAccount, accessDenied: sourceDenied } = await resolveAuthorizedAccount(database, cleanSourceId, req.userId, !!req.isAdmin);
  if (sourceDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to source account', req.requestId);
  if (!sourceAccount) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Source account not found', req.requestId);

  const { account: targetAccount, accessDenied: targetDenied } = await resolveAuthorizedAccount(database, cleanTargetId, req.userId, !!req.isAdmin);
  if (targetDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to target account', req.requestId);
  if (!targetAccount) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Target account not found', req.requestId);

  const conflictStrategy: ConflictStrategy =
    rawConflict === 'skip' || rawConflict === 'rename' || rawConflict === 'overwrite'
      ? rawConflict
      : 'skip';
  const moveFlag = Boolean(isMove);

  const sourceName = sourceAccount.name || sourceAccount.email || (sourceAccount.accountType === 'tgdrive' ? 'TG Drive' : 'Source Drive');
  const targetName = targetAccount.name || targetAccount.email || (targetAccount.accountType === 'tgdrive' ? 'TG Drive' : 'Target Drive');
  const displayName = `${sourceName} → ${targetName}`;

  try {
    const job = await enqueueTransferJob(
      database,
      {
        sourceAccountId: cleanSourceId,
        targetAccountId: cleanTargetId,
        sourceFolderId: srcFolderCheck.folderId,
        targetFolderId: dstFolderCheck.folderId,
        sourceAccountName: sourceName,
        targetAccountName: targetName,
        displayName,
        isMove: moveFlag,
        conflictStrategy,
        userId: req.userId ? String(req.userId) : null,
        isAdmin: !!req.isAdmin,
      },
      'drive_transfer'
    );
    recordAuditEvent(moveFlag ? 'drive_move_enqueued' : 'drive_copy_enqueued', {
      jobId: String(job._id),
      userId: req.userId ? String(req.userId) : null,
      sourceAccountId: cleanSourceId,
      targetAccountId: cleanTargetId,
      conflictStrategy,
    });
    runJobWorker().catch(() => {});
    return res.status(202).json({
      success: true,
      async: true,
      jobId: String(job._id),
      status: job.status,
      job: publicJob(job),
    });
  } catch (err: any) {
    return apiError(res, err?.status || 500, err?.code || STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Failed to enqueue drive transfer', req.requestId);
  }
});

app.get('/api/jobs/health', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const [queued, running, failed, deadLettered] = await Promise.all([
    database.collection('jobs').countDocuments({ status: 'queued' }),
    database.collection('jobs').countDocuments({ status: 'running' }),
    database.collection('jobs').countDocuments({ status: 'failed' }),
    database.collection('jobs').countDocuments({ status: 'failed', deadLettered: true }),
  ]);
  const queuesByType: Record<string, { queued: number; running: number }> = {};
  for (const jt of SUPPORTED_JOB_TYPES) {
    const [qCount, rCount] = await Promise.all([
      database.collection('jobs').countDocuments({ type: jt, status: 'queued' }),
      database.collection('jobs').countDocuments({ type: jt, status: 'running' }),
    ]);
    queuesByType[jt] = { queued: qCount, running: rCount };
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: !isShuttingDown,
    workerId: WORKER_ID,
    activeWorkers: activeJobWorkers,
    maxConcurrentWorkers: MAX_CONCURRENT_JOBS,
    maxQueueDepth: MAX_JOB_QUEUE_DEPTH,
    lastWorkerHeartbeatAt: systemMetrics.lastWorkerHeartbeatAt ? new Date(systemMetrics.lastWorkerHeartbeatAt).toISOString() : null,
    workerHeartbeats: systemMetrics.workerHeartbeats,
    totals: { queued, running, failed, deadLettered },
    queues: queuesByType,
  });
});

app.get('/api/jobs', requireAuth, async (req: any, res: any) => {
  const database = req.db || db || await connectToMongo();
  const query: any = {};
  if (!req.isAdmin && req.userId) query['payload.userId'] = String(req.userId);
  if (typeof req.query.status === 'string' && req.query.status.trim()) {
    query.status = req.query.status.trim();
  }
  if (typeof req.query.type === 'string' && req.query.type.trim()) {
    query.type = req.query.type.trim();
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

registerAiBridgeRoutes(app, { getBot: () => bot });
registerArchiveRoutes(app, { bot, enqueueTransferJob, publicJob, collectAccountManifest, runJobWorker });
registerTempDropRoutes(app, { uploadLimiter, downloadLimiter });

// Serve standalone Node.js CLI helper for terminal upload/download automation
app.get(['/api/cli/download', '/cli/cloudyte.mjs'], (req: any, res: any) => {
  const cliPath = path.resolve(process.cwd(), 'cli', 'cloudyte.mjs');
  if (!fs.existsSync(cliPath)) {
    return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'CLI script not found', req.requestId);
  }
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (req.query?.download === '1' || req.path === '/api/cli/download') {
    res.setHeader('Content-Disposition', 'attachment; filename="cloudyte.mjs"');
  }
  res.sendFile(cliPath);
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
      if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/s/') || req.path === '/mcp') {
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
  setShuttingDown(true);
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
  backgroundIntervals.push(setInterval(() => sweepExpiredTempDrop().catch(err => console.error('[TempDrop] Sweep failed:', err)), 5 * 60 * 1000));
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

export {
  STANDARD_ERROR_CODES,
  runEncryptionMigration,
  setTestDependencies,
  resetLoginAttemptsForTest,
  normaliseTgFile,
  sweepUploadSessions,
  sweepExpiredTrash,
  sweepExpiredTempDrop,
  runJobWorker,
  pruneTempFiles,
  pruneThumbDir,
  TEMP_DIR,
};
export default app;

