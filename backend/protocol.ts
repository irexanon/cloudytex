import crypto from 'crypto';
import fs from 'fs';

/** Pure offset parsers shared by provider adapters and tests; offsets are exclusive byte positions. */
export function parseOneDriveNextOffset(ranges: unknown, totalBytes: number, fallback = 0): number {
  if (!Array.isArray(ranges) || ranges.length === 0) return fallback;
  const match = String(ranges[0]).match(/^(\d+)-/);
  if (!match) throw new Error('OneDrive returned an invalid nextExpectedRanges value');
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes) throw new Error('OneDrive returned an out-of-range nextExpectedRanges offset');
  return offset;
}

export function parseGoogleRangeOffset(rangeHeader: unknown, totalBytes: number): number {
  if (rangeHeader == null || rangeHeader === '') return 0;
  if (typeof rangeHeader !== 'string') throw new Error('Google Drive returned a non-string Range acknowledgement');
  const match = rangeHeader.match(/^bytes=0-(\d+)$/);
  if (!match) throw new Error('Google Drive returned an invalid Range acknowledgement');
  const offset = Number(match[1]) + 1;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes) throw new Error('Google Drive returned an out-of-range Range offset');
  return offset;
}

/** Per-process FIFO mutex. Rejected operations do not poison the queue. */
const sessionQueues = new Map<string, Promise<unknown>>();
export async function withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionQueues.get(sessionId) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  sessionQueues.set(sessionId, queued);
  await previous.catch(() => undefined);
  try { return await operation(); }
  finally { release(); if (sessionQueues.get(sessionId) === queued) sessionQueues.delete(sessionId); }
}

export function chunkSha256(data: Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function isSafeProviderItemId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > 512) return false;
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('..')) return false;
  if (/[\/\\\?#\s\x00-\x1f\x7f]/.test(trimmed)) return false;
  return true;
}

export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function isTrustedGraphNextLink(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'graph.microsoft.com';
  } catch {
    return false;
  }
}

export function isValidHttpsUrl(rawUrl: unknown, allowLoopbackHttpInTest = false): rawUrl is string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:') return true;
    if (allowLoopbackHttpInTest && process.env.CLOUDYTE_TEST_MODE === '1' && parsed.protocol === 'http:') {
      const host = parsed.hostname.toLowerCase();
      return host === '127.0.0.1' || host === 'localhost';
    }
    return false;
  } catch {
    return false;
  }
}

// ─── End-to-End Encryption (CYTE1) Validation & Privacy Helpers ───────────────

export const MAX_ENCRYPTED_METADATA_BYTES = 64 * 1024; // 64 KiB
export const MAX_KEY_BACKUP_BYTES = 64 * 1024; // 64 KiB
export const SUPPORTED_ENCRYPTION_FORMAT_VERSION = 1;
export const SUPPORTED_METADATA_VERSION = 1;
export const SUPPORTED_ENCRYPTION_ALGORITHM = 'AES-256-GCM';
export const SUPPORTED_KDF = 'PBKDF2-HMAC-SHA256';
export const MIN_PBKDF2_ITERATIONS = 100_000;
export const MAX_PBKDF2_ITERATIONS = 10_000_000;
export const TELEGRAM_ENCRYPTED_CAPTION_MARKER = 'cloudyte:c1';

export interface EncryptedMetadataEnvelope {
  metadataVersion: number;
  algorithm: string;
  keyId: string;
  nonce: string;
  ciphertext: string;
}

export interface ValidatedUploadSpec {
  isEncrypted: boolean;
  fileName: string;
  mimeType: string;
  size: number;
  folderId: string;
  checksum: string | null;
  encryptionFormatVersion: number | null;
  encryptionKeyId: string | null;
  encryptedSizeBytes: number | null;
  encryptedChecksum?: string | null;
  encryptedMetadata: EncryptedMetadataEnvelope | null;
  opaqueRemoteName: string | null;
}

export interface ValidatedKeyBackup {
  backupVersion: number;
  version: number;
  keyId: string;
  kdfAlgorithm: string;
  kdf: string;
  kdfIterations: number;
  iterations: number;
  salt: string;
  wrapAlgorithm: string;
  nonce: string;
  wrappedKey: string;
  ciphertext: string;
  createdAt?: number;
}

export interface ValidationFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
  error: {
    status: number;
    code: string;
    message: string;
  };
  [key: string]: any;
}

