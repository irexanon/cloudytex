import fs from 'fs';
import path from 'path';
import stream from 'stream';
import axios from 'axios';
import { ObjectId } from 'mongodb';

import {
  withSessionLock,
  computeFileSha256,
  escapeDriveQueryValue,
  type ValidatedUploadSpec,
} from './protocol.ts';

import {
  TEMP_DIR,
  WORKER_ID,
  JOB_LEASE_MS,
  JOB_MAX_ATTEMPTS,
  MAX_JOB_QUEUE_DEPTH,
  PROVIDER_API_TIMEOUT_MS,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  STANDARD_ERROR_CODES,
  systemMetrics,
  isShuttingDown,
  db,
  connectToMongo,
  providerLimit,
  hasTempDiskHeadroom,
  deleteThumbFiles,
  invalidateDriveCache,
  buildThumbPath,
  recordAuditEvent,
  nanoid,
} from './core.ts';

import {
  isTgChannelAccessError,
  formatTgChannelError,
  markTgChannelInaccessible,
  resolvePeer,
  getTgClient,
  withTgPoolClient,
  tgFastCopyMessage,
  getDriveClient,
  getOneDriveClient,
  resolveAuthorizedAccount,
  resolveFileMetadataForAccount,
  tgStreamFile,
  generateThumbnail,
  permanentlyDeleteSingleFile,
  withTransientRetry,
  uploadFileToProvider,
  type PersistedProviderSession,
} from './provider.ts';

