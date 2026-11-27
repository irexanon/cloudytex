import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as archiverPkg from 'archiver';
import type { Archiver } from 'archiver';
import { ObjectId } from 'mongodb';

const ZipArchive = (archiverPkg as any).ZipArchive as new (options?: any) => Archiver;

import {
  PROVIDER_API_TIMEOUT_MS,
  STANDARD_ERROR_CODES,
  TEMP_DROP_DIR,
  apiError,
  connectToMongo,
  db,
  hasTempDiskHeadroom,
  invalidateDriveCache,
  optionalAuth,
  recordAuditEvent,
  requireAuth,
  upload,
} from './core.ts';

import {
  buildSafeContentDisposition,
  computeFileSha256,
  normalizeSafeFilename,
  parseHttpByteRange,
  validateSafeFolderId,
} from './protocol.ts';

import {
  getDriveClient,
  getOneDriveClient,
  permanentlyDeleteSingleFile,
  pipeUpstreamWithAbort,
  resolveAuthorizedAccount,
  resolveFileMetadataForAccount,
  tgStreamFile,
  transferProviderType,
  uploadFileToProvider,
} from './provider.ts';

import {
  openProviderFileReadStream,
  waitForEntryStreamAppended,
} from './archive.ts';

export const DEFAULT_TEMP_ROOM_TTL_HOURS = 24;
export const MIN_TEMP_ROOM_TTL_HOURS = 1;
export const MAX_TEMP_ROOM_TTL_HOURS = 168; // 7 days
export const DEFAULT_TEMP_ROOM_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB (temp disk)
export const DEFAULT_DRIVE_TEMP_ROOM_MAX_BYTES = 20 * 1024 * 1024 * 1024; // 20 GiB (drive-backed)
export const DEFAULT_TEMP_FILE_MAX_BYTES = 512 * 1024 * 1024; // 512 MiB (temp disk)
export const DEFAULT_DRIVE_TEMP_FILE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB (drive-backed)
export const MAX_FILES_PER_TEMP_ROOM = 200;

export type TempRoomAccessMode = 'both' | 'upload_only' | 'download_only';

const SAFE_ROOM_CODE_RE = /^[A-Za-z0-9_-]{6,32}$/;
const SAFE_STORAGE_NAME_RE = /^[A-Za-z0-9._-]{8,128}$/;

const SAFE_PREVIEW_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'application/pdf',
]);

function getDb(req?: any) {
  return req?.db || db || connectToMongo();
}

function generateRoomCode(): string {
  return crypto.randomBytes(9).toString('base64url'); // 12 URL-safe chars
}

function generateCreatorToken(): string {
  return crypto.randomBytes(18).toString('base64url'); // 24 URL-safe chars
}

function hashCreatorToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function hashPasscode(passcode: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(passcode, salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPasscodeHash(passcode: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [salt, expectedHex] = parts;
  const derivedHex = crypto.scryptSync(passcode, salt, 32).toString('hex');
  return timingSafeStringEqual(derivedHex, expectedHex);
}

function validateRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!SAFE_ROOM_CODE_RE.test(trimmed)) return null;
  return trimmed;
}

function parseAccessMode(raw: unknown, fallback: TempRoomAccessMode = 'both'): TempRoomAccessMode | null {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (raw === 'both' || raw === 'upload_only' || raw === 'download_only') return raw;
  return null;
}

function resolveTempDropRoot(): string {
  const root = path.resolve(TEMP_DROP_DIR);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
}

function resolveTempDropRoomDir(roomCode: string): string {
  const validCode = validateRoomCode(roomCode);
  if (!validCode) throw new Error('Invalid temp room code');
  const root = resolveTempDropRoot();
  const roomDir = path.resolve(root, validCode);
  if (!roomDir.startsWith(root + path.sep)) {
    throw new Error('Invalid temp room path');
  }
  return roomDir;
}

function resolveTempDropFilePath(roomCode: string, storageName: string): string {
  if (typeof storageName !== 'string' || !SAFE_STORAGE_NAME_RE.test(storageName)) {
    throw new Error('Invalid temp storage name');
  }
  const roomDir = resolveTempDropRoomDir(roomCode);
  const candidate = path.resolve(roomDir, storageName);
  if (!candidate.startsWith(roomDir + path.sep)) {
    throw new Error('Invalid temp file path');
  }
  return candidate;
}

function moveTempFileIntoRoom(srcPath: string, destPath: string): void {
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  try {
    fs.renameSync(srcPath, destPath);
  } catch (err: any) {
    if (err?.code === 'EXDEV') {
      fs.copyFileSync(srcPath, destPath);
      fs.unlinkSync(srcPath);
    } else {
      throw err;
    }
  }
}

function safeUnlink(filePath?: string | null): void {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore */ }
}