export interface ValidationSuccess {
  ok: true;
  status?: number;
  code?: string;
  message?: string;
  error?: {
    status: number;
    code: string;
    message: string;
  };
  [key: string]: any;
}

function makeFailure(status: number, code: string, message: string): ValidationFailure {
  return {
    ok: false,
    status,
    code,
    message,
    error: { status, code, message },
  };
}

const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_REGEX = /^[a-fA-F0-9]{64}$/;
const OPAQUE_KEY_ID_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;
const OPAQUE_FILENAME_REGEX = /^cyte_[A-Za-z0-9_-]{4,120}\.(bin|cyte1|enc)$/;

const FORBIDDEN_SECRET_FIELDS = [
  'contentKey',
  'CONTENT_KEY',
  'recoveryPassphrase',
  'passphrase',
  'rawKey',
  'privateKey',
  'originalName',
  'originalFileName',
  'originalMimeType',
  'originalFolderPath',
  'plaintextChecksum',
  'plaintextHash',
  'plaintextSizeBytes',
];

export function isBase64Url(value: unknown, minLen = 1, maxLen = 131072): value is string {
  if (typeof value !== 'string') return false;
  if (value.length < minLen || value.length > maxLen) return false;
  return BASE64URL_REGEX.test(value);
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_REGEX.test(value);
}

export function isOpaqueKeyId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_KEY_ID_REGEX.test(value);
}

export function hasPathTraversal(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  if (value.includes('\0') || value.includes('\\')) return true;
  if (/[\x00-\x1f\x7f]/.test(value)) return true;
  const segments = value.split('/');
  return segments.some(seg => seg === '..' || seg === '.');
}

export function validateSafeFolderId(folderId: unknown, isEncrypted = false): ValidationSuccess | ValidationFailure {
  if (folderId === undefined || folderId === null || folderId === '' || folderId === 'root') {
    return { ok: true, folderId: folderId === 'root' ? 'root' : '' };
  }
  if (typeof folderId !== 'string' || folderId.length > 512) {
    return makeFailure(400, isEncrypted ? 'ENCRYPTED_METADATA_INVALID' : 'BAD_REQUEST', 'Invalid folder identifier');
  }
  const clean = folderId.startsWith('folder:') ? folderId.slice('folder:'.length) : folderId;
  if (clean.startsWith('/') || clean.endsWith('/') || clean.includes('//') || hasPathTraversal(clean)) {
    return makeFailure(400, isEncrypted ? 'ENCRYPTED_METADATA_INVALID' : 'BAD_REQUEST', 'Folder identifier contains invalid path characters or traversal');
  }
  if (isEncrypted && clean.includes('/')) {
    return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'Encrypted uploads must not include plaintext nested folder paths');
  }
  return { ok: true, folderId: clean };
}

export function validateOpaqueFilename(fileName: unknown): ValidationSuccess | ValidationFailure {
  if (typeof fileName !== 'string' || fileName.length === 0 || fileName.length > 128) {
    return makeFailure(400, 'OPAQUE_FILENAME_REQUIRED', 'Opaque filename must be a non-empty string up to 128 characters');
  }
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..') || fileName.includes('\0') || /[\x00-\x1f\x7f]/.test(fileName)) {
    return makeFailure(400, 'OPAQUE_FILENAME_REQUIRED', 'Filename contains forbidden path traversal or control characters');
  }
  if (!OPAQUE_FILENAME_REGEX.test(fileName)) {
    return makeFailure(400, 'OPAQUE_FILENAME_REQUIRED', 'Encrypted uploads require an opaque filename matching cyte_<random_id>.(bin|cyte1|enc)');
  }
  return { ok: true, fileName };
}

export function validatePlaintextFilename(fileName: unknown): ValidationSuccess | ValidationFailure {
  if (typeof fileName !== 'string' || fileName.trim().length === 0 || fileName.length > 255) {
    return makeFailure(400, 'BAD_REQUEST', 'Filename must be a non-empty string up to 255 characters');
  }
  if (fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..' || fileName.includes('..') || fileName.includes('\0') || /[\x00-\x1f\x7f]/.test(fileName)) {
    return makeFailure(400, 'BAD_REQUEST', 'Filename contains forbidden path traversal or control characters');
  }
  return { ok: true, fileName };
}