import {
  executeArchiveZipToCloudJob,
  executeArchiveUnzipJob,
} from './archive.ts';

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

        if (meta.isNote === true && typeof meta.textContent === 'string') {
          const noteBuf = Buffer.from(meta.textContent, 'utf8');
          expectedBytes = noteBuf.length;
          await new Promise<void>((res, rej) => {
            writeStream.on('finish', () => res());
            writeStream.on('error', rej);
            writeStream.end(noteBuf);
          });
          await onProgress?.({ stage: 'downloading', bytesProcessed: noteBuf.length, totalBytes: noteBuf.length, progressPct: 50 });
        } else {
          let telegram: any = null;
          let messages: any;
          try {
            const fetched = await withTgPoolClient(
              sourceAccount.channelId,
              async (tgc) => {
                const peer = await resolvePeer(tgc, sourceAccount.channelId);
                const msgs = await tgc.getMessages(peer, { ids: [meta.messageId] });
                return { tgc, msgs };
              },
              { preferWorker: true }
            );
            telegram = fetched.tgc;
            messages = fetched.msgs;
          } catch (tgErr: any) {
            if (isTgChannelAccessError(tgErr)) {
              markTgChannelInaccessible(sourceAccount.channelId, tgErr);
              const accessErr: any = new Error(formatTgChannelError(tgErr, sourceAccount.channelId));
              accessErr.code = 'TG_CHANNEL_ACCESS_DENIED';
              throw accessErr;
            }
            throw tgErr;
          }
          const tgMsg: any = messages?.[0];
          if (!tgMsg) throw new Error('Message not found');

          if (!tgMsg.media && typeof tgMsg.message === 'string') {
            const noteBuf = Buffer.from(tgMsg.message, 'utf8');
            expectedBytes = noteBuf.length;
            await new Promise<void>((res, rej) => {
              writeStream.on('finish', () => res());
              writeStream.on('error', rej);
              writeStream.end(noteBuf);
            });
            await onProgress?.({ stage: 'downloading', bytesProcessed: noteBuf.length, totalBytes: noteBuf.length, progressPct: 50 });
          } else {
            if (!tgMsg.media) throw new Error('Message not found');
            let downloaded = 0;
            for await (const chunk of telegram.iterDownload({ file: tgMsg.media, requestSize: 1024 * 1024 })) {
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
          }
        }
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

      // Verify destination success based on real provider identifier + verified byte size before ever deleting source on move
      const hasRealIdentifier = Boolean(
        uploadResult &&
        (uploadResult.id || uploadResult._id || uploadResult.messageId || uploadResult.success === true)
      );
      const destinationConfirmed = hasRealIdentifier && verifiedBytes === stat.size;
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
            sourceDeleteApproved: Boolean(isMove),
            sourceDeleteApprovedAt: isMove ? manifestNow : null,
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
    // Ensure destination_verified + sourceDeleteApproved state is recorded before deleting source
    const approvedManifest = await database.collection('transfer_manifests').findOne({ jobId: manifestKey });
    if (approvedManifest && !approvedManifest.verified && !destinationFileId) {
      throw new Error('Refusing to delete source file: destination verification state missing');
    }
    await onProgress?.({ stage: 'finalizing', bytesProcessed: verifiedBytes, totalBytes: verifiedBytes, progressPct: 95 });
    deleteThumbFiles(fileId, String(sourceAccount._id));
    if (sourceAccount.accountType === 'tgdrive') {
      if (sourceMeta) {
        await withTgPoolClient(sourceAccount.channelId, async (telegram) => {
          const peer = await resolvePeer(telegram, sourceAccount.channelId);
          try { await telegram.deleteMessages(peer, [sourceMeta.messageId], { revoke: true }); } catch { /* ignore */ }
        });
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

// ─── Whole-Drive Manifest & Recursive Drive Copy / Move Engine ───────────────
export interface ManifestFileItem {
  id: string;
  name: string;
  relativePath: string;
  folderPath: string;
  sizeBytes: number;
  mimeType: string;
  updatedAt: string | null;
  isEncrypted: boolean;
  isNote: boolean;
  messageId?: number | null;
  textContent?: string | null;
}

export interface AccountManifest {
  accountId: string;
  accountType: string;
  driveName: string;
  rootFolderId: string;
  generatedAt: string;
  truncated: boolean;
  totalFolders: number;
  totalFiles: number;
  totalBytes: number;
  folders: string[];
  files: ManifestFileItem[];
}

function sanitizeManifestSegment(raw: string, fallback = 'untitled'): string {
  const cleaned = String(raw || '')
    .replace(/[\\/\0]+/g, '_')
    .replace(/^\.+$/, '')
    .trim();
  return cleaned || fallback;
}

function normalizeRelativeFolderPath(raw: string): string {
  return String(raw || '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

/**
 * Recursively enumerates all non-trashed folders & files in an account (or subfolder).
 * Powers both GET /api/accounts/:accountId/manifest (for native Android whole-drive downloads)
 * and server-side whole-drive copy/move jobs.
 */
async function collectAccountManifest(
  database: any,
  account: any,
  rootFolderId = '',
  maxFiles = 25000,
  includeNoteContent = false
): Promise<AccountManifest> {
  const accountId = String(account._id);
  const driveName = account.name || account.email || (account.accountType === 'tgdrive' ? 'TG Drive' : 'Cloud Drive');
  const foldersSet = new Set<string>();
  const files: ManifestFileItem[] = [];
  let totalBytes = 0;
  let truncated = false;
  const effectiveRoot = !rootFolderId || rootFolderId === 'root' ? '' : String(rootFolderId).trim();

  if (account.accountType === 'tgdrive') {
    const rootPrefix = normalizeRelativeFolderPath(effectiveRoot);
    const tgFolders = await database.collection('tg_folders')
      .find({ accountId: account._id })
      .sort({ path: 1 })
      .toArray();

    for (const f of tgFolders) {
      const fPath = normalizeRelativeFolderPath(String(f.path || ''));
      if (!fPath) continue;
      if (!rootPrefix) {
        foldersSet.add(fPath);
      } else if (fPath.startsWith(`${rootPrefix}/`)) {
        const rel = fPath.slice(rootPrefix.length + 1);
        if (rel) foldersSet.add(rel);
      }
    }

    const tgFiles = await database.collection('tg_files')
      .find({ accountId: account._id, trashed: { $ne: true } })
      .sort({ folder: 1, date: 1, _id: 1 })
      .limit(maxFiles + 1)
      .toArray();

    for (const doc of tgFiles) {
      const rawFolder = normalizeRelativeFolderPath(String(doc.folder || ''));
      let relFolder = rawFolder;
      if (rootPrefix) {
        if (rawFolder === rootPrefix) {
          relFolder = '';
        } else if (rawFolder.startsWith(`${rootPrefix}/`)) {
          relFolder = rawFolder.slice(rootPrefix.length + 1);
        } else {
          continue;
        }
      }
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (relFolder) foldersSet.add(relFolder);
      const isEncrypted = doc.isEncrypted === true;
      const isNote = doc.isNote === true;
      const rawName = isEncrypted ? (doc.opaqueRemoteName || doc.name || 'encrypted.bin') : (doc.name || 'file');
      const safeName = sanitizeManifestSegment(rawName, `file_${String(doc._id).slice(-6)}`);
      const sizeBytes = Number(isEncrypted ? (doc.encryptedSizeBytes ?? doc.size ?? 0) : (doc.size ?? 0)) || 0;
      const updatedMs = doc.updatedAt
        ? new Date(doc.updatedAt).getTime()
        : (doc.date ? Number(doc.date) * 1000 : null);

      const item: ManifestFileItem = {
        id: String(doc._id),
        name: safeName,
        folderPath: relFolder,
        relativePath: relFolder ? `${relFolder}/${safeName}` : safeName,
        sizeBytes,
        mimeType: isEncrypted ? 'application/octet-stream' : (doc.mimeType || (isNote ? 'text/plain; charset=utf-8' : 'application/octet-stream')),
        updatedAt: updatedMs && Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : null,
        isEncrypted,
        isNote,
        messageId: Number.isInteger(Number(doc.messageId)) ? Number(doc.messageId) : null,
        ...(includeNoteContent && isNote && typeof doc.textContent === 'string' ? { textContent: doc.textContent } : {}),
      };
      files.push(item);
      totalBytes += sizeBytes;
    }
  } else if (account.accountType === 'google') {
    const drive = await getDriveClient(account.tokens || account.credentials, accountId);
    const encMetaDocs = await database.collection('tg_files')
      .find({ accountId: account._id, isEncrypted: true })
      .toArray();
    const encByProviderId = new Map<string, any>();
    for (const m of encMetaDocs) {
      if (m.providerFileId) encByProviderId.set(String(m.providerFileId), m);
    }

    const startId = effectiveRoot || 'root';
    const queue: Array<{ id: string; relPath: string }> = [{ id: startId, relPath: '' }];
    const visited = new Set<string>([startId]);

    while (queue.length > 0 && !truncated) {
      const current = queue.shift()!;
      const safeParent = escapeDriveQueryValue(current.id);
      let pageToken: string | undefined;
      do {
        const res: any = await withTransientRetry(
          () => drive.files.list({
            q: `'${safeParent}' in parents and trashed = false`,
            fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
            pageSize: 200,
            pageToken,
          }),
          undefined,
          3,
          { provider: 'google', operation: 'manifestList' }
        );
        const items: any[] = Array.isArray(res?.data?.files) ? res.data.files : [];
        for (const f of items) {
          const id = String(f.id || '');
          if (!id) continue;
          const safeName = sanitizeManifestSegment(String(f.name || ''), id);
          if (f.mimeType === 'application/vnd.google-apps.folder') {
            if (!visited.has(id)) {
              visited.add(id);
              const subRel = current.relPath ? `${current.relPath}/${safeName}` : safeName;
              foldersSet.add(subRel);
              queue.push({ id, relPath: subRel });
            }
          } else {
            if (files.length >= maxFiles) {
              truncated = true;
              break;
            }
            const encMeta = encByProviderId.get(id);
            const sizeBytes = Number(encMeta?.encryptedSizeBytes ?? f.size ?? 0) || 0;
            files.push({
              id,
              name: safeName,
              folderPath: current.relPath,
              relativePath: current.relPath ? `${current.relPath}/${safeName}` : safeName,
              sizeBytes,
              mimeType: encMeta ? 'application/octet-stream' : (f.mimeType || 'application/octet-stream'),
              updatedAt: f.modifiedTime ? new Date(f.modifiedTime).toISOString() : null,
              isEncrypted: Boolean(encMeta),
              isNote: false,
            });
            totalBytes += sizeBytes;
          }
        }
        pageToken = res?.data?.nextPageToken || undefined;
      } while (pageToken && !truncated);
    }
  } else if (account.accountType === 'onedrive') {
    const c = await getOneDriveClient(account.tokens || account.credentials, accountId);
    const encMetaDocs = await database.collection('tg_files')
      .find({ accountId: account._id, isEncrypted: true })
      .toArray();
    const encByProviderId = new Map<string, any>();
    for (const m of encMetaDocs) {
      if (m.providerFileId) encByProviderId.set(String(m.providerFileId), m);
    }

    const startId = effectiveRoot || 'root';
    const queue: Array<{ id: string; relPath: string }> = [{ id: startId, relPath: '' }];
    const visited = new Set<string>([startId]);

    while (queue.length > 0 && !truncated) {
      const current = queue.shift()!;
      let nextEndpoint: string | null = current.id === 'root'
        ? '/me/drive/root/children?$top=200'
        : `/me/drive/items/${current.id}/children?$top=200`;

      while (nextEndpoint && !truncated) {
        const res: any = await withTransientRetry(
          () => c.api(nextEndpoint!).get(),
          undefined,
          3,
          { provider: 'onedrive', operation: 'manifestList' }
        );
        const items: any[] = Array.isArray(res?.value) ? res.value : [];
        for (const it of items) {
          if (it.deleted) continue;
          const id = String(it.id || '');
          if (!id) continue;
          const safeName = sanitizeManifestSegment(String(it.name || ''), id);
          if (it.folder) {
            if (!visited.has(id)) {
              visited.add(id);
              const subRel = current.relPath ? `${current.relPath}/${safeName}` : safeName;
              foldersSet.add(subRel);
              queue.push({ id, relPath: subRel });
            }
          } else {
            if (files.length >= maxFiles) {
              truncated = true;
              break;
            }
            const encMeta = encByProviderId.get(id);
            const sizeBytes = Number(encMeta?.encryptedSizeBytes ?? it.size ?? 0) || 0;
            files.push({
              id,
              name: safeName,
              folderPath: current.relPath,
              relativePath: current.relPath ? `${current.relPath}/${safeName}` : safeName,
              sizeBytes,
              mimeType: encMeta ? 'application/octet-stream' : (it.file?.mimeType || 'application/octet-stream'),
              updatedAt: it.lastModifiedDateTime ? new Date(it.lastModifiedDateTime).toISOString() : null,
              isEncrypted: Boolean(encMeta),
              isNote: false,
            });
            totalBytes += sizeBytes;
          }
        }
        nextEndpoint = typeof res?.['@odata.nextLink'] === 'string' ? res['@odata.nextLink'] : null;
      }
    }
  }

  const folders = Array.from(foldersSet).sort();
  return {
    accountId,
    accountType: String(account.accountType || ''),
    driveName,
    rootFolderId: effectiveRoot || 'root',
    generatedAt: new Date().toISOString(),
    truncated,
    totalFolders: folders.length,
    totalFiles: files.length,
    totalBytes,
    folders,
    files,
  };
}

async function ensureTargetFolderPath(
  database: any,
  targetAccount: any,
  baseFolderId: string,
  relativeFolderPath: string,
  folderCache: Map<string, string>
): Promise<string> {
  const cleanRel = normalizeRelativeFolderPath(relativeFolderPath);
  const cleanBase = !baseFolderId || baseFolderId === 'root' ? '' : String(baseFolderId).trim();

  if (targetAccount.accountType === 'tgdrive') {
    const cleanBasePath = normalizeRelativeFolderPath(cleanBase);
    const fullPath = [cleanBasePath, cleanRel].filter(Boolean).join('/');
    if (!fullPath) return '';
    if (folderCache.has(fullPath)) return folderCache.get(fullPath)!;

    const segments = fullPath.split('/');
    let accum = '';
    for (const seg of segments) {
      const parent = accum;
      accum = accum ? `${accum}/${seg}` : seg;
      if (!folderCache.has(accum)) {
        await database.collection('tg_folders').updateOne(
          { accountId: targetAccount._id, path: accum },
          {
            $setOnInsert: {
              accountId: targetAccount._id,
              userId: String(targetAccount.userId || ''),
              name: seg,
              path: accum,
              parent,
              createdAt: Math.floor(Date.now() / 1000),
            },
          },
          { upsert: true }
        );
        folderCache.set(accum, accum);
      }
    }
    return fullPath;
  }

  const rootId = cleanBase || 'root';
  if (!cleanRel) return rootId;
  if (folderCache.has(cleanRel)) return folderCache.get(cleanRel)!;

  const segments = cleanRel.split('/');
  let currentParentId = rootId;
  let accumRel = '';

  if (targetAccount.accountType === 'google') {
    const drive = await getDriveClient(targetAccount.tokens || targetAccount.credentials, String(targetAccount._id));
    for (const seg of segments) {
      accumRel = accumRel ? `${accumRel}/${seg}` : seg;
      const cached = folderCache.get(accumRel);
      if (cached) {
        currentParentId = cached;
        continue;
      }
      const safeName = escapeDriveQueryValue(seg);
      const safeParent = escapeDriveQueryValue(currentParentId);
      const existing: any = await drive.files.list({
        q: `name = '${safeName}' and '${safeParent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name)',
        pageSize: 1,
      });
      let folderId = existing?.data?.files?.[0]?.id;
      if (!folderId) {
        const created: any = await drive.files.create({
          requestBody: {
            name: seg,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [currentParentId],
          },
          fields: 'id',
        });
        folderId = created?.data?.id;
      }
      if (!folderId) throw new Error(`Failed to create folder '${seg}' in Google Drive`);
      folderCache.set(accumRel, String(folderId));
      currentParentId = String(folderId);
    }
    return currentParentId;
  }

  if (targetAccount.accountType === 'onedrive') {
    const c = await getOneDriveClient(targetAccount.tokens || targetAccount.credentials, String(targetAccount._id));
    for (const seg of segments) {
      accumRel = accumRel ? `${accumRel}/${seg}` : seg;
      const cached = folderCache.get(accumRel);
      if (cached) {
        currentParentId = cached;
        continue;
      }
      const parentEndpoint = currentParentId === 'root'
        ? '/me/drive/root/children'
        : `/me/drive/items/${currentParentId}/children`;
      let folderId: string | null = null;
      try {
        const children: any = await c.api(parentEndpoint).get();
        const found = (Array.isArray(children?.value) ? children.value : []).find(
          (it: any) => !it.deleted && it.folder && String(it.name || '') === seg
        );
        if (found?.id) folderId = String(found.id);
      } catch { /* fallback to create */ }
      if (!folderId) {
        const created: any = await c.api(parentEndpoint).post({
          name: seg,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'rename',
        });
        folderId = created?.id ? String(created.id) : null;
      }
      if (!folderId) throw new Error(`Failed to create folder '${seg}' in OneDrive`);
      folderCache.set(accumRel, folderId);
      currentParentId = folderId;
    }
    return currentParentId;
  }

  return rootId;
}

async function executeDriveTransfer(
  job: any,
  database: any,
  shouldCancel: () => Promise<boolean>
) {
  const p = job.payload || {};
  const sourceAccountId = String(p.sourceAccountId || '');
  const targetAccountId = String(p.targetAccountId || '');
  const sourceFolderId = String(p.sourceFolderId || 'root');
  const targetFolderId = String(p.targetFolderId || 'root');
  const isMove = Boolean(p.isMove);
  const conflictStrategy: ConflictStrategy =
    p.conflictStrategy === 'skip' || p.conflictStrategy === 'rename' || p.conflictStrategy === 'overwrite'
      ? p.conflictStrategy
      : 'skip';
  const jobId = String(job._id);

  const { account: sourceAccount, accessDenied: srcDenied } = await resolveAuthorizedAccount(database, sourceAccountId, p.userId, !!p.isAdmin);
  if (srcDenied || !sourceAccount) throw new Error('Source account not accessible');
  const { account: targetAccount, accessDenied: dstDenied } = await resolveAuthorizedAccount(database, targetAccountId, p.userId, !!p.isAdmin);
  if (dstDenied || !targetAccount) throw new Error('Target account not accessible');

  await database.collection('jobs').updateOne(
    { _id: job._id, status: 'running' },
    { $set: { stage: 'scanning', leaseUntil: new Date(Date.now() + JOB_LEASE_MS), updatedAt: new Date() } }
  );

  const manifest = await collectAccountManifest(database, sourceAccount, sourceFolderId, 25000, true);
  job.totalItems = manifest.totalFiles;
  job.totalBytes = manifest.totalBytes;

  await database.collection('jobs').updateOne(
    { _id: job._id, status: 'running' },
    {
      $set: {
        stage: manifest.folders.length > 0 ? 'creating_folders' : (isMove ? 'moving' : 'copying'),
        totalItems: manifest.totalFiles,
        totalBytes: manifest.totalBytes,
        itemsProcessed: 0,
        bytesProcessed: 0,
        progressPct: manifest.totalFiles === 0 ? 100 : 2,
        leaseUntil: new Date(Date.now() + JOB_LEASE_MS),
        updatedAt: new Date(),
      },
    }
  );

  const folderCache = new Map<string, string>();
  for (const folderRel of manifest.folders) {
    if (await shouldCancel()) {
      const cancelErr: any = new Error('Transfer job was cancelled');
      cancelErr.code = 'JOB_CANCELLED';
      throw cancelErr;
    }
    await ensureTargetFolderPath(database, targetAccount, targetFolderId, folderRel, folderCache);
  }

  const items: any[] = [];
  const failedFiles: any[] = [];
  let bytesProcessed = 0;
  let processedCount = 0;
  let fastCopiedCount = 0;
  let skippedCount = 0;

  for (let idx = 0; idx < manifest.files.length; idx++) {
    if (await shouldCancel()) {
      const cancelErr: any = new Error('Transfer job was cancelled');
      cancelErr.code = 'JOB_CANCELLED';
      throw cancelErr;
    }

    const fileItem = manifest.files[idx];
    const destFolderId = await ensureTargetFolderPath(database, targetAccount, targetFolderId, fileItem.folderPath, folderCache);
    const destTgFolder = destFolderId === 'root' ? '' : destFolderId;

    try {
      let handledFast = false;

      if (sourceAccount.accountType === 'tgdrive' && targetAccount.accountType === 'tgdrive') {
        const sourceMeta = ObjectId.isValid(fileItem.id)
          ? await database.collection('tg_files').findOne({ _id: new ObjectId(fileItem.id), accountId: sourceAccount._id })
          : null;

        if (sourceMeta) {
          const desiredName = sourceMeta.isEncrypted ? (sourceMeta.opaqueRemoteName || sourceMeta.name) : sourceMeta.name;
          const resolution = await resolveNonConflictingFileName(
            database,
            targetAccount,
            destTgFolder || 'root',
            desiredName,
            conflictStrategy
          );

          if (resolution.skipped) {
            skippedCount++;
            items.push({
              sourceFileId: fileItem.id,
              relativePath: fileItem.relativePath,
              fileName: fileItem.name,
              status: 'skipped_conflict',
              sizeBytes: fileItem.sizeBytes,
            });
            handledFast = true;
          } else if (sourceMeta.isNote === true && typeof sourceMeta.textContent === 'string') {
            // Instant zero-network note clone between TG Drives
            const clonedNote: any = { ...sourceMeta };
            delete clonedNote._id;
            clonedNote.accountId = targetAccount._id;
            clonedNote.folder = destTgFolder;
            clonedNote.name = resolution.resolvedName;
            clonedNote.shareId = nanoid(6);
            clonedNote.trashed = false;
            delete clonedNote.trashedAt;
            clonedNote.updatedAt = Date.now();
            const ins = await database.collection('tg_files').insertOne(clonedNote);
            if (isMove) {
              await permanentlyDeleteSingleFile(database, sourceAccount, fileItem.id, p.userId, !!p.isAdmin);
            }
            fastCopiedCount++;
            items.push({
              sourceFileId: fileItem.id,
              destinationFileId: String(ins?.insertedId || ''),
              relativePath: fileItem.relativePath,
              fileName: resolution.resolvedName,
              mode: 'note_clone',
              status: 'completed',
              sizeBytes: fileItem.sizeBytes,
            });
            handledFast = true;
          } else if (Number.isInteger(Number(sourceMeta.messageId)) && Number(sourceMeta.messageId) > 0) {
            // Zero-bandwidth TG -> TG server-side fast copy
            let targetThreadId: number | null = null;
            if (destTgFolder) {
              const topFolder = destTgFolder.split('/')[0];
              const targetFolderDoc = await database.collection('tg_folders').findOne({
                accountId: targetAccount._id,
                $or: [{ path: destTgFolder }, { path: topFolder }],
              });
              if (targetFolderDoc && Number.isInteger(Number(targetFolderDoc.threadId)) && Number(targetFolderDoc.threadId) > 0) {
                targetThreadId = Number(targetFolderDoc.threadId);
              }
            }
            const newMsgId = await tgFastCopyMessage(
              sourceAccount.channelId,
              targetAccount.channelId,
              Number(sourceMeta.messageId),
              targetThreadId
            );
            if (newMsgId) {
              const clonedDoc: any = { ...sourceMeta };
              delete clonedDoc._id;
              clonedDoc.accountId = targetAccount._id;
              clonedDoc.messageId = newMsgId;
              if (targetThreadId) clonedDoc.threadId = targetThreadId;
              else delete clonedDoc.threadId;
              clonedDoc.folder = destTgFolder;
              clonedDoc.name = resolution.resolvedName;
              if (clonedDoc.isEncrypted) clonedDoc.opaqueRemoteName = resolution.resolvedName;
              if (clonedDoc.isEncrypted) delete clonedDoc.shareId;
              else clonedDoc.shareId = nanoid(6);
              clonedDoc.trashed = false;
              delete clonedDoc.trashedAt;
              clonedDoc.updatedAt = Date.now();
              const ins = await database.collection('tg_files').insertOne(clonedDoc);
              if (isMove) {
                await permanentlyDeleteSingleFile(database, sourceAccount, fileItem.id, p.userId, !!p.isAdmin);
              }
              fastCopiedCount++;
              items.push({
                sourceFileId: fileItem.id,
                destinationFileId: String(ins?.insertedId || ''),
                relativePath: fileItem.relativePath,
                fileName: resolution.resolvedName,
                mode: 'tg_fast_copy',
                status: 'completed',
                sizeBytes: fileItem.sizeBytes,
              });
              handledFast = true;
            }
          }
        }
      }

      if (!handledFast) {
        const subJobKey = `${jobId}:${idx}`;
        const res = await crossAccountTransfer(
          sourceAccountId,
          fileItem.id,
          targetAccountId,
          destFolderId || 'root',
          p.userId,
          !!p.isAdmin,
          database,
          isMove,
          undefined,
          subJobKey,
          shouldCancel,
          conflictStrategy
        );
        if (res?.skipped) skippedCount++;
        items.push({
          sourceFileId: fileItem.id,
          destinationFileId: res?.destinationFileId || null,
          relativePath: fileItem.relativePath,
          fileName: res?.resolvedFileName || fileItem.name,
          mode: 'stream',
          status: res?.skipped ? 'skipped_conflict' : 'completed',
          sizeBytes: Number(res?.sizeBytes ?? fileItem.sizeBytes ?? 0),
        });
      }
    } catch (itemErr: any) {
      if (itemErr?.code === 'JOB_CANCELLED') throw itemErr;
      failedFiles.push({
        fileId: fileItem.id,
        relativePath: fileItem.relativePath,
        error: itemErr?.message || 'Transfer failed',
        code: itemErr?.code || STANDARD_ERROR_CODES.TRANSFER_FAILED,
      });
      items.push({
        sourceFileId: fileItem.id,
        relativePath: fileItem.relativePath,
        fileName: fileItem.name,
        status: 'failed',
        error: itemErr?.message || 'Transfer failed',
        sizeBytes: fileItem.sizeBytes,
      });
    }

    processedCount = idx + 1;
    bytesProcessed += fileItem.sizeBytes;
    const progressPct = manifest.totalFiles > 0
      ? Math.min(98, Math.max(2, Math.round((processedCount / manifest.totalFiles) * 98)))
      : 100;
    const now = new Date();
    job.itemsProcessed = processedCount;
    job.bytesProcessed = bytesProcessed;
    job.failedCount = failedFiles.length;

    await database.collection('jobs').updateOne(
      { _id: job._id, status: 'running' },
      {
        $set: {
          stage: `${isMove ? 'moving' : 'copying'}_${processedCount}_of_${manifest.totalFiles}`,
          itemsProcessed: processedCount,
          totalItems: manifest.totalFiles,
          bytesProcessed,
          totalBytes: manifest.totalBytes,
          failedCount: failedFiles.length,
          progressPct,
          leaseUntil: new Date(Date.now() + JOB_LEASE_MS),
          updatedAt: now,
        },
      }
    );
  }

  const now = new Date();
  await database.collection('transfer_manifests').updateOne(
    { jobId },
    {
      $set: {
        jobId,
        type: 'drive_transfer',
        isMove,
        userId: p.userId ? String(p.userId) : null,
        sourceAccountId,
        targetAccountId,
        sourceFolderId,
        targetFolderId,
        conflictStrategy,
        totalFolders: manifest.totalFolders,
        totalFiles: manifest.totalFiles,
        totalBytes: manifest.totalBytes,
        fastCopiedCount,
        skippedCount,
        succeededCount: items.filter((i) => i.status === 'completed' || i.status === 'skipped_conflict').length,
        failedCount: failedFiles.length,
        failedFiles,
        items,
        status: failedFiles.length === 0 ? 'completed' : (items.some((i) => i.status === 'completed') ? 'completed_with_errors' : 'failed'),
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );

  invalidateDriveCache(sourceAccountId);
  invalidateDriveCache(targetAccountId);
  return {
    totalFiles: manifest.totalFiles,
    totalFolders: manifest.totalFolders,
    processedCount,
    failedCount: failedFiles.length,
    fastCopiedCount,
    skippedCount,
  };
}

export type QueueJobType =
  | 'cross_account_transfer'
  | 'drive_transfer'
  | 'archive_zip_to_cloud'
  | 'archive_unzip'
  | 'batch_backup'
  | 'batch_restore'
  | 'trash_cleanup'
  | 'thumb_generation'
  | 'provider_sync';

async function enqueueTransferJob(
  database: any,
  payload: any,
  jobType: QueueJobType = 'cross_account_transfer'
) {
  const activeCount = await database.collection('jobs').countDocuments({ status: { $in: ['queued', 'running'] } });
  if (activeCount >= MAX_JOB_QUEUE_DEPTH) {
    const err: any = new Error('Background transfer queue is currently full; please try again shortly');
    err.status = 503;
    err.code = STANDARD_ERROR_CODES.RATE_LIMITED;
    throw err;
  }
  const now = new Date();
  const totalItems = Array.isArray(payload?.fileIds) ? payload.fileIds.length : 1;
  const job = {
    _id: nanoid(32),
    userId: payload?.userId ? String(payload.userId) : null,
    accountId: payload?.sourceAccountId ? String(payload.sourceAccountId) : (payload?.accountId ? String(payload.accountId) : null),
    type: jobType,
    status: 'queued',
    stage: 'queued',
    priority: Number(payload?.priority || 0),
    progressPct: 0,
    bytesProcessed: 0,
    totalBytes: 0,
    itemsProcessed: 0,
    totalItems,
    attempts: 0,
    maxAttempts: JOB_MAX_ATTEMPTS,
    deadLettered: false,
    cancelRequested: false,
    sourceDeleteApproved: false,
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

/**
 * Formats a job document into the unified Operation response shape while preserving all legacy fields.
 */
function publicJob(job: any) {
  const p = job.payload || {};
  const progressPct = typeof job.progressPct === 'number' ? job.progressPct : (job.status === 'completed' ? 100 : 0);
  const totalItems = typeof job.totalItems === 'number' ? job.totalItems : (Array.isArray(p.fileIds) ? p.fileIds.length : 1);
  const itemsProcessed = typeof job.itemsProcessed === 'number'
    ? job.itemsProcessed
    : (job.status === 'completed' ? totalItems : 0);
  return {
    id: String(job._id),
    userId: job.userId || p.userId || null,
    accountId: job.accountId || p.sourceAccountId || p.accountId || null,
    type: job.type,
    status: job.status,
    stage: job.stage || job.status,
    priority: job.priority || 0,
    fileName: p.displayName || p.fileName || null,
    isMove: Boolean(p.isMove),
    sourceAccountName: p.sourceAccountName || null,
    targetAccountName: p.targetAccountName || null,
    conflictStrategy: p.conflictStrategy || null,
    failedCount: typeof job.failedCount === 'number' ? job.failedCount : 0,
    source: {
      accountId: p.sourceAccountId || p.accountId || null,
      folderId: p.sourceFolderId || null,
      fileId: p.fileId || null,
      fileIds: Array.isArray(p.fileIds) ? p.fileIds : null,
    },
    destination: {
      accountId: p.targetAccountId || null,
      folderId: p.targetFolderId || 'root',
      destinationFileId: job.destinationFileId || null,
    },
    progress: progressPct,
    progressPct,
    bytesProcessed: job.bytesProcessed || 0,
    totalBytes: job.totalBytes || 0,
    itemsProcessed,
    totalItems,
    retryCount: job.attempts || 0,
    attempts: job.attempts || 0,
    maxAttempts: job.maxAttempts || JOB_MAX_ATTEMPTS,
    deadLettered: Boolean(job.deadLettered),
    cancellationRequested: Boolean(job.cancelRequested),
    cancelRequested: Boolean(job.cancelRequested),
    sourceDeleteApproved: Boolean(job.sourceDeleteApproved),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    expiresAt: job.expiresAt,
    error: job.error || null,
  };
}

const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 3));
let activeJobWorkers = 0;
const SUPPORTED_JOB_TYPES: QueueJobType[] = [
  'cross_account_transfer',
  'drive_transfer',
  'archive_zip_to_cloud',
  'archive_unzip',
  'batch_backup',
  'batch_restore',
  'trash_cleanup',
  'thumb_generation',
  'provider_sync',
];

async function runJobWorker() {
  if (activeJobWorkers >= MAX_CONCURRENT_JOBS || isShuttingDown || !db) return;
  activeJobWorkers++;
  systemMetrics.lastWorkerHeartbeatAt = Date.now();
  systemMetrics.workerHeartbeats++;
  try {
    const now = new Date();
    const claimedResult = await db.collection('jobs').findOneAndUpdate(
      {
        type: { $in: SUPPORTED_JOB_TYPES },
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
      const p = job.payload || {};
      let lastUpdateMs = 0;
      const shouldCancel = async () => {
        if (isShuttingDown) return false;
        const current = await db.collection('jobs').findOne({ _id: job._id });
        return !current || current.status === 'cancelled' || current.cancelRequested === true || (current.leaseOwner && current.leaseOwner !== WORKER_ID);
      };

      let finalStatus: 'completed' | 'completed_with_errors' = 'completed';
      if (job.type === 'drive_transfer') {
        const driveSummary = await providerLimit(`transfer:${p.sourceAccountId}:${p.targetAccountId}`, 1)(() =>
          executeDriveTransfer(job, db, shouldCancel)
        );
        if (driveSummary.failedCount > 0) {
          finalStatus = 'completed_with_errors';
        }
      } else if (job.type === 'archive_zip_to_cloud') {
        await providerLimit(`archive:${p.accountId}`, 1)(() =>
          executeArchiveZipToCloudJob(job, db, shouldCancel, {
            collectAccountManifest,
            resolveNonConflictingFileName,
          })
        );
      } else if (job.type === 'archive_unzip') {
        const unzipSummary = await providerLimit(`archive:${p.accountId}`, 1)(() =>
          executeArchiveUnzipJob(job, db, shouldCancel, {
            ensureTargetFolderPath,
            resolveNonConflictingFileName,
          })
        );
        if (unzipSummary.failedCount > 0) {
          finalStatus = 'completed_with_errors';
        }
      } else if (job.type === 'batch_backup' || job.type === 'batch_restore') {
        await providerLimit(`transfer:${p.sourceAccountId}:${p.targetAccountId}`, 1)(() =>
          executeBatchBackupOrRestore(job, db, shouldCancel)
        );
      } else if (job.type === 'trash_cleanup') {
        await sweepExpiredTrash();
      } else if (job.type === 'thumb_generation') {
        if (p.accountId && p.fileId && ObjectId.isValid(String(p.accountId))) {
          const acc = await db.collection('accounts').findOne({ _id: new ObjectId(String(p.accountId)) });
          if (acc) {
            const s = Number(p.size || 256);
            const thumbPath = buildThumbPath(String(acc._id), String(p.fileId), s);
            await generateThumbnail(acc, String(p.fileId), s, thumbPath);
          }
        }
      } else if (job.type === 'provider_sync') {
        if (p.accountId) {
          invalidateDriveCache(String(p.accountId));
        }
      } else {
        const transferResult = await providerLimit(`transfer:${p.sourceAccountId}:${p.targetAccountId}`, 1)(() =>
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
              const leaseRes = await db.collection('jobs').updateOne(
                { _id: job._id, status: 'running', leaseOwner: WORKER_ID, cancelRequested: { $ne: true } },
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
              // Atomic cancellation / lease fence
              if (leaseRes && typeof leaseRes.matchedCount === 'number' && leaseRes.matchedCount === 0) {
                const current = await db.collection('jobs').findOne({ _id: job._id });
                if (!current || current.status === 'cancelled' || current.cancelRequested === true) {
                  const cancelErr: any = new Error('Transfer job was cancelled');
                  cancelErr.code = 'JOB_CANCELLED';
                  throw cancelErr;
                }
              }
            },
            String(job._id),
            shouldCancel,
            p.conflictStrategy || 'overwrite'
          )
        );
        if (transferResult?.destinationFileId) {
          job.destinationFileId = transferResult.destinationFileId;
        }
      }
      systemMetrics.transfersCompleted++;
      if (p.sourceAccountId) invalidateDriveCache(p.sourceAccountId);
      if (p.targetAccountId) invalidateDriveCache(p.targetAccountId);
      await db.collection('jobs').updateOne(
        { _id: job._id, status: 'running' },
        {
          $set: {
            status: finalStatus,
            stage: finalStatus,
            progressPct: 100,
            itemsProcessed: typeof job.itemsProcessed === 'number' && (job.type === 'drive_transfer' || job.type === 'archive_zip_to_cloud' || job.type === 'archive_unzip')
              ? job.itemsProcessed
              : (job.totalItems || 1),
            totalItems: typeof job.totalItems === 'number' ? job.totalItems : 1,
            ...(typeof job.bytesProcessed === 'number' && (job.type === 'drive_transfer' || job.type === 'archive_zip_to_cloud' || job.type === 'archive_unzip') ? { bytesProcessed: job.bytesProcessed } : {}),
            ...(typeof job.totalBytes === 'number' && (job.type === 'drive_transfer' || job.type === 'archive_zip_to_cloud' || job.type === 'archive_unzip') ? { totalBytes: job.totalBytes } : {}),
            ...(typeof job.failedCount === 'number' ? { failedCount: job.failedCount } : {}),
            destinationFileId: job.destinationFileId || null,
            sourceDeleteApproved: Boolean(p.isMove) && finalStatus === 'completed',
            completedAt: new Date(),
            updatedAt: new Date(),
          },
          $unset: { leaseUntil: '', leaseOwner: '' },
        }
      );
    } catch (err: any) {
      if (err?.code === 'JOB_CANCELLED') {
        recordAuditEvent('job_cancelled', { jobId: String(job._id), type: job.type, userId: job.payload?.userId || null });
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
        recordAuditEvent('job_dead_lettered', {
          jobId: String(job._id),
          type: job.type,
          attempts,
          error: err?.message || 'Transfer failed',
        });
      } else {
        recordAuditEvent('job_retry_scheduled', {
          jobId: String(job._id),
          type: job.type,
          attempts,
          error: err?.message || 'Transfer failed',
        });
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


export {
  TRASH_RETENTION_MS,
  sweepExpiredTrash,
  UPLOAD_SESSION_TTL_MS,
  COMPLETED_SESSION_TTL_MS,
  PROVIDER_COMPLETION_LEASE_MS,
  sweepUploadSessions,
  publicUploadSession,
  resolveUploadSessionForRequest,
  expireUploadSessionIfNeeded,
  type TransferProgressInfo,
  type ConflictStrategy,
  buildConflictCopyName,
  checkDestinationFileExists,
  resolveNonConflictingFileName,
  crossAccountTransfer,
  verifySingleBackupItem,
  executeBatchBackupOrRestore,
  collectAccountManifest,
  ensureTargetFolderPath,
  executeDriveTransfer,
  enqueueTransferJob,
  publicJob,
  MAX_CONCURRENT_JOBS,
  SUPPORTED_JOB_TYPES,
  activeJobWorkers,
  runJobWorker,
};
