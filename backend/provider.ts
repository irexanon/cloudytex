import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import sharp from 'sharp';
import { ObjectId } from 'mongodb';
import { google } from 'googleapis';
import { Client } from '@microsoft/microsoft-graph-client';
import { TelegramClient, helpers as tgHelpers } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';

import {
  parseGoogleRangeOffset,
  parseOneDriveNextOffset,
  withSessionLock,
  validateOpaqueFilename,
  escapeDriveQueryValue,
  isValidHttpsUrl,
  TELEGRAM_ENCRYPTED_CAPTION_MARKER,
  type ValidatedUploadSpec,
} from './protocol.ts';

import {
  API_ID,
  API_HASH,
  MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET,
  MICROSOFT_REDIRECT_URI,
  PROVIDER_API_TIMEOUT_MS,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  STANDARD_ERROR_CODES,
  db,
  setDb,
  connectToMongo,
  authCache,
  driveCache,
  failedThumbCache,
  withCacheStampedeProtection,
  invalidateDriveCache,
  buildThumbPath,
  deleteThumbFiles,
  recordProviderCall,
  recordAuditEvent,
  systemMetrics,
  providerLimit,
  nanoid,
} from './core.ts';

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
  if ('db' in deps) setDb(deps.db);
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
      } catch (err: any) {
        systemMetrics.oauthRefreshFailures++;
        recordAuditEvent('oauth_refresh_failed', {
          provider: 'onedrive',
          accountId: accountId || null,
          error: err?.message || 'OneDrive token refresh failed',
        });
        done(err, null);
      }
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
    // Always fall back to Telegram media size — handles cases where meta.size is missing or zero
    if (!totalSize) {
      const mediaSizeRaw = media?.document?.size ?? media?.photo?.size ?? media?.video?.size ?? null;
      if (mediaSizeRaw !== null && mediaSizeRaw !== undefined) totalSize = Number(mediaSizeRaw);
    }
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
      const stepSize = 1024 * 1024;
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
      for await (const chunk of telegram.iterDownload({ file: media, requestSize: 1024 * 1024 })) {
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

// ─── Thumbnail Generation Engine (with failedThumbCache & pixel/size guards) ───
const MAX_THUMB_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_THUMB_INPUT_PIXELS = 64_000_000;

async function generateThumbnail(account: any, fileId: string, s: number, thumbPath: string): Promise<string | null> {
  const database = db || await connectToMongo();
  const failKey = `${String(account?._id || '')}:${fileId}`;
  const priorFailCount = Number(failedThumbCache.get(failKey) || 0);
  if (priorFailCount >= 2) {
    return null;
  }

  const { meta } = await resolveFileMetadataForAccount(database, account, fileId);
  if (meta?.isEncrypted === true) {
    return null;
  }

  try {
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

      if (!sourceBuffer || sourceBuffer.length > MAX_THUMB_SOURCE_BYTES) return null;

      await sharp(sourceBuffer, { sequentialRead: true, limitInputPixels: MAX_THUMB_INPUT_PIXELS })
        .rotate()
        .resize(s, s, { fit: 'cover', fastShrinkOnLoad: true })
        .jpeg({ quality: 72, mozjpeg: true })
        .toFile(thumbPath);

      failedThumbCache.del(failKey);
      return thumbPath;
    } else if (account.accountType === 'google') {
      const drive = await getDriveClient(account.tokens || account.credentials, String(account._id));
      const fileRes = await drive.files.get({ fileId, fields: 'thumbnailLink' });
      let link = fileRes.data.thumbnailLink;
      if (!link) return null;
      link = link.replace(/=s\d+$/, `=s${s}`);

      const resp = await axios.get(link, { responseType: 'arraybuffer', timeout: 20_000, maxContentLength: 20 * 1024 * 1024 });
      const buf = Buffer.from(resp.data);
      if (buf.length > MAX_THUMB_SOURCE_BYTES) return null;
      await sharp(buf, { sequentialRead: true, limitInputPixels: MAX_THUMB_INPUT_PIXELS })
        .rotate()
        .resize(s, s, { fit: 'cover', fastShrinkOnLoad: true })
        .jpeg({ quality: 72, mozjpeg: true })
        .toFile(thumbPath);

      failedThumbCache.del(failKey);
      return thumbPath;
    } else if (account.accountType === 'onedrive') {
      const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
      const thumbsRes = await c.api(`/me/drive/items/${fileId}/thumbnails`).get();
      const thumbSet = thumbsRes.value?.[0];
      const thumbUrl = thumbSet?.large?.url || thumbSet?.medium?.url;
      if (!thumbUrl) return null;

      const resp = await axios.get(thumbUrl, { responseType: 'arraybuffer', timeout: 20_000, maxContentLength: 20 * 1024 * 1024 });
      const buf = Buffer.from(resp.data);
      if (buf.length > MAX_THUMB_SOURCE_BYTES) return null;
      await sharp(buf, { sequentialRead: true, limitInputPixels: MAX_THUMB_INPUT_PIXELS })
        .rotate()
        .resize(s, s, { fit: 'cover', fastShrinkOnLoad: true })
        .jpeg({ quality: 72, mozjpeg: true })
        .toFile(thumbPath);

      failedThumbCache.del(failKey);
      return thumbPath;
    }
  } catch (err) {
    failedThumbCache.set(failKey, priorFailCount + 1);
    throw err;
  }
  return null;
}


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


export {
  resolvePeer,
  tgClient,
  getTgClient,
  getDriveClient,
  getOneDriveClient,
  resolveAuthorizedAccount,
  resolveFileMetadataForAccount,
  tgUploadFile,
  waitForDrainOrClose,
  pipeUpstreamWithAbort,
  tgStreamFile,
  sendJsonWithEtag,
  generateThumbnail,
  getAccountQuota,
  type StorageCategories,
  emptyStorageCategories,
  classifyFileCategory,
  computeSingleAccountStorageSummary,
  permanentlyDeleteSingleFile,
  listTrashForAccount,
  type ProviderUploadFile,
  type PersistedProviderSession,
  isRetryableProviderError,
  withTransientRetry,
  uploadOneDriveResumable,
  uploadGoogleDriveResumable,
  uploadFileToProvider,
  transferProviderType,
  uploadSessionId,
  findUploadAccount,
};