export function validateEncryptedMetadataEnvelope(rawEnvelope: unknown): ValidationSuccess | ValidationFailure {
  let parsed: any = rawEnvelope;
  if (typeof rawEnvelope === 'string') {
    if (Buffer.byteLength(rawEnvelope, 'utf8') > MAX_ENCRYPTED_METADATA_BYTES) {
      return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'encryptedMetadata exceeds maximum allowed size of 64 KiB');
    }
    try {
      parsed = JSON.parse(rawEnvelope);
    } catch {
      return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'encryptedMetadata must be valid JSON');
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'encryptedMetadata must be a JSON object');
  }

  const serialized = JSON.stringify(parsed);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ENCRYPTED_METADATA_BYTES) {
    return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'encryptedMetadata exceeds maximum allowed size of 64 KiB');
  }

  const allowedKeys = new Set(['metadataVersion', 'algorithm', 'keyId', 'nonce', 'ciphertext']);
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) {
      return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', `encryptedMetadata contains unexpected field '${key}'`);
    }
  }

  if (parsed.metadataVersion !== SUPPORTED_METADATA_VERSION) {
    return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'Unsupported encryptedMetadata.metadataVersion');
  }
  if (parsed.algorithm !== SUPPORTED_ENCRYPTION_ALGORITHM) {
    return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'Unsupported encryptedMetadata.algorithm');
  }
  if (!isOpaqueKeyId(parsed.keyId)) {
    return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'Invalid encryptedMetadata.keyId');
  }
  if (!isBase64Url(parsed.nonce, 12, 128)) {
    return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'Invalid encryptedMetadata.nonce base64url value');
  }
  if (!isBase64Url(parsed.ciphertext, 16, MAX_ENCRYPTED_METADATA_BYTES)) {
    return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'Invalid encryptedMetadata.ciphertext base64url value');
  }

  return {
    ok: true,
    envelope: {
      metadataVersion: parsed.metadataVersion,
      algorithm: parsed.algorithm,
      keyId: parsed.keyId,
      nonce: parsed.nonce,
      ciphertext: parsed.ciphertext,
    },
  };
}