function safeRemoveRoomDir(roomCode: string): void {
  try {
    const roomDir = resolveTempDropRoomDir(roomCode);
    if (fs.existsSync(roomDir)) {
      fs.rmSync(roomDir, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}

function isRoomExpired(room: any, nowMs = Date.now()): boolean {
  if (!room?.expiresAt) return true;
  const expMs = new Date(room.expiresAt).getTime();
  return Number.isNaN(expMs) || expMs <= nowMs;
}

function getCreatorTokenFromRequest(req: any): string {
  const headerToken = typeof req.headers['x-temp-creator-token'] === 'string'
    ? req.headers['x-temp-creator-token'].trim()
    : '';
  if (headerToken) return headerToken;
  if (typeof req.body?.creatorToken === 'string') return req.body.creatorToken.trim();
  if (typeof req.query?.creatorToken === 'string') return req.query.creatorToken.trim();
  return '';
}

function getPasscodeFromRequest(req: any): string {
  const headerCode = typeof req.headers['x-temp-passcode'] === 'string'
    ? req.headers['x-temp-passcode']
    : '';
  if (headerCode) return headerCode;
  if (typeof req.query?.passcode === 'string') return req.query.passcode;
  if (typeof req.body?.passcode === 'string') return req.body.passcode;
  return '';
}

function isRequestRoomOwner(req: any, room: any): boolean {
  if (!room) return false;
  if (req.isAdmin) return true;
  if (req.userId && room.ownerUserId && String(req.userId) === String(room.ownerUserId)) {
    return true;
  }
  const candidateToken = getCreatorTokenFromRequest(req);
  if (candidateToken && room.creatorTokenHash) {
    const candidateHash = hashCreatorToken(candidateToken);
    if (timingSafeStringEqual(candidateHash, String(room.creatorTokenHash))) {
      return true;
    }
  }
  return false;
}

function hasValidPasscodeAccess(req: any, room: any, isOwner: boolean): boolean {
  if (!room?.passcodeHash) return true;
  if (isOwner) return true;
  const supplied = getPasscodeFromRequest(req);
  if (!supplied) return false;
  return verifyPasscodeHash(supplied, String(room.passcodeHash));
}

function buildPublicShareOrigin(req: any): string {
  const envUrl = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (envUrl && /^https?:\/\//i.test(envUrl)) return envUrl;
  const proto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http').split(',')[0].trim();
  const host = String(req?.headers?.['x-forwarded-host'] || req?.get?.('host') || '').split(',')[0].trim();
  if (host) return `${proto}://${host}`;
  return '';
}

function serialiseTempRoom(room: any, req: any, isOwner: boolean) {
  const sharePath = `/drop/${room.roomCode}`;
  const origin = buildPublicShareOrigin(req);
  const storageMode = room.storageMode === 'drive' && room.targetAccountId ? 'drive' : 'temp_disk';
  return {
    roomCode: String(room.roomCode),
    title: String(room.title || 'Temp Drop'),
    note: typeof room.note === 'string' ? room.note : '',
    accessMode: (room.accessMode || 'both') as TempRoomAccessMode,
    storageMode,
    targetAccountId: storageMode === 'drive' ? String(room.targetAccountId) : null,
    targetAccountName: storageMode === 'drive' ? String(room.targetAccountName || 'Cloud Drive') : null,
    targetAccountType: storageMode === 'drive' ? String(room.targetAccountType || 'tgdrive') : null,
    targetFolderId: storageMode === 'drive' ? String(room.targetFolderId || 'root') : null,
    targetFolderName: storageMode === 'drive' && typeof room.targetFolderName === 'string' && room.targetFolderName.trim()
      ? room.targetFolderName.trim()
      : null,
    deleteOnExpire: Boolean(room.deleteOnExpire),
    hasPasscode: Boolean(room.passcodeHash),
    isOwner,
    hasAccountOwner: Boolean(room.ownerUserId),
    maxBytes: Number(room.maxBytes || DEFAULT_TEMP_ROOM_MAX_BYTES),
    usedBytes: Math.max(0, Number(room.usedBytes || 0)),
    maxFileBytes: Number(room.maxFileBytes || DEFAULT_TEMP_FILE_MAX_BYTES),
    fileCount: Math.max(0, Number(room.fileCount || 0)),
    downloadCount: Math.max(0, Number(room.downloadCount || 0)),
    expiresAt: new Date(room.expiresAt).toISOString(),
    createdAt: room.createdAt ? new Date(room.createdAt).toISOString() : new Date().toISOString(),
    sharePath,
    shareUrl: origin ? `${origin}${sharePath}` : sharePath,
  };
}

function serialiseTempFile(doc: any, roomCode: string) {
  const id = String(doc._id);
  return {
    id,
    roomCode,
    name: String(doc.name),
    mimeType: String(doc.mimeType || 'application/octet-stream'),
    size: Number(doc.size || 0),
    sha256: typeof doc.sha256 === 'string' ? doc.sha256 : null,
    storageMode: doc.storageMode === 'drive' ? 'drive' : 'temp_disk',
    uploadedByLabel: typeof doc.uploadedByLabel === 'string' && doc.uploadedByLabel.trim() ? doc.uploadedByLabel.trim() : 'Guest',
    downloadCount: Math.max(0, Number(doc.downloadCount || 0)),
    expiresAt: doc.expiresAt ? new Date(doc.expiresAt).toISOString() : null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
    downloadPath: `/api/temp-rooms/${encodeURIComponent(roomCode)}/files/${encodeURIComponent(id)}/download`,
  };
}

function deduplicateZipName(rawName: string, usedNames: Set<string>): string {
  const safe = normalizeSafeFilename(rawName, 'file');
  if (!usedNames.has(safe)) {
    usedNames.add(safe);
    return safe;
  }
  const dotIdx = safe.lastIndexOf('.');
  const stem = dotIdx > 0 ? safe.slice(0, dotIdx) : safe;
  const ext = dotIdx > 0 ? safe.slice(dotIdx) : '';
  let counter = 2;
  while (counter < 10000) {
    const candidate = `${stem} (${counter})${ext}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    counter++;
  }
  return `${Date.now()}_${safe}`;
}

async function purgeDriveTempFile(database: any, fileDoc: any, ownerUserId: string | null) {
  if (!fileDoc || fileDoc.storageMode !== 'drive' || !fileDoc.accountId || !fileDoc.providerFileId) return;
  if (!ObjectId.isValid(String(fileDoc.accountId))) return;
  try {
    const account = await database.collection('accounts').findOne({ _id: new ObjectId(String(fileDoc.accountId)) });
    if (!account) return;
    if (ownerUserId && account.userId && String(account.userId) !== String(ownerUserId)) return;
    await permanentlyDeleteSingleFile(database, account, String(fileDoc.providerFileId), ownerUserId || account.userId, true);
    invalidateDriveCache(String(account._id));
  } catch { /* best-effort cleanup */ }
}

export async function sweepExpiredTempDrop(explicitDb?: any): Promise<{ expiredRooms: number; expiredFiles: number }> {
  const database = explicitDb || await getDb();
  if (!database) return { expiredRooms: 0, expiredFiles: 0 };
  const now = new Date();
  let expiredRooms = 0;
  let expiredFiles = 0;

  try {
    const rooms = await database.collection('temp_rooms').find({ expiresAt: { $lte: now } }).limit(500).toArray();
    for (const room of rooms) {
      if (room?.roomCode) {
        const roomCodeStr = String(room.roomCode);
        if (room.storageMode === 'drive' && room.deleteOnExpire) {
          const driveFiles = await database.collection('temp_files').find({ roomCode: roomCodeStr, storageMode: 'drive' }).toArray();
          for (const df of driveFiles) {
            await purgeDriveTempFile(database, df, room.ownerUserId ? String(room.ownerUserId) : null);
          }
        }
        safeRemoveRoomDir(roomCodeStr);
        await database.collection('temp_files').deleteMany({ roomCode: roomCodeStr });
        await database.collection('temp_rooms').deleteOne({ _id: room._id });
        expiredRooms++;
      }
    }

    const orphanExpiredFiles = await database.collection('temp_files').find({ expiresAt: { $lte: now } }).limit(500).toArray();
    for (const f of orphanExpiredFiles) {
      try {
        if (f?.roomCode && f?.storageName) {
          safeUnlink(resolveTempDropFilePath(String(f.roomCode), String(f.storageName)));
        }
      } catch { /* ignore */ }
      await database.collection('temp_files').deleteOne({ _id: f._id });
      expiredFiles++;
    }
  } catch (err) {
    console.error('[TempDrop] Sweep failed:', err);
  }

  return { expiredRooms, expiredFiles };
}

export function registerTempDropRoutes(app: any, rateLimiters?: { uploadLimiter?: any; downloadLimiter?: any }) {
  const withUploadLimit = rateLimiters?.uploadLimiter ? [rateLimiters.uploadLimiter] : [];
  const withDownloadLimit = rateLimiters?.downloadLimiter ? [rateLimiters.downloadLimiter] : [];

  // List authenticated user's active temp rooms
  app.get('/api/temp-rooms', requireAuth, async (req: any, res: any) => {
    try {
      const database = await getDb(req);
      const now = new Date();
      const query: any = {
        ownerUserId: String(req.userId || ''),
        expiresAt: { $gt: now },
      };
      const rooms = await database.collection('temp_rooms').find(query).sort({ createdAt: -1 }).limit(50).toArray();
      res.json({
        rooms: rooms.map((room: any) => serialiseTempRoom(room, req, true)),
      });
    } catch (err: any) {
      apiError(res, 500, STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Failed to load temp rooms', req.requestId, true);
    }
  });

  // Create a new Temp Drop room (works with OR without auth)
  app.post('/api/temp-rooms', optionalAuth, ...withUploadLimit, async (req: any, res: any) => {
    try {
      const database = await getDb(req);
      const body = req.body && typeof req.body === 'object' ? req.body : {};

      const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
      const title = rawTitle ? rawTitle.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : 'Temp Drop';
      const rawNote = typeof body.note === 'string' ? body.note.trim() : '';
      const note = rawNote ? rawNote.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 400) : '';

      const accessMode = parseAccessMode(body.accessMode, 'both');
      if (!accessMode) {
        return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid accessMode (expected both, upload_only, or download_only)', req.requestId);
      }

      const rawTtlHours = body.ttlHours !== undefined ? Number(body.ttlHours) : DEFAULT_TEMP_ROOM_TTL_HOURS;
      if (!Number.isFinite(rawTtlHours)) {
        return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'ttlHours must be a valid number', req.requestId);
      }
      const ttlHours = Math.min(MAX_TEMP_ROOM_TTL_HOURS, Math.max(MIN_TEMP_ROOM_TTL_HOURS, Math.round(rawTtlHours)));

      const passcodeRaw = typeof body.passcode === 'string' ? body.passcode.trim() : '';
      if (passcodeRaw.length > 64) {
        return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Passcode cannot exceed 64 characters', req.requestId);
      }
      const passcodeHash = passcodeRaw ? hashPasscode(passcodeRaw) : null;

      const rawTargetAccountId = typeof body.targetAccountId === 'string' ? body.targetAccountId.trim() : '';
      let driveConfig: {
        storageMode: 'drive' | 'temp_disk';
        targetAccountId: string | null;
        targetAccountName: string | null;
        targetAccountType: string | null;
        targetFolderId: string | null;
        targetFolderName: string | null;
        deleteOnExpire: boolean;
      } = {
        storageMode: 'temp_disk',
        targetAccountId: null,
        targetAccountName: null,
        targetAccountType: null,
        targetFolderId: null,
        targetFolderName: null,
        deleteOnExpire: true,
      };

      if (rawTargetAccountId) {
        if (!req.userId) {
          return apiError(res, 401, STANDARD_ERROR_CODES.UNAUTHORIZED, 'Sign in required to back a temp room with a cloud drive', req.requestId);
        }
        const rawFolder = typeof body.targetFolderId === 'string' && body.targetFolderId.startsWith('folder:')
          ? body.targetFolderId.slice('folder:'.length)
          : body.targetFolderId;
        const folderCheck = validateSafeFolderId(rawFolder);
        if (!folderCheck.ok) {
          return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid targetFolderId', req.requestId);
        }
        const authAcc = await resolveAuthorizedAccount(database, rawTargetAccountId, req.userId, req.isAdmin);
        if (authAcc.invalidId) return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid targetAccountId', req.requestId);
        if (authAcc.accessDenied) return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Access denied to target drive account', req.requestId);
        if (!authAcc.account) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Target drive account not found', req.requestId);
        if (!transferProviderType(authAcc.account.accountType)) {
          return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Selected drive provider does not support uploads', req.requestId);
        }
        const cleanFolderName = typeof body.targetFolderName === 'string'
          ? body.targetFolderName.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80)
          : '';
        driveConfig = {
          storageMode: 'drive',
          targetAccountId: String(authAcc.account._id),
          targetAccountName: String(authAcc.account.name || authAcc.account.email || (authAcc.account.accountType === 'tgdrive' ? 'TG Drive' : 'Cloud Drive')),
          targetAccountType: String(authAcc.account.accountType || 'tgdrive'),
          targetFolderId: folderCheck.folderId || 'root',
          targetFolderName: cleanFolderName || null,
          deleteOnExpire: Boolean(body.deleteOnExpire),
        };
      }

      let roomCode = generateRoomCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const collision = await database.collection('temp_rooms').findOne({ roomCode });
        if (!collision) break;
        roomCode = generateRoomCode();
      }

      const creatorToken = generateCreatorToken();
      const creatorTokenHash = hashCreatorToken(creatorToken);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000);

      const isDriveBacked = driveConfig.storageMode === 'drive';
      const doc = {
        roomCode,
        ownerUserId: req.userId ? String(req.userId) : null,
        creatorTokenHash,
        title,
        note,
        accessMode,
        ...driveConfig,
        passcodeHash,
        maxBytes: isDriveBacked ? DEFAULT_DRIVE_TEMP_ROOM_MAX_BYTES : DEFAULT_TEMP_ROOM_MAX_BYTES,
        maxFileBytes: isDriveBacked ? DEFAULT_DRIVE_TEMP_FILE_MAX_BYTES : DEFAULT_TEMP_FILE_MAX_BYTES,
        usedBytes: 0,
        fileCount: 0,
        downloadCount: 0,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      };

      await database.collection('temp_rooms').insertOne(doc);
      recordAuditEvent('temp_room_created', {
        userId: req.userId ? String(req.userId) : null,
        roomCode,
        accessMode,
        storageMode: driveConfig.storageMode,
        targetAccountId: driveConfig.targetAccountId,
        ttlHours,
        hasPasscode: Boolean(passcodeHash),
      });

      const serialised = serialiseTempRoom(doc, req, true);
      res.status(201).json({
        success: true,
        room: serialised,
        creatorToken,
        sharePath: serialised.sharePath,
        shareUrl: serialised.shareUrl,
      });
    } catch (err: any) {
      apiError(res, 500, STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Failed to create temp room', req.requestId, true);
    }
  });

  // Get room details & files (no auth required)
  app.get('/api/temp-rooms/:roomCode', optionalAuth, async (req: any, res: any) => {
    try {
      const roomCode = validateRoomCode(req.params.roomCode);
      if (!roomCode) {
        return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid temp room code', req.requestId);
      }
      const database = await getDb(req);
      const room = await database.collection('temp_rooms').findOne({ roomCode });
      if (!room || isRoomExpired(room)) {
        return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Temp room not found or expired', req.requestId);
      }

      const isOwner = isRequestRoomOwner(req, room);
      if (!hasValidPasscodeAccess(req, room, isOwner)) {
        return res.status(403).json({
          error: 'Passcode required to open this temp room',
          code: 'TEMP_PASSCODE_REQUIRED',
          roomSummary: {
            roomCode: room.roomCode,
            title: room.title || 'Temp Drop',
            accessMode: room.accessMode || 'both',
            hasPasscode: true,
            expiresAt: new Date(room.expiresAt).toISOString(),
          },
        });
      }

      const hideFilesForVisitor = room.accessMode === 'upload_only' && !isOwner;
      const rawFiles = hideFilesForVisitor
        ? []
        : await database.collection('temp_files').find({ roomCode }).sort({ createdAt: -1 }).limit(MAX_FILES_PER_TEMP_ROOM).toArray();

      res.json({
        room: serialiseTempRoom(room, req, isOwner),
        filesHidden: hideFilesForVisitor,
        files: rawFiles.map((doc: any) => serialiseTempFile(doc, roomCode)),
      });
    } catch (err: any) {
      apiError(res, 500, STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Failed to load temp room', req.requestId, true);
    }
  });

  // Update room settings / extend TTL (owner or creatorToken only)
  app.patch('/api/temp-rooms/:roomCode', optionalAuth, async (req: any, res: any) => {
    try {
      const roomCode = validateRoomCode(req.params.roomCode);
      if (!roomCode) {
        return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid temp room code', req.requestId);
      }
      const database = await getDb(req);
      const room = await database.collection('temp_rooms').findOne({ roomCode });
      if (!room || isRoomExpired(room)) {
        return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Temp room not found or expired', req.requestId);
      }
      if (!isRequestRoomOwner(req, room)) {
        return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Only the room creator can modify this temp room', req.requestId);
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const updates: any = { updatedAt: new Date() };

      if (typeof body.title === 'string') {
        const cleanTitle = body.title.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80);
        updates.title = cleanTitle || 'Temp Drop';
      }
      if (typeof body.note === 'string') {
        updates.note = body.note.trim().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 400);
      }
      if (body.accessMode !== undefined) {
        const mode = parseAccessMode(body.accessMode);
        if (!mode) {
          return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid accessMode', req.requestId);
        }
        updates.accessMode = mode;
      }
      if (body.passcode !== undefined) {
        if (typeof body.passcode !== 'string' || body.passcode.trim().length > 64) {
          return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid passcode format', req.requestId);
        }
        const trimmed = body.passcode.trim();
        updates.passcodeHash = trimmed ? hashPasscode(trimmed) : null;
      }
      if (body.ttlHours !== undefined) {
        const hrs = Number(body.ttlHours);
        if (!Number.isFinite(hrs)) {
          return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid ttlHours', req.requestId);
        }
        const clamped = Math.min(MAX_TEMP_ROOM_TTL_HOURS, Math.max(MIN_TEMP_ROOM_TTL_HOURS, Math.round(hrs)));
        const nextExp = new Date(Date.now() + clamped * 3600 * 1000);
        updates.expiresAt = nextExp;
        await database.collection('temp_files').updateMany({ roomCode }, { $set: { expiresAt: nextExp } });
      }

      if (body.deleteOnExpire !== undefined && room.storageMode === 'drive') {
        updates.deleteOnExpire = Boolean(body.deleteOnExpire);
      }

      await database.collection('temp_rooms').updateOne({ _id: room._id }, { $set: updates });
      const updated = await database.collection('temp_rooms').findOne({ _id: room._id });
      res.json({ success: true, room: serialiseTempRoom(updated, req, true) });
    } catch (err: any) {
      apiError(res, 500, STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Failed to update temp room', req.requestId, true);
    }
  });

  // Delete an entire Temp Room and all disk/linked files (owner or creatorToken only)
  app.delete('/api/temp-rooms/:roomCode', optionalAuth, async (req: any, res: any) => {
    try {
      const roomCode = validateRoomCode(req.params.roomCode);
      if (!roomCode) {
        return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid temp room code', req.requestId);
      }
      const database = await getDb(req);
      const room = await database.collection('temp_rooms').findOne({ roomCode });
      if (!room) {
        return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Temp room not found', req.requestId);
      }
      if (!isRequestRoomOwner(req, room)) {
        return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Only the room creator can delete this temp room', req.requestId);
      }

      if (room.storageMode === 'drive' && room.deleteOnExpire) {
        const driveFiles = await database.collection('temp_files').find({ roomCode, storageMode: 'drive' }).toArray();
        for (const df of driveFiles) {
          await purgeDriveTempFile(database, df, room.ownerUserId ? String(room.ownerUserId) : null);
        }
      }
      safeRemoveRoomDir(roomCode);
      await database.collection('temp_files').deleteMany({ roomCode });
      await database.collection('temp_rooms').deleteOne({ _id: room._id });
      recordAuditEvent('temp_room_deleted', { userId: req.userId ? String(req.userId) : null, roomCode });
      res.json({ success: true });
    } catch (err: any) {
      apiError(res, 500, STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Failed to delete temp room', req.requestId, true);
    }
  });

  // Upload a file directly to a Temp Room (no auth required)
  app.post('/api/temp-rooms/:roomCode/upload', optionalAuth, ...withUploadLimit, upload.single('file'), async (req: any, res: any) => {
    let movedToRoom = false;
    try {
      if (!req.file) {
        return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'No file uploaded', req.requestId);
      }
      const roomCode = validateRoomCode(req.params.roomCode);
      if (!roomCode) {
        return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid temp room code', req.requestId);
      }
      const database = await getDb(req);
      const room = await database.collection('temp_rooms').findOne({ roomCode });
      if (!room || isRoomExpired(room)) {
        return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Temp room not found or expired', req.requestId);
      }

      const isOwner = isRequestRoomOwner(req, room);
      if (!hasValidPasscodeAccess(req, room, isOwner)) {
        return apiError(res, 403, 'TEMP_PASSCODE_REQUIRED', 'Valid passcode required to upload to this room', req.requestId);
      }
      if (room.accessMode === 'download_only' && !isOwner) {
        return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Uploads are disabled for this temp room', req.requestId);
      }

      const fileSize = Number(req.file.size || 0);
      const maxFileBytes = Number(room.maxFileBytes || DEFAULT_TEMP_FILE_MAX_BYTES);
      const maxRoomBytes = Number(room.maxBytes || DEFAULT_TEMP_ROOM_MAX_BYTES);
      const currentUsed = Math.max(0, Number(room.usedBytes || 0));
      const currentCount = Math.max(0, Number(room.fileCount || 0));

      if (currentCount >= MAX_FILES_PER_TEMP_ROOM) {
        return apiError(res, 413, STANDARD_ERROR_CODES.INSUFFICIENT_STORAGE, `Temp room reached the ${MAX_FILES_PER_TEMP_ROOM}-file limit`, req.requestId);
      }
      if (fileSize > maxFileBytes) {
        return apiError(res, 413, STANDARD_ERROR_CODES.BAD_REQUEST, `File exceeds the ${Math.round(maxFileBytes / (1024 * 1024))} MB temp file limit`, req.requestId);
      }
      if (currentUsed + fileSize > maxRoomBytes) {
        return apiError(res, 507, STANDARD_ERROR_CODES.INSUFFICIENT_STORAGE, 'Temp room storage capacity is full', req.requestId);
      }
      if (!hasTempDiskHeadroom(fileSize)) {
        return apiError(res, 507, STANDARD_ERROR_CODES.INSUFFICIENT_STORAGE, 'Server temporary storage is full', req.requestId, true);
      }

      const safeName = normalizeSafeFilename(req.file.originalname, 'file.bin');
      const mimeType = typeof req.file.mimetype === 'string' && req.file.mimetype ? req.file.mimetype.slice(0, 160) : 'application/octet-stream';
      const rawLabel = typeof req.body?.uploadedByLabel === 'string' ? req.body.uploadedByLabel.trim() : '';
      const uploadedByLabel = rawLabel
        ? rawLabel.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 40)
        : (isOwner ? 'Owner' : 'Guest');
      const now = new Date();
      let doc: any;

      if (room.storageMode === 'drive' && room.targetAccountId) {
        if (!ObjectId.isValid(String(room.targetAccountId))) {
          return apiError(res, 500, STANDARD_ERROR_CODES.INTERNAL_ERROR, 'Invalid destination drive on room', req.requestId);
        }
        const targetAcc = await database.collection('accounts').findOne({ _id: new ObjectId(String(room.targetAccountId)) });
        if (!targetAcc || (room.ownerUserId && targetAcc.userId && String(targetAcc.userId) !== String(room.ownerUserId))) {
          return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Connected destination drive is no longer available', req.requestId);
        }
        if (fileSize === 0 && targetAcc.accountType === 'tgdrive') {
          return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Telegram Drive cannot store empty (0-byte) files', req.requestId);
        }

        const sha256 = await computeFileSha256(req.file.path);
        const targetFolder = room.targetFolderId && room.targetFolderId !== 'root' ? String(room.targetFolderId) : undefined;
        const uploaded = await uploadFileToProvider(
          targetAcc,
          String(targetAcc._id),
          {
            path: req.file.path,
            originalname: safeName,
            mimetype: mimeType,
            size: fileSize,
          },
          targetFolder,
          undefined,
          undefined,
          undefined,
          undefined,
          room.ownerUserId ? String(room.ownerUserId) : String(targetAcc.userId || '')
        );
        const providerFileId = targetAcc.accountType === 'tgdrive'
          ? String(uploaded?._id || '')
          : String(uploaded?.id || '');
        if (!providerFileId) {
          throw new Error('Destination drive did not return a file ID');
        }
        invalidateDriveCache(String(targetAcc._id));

        doc = {
          roomCode,
          name: safeName,
          mimeType,
          size: fileSize,
          sha256,
          storageMode: 'drive',
          accountId: String(targetAcc._id),
          accountType: String(targetAcc.accountType),
          providerFileId,
          folderId: targetFolder || 'root',
          uploadedByLabel,
          downloadCount: 0,
          expiresAt: new Date(room.expiresAt),
          createdAt: now,
        };
      } else {
        if (!hasTempDiskHeadroom(fileSize)) {
          return apiError(res, 507, STANDARD_ERROR_CODES.INSUFFICIENT_STORAGE, 'Server temporary storage is full', req.requestId, true);
        }
        const ext = path.extname(safeName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 16);
        const storageName = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
        const destPath = resolveTempDropFilePath(roomCode, storageName);

        moveTempFileIntoRoom(req.file.path, destPath);
        movedToRoom = true;

        const sha256 = await computeFileSha256(destPath);
        doc = {
          roomCode,
          name: safeName,
          mimeType,
          size: fileSize,
          sha256,
          storageMode: 'temp_disk',
          storageName,
          uploadedByLabel,
          downloadCount: 0,
          expiresAt: new Date(room.expiresAt),
          createdAt: now,
        };
      }

      const ins = await database.collection('temp_files').insertOne(doc);
      doc._id = doc._id ?? ins?.insertedId;

      await database.collection('temp_rooms').updateOne(
        { _id: room._id },
        { $inc: { usedBytes: fileSize, fileCount: 1 }, $set: { updatedAt: now } }
      );

      recordAuditEvent('temp_file_uploaded', {
        userId: req.userId ? String(req.userId) : null,
        roomCode,
        fileId: String(doc._id),
        storageMode: doc.storageMode,
        sizeBytes: fileSize,
      });

      res.status(201).json({
        success: true,
        file: serialiseTempFile(doc, roomCode),
      });
    } catch (err: any) {
      apiError(res, 500, STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Temp upload failed', req.requestId, true);
    } finally {
      if (!movedToRoom && req.file?.path) {
        safeUnlink(req.file.path);
      }
    }
  });

  // Shared HEAD / GET download handler for Temp Drop files (no auth required)
  const handleTempFileDownload = async (req: any, res: any, isHead: boolean) => {
    try {
      const roomCode = validateRoomCode(req.params.roomCode);
      const fileId = typeof req.params.fileId === 'string' ? req.params.fileId.trim() : '';
      if (!roomCode || !ObjectId.isValid(fileId)) {
        return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid temp file request', req.requestId);
      }

      const database = await getDb(req);
      const room = await database.collection('temp_rooms').findOne({ roomCode });
      if (!room || isRoomExpired(room)) {
        return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Temp room not found or expired', req.requestId);
      }

      const isOwner = isRequestRoomOwner(req, room);
      if (!hasValidPasscodeAccess(req, room, isOwner)) {
        return apiError(res, 403, 'TEMP_PASSCODE_REQUIRED', 'Passcode required to access files in this temp room', req.requestId);
      }
      if (room.accessMode === 'upload_only' && !isOwner) {
        return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Downloads are restricted to the room owner', req.requestId);
      }

      const fileDoc = await database.collection('temp_files').findOne({ _id: new ObjectId(fileId), roomCode });
      if (!fileDoc || isRoomExpired(fileDoc)) {
        return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Temp file not found or expired', req.requestId);
      }

      const mimeType = String(fileDoc.mimeType || 'application/octet-stream');
      const wantsInline = req.query?.preview === '1' && SAFE_PREVIEW_MIME_TYPES.has(mimeType.toLowerCase());
      const dispositionType = wantsInline ? 'inline' : 'attachment';

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader('Content-Type', wantsInline ? mimeType : 'application/octet-stream');
      res.setHeader('Content-Disposition', buildSafeContentDisposition(dispositionType, String(fileDoc.name)));

      if (fileDoc.storageMode === 'drive' && fileDoc.accountId && fileDoc.providerFileId) {
        if (!ObjectId.isValid(String(fileDoc.accountId))) {
          return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Backing drive account missing', req.requestId);
        }
        const account = await database.collection('accounts').findOne({ _id: new ObjectId(String(fileDoc.accountId)) });
        if (!account || (room.ownerUserId && account.userId && String(account.userId) !== String(room.ownerUserId))) {
          return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Backing drive account no longer available', req.requestId);
        }

        const providerFileId = String(fileDoc.providerFileId);
        const { meta, accessDenied } = await resolveFileMetadataForAccount(database, account, providerFileId, room.ownerUserId || account.userId, true);
        if (accessDenied) {
          return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Backing drive file unavailable', req.requestId);
        }

        const incrementCounters = () => {
          database.collection('temp_files').updateOne({ _id: fileDoc._id }, { $inc: { downloadCount: 1 } }).catch(() => {});
          database.collection('temp_rooms').updateOne({ _id: room._id }, { $inc: { downloadCount: 1 } }).catch(() => {});
        };

        if (account.accountType === 'tgdrive') {
          if (!meta) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'File not found in TG Drive', req.requestId);
          const tgSize = (meta.isNote === true && typeof meta.textContent === 'string')
            ? Buffer.byteLength(meta.textContent, 'utf8')
            : Number(meta.size || fileDoc.size || 0);
          const parsedRange = parseHttpByteRange(req.headers.range, tgSize);
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
            if (tgSize >= 0) res.setHeader('Content-Length', String(tgSize));
            return res.status(200).end();
          }
          if (parsedRange.kind !== 'range' || parsedRange.start === 0) incrementCounters();
          await tgStreamFile(meta.messageId, account.channelId, req, res, meta);
          return;
        }

        if (account.accountType === 'onedrive') {
          const c = await getOneDriveClient(account.tokens || account.credentials, String(account._id));
          const item = await c.api(`/me/drive/items/${providerFileId}`).get();
          const dlUrl = item?.['@microsoft.graph.downloadUrl'];
          if (!dlUrl) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'OneDrive download link unavailable', req.requestId);
          const totalSize = Number(item.size || fileDoc.size || 0);
          const parsedRange = parseHttpByteRange(req.headers.range, totalSize);
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
            if (totalSize >= 0) res.setHeader('Content-Length', String(totalSize));
            return res.status(200).end();
          }
          if (parsedRange.kind !== 'range' || parsedRange.start === 0) incrementCounters();
          const upstreamHeaders: Record<string, string> = { 'Accept-Encoding': 'identity' };
          if (parsedRange.kind === 'range') upstreamHeaders.Range = parsedRange.header;
          const response = await axios.get(dlUrl, {
            responseType: 'stream',
            timeout: PROVIDER_API_TIMEOUT_MS,
            headers: upstreamHeaders,
            decompress: false,
            validateStatus: (status: number) => status === 200 || status === 206 || status === 416,
          });
          if (response.status === 416) return res.status(416).end();
          if (response.status === 206) res.status(206);
          for (const h of ['content-range', 'content-length']) {
            if (response.headers[h]) res.setHeader(h, response.headers[h]);
          }
          pipeUpstreamWithAbort(response.data, req, res);
          return;
        }

        // Google Drive
        const drive = await getDriveClient(account.tokens || account.credentials, String(account._id));
        const gFile = await drive.files.get({ fileId: providerFileId, fields: 'name,mimeType,size' });
        const totalSize = Number(gFile?.data?.size || fileDoc.size || 0);
        const parsedRange = parseHttpByteRange(req.headers.range, totalSize);
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
          if (totalSize >= 0) res.setHeader('Content-Length', String(totalSize));
          return res.status(200).end();
        }
        if (parsedRange.kind !== 'range' || parsedRange.start === 0) incrementCounters();
        const gdHeaders: Record<string, string> = { 'Accept-Encoding': 'identity' };
        if (parsedRange.kind === 'range') gdHeaders.Range = parsedRange.header;
        const response = await drive.files.get(
          { fileId: providerFileId, alt: 'media' },
          {
            responseType: 'stream',
            headers: gdHeaders,
            validateStatus: (status: number) => status === 200 || status === 206 || status === 416,
          } as any
        );
        if (response.status === 416) return res.status(416).end();
        if (response.status === 206) res.status(206);
        for (const h of ['content-range', 'content-length']) {
          if (response.headers?.[h]) res.setHeader(h, response.headers[h]);
        }
        pipeUpstreamWithAbort(response.data, req, res);
        return;
      }

      const diskPath = resolveTempDropFilePath(roomCode, String(fileDoc.storageName));
      if (!fs.existsSync(diskPath)) {
        return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Temp file payload no longer exists on disk', req.requestId);
      }

      const stat = fs.statSync(diskPath);
      const totalSize = stat.size;
      const parsedRange = parseHttpByteRange(req.headers.range, totalSize);
      if (parsedRange.kind === 'invalid') {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }

      const isRange = parsedRange.kind === 'range';
      const start = isRange ? parsedRange.start : 0;
      const end = isRange ? parsedRange.end : Math.max(0, totalSize - 1);
      const contentLength = totalSize === 0 ? 0 : (end - start + 1);

      res.setHeader('Content-Length', String(contentLength));
      if (isRange) {
        res.setHeader('Content-Range', parsedRange.header);
      }

      if (isHead) {
        return res.status(isRange ? 206 : 200).end();
      }

      if (!isRange || start === 0) {
        database.collection('temp_files').updateOne({ _id: fileDoc._id }, { $inc: { downloadCount: 1 } }).catch(() => {});
        database.collection('temp_rooms').updateOne({ _id: room._id }, { $inc: { downloadCount: 1 } }).catch(() => {});
      }

      res.status(isRange ? 206 : 200);
      if (totalSize === 0) {
        return res.end();
      }

      const readStream = fs.createReadStream(diskPath, { start, end });
      readStream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      res.on('close', () => {
        readStream.destroy();
      });
      readStream.pipe(res);
    } catch (err: any) {
      if (!res.headersSent) {
        apiError(res, 500, STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Temp download failed', req.requestId, true);
      }
    }
  };

  app.head('/api/temp-rooms/:roomCode/files/:fileId/download', optionalAuth, ...withDownloadLimit, (req: any, res: any) => handleTempFileDownload(req, res, true));
  app.get('/api/temp-rooms/:roomCode/files/:fileId/download', optionalAuth, ...withDownloadLimit, (req: any, res: any) => handleTempFileDownload(req, res, false));

  // Stream all files in a Temp Room as a single ZIP archive (no auth required)
  app.get('/api/temp-rooms/:roomCode/zip', optionalAuth, ...withDownloadLimit, async (req: any, res: any) => {
    try {
      const roomCode = validateRoomCode(req.params.roomCode);
      if (!roomCode) {
        return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid temp room code', req.requestId);
      }
      const database = await getDb(req);
      const room = await database.collection('temp_rooms').findOne({ roomCode });
      if (!room || isRoomExpired(room)) {
        return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Temp room not found or expired', req.requestId);
      }
      const isOwner = isRequestRoomOwner(req, room);
      if (!hasValidPasscodeAccess(req, room, isOwner)) {
        return apiError(res, 403, 'TEMP_PASSCODE_REQUIRED', 'Passcode required to download this temp room', req.requestId);
      }
      if (room.accessMode === 'upload_only' && !isOwner) {
        return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Downloads are restricted to the room owner', req.requestId);
      }

      const fileDocs = await database.collection('temp_files').find({ roomCode }).sort({ createdAt: 1 }).limit(MAX_FILES_PER_TEMP_ROOM).toArray();
      if (fileDocs.length === 0) {
        return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'No files in this temp room yet', req.requestId);
      }

      const safeArchiveName = `${normalizeSafeFilename(room.title || `temp_${roomCode}`, `temp_${roomCode}`).replace(/\.zip$/i, '')}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader('Content-Disposition', buildSafeContentDisposition('attachment', safeArchiveName));

      let clientAborted = false;
      const archive = new ZipArchive({ zlib: { level: 5 } });
      archive.on('error', () => {
        clientAborted = true;
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      res.on('close', () => {
        clientAborted = true;
        try { archive.abort(); } catch { /* ignore */ }
      });
      archive.pipe(res);

      const usedNames = new Set<string>();
      const accountCache = new Map<string, any>();

      for (const doc of fileDocs) {
        if (clientAborted) break;
        const entryName = deduplicateZipName(String(doc.name), usedNames);
        try {
          if (doc.storageMode === 'drive' && doc.accountId && doc.providerFileId) {
            const accIdStr = String(doc.accountId);
            let account = accountCache.get(accIdStr);
            if (!account && ObjectId.isValid(accIdStr)) {
              account = await database.collection('accounts').findOne({ _id: new ObjectId(accIdStr) });
              if (account) accountCache.set(accIdStr, account);
            }
            if (account && (!room.ownerUserId || !account.userId || String(account.userId) === String(room.ownerUserId))) {
              const stream = await openProviderFileReadStream(
                database,
                account,
                { fileId: String(doc.providerFileId), entryPath: entryName, sizeBytes: Number(doc.size || 0) },
                room.ownerUserId || account.userId,
                true,
                () => clientAborted
              );
              await waitForEntryStreamAppended(archive, stream, entryName);
            }
          } else {
            const diskPath = resolveTempDropFilePath(roomCode, String(doc.storageName));
            if (fs.existsSync(diskPath)) {
              archive.file(diskPath, { name: entryName });
            }
          }
        } catch { /* skip unavailable entry */ }
      }
      database.collection('temp_rooms').updateOne({ _id: room._id }, { $inc: { downloadCount: 1 } }).catch(() => {});
      await archive.finalize();
    } catch (err: any) {
      if (!res.headersSent) {
        apiError(res, 500, STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Failed to build temp room archive', req.requestId, true);
      }
    }
  });

  // Delete a single file inside a Temp Room (owner or creatorToken only)
  app.delete('/api/temp-rooms/:roomCode/files/:fileId', optionalAuth, async (req: any, res: any) => {
    try {
      const roomCode = validateRoomCode(req.params.roomCode);
      const fileId = typeof req.params.fileId === 'string' ? req.params.fileId.trim() : '';
      if (!roomCode || !ObjectId.isValid(fileId)) {
        return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid temp file request', req.requestId);
      }
      const database = await getDb(req);
      const room = await database.collection('temp_rooms').findOne({ roomCode });
      if (!room || isRoomExpired(room)) {
        return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Temp room not found or expired', req.requestId);
      }
      if (!isRequestRoomOwner(req, room)) {
        return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Only the room creator can delete temp files', req.requestId);
      }

      const fileDoc = await database.collection('temp_files').findOne({ _id: new ObjectId(fileId), roomCode });
      if (!fileDoc) {
        return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Temp file not found', req.requestId);
      }

      if (fileDoc.storageMode === 'drive') {
        if (room.deleteOnExpire || req.query?.deleteFromDrive === '1') {
          await purgeDriveTempFile(database, fileDoc, room.ownerUserId ? String(room.ownerUserId) : null);
        }
      } else {
        try {
          safeUnlink(resolveTempDropFilePath(roomCode, String(fileDoc.storageName)));
        } catch { /* ignore */ }
      }

      await database.collection('temp_files').deleteOne({ _id: fileDoc._id });
      const nextUsed = Math.max(0, Number(room.usedBytes || 0) - Number(fileDoc.size || 0));
      const nextCount = Math.max(0, Number(room.fileCount || 0) - 1);
      await database.collection('temp_rooms').updateOne(
        { _id: room._id },
        { $set: { usedBytes: nextUsed, fileCount: nextCount, updatedAt: new Date() } }
      );

      res.json({ success: true, usedBytes: nextUsed, fileCount: nextCount });
    } catch (err: any) {
      apiError(res, 500, STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Failed to delete temp file', req.requestId, true);
    }
  });

  // Save a file from a Temp Room directly into a user's connected cloud drive (auth required)
  app.post('/api/temp-rooms/:roomCode/files/:fileId/save-to-drive', requireAuth, async (req: any, res: any) => {
    try {
      const roomCode = validateRoomCode(req.params.roomCode);
      const fileId = typeof req.params.fileId === 'string' ? req.params.fileId.trim() : '';
      const { targetAccountId, targetFolderId } = req.body || {};
      if (!roomCode || !ObjectId.isValid(fileId) || typeof targetAccountId !== 'string') {
        return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Valid roomCode, fileId, and targetAccountId are required', req.requestId);
      }
      const rawFolder = typeof targetFolderId === 'string' && targetFolderId.startsWith('folder:')
        ? targetFolderId.slice('folder:'.length)
        : targetFolderId;
      const folderCheck = validateSafeFolderId(rawFolder);
      if (!folderCheck.ok) {
        return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid targetFolderId', req.requestId);
      }

      const database = await getDb(req);
      const room = await database.collection('temp_rooms').findOne({ roomCode });
      if (!room || isRoomExpired(room)) {
        return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Temp room not found or expired', req.requestId);
      }
      const isOwner = isRequestRoomOwner(req, room);
      if (!hasValidPasscodeAccess(req, room, isOwner)) {
        return apiError(res, 403, 'TEMP_PASSCODE_REQUIRED', 'Passcode required to access this temp room', req.requestId);
      }
      if (room.accessMode === 'upload_only' && !isOwner) {
        return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Access restricted to the room owner', req.requestId);
      }

      const fileDoc = await database.collection('temp_files').findOne({ _id: new ObjectId(fileId), roomCode });
      if (!fileDoc || isRoomExpired(fileDoc)) {
        return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Temp file not found or expired', req.requestId);
      }

      const authAcc = await resolveAuthorizedAccount(database, targetAccountId, req.userId, req.isAdmin);
      if (authAcc.invalidId) return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Invalid targetAccountId', req.requestId);
      if (authAcc.accessDenied) return apiError(res, 403, STANDARD_ERROR_CODES.FORBIDDEN, 'Access denied to target account', req.requestId);
      if (!authAcc.account) return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Target account not found', req.requestId);

      let uploadSourcePath = '';
      let stagedTempPath: string | null = null;
      try {
        if (fileDoc.storageMode === 'drive' && fileDoc.accountId && fileDoc.providerFileId) {
          if (!ObjectId.isValid(String(fileDoc.accountId))) {
            return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Source drive account missing', req.requestId);
          }
          const srcAcc = await database.collection('accounts').findOne({ _id: new ObjectId(String(fileDoc.accountId)) });
          if (!srcAcc || (room.ownerUserId && srcAcc.userId && String(srcAcc.userId) !== String(room.ownerUserId))) {
            return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Source drive account unavailable', req.requestId);
          }
          const srcStream = await openProviderFileReadStream(
            database,
            srcAcc,
            { fileId: String(fileDoc.providerFileId), entryPath: String(fileDoc.name), sizeBytes: Number(fileDoc.size || 0) },
            room.ownerUserId || srcAcc.userId,
            true,
            () => false
          );
          const stageName = `stage_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.bin`;
          const stageCandidate = path.resolve(resolveTempDropRoot(), stageName);
          if (!stageCandidate.startsWith(resolveTempDropRoot() + path.sep)) {
            throw new Error('Invalid staging path');
          }
          stagedTempPath = stageCandidate;
          await new Promise<void>((resolve, reject) => {
            const ws = fs.createWriteStream(stageCandidate);
            ws.on('finish', resolve);
            ws.on('error', reject);
            srcStream.on('error', reject);
            srcStream.pipe(ws);
          });
          uploadSourcePath = stageCandidate;
        } else {
          const diskPath = resolveTempDropFilePath(roomCode, String(fileDoc.storageName));
          if (!fs.existsSync(diskPath)) {
            return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Temp file payload missing from disk', req.requestId);
          }
          uploadSourcePath = diskPath;
        }

        const cleanFolder = folderCheck.folderId === 'root' ? undefined : folderCheck.folderId;
        await uploadFileToProvider(
          authAcc.account,
          String(authAcc.account._id),
          {
            path: uploadSourcePath,
            originalname: String(fileDoc.name),
            mimetype: String(fileDoc.mimeType || 'application/octet-stream'),
            size: Number(fileDoc.size || fs.statSync(uploadSourcePath).size),
          },
          cleanFolder,
          undefined,
          undefined,
          undefined,
          undefined,
          req.userId ? String(req.userId) : undefined
        );
        invalidateDriveCache(String(authAcc.account._id));
        recordAuditEvent('temp_file_saved_to_drive', {
          userId: req.userId ? String(req.userId) : null,
          roomCode,
          fileId: String(fileDoc._id),
          targetAccountId: String(authAcc.account._id),
        });

        res.json({
          success: true,
          accountId: String(authAcc.account._id),
          targetFolderId: cleanFolder || 'root',
        });
      } finally {
        if (stagedTempPath) safeUnlink(stagedTempPath);
      }
    } catch (err: any) {
      apiError(res, 500, STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Failed to save temp file to drive', req.requestId, true);
    }
  });
}