export function validateUploadRequest(
  body: any,
  options: { actualByteSize?: number; maxUploadBytes?: number; defaultFileName?: string; defaultMimeType?: string } = {}
): ValidationSuccess | ValidationFailure {
  const payload = body && typeof body === 'object' ? body : {};
  const maxBytes = options.maxUploadBytes ?? 2 * 1024 * 1024 * 1024;

  // Never accept secret keys or plaintext metadata fields
  for (const forbidden of FORBIDDEN_SECRET_FIELDS) {
    if (payload[forbidden] !== undefined && payload[forbidden] !== null) {
      return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', `Forbidden field '${forbidden}' must never be sent to the server`);
    }
  }

  const rawIsEncrypted = payload.isEncrypted;
  let isEncrypted = false;
  if (rawIsEncrypted === true || rawIsEncrypted === 'true') {
    isEncrypted = true;
  } else if (rawIsEncrypted !== undefined && rawIsEncrypted !== false && rawIsEncrypted !== 'false') {
    return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'Invalid isEncrypted boolean flag');
  }

  const folderCheck = validateSafeFolderId(payload.folderId, isEncrypted);
  if (!folderCheck.ok) {
    return folderCheck;
  }

  if (!isEncrypted) {
    const fileName = payload.fileName ?? options.defaultFileName ?? '';
    const nameCheck = validatePlaintextFilename(fileName);
    if (!nameCheck.ok) {
      return nameCheck;
    }
    const sizeNum = options.actualByteSize !== undefined ? Number(options.actualByteSize) : Number(payload.size);
    if (!Number.isSafeInteger(sizeNum) || sizeNum < 0 || sizeNum > maxBytes) {
      return makeFailure(400, 'BAD_REQUEST', 'Invalid file size');
    }
    const checksum = payload.checksum ? String(payload.checksum).toLowerCase() : null;
    if (checksum && !isSha256Hex(checksum)) {
      return makeFailure(400, 'BAD_REQUEST', 'Invalid SHA-256 checksum format');
    }
    return {
      ok: true,
      spec: {
        isEncrypted: false,
        fileName: nameCheck.fileName,
        mimeType: String(payload.mimeType || options.defaultMimeType || 'application/octet-stream'),
        size: sizeNum,
        folderId: folderCheck.folderId || 'root',
        checksum,
        encryptionFormatVersion: null,
        encryptionKeyId: null,
        encryptedSizeBytes: null,
        encryptedChecksum: null,
        encryptedMetadata: null,
        opaqueRemoteName: null,
      },
    };
  }

  // Encrypted upload validation
  if (payload.encryptionFormatVersion === undefined || payload.encryptionFormatVersion === null || payload.encryptionFormatVersion === '') {
    return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'encryptionFormatVersion is required for encrypted uploads');
  }
  const formatVersion = Number(payload.encryptionFormatVersion);
  if (!Number.isSafeInteger(formatVersion) || formatVersion !== SUPPORTED_ENCRYPTION_FORMAT_VERSION) {
    return makeFailure(400, 'UNSUPPORTED_ENCRYPTION_VERSION', `Unsupported encryptionFormatVersion '${String(payload.encryptionFormatVersion)}'`);
  }

  const fileName = payload.opaqueRemoteName ?? payload.fileName ?? options.defaultFileName;
  const opaqueCheck = validateOpaqueFilename(fileName);
  if (!opaqueCheck.ok) {
    return opaqueCheck;
  }

  const mimeType = payload.mimeType ?? options.defaultMimeType ?? 'application/octet-stream';
  if (mimeType !== 'application/octet-stream') {
    return makeFailure(400, 'ENCRYPTED_MIME_INVALID', 'Encrypted uploads must use mimeType application/octet-stream');
  }

  if (!isOpaqueKeyId(payload.encryptionKeyId)) {
    return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'Valid opaque encryptionKeyId is required for encrypted uploads');
  }

  const rawSize = payload.size !== undefined ? Number(payload.size) : options.actualByteSize;
  const rawEncryptedSize = payload.encryptedSizeBytes !== undefined ? Number(payload.encryptedSizeBytes) : rawSize;
  if (
    rawSize === undefined ||
    rawEncryptedSize === undefined ||
    !Number.isSafeInteger(rawSize) ||
    !Number.isSafeInteger(rawEncryptedSize) ||
    rawSize < 0 ||
    rawEncryptedSize < 0 ||
    rawSize > maxBytes ||
    rawSize !== rawEncryptedSize
  ) {
    return makeFailure(400, 'ENCRYPTED_SIZE_INVALID', 'size and encryptedSizeBytes must be matching non-negative integers');
  }

  if (options.actualByteSize !== undefined && options.actualByteSize !== rawEncryptedSize) {
    return makeFailure(400, 'ENCRYPTED_SIZE_INVALID', 'Uploaded byte length does not match encryptedSizeBytes');
  }

  const rawChecksum = payload.checksum ?? payload.encryptedChecksum;
  if (!isSha256Hex(rawChecksum)) {
    return makeFailure(400, 'ENCRYPTED_CHECKSUM_INVALID', 'Valid SHA-256 checksum of encrypted bytes is required');
  }
  const normalizedChecksum = rawChecksum.toLowerCase();

  if (payload.encryptedMetadata === undefined || payload.encryptedMetadata === null) {
    return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'encryptedMetadata is required for encrypted uploads');
  }
  const metaCheck = validateEncryptedMetadataEnvelope(payload.encryptedMetadata);
  if (!metaCheck.ok) {
    return metaCheck;
  }

  if (metaCheck.envelope.keyId !== payload.encryptionKeyId) {
    return makeFailure(400, 'ENCRYPTED_METADATA_INVALID', 'encryptionKeyId must match encryptedMetadata.keyId');
  }

  return {
    ok: true,
    spec: {
      isEncrypted: true,
      fileName: opaqueCheck.fileName,
      mimeType: 'application/octet-stream',
      size: rawEncryptedSize,
      folderId: folderCheck.folderId || 'root',
      checksum: normalizedChecksum,
      encryptionFormatVersion: formatVersion,
      encryptionKeyId: payload.encryptionKeyId,
      encryptedSizeBytes: rawEncryptedSize,
      encryptedChecksum: normalizedChecksum,
      encryptedMetadata: metaCheck.envelope,
      opaqueRemoteName: opaqueCheck.fileName,
    },
  };
}

export function validateKeyBackupInput(rawBody: unknown): ValidationSuccess | ValidationFailure {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return makeFailure(400, 'KEY_BACKUP_INVALID', 'Key backup body must be a JSON object');
  }

  const serialized = JSON.stringify(rawBody);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_KEY_BACKUP_BYTES) {
    return makeFailure(413, 'KEY_BACKUP_TOO_LARGE', 'Key backup payload exceeds maximum allowed size of 64 KiB');
  }

  const body = rawBody as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_SECRET_FIELDS) {
    if (body[forbidden] !== undefined) {
      return makeFailure(400, 'KEY_BACKUP_INVALID', `Forbidden field '${forbidden}' in key backup payload`);
    }
  }

  const allowedKeys = new Set([
    'version',
    'backupVersion',
    'kdf',
    'kdfAlgorithm',
    'iterations',
    'kdfIterations',
    'salt',
    'wrapAlgorithm',
    'nonce',
    'ciphertext',
    'wrappedKey',
    'keyId',
    'createdAt',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return makeFailure(400, 'KEY_BACKUP_INVALID', `Unexpected field '${key}' in key backup payload`);
    }
  }

  const version = body.backupVersion ?? body.version;
  if (version !== 1) {
    return makeFailure(400, 'KEY_BACKUP_INVALID', 'Unsupported key backup version');
  }
  const kdf = body.kdfAlgorithm ?? body.kdf;
  if (kdf !== SUPPORTED_KDF) {
    return makeFailure(400, 'KEY_BACKUP_INVALID', 'Unsupported key backup KDF');
  }
  const wrapAlg = body.wrapAlgorithm ?? SUPPORTED_ENCRYPTION_ALGORITHM;
  if (wrapAlg !== SUPPORTED_ENCRYPTION_ALGORITHM) {
    return makeFailure(400, 'KEY_BACKUP_INVALID', 'Unsupported key backup wrapAlgorithm');
  }
  const iterations = Number(body.kdfIterations ?? body.iterations);
  if (!Number.isSafeInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) {
    return makeFailure(400, 'KEY_BACKUP_INVALID', 'Key backup iterations out of allowed bounds');
  }
  if (!isBase64Url(body.salt, 12, 256)) {
    return makeFailure(400, 'KEY_BACKUP_INVALID', 'Invalid base64url salt in key backup');
  }
  if (!isBase64Url(body.nonce, 12, 128)) {
    return makeFailure(400, 'KEY_BACKUP_INVALID', 'Invalid base64url nonce in key backup');
  }
  const wrappedKey = body.wrappedKey ?? body.ciphertext;
  if (!isBase64Url(wrappedKey, 16, MAX_KEY_BACKUP_BYTES)) {
    return makeFailure(400, 'KEY_BACKUP_INVALID', 'Invalid base64url wrappedKey in key backup');
  }
  if (!isOpaqueKeyId(body.keyId)) {
    return makeFailure(400, 'KEY_BACKUP_INVALID', 'Invalid keyId in key backup');
  }

  return {
    ok: true,
    backup: {
      backupVersion: 1,
      version: 1,
      keyId: body.keyId,
      kdfAlgorithm: SUPPORTED_KDF,
      kdf: SUPPORTED_KDF,
      kdfIterations: iterations,
      iterations,
      salt: body.salt,
      wrapAlgorithm: SUPPORTED_ENCRYPTION_ALGORITHM,
      nonce: body.nonce,
      wrappedKey,
      ciphertext: wrappedKey,
      ...(typeof body.createdAt === 'number' ? { createdAt: body.createdAt } : {}),
    },
  };
}

export async function computeFileSha256(filePath: string, fsModule: typeof import('fs') = fs): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fsModule.createReadStream(filePath, { highWaterMark: 256 * 1024 });
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * Normalizes a filename to Unicode NFC, strips control characters and path separators,
 * and ensures a safe bounded length.
 */
export function normalizeSafeFilename(rawName: unknown, fallback = 'file'): string {
  if (typeof rawName !== 'string' || !rawName.trim()) return fallback;
  const nfc = rawName.normalize('NFC');
  const cleaned = nfc
    .replace(/[\x00-\x1f\x7f/\\]/g, '_')
    .replace(/^\.+$/, '_')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 255 ? cleaned.slice(0, 255) : cleaned;
}

/**
 * Inspects the first bytes of a file or buffer to detect magic-byte MIME types
 * and checks for suspicious nested archive flags.
 */
export async function sniffMagicMimeType(
  filePath: string,
  fsModule: typeof import('fs') = fs
): Promise<{ detectedMime: string | null; isArchive: boolean; suspiciousArchive: boolean }> {
  try {
    const handle = await fsModule.promises.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(64);
      const { bytesRead } = await handle.read(buf, 0, 64, 0);
      if (bytesRead < 4) {
        return { detectedMime: null, isArchive: false, suspiciousArchive: false };
      }
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { detectedMime: 'image/png', isArchive: false, suspiciousArchive: false };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return { detectedMime: 'image/jpeg', isArchive: false, suspiciousArchive: false };
      }
      if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
        return { detectedMime: 'image/gif', isArchive: false, suspiciousArchive: false };
      }
      if (
        bytesRead >= 12 &&
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
      ) {
        return { detectedMime: 'image/webp', isArchive: false, suspiciousArchive: false };
      }
      if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
        return { detectedMime: 'application/pdf', isArchive: false, suspiciousArchive: false };
      }
      if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05) && (buf[3] === 0x04 || buf[3] === 0x06)) {
        // Check ZIP local file header uncompressed vs compressed size ratio if present
        let suspiciousArchive = false;
        if (bytesRead >= 26 && buf[2] === 0x03 && buf[3] === 0x04) {
          const compressedSize = buf.readUInt32LE(18);
          const uncompressedSize = buf.readUInt32LE(22);
          if (compressedSize > 0 && uncompressedSize / compressedSize > 200) {
            suspiciousArchive = true;
          }
        }
        return { detectedMime: 'application/zip', isArchive: true, suspiciousArchive };
      }
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        return { detectedMime: 'application/gzip', isArchive: true, suspiciousArchive: false };
      }
      return { detectedMime: null, isArchive: false, suspiciousArchive: false };
    } finally {
      await handle.close();
    }
  } catch {
    return { detectedMime: null, isArchive: false, suspiciousArchive: false };
  }
}

/**
 * Builds a RFC 6266 / 5987 safe Content-Disposition header value.
 */
export function buildSafeContentDisposition(dispositionType: 'inline' | 'attachment', rawFilename: string): string {
  const safeName = normalizeSafeFilename(rawFilename, 'download');
  const asciiFallback = safeName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(safeName);
  return `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export type ParsedByteRange =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'range'; start: number; end: number; length: number; header: string };

/**
 * Strictly parses a single HTTP Range header (RFC 9110 §14.1.2).
 * Supports `bytes=start-end`, `bytes=start-`, and `bytes=-suffix`.
 * Rejects control characters, negative offsets, and unsatisfiable ranges.
 */
export function parseHttpByteRange(rawRange: unknown, totalSize: number): ParsedByteRange {
  if (typeof rawRange !== 'string') return { kind: 'none' };
  const trimmed = rawRange.trim();
  if (!trimmed) return { kind: 'none' };
  if (/[\r\n\x00-\x1f\x7f]/.test(trimmed)) return { kind: 'invalid' };
  if (!/^bytes=/i.test(trimmed)) return { kind: 'none' };
  if (!Number.isFinite(totalSize) || totalSize <= 0) return { kind: 'none' };

  const spec = trimmed.slice(6).trim();
  // Multi-range requests (comma-separated) fall back cleanly to full 200 OK per RFC 9110 §14.2
  if (spec.includes(',')) return { kind: 'none' };

  const match = spec.match(/^(\d*)-(\d*)$/);
  if (!match) return { kind: 'invalid' };
  const [, startStr, endStr] = match;
  if (!startStr && !endStr) return { kind: 'invalid' };

  let start: number;
  let end: number;

  if (!startStr) {
    // Suffix byte range: bytes=-N (last N bytes)
    const suffixLength = Number(endStr);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'invalid' };
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(startStr);
    if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) return { kind: 'invalid' };
    if (!endStr) {
      end = totalSize - 1;
    } else {
      const requestedEnd = Number(endStr);
      if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return { kind: 'invalid' };
      end = Math.min(requestedEnd, totalSize - 1);
    }
  }

  return {
    kind: 'range',
    start,
    end,
    length: end - start + 1,
    header: `bytes=${start}-${end}`,
  };
}

/**
 * Checks RFC 9110 §13.1.5 If-Range precondition against the current entity tag.
 * If If-Range is present and does not strongly match the current ETag, returns false
 * so the server serves the complete 200 OK representation instead of corrupting a resume.
 */
export function shouldHonorRangeHeader(headers: Record<string, any> | undefined, etag: string): boolean {
  const rawIfRange = headers?.['if-range'];
  if (typeof rawIfRange !== 'string' || !rawIfRange.trim()) return true;
  const ifRange = rawIfRange.trim();
  if (ifRange.startsWith('W/')) return false;
  if (ifRange.startsWith('"') && ifRange.endsWith('"')) {
    return Boolean(etag) && ifRange === etag;
  }
  return true;
}


