import fs from 'fs';
import path from 'path';
import stream, { PassThrough, Readable } from 'stream';
import axios from 'axios';
import { createRequire } from 'module';
import * as archiverPkg from 'archiver';
import type { Archiver } from 'archiver';
import type yauzlType from 'yauzl';
import { ObjectId } from 'mongodb';

const require = createRequire(import.meta.url);
const ZipArchive = (archiverPkg as any).ZipArchive as new (options?: any) => Archiver;
const yauzl = require('yauzl') as typeof import('yauzl');

import {
  STANDARD_ERROR_CODES,
  TEMP_DIR,
  JOB_LEASE_MS,
  PROVIDER_API_TIMEOUT_MS,
  apiError,
  connectToMongo,
  db,
  hasTempDiskHeadroom,
  invalidateDriveCache,
  nanoid,
  recordAuditEvent,
  requireAuth,
} from './core.ts';

import {
  buildSafeContentDisposition,
  hasPathTraversal,
  isSafeProviderItemId,
  normalizeSafeFilename,
  validateSafeFolderId,
} from './protocol.ts';

import {
  checkTgChannelAccess,
  formatTgChannelError,
  getDriveClient,
  getOneDriveClient,
  isTgChannelAccessError,
  markTgChannelInaccessible,
  resolveAuthorizedAccount,
  resolveFileMetadataForAccount,
  resolvePeer,
  uploadFileToProvider,
  withTgPoolClient,
} from './provider.ts';

export const MAX_ZIP_ENTRIES = 5000;
export const MAX_UNZIP_ENTRIES = 2000;
export const MAX_UNZIP_TOTAL_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
const MAX_ZIP_COMPRESSION_RATIO = 100;
const RATIO_CHECK_MIN_BYTES = 50 * 1024 * 1024; // 50 MiB

export interface ArchiveSourceEntry {
  fileId: string;
  entryPath: string;
  sizeBytes: number;
  isNote?: boolean;
  textContent?: string;
}

function resolveInsideTempDir(filename: string): string {
  const root = path.resolve(TEMP_DIR);
  const candidate = path.resolve(root, filename);
  if (!candidate.startsWith(root + path.sep)) {
    throw new Error('Invalid temporary file path');
  }
  return candidate;
}

function sanitizeArchiveSegment(raw: string, fallback = 'item'): string {
  const cleaned = String(raw || '')
    .normalize('NFC')
    .replace(/[\x00-\x1f\x7f/\\]/g, '_')
    .replace(/^\.+$/, '_')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 255 ? cleaned.slice(0, 255) : cleaned;
}

function deduplicateEntryPath(rawPath: string, usedPaths: Set<string>): string {
  const normalized = rawPath.split('/').filter(Boolean).join('/') || 'file';
  if (!usedPaths.has(normalized)) {
    usedPaths.add(normalized);
    return normalized;
  }
  const slashIdx = normalized.lastIndexOf('/');
  const dir = slashIdx >= 0 ? normalized.slice(0, slashIdx + 1) : '';
  const base = slashIdx >= 0 ? normalized.slice(slashIdx + 1) : normalized;
  const dotIdx = base.lastIndexOf('.');
  const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
  const ext = dotIdx > 0 ? base.slice(dotIdx) : '';
  let counter = 2;
  while (counter < 10000) {
    const candidate = `${dir}${stem} (${counter})${ext}`;
    if (!usedPaths.has(candidate)) {
      usedPaths.add(candidate);
      return candidate;
    }
    counter++;
  }
  const fallback = `${dir}${stem}_${Date.now()}${ext}`;
  usedPaths.add(fallback);
  return fallback;
}

async function resolveFolderDisplayName(
  database: any,
  account: any,
  folderId: string
): Promise<string> {
  const clean = folderId.startsWith('folder:') ? folderId.slice('folder:'.length) : folderId;
  if (!clean || clean === 'root') return 'root';
  if (account.accountType === 'tgdrive') {
    const folderDoc = await database.collection('tg_folders').findOne({ accountId: account._id, path: clean });
    if (folderDoc?.name) return sanitizeArchiveSegment(String(folderDoc.name), 'folder');
    const tail = clean.split('/').filter(Boolean).pop();
    return sanitizeArchiveSegment(tail || 'folder', 'folder');
  }
  if (account.accountType === 'onedrive') {
    try {
      const c = await getOneDriveClient(account.tokens || account.credentials, String(account._id));
      const item = await c.api(`/me/drive/items/${clean}?$select=id,name,folder`).get();
      if (item?.name) return sanitizeArchiveSegment(String(item.name), 'folder');
    } catch { /* fallback */ }
    return sanitizeArchiveSegment(clean.slice(0, 24), 'folder');
  }
  if (account.accountType === 'google') {
    try {
      const drive = await getDriveClient(account.tokens || account.credentials, String(account._id));
      const res = await drive.files.get({ fileId: clean, fields: 'id,name,mimeType' });
      if (res?.data?.name) return sanitizeArchiveSegment(String(res.data.name), 'folder');
    } catch { /* fallback */ }
    return sanitizeArchiveSegment(clean.slice(0, 24), 'folder');
  }
  return 'folder';
}

export async function collectArchiveSelectionEntries(
  database: any,
  account: any,
  rawFileIds: string[],
  rawFolderIds: string[],
  userId: any,
  isAdmin: boolean,
  collectAccountManifest: (database: any, account: any, rootFolderId?: string, maxFiles?: number, includeNoteContent?: boolean) => Promise<any>
): Promise<{ entries: ArchiveSourceEntry[]; totalBytes: number; skippedEncryptedCount: number }> {
  const usedPaths = new Set<string>();
  const entries: ArchiveSourceEntry[] = [];
  let totalBytes = 0;
  let skippedEncryptedCount = 0;

  for (const rawFileId of rawFileIds) {
    if (entries.length >= MAX_ZIP_ENTRIES) {
      throw Object.assign(new Error(`Archive exceeds maximum of ${MAX_ZIP_ENTRIES} files`), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
    }
    const fileId = String(rawFileId || '').trim();
    if (!fileId || !isSafeProviderItemId(fileId)) {
      throw Object.assign(new Error(`Invalid file identifier: ${fileId}`), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
    }
    const { meta, accessDenied } = await resolveFileMetadataForAccount(database, account, fileId, userId, isAdmin);
    if (accessDenied) {
      throw Object.assign(new Error('Access denied to selected file'), { status: 403, code: 'ACCOUNT_ACCESS_DENIED' });
    }
    if (meta?.isEncrypted) {
      skippedEncryptedCount++;
      continue;
    }

    let fileName = '';
    let sizeBytes = 0;
    if (account.accountType === 'tgdrive') {
      if (!meta || meta.trashed === true) continue;
      fileName = String(meta.name || 'file');
      sizeBytes = Number(meta.size || 0) || 0;
    } else if (account.accountType === 'onedrive') {
      const c = await getOneDriveClient(account.tokens || account.credentials, String(account._id));
      const item = await c.api(`/me/drive/items/${fileId}?$select=id,name,size,folder,file`).get();
      if (item?.folder) {
        // Handle accidentally passed folder ID inside fileIds
        rawFolderIds = [...rawFolderIds, fileId];
        continue;
      }
      fileName = String(item?.name || 'file');
      sizeBytes = Number(item?.size || 0) || 0;
    } else if (account.accountType === 'google') {
      const drive = await getDriveClient(account.tokens || account.credentials, String(account._id));
      const res = await drive.files.get({ fileId, fields: 'id,name,size,mimeType' });
      if (res?.data?.mimeType === 'application/vnd.google-apps.folder') {
        rawFolderIds = [...rawFolderIds, fileId];
        continue;
      }
      fileName = String(res?.data?.name || 'file');
      sizeBytes = Number(res?.data?.size || 0) || 0;
    }

    const safeName = sanitizeArchiveSegment(fileName, 'file');
    const entryPath = deduplicateEntryPath(safeName, usedPaths);
    entries.push({
      fileId,
      entryPath,
      sizeBytes,
      ...(meta?.isNote === true && typeof meta.textContent === 'string' ? { isNote: true, textContent: meta.textContent } : {}),
    });
    totalBytes += sizeBytes;
  }

  const seenFolders = new Set<string>();
  for (const rawFolderId of rawFolderIds) {
    const folderCheck = validateSafeFolderId(rawFolderId);
    if (!folderCheck.ok) {
      throw Object.assign(new Error(folderCheck.error.message), { status: folderCheck.error.status, code: folderCheck.error.code });
    }
    const cleanFolderId = folderCheck.folderId || 'root';
    if (seenFolders.has(cleanFolderId)) continue;
    seenFolders.add(cleanFolderId);

    const folderLabel = await resolveFolderDisplayName(database, account, cleanFolderId);
    const manifest = await collectAccountManifest(database, account, cleanFolderId, MAX_ZIP_ENTRIES - entries.length + 1, true);
    for (const mf of manifest.files || []) {
      if (mf.isEncrypted) {
        skippedEncryptedCount++;
        continue;
      }
      if (entries.length >= MAX_ZIP_ENTRIES) {
        throw Object.assign(new Error(`Archive exceeds maximum of ${MAX_ZIP_ENTRIES} files`), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
      }
      const relParts = String(mf.relativePath || mf.name || 'file')
        .split('/')
        .map((seg) => sanitizeArchiveSegment(seg, 'item'))
        .filter(Boolean);
      const rawEntryPath = folderLabel && folderLabel !== 'root'
        ? [folderLabel, ...relParts].join('/')
        : relParts.join('/');
      const entryPath = deduplicateEntryPath(rawEntryPath, usedPaths);
      const sizeBytes = Number(mf.sizeBytes || 0) || 0;
      entries.push({
        fileId: String(mf.id),
        entryPath,
        sizeBytes,
        ...(mf.isNote === true && typeof mf.textContent === 'string' ? { isNote: true, textContent: mf.textContent } : {}),
      });
      totalBytes += sizeBytes;
    }
  }

  return { entries, totalBytes, skippedEncryptedCount };
}

export async function openProviderFileReadStream(
  database: any,
  account: any,
  entry: ArchiveSourceEntry,
  userId: any,
  isAdmin: boolean,
  isCancelled: () => boolean
): Promise<Readable> {
  if (entry.isNote && typeof entry.textContent === 'string') {
    return Readable.from([Buffer.from(entry.textContent, 'utf8')]);
  }

  const { meta, accessDenied } = await resolveFileMetadataForAccount(database, account, entry.fileId, userId, isAdmin);
  if (accessDenied) throw new Error('Access denied to file');
  if (meta?.isEncrypted) throw new Error('Encrypted CYTE1 files cannot be archived on server');

  if (account.accountType === 'tgdrive') {
    if (!meta) throw new Error(`File not found in TG Drive (${entry.fileId})`);
    if (meta.isNote === true && typeof meta.textContent === 'string') {
      return Readable.from([Buffer.from(meta.textContent, 'utf8')]);
    }
    let telegram: any = null;
    let messages: any;
    try {
      const fetched = await withTgPoolClient(
        account.channelId,
        async (tgc) => {
          const peer = await resolvePeer(tgc, account.channelId);
          const msgs = await tgc.getMessages(peer, { ids: [meta.messageId] });
          return { tgc, msgs };
        },
        { preferWorker: true }
      );
      telegram = fetched.tgc;
      messages = fetched.msgs;
    } catch (tgErr: any) {
      if (isTgChannelAccessError(tgErr)) {
        markTgChannelInaccessible(account.channelId, tgErr);
        throw Object.assign(new Error(formatTgChannelError(tgErr, account.channelId)), { code: 'TG_CHANNEL_ACCESS_DENIED' });
      }
      throw tgErr;
    }
    const tgMsg: any = messages?.[0];
    if (!tgMsg) throw new Error(`Telegram message not found for ${entry.entryPath}`);
    if (!tgMsg.media && typeof tgMsg.message === 'string') {
      return Readable.from([Buffer.from(tgMsg.message, 'utf8')]);
    }
    if (!tgMsg.media) throw new Error(`No media attached for ${entry.entryPath}`);

    const pass = new PassThrough();
    (async () => {
      try {
        for await (const chunk of telegram.iterDownload({ file: tgMsg.media, requestSize: 1024 * 1024 })) {
          if (isCancelled() || pass.destroyed) break;
          if (!pass.write(chunk)) {
            await new Promise<void>((resolve, reject) => {
              const onDrain = () => { cleanup(); resolve(); };
              const onClose = () => { cleanup(); resolve(); };
              const onErr = (err: any) => { cleanup(); reject(err); };
              const cleanup = () => {
                pass.off('drain', onDrain);
                pass.off('close', onClose);
                pass.off('error', onErr);
              };
              pass.once('drain', onDrain);
              pass.once('close', onClose);
              pass.once('error', onErr);
            });
          }
        }
        if (!pass.destroyed) pass.end();
      } catch (err: any) {
        if (!pass.destroyed) pass.destroy(err);
      }
    })();
    return pass;
  }

  if (account.accountType === 'onedrive') {
    const c = await getOneDriveClient(account.tokens || account.credentials, String(account._id));
    const item = await c.api(`/me/drive/items/${entry.fileId}`).get();
    const dlUrl = item?.['@microsoft.graph.downloadUrl'];
    if (!dlUrl) throw new Error(`OneDrive download link unavailable for ${entry.entryPath}`);
    const response = await axios.get(dlUrl, { responseType: 'stream', timeout: PROVIDER_API_TIMEOUT_MS });
    return response.data as Readable;
  }

  if (account.accountType === 'google') {
    const drive = await getDriveClient(account.tokens || account.credentials, String(account._id));
    const response = await drive.files.get({ fileId: entry.fileId, alt: 'media' }, { responseType: 'stream' });
    return response.data as Readable;
  }

  throw new Error(`Unsupported provider '${String(account.accountType || '')}'`);
}

export async function waitForEntryStreamAppended(
  archive: Archiver,
  readStream: Readable,
  entryName: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: any) => {
      if (settled) return;
      settled = true;
      readStream.off('end', onEnd);
      readStream.off('error', onError);
      archive.off('error', onError);
      if (err) reject(err);
      else resolve();
    };
    const onEnd = () => finish();
    const onError = (err: any) => finish(err);
    readStream.once('end', onEnd);
    readStream.once('error', onError);
    archive.once('error', onError);
    archive.append(readStream, { name: entryName });
  });
}

async function downloadFileToTemp(
  database: any,
  account: any,
  fileId: string,
  destPath: string,
  userId: any,
  isAdmin: boolean,
  shouldCancel: () => Promise<boolean>
): Promise<{ fileName: string; sizeBytes: number }> {
  const { meta, accessDenied } = await resolveFileMetadataForAccount(database, account, fileId, userId, isAdmin);
  if (accessDenied) throw new Error('Access denied to archive file');
  if (meta?.isEncrypted) throw new Error('Encrypted CYTE1 files cannot be unzipped on server');

  let fileName = String(meta?.name || 'archive.zip');
  let expectedBytes = Number(meta?.size || 0) || 0;

  if (account.accountType === 'onedrive') {
    const c = await getOneDriveClient(account.tokens || account.credentials, String(account._id));
    const item = await c.api(`/me/drive/items/${fileId}?$select=id,name,size`).get();
    if (item?.name) fileName = String(item.name);
    if (item?.size !== undefined) expectedBytes = Number(item.size) || 0;
  } else if (account.accountType === 'google') {
    const drive = await getDriveClient(account.tokens || account.credentials, String(account._id));
    const res = await drive.files.get({ fileId, fields: 'id,name,size' });
    if (res?.data?.name) fileName = String(res.data.name);
    if (res?.data?.size !== undefined) expectedBytes = Number(res.data.size) || 0;
  }

  if (!hasTempDiskHeadroom(expectedBytes)) {
    throw Object.assign(new Error('Server temporary storage is too low to extract this archive'), {
      code: STANDARD_ERROR_CODES.INSUFFICIENT_STORAGE,
    });
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const writeStream = fs.createWriteStream(destPath);
  let cancelled = false;
  try {
    const readStream = await openProviderFileReadStream(
      database,
      account,
      { fileId, entryPath: fileName, sizeBytes: expectedBytes },
      userId,
      isAdmin,
      () => cancelled
    );
    const cancelWatch = new stream.Transform({
      async transform(chunk, _enc, cb) {
        try {
          if (await shouldCancel()) {
            cancelled = true;
            cb(Object.assign(new Error('Archive job was cancelled'), { code: 'JOB_CANCELLED' }));
            return;
          }
          cb(null, chunk);
        } catch (err: any) {
          cb(err);
        }
      },
    });
    await stream.promises.pipeline(readStream, cancelWatch, writeStream);
    const stat = await fs.promises.stat(destPath);
    return { fileName, sizeBytes: stat.size };
  } catch (err) {
    try { writeStream.destroy(); } catch { /* ignore */ }
    try { await fs.promises.unlink(destPath); } catch { /* ignore */ }
    throw err;
  }
}

export async function executeArchiveZipToCloudJob(
  job: any,
  database: any,
  shouldCancel: () => Promise<boolean>,
  deps: {
    collectAccountManifest: (database: any, account: any, rootFolderId?: string, maxFiles?: number, includeNoteContent?: boolean) => Promise<any>;
    resolveNonConflictingFileName: (database: any, account: any, folderId: string, desiredName: string, conflictStrategy: any) => Promise<{ resolvedName: string; conflictDetected: boolean; skipped: boolean }>;
  }
) {
  const p = job.payload || {};
  const accountId = String(p.accountId || '');
  const targetFolderId = String(p.targetFolderId || 'root');
  const rawFileIds: string[] = Array.isArray(p.fileIds) ? p.fileIds.map(String) : [];
  const rawFolderIds: string[] = Array.isArray(p.folderIds) ? p.folderIds.map(String) : [];
  const requestedName = normalizeSafeFilename(p.archiveName || `archive_${Date.now()}.zip`, `archive_${Date.now()}.zip`);
  const archiveName = requestedName.toLowerCase().endsWith('.zip') ? requestedName : `${requestedName}.zip`;

  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, p.userId, !!p.isAdmin);
  if (accessDenied || !account) throw new Error('Storage account is not accessible');

  await database.collection('jobs').updateOne(
    { _id: job._id, status: 'running' },
    { $set: { stage: 'scanning_files', leaseUntil: new Date(Date.now() + JOB_LEASE_MS), updatedAt: new Date() } }
  );

  const { entries, totalBytes, skippedEncryptedCount } = await collectArchiveSelectionEntries(
    database,
    account,
    rawFileIds,
    rawFolderIds,
    p.userId,
    !!p.isAdmin,
    deps.collectAccountManifest
  );

  if (entries.length === 0) {
    throw new Error(
      skippedEncryptedCount > 0
        ? 'Encrypted CYTE1 files cannot be zipped on the server'
        : 'No files found to compress'
    );
  }
  if (!hasTempDiskHeadroom(totalBytes)) {
    throw Object.assign(new Error('Server temporary storage is too low for this ZIP archive'), {
      code: STANDARD_ERROR_CODES.INSUFFICIENT_STORAGE,
    });
  }

  job.totalItems = entries.length;
  job.totalBytes = totalBytes;
  job.itemsProcessed = 0;
  job.bytesProcessed = 0;

  await database.collection('jobs').updateOne(
    { _id: job._id, status: 'running' },
    {
      $set: {
        stage: 'archiving',
        totalItems: entries.length,
        totalBytes,
        itemsProcessed: 0,
        bytesProcessed: 0,
        progressPct: 5,
        leaseUntil: new Date(Date.now() + JOB_LEASE_MS),
        updatedAt: new Date(),
      },
    }
  );

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const tmpZipPath = resolveInsideTempDir(`archive_job_${String(job._id)}_${nanoid(8)}.zip`);
  let cancelled = false;

  try {
    const outStream = fs.createWriteStream(tmpZipPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const outDone = new Promise<void>((resolve, reject) => {
      outStream.once('close', () => resolve());
      outStream.once('error', reject);
      archive.once('error', reject);
    });
    archive.pipe(outStream);

    let processedBytes = 0;
    for (let i = 0; i < entries.length; i++) {
      if (await shouldCancel()) {
        cancelled = true;
        try { archive.abort(); } catch { /* ignore */ }
        throw Object.assign(new Error('ZIP archive job cancelled'), { code: 'JOB_CANCELLED' });
      }
      const entry = entries[i];
      const readStream = await openProviderFileReadStream(
        database,
        account,
        entry,
        p.userId,
        !!p.isAdmin,
        () => cancelled
      );
      await waitForEntryStreamAppended(archive, readStream, entry.entryPath);
      processedBytes += entry.sizeBytes;
      job.itemsProcessed = i + 1;
      job.bytesProcessed = processedBytes;
      const pct = Math.min(65, Math.max(8, Math.round(((i + 1) / entries.length) * 60) + 5));
      await database.collection('jobs').updateOne(
        { _id: job._id, status: 'running' },
        {
          $set: {
            stage: `archiving_${i + 1}_of_${entries.length}`,
            itemsProcessed: i + 1,
            bytesProcessed: processedBytes,
            progressPct: pct,
            leaseUntil: new Date(Date.now() + JOB_LEASE_MS),
            updatedAt: new Date(),
          },
        }
      );
    }

    await archive.finalize();
    await outDone;

    if (await shouldCancel()) {
      throw Object.assign(new Error('ZIP archive job cancelled'), { code: 'JOB_CANCELLED' });
    }

    const zipStat = await fs.promises.stat(tmpZipPath);
    const resolvedNameObj = await deps.resolveNonConflictingFileName(
      database,
      account,
      targetFolderId || 'root',
      archiveName,
      'rename'
    );
    const finalArchiveName = resolvedNameObj.resolvedName || archiveName;

    await database.collection('jobs').updateOne(
      { _id: job._id, status: 'running' },
      {
        $set: {
          stage: 'uploading_archive',
          progressPct: 75,
          leaseUntil: new Date(Date.now() + JOB_LEASE_MS),
          updatedAt: new Date(),
        },
      }
    );

    const uploadResult: any = await uploadFileToProvider(
      account,
      String(account._id),
      {
        path: tmpZipPath,
        size: zipStat.size,
        originalname: finalArchiveName,
        mimetype: 'application/zip',
      },
      targetFolderId || 'root',
      undefined,
      undefined,
      `zip_job_${String(job._id)}`,
      undefined,
      String(p.userId || account.userId || '')
    );

    job.destinationFileId = String(uploadResult?.id || uploadResult?._id || uploadResult?.messageId || finalArchiveName);
    invalidateDriveCache(accountId);
    recordAuditEvent('archive_zip_created', {
      userId: p.userId ? String(p.userId) : null,
      accountId,
      archiveName: finalArchiveName,
      entryCount: entries.length,
      archiveBytes: zipStat.size,
    });
    return { destinationFileId: job.destinationFileId, archiveName: finalArchiveName, entryCount: entries.length, archiveBytes: zipStat.size };
  } finally {
    try { await fs.promises.unlink(tmpZipPath); } catch { /* ignore */ }
  }
}

interface ParsedZipEntryMeta {
  entry: yauzlType.Entry;
  dirPath: string;
  fileName: string;
  uncompressedSize: number;
}

export async function executeArchiveUnzipJob(
  job: any,
  database: any,
  shouldCancel: () => Promise<boolean>,
  deps: {
    ensureTargetFolderPath: (database: any, targetAccount: any, baseFolderId: string, relativeFolderPath: string, folderCache: Map<string, string>) => Promise<string>;
    resolveNonConflictingFileName: (database: any, account: any, folderId: string, desiredName: string, conflictStrategy: any) => Promise<{ resolvedName: string; conflictDetected: boolean; skipped: boolean }>;
  }
) {
  const p = job.payload || {};
  const accountId = String(p.accountId || '');
  const fileId = String(p.fileId || '');
  const targetFolderId = String(p.targetFolderId || 'root');
  const conflictStrategy = p.conflictStrategy === 'skip' || p.conflictStrategy === 'overwrite' || p.conflictStrategy === 'rename'
    ? p.conflictStrategy
    : 'rename';

  const { account, accessDenied } = await resolveAuthorizedAccount(database, accountId, p.userId, !!p.isAdmin);
  if (accessDenied || !account) throw new Error('Storage account is not accessible');

  await database.collection('jobs').updateOne(
    { _id: job._id, status: 'running' },
    { $set: { stage: 'downloading_archive', progressPct: 5, leaseUntil: new Date(Date.now() + JOB_LEASE_MS), updatedAt: new Date() } }
  );

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const tmpZipPath = resolveInsideTempDir(`unzip_src_${String(job._id)}_${nanoid(8)}.zip`);

  try {
    await downloadFileToTemp(database, account, fileId, tmpZipPath, p.userId, !!p.isAdmin, shouldCancel);

    await database.collection('jobs').updateOne(
      { _id: job._id, status: 'running' },
      { $set: { stage: 'inspecting_archive', progressPct: 15, leaseUntil: new Date(Date.now() + JOB_LEASE_MS), updatedAt: new Date() } }
    );

    const zipFile = await new Promise<yauzlType.ZipFile>((resolve, reject) => {
      yauzl.open(tmpZipPath, { lazyEntries: true, autoClose: false }, (err, zf) => {
        if (err || !zf) reject(err || new Error('Unable to open ZIP archive'));
        else resolve(zf);
      });
    });

    try {
      const validEntries: ParsedZipEntryMeta[] = [];
      let totalUncompressed = 0;

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          zipFile.off('entry', onEntry);
          zipFile.off('end', onEnd);
          zipFile.off('error', onError);
        };
        const onError = (err: any) => { cleanup(); reject(err); };
        const onEnd = () => { cleanup(); resolve(); };
        const onEntry = (entry: yauzlType.Entry) => {
          const rawName = String(entry.fileName || '');
          // Skip directory entries
          if (rawName.endsWith('/') || rawName.endsWith('\\')) {
            zipFile.readEntry();
            return;
          }
          const normalized = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
          if (hasPathTraversal(normalized)) {
            zipFile.readEntry();
            return;
          }
          const segments = normalized.split('/').filter((s) => s.length > 0 && s !== '.');
          if (segments.length === 0) {
            zipFile.readEntry();
            return;
          }
          const lastSeg = segments[segments.length - 1];
          if (segments[0] === '__MACOSX' || lastSeg === '.DS_Store' || lastSeg.startsWith('._')) {
            zipFile.readEntry();
            return;
          }
          if (validEntries.length >= MAX_UNZIP_ENTRIES) {
            cleanup();
            reject(new Error(`ZIP archive exceeds limit of ${MAX_UNZIP_ENTRIES} files`));
            return;
          }

          const uncompressedSize = Number(entry.uncompressedSize || 0);
          const compressedSize = Number(entry.compressedSize || 0);
          if (
            uncompressedSize > RATIO_CHECK_MIN_BYTES &&
            compressedSize > 0 &&
            uncompressedSize / compressedSize > MAX_ZIP_COMPRESSION_RATIO
          ) {
            cleanup();
            reject(Object.assign(new Error('ZIP archive rejected due to abnormal compression ratio'), { code: 'SUSPICIOUS_ARCHIVE_DETECTED' }));
            return;
          }

          totalUncompressed += uncompressedSize;
          if (totalUncompressed > MAX_UNZIP_TOTAL_BYTES) {
            cleanup();
            reject(new Error('Extracted ZIP size exceeds 4 GiB safety limit'));
            return;
          }

          const dirSegments = segments.slice(0, -1).map((s) => sanitizeArchiveSegment(s, 'folder')).filter(Boolean);
          const safeFile = sanitizeArchiveSegment(lastSeg, 'file');
          validEntries.push({
            entry,
            dirPath: dirSegments.join('/'),
            fileName: safeFile,
            uncompressedSize,
          });
          zipFile.readEntry();
        };

        zipFile.on('entry', onEntry);
        zipFile.once('end', onEnd);
        zipFile.once('error', onError);
        zipFile.readEntry();
      });

      if (validEntries.length === 0) {
        throw new Error('ZIP archive contains no extractable files');
      }
      if (!hasTempDiskHeadroom(Math.max(0, ...validEntries.map((v) => v.uncompressedSize)))) {
        throw Object.assign(new Error('Server temporary storage is too low to extract files'), {
          code: STANDARD_ERROR_CODES.INSUFFICIENT_STORAGE,
        });
      }

      job.totalItems = validEntries.length;
      job.totalBytes = totalUncompressed;
      job.itemsProcessed = 0;
      job.bytesProcessed = 0;

      await database.collection('jobs').updateOne(
        { _id: job._id, status: 'running' },
        {
          $set: {
            stage: `extracting_0_of_${validEntries.length}`,
            totalItems: validEntries.length,
            totalBytes: totalUncompressed,
            itemsProcessed: 0,
            bytesProcessed: 0,
            progressPct: 20,
            leaseUntil: new Date(Date.now() + JOB_LEASE_MS),
            updatedAt: new Date(),
          },
        }
      );

      const folderCache = new Map<string, string>();
      let processedBytes = 0;
      let extractedBytesGuard = 0;
      let failedCount = 0;

      for (let i = 0; i < validEntries.length; i++) {
        if (await shouldCancel()) {
          throw Object.assign(new Error('Unzip job cancelled'), { code: 'JOB_CANCELLED' });
        }

        const item = validEntries[i];
        const destFolderId = item.dirPath
          ? await deps.ensureTargetFolderPath(database, account, targetFolderId, item.dirPath, folderCache)
          : (targetFolderId || 'root');

        const tmpEntryPath = resolveInsideTempDir(`unzip_entry_${String(job._id)}_${i}_${nanoid(6)}`);
        try {
          const readStream = await new Promise<Readable>((resolve, reject) => {
            zipFile.openReadStream(item.entry, (err, rs) => {
              if (err || !rs) reject(err || new Error(`Failed to read ZIP entry ${item.fileName}`));
              else resolve(rs);
            });
          });

          let entryActualBytes = 0;
          const byteGuard = new stream.Transform({
            transform(chunk, _enc, cb) {
              entryActualBytes += chunk.length;
              extractedBytesGuard += chunk.length;
              if (extractedBytesGuard > MAX_UNZIP_TOTAL_BYTES) {
                cb(new Error('Extracted ZIP size exceeded safety cap'));
                return;
              }
              cb(null, chunk);
            },
          });
          await stream.promises.pipeline(readStream, byteGuard, fs.createWriteStream(tmpEntryPath));

          const resolution = await deps.resolveNonConflictingFileName(
            database,
            account,
            destFolderId || 'root',
            item.fileName,
            conflictStrategy
          );
          if (!resolution.skipped) {
            await uploadFileToProvider(
              account,
              String(account._id),
              {
                path: tmpEntryPath,
                size: entryActualBytes,
                originalname: resolution.resolvedName,
                mimetype: 'application/octet-stream',
              },
              destFolderId || 'root',
              undefined,
              undefined,
              `unzip_job_${String(job._id)}_${i}`,
              undefined,
              String(p.userId || account.userId || '')
            );
          }

          processedBytes += entryActualBytes;
        } catch (entryErr: any) {
          if (entryErr?.code === 'JOB_CANCELLED') throw entryErr;
          failedCount++;
          console.warn(`[Unzip Job ${job._id}] Failed entry ${item.dirPath ? `${item.dirPath}/` : ''}${item.fileName}:`, entryErr?.message);
        } finally {
          try { await fs.promises.unlink(tmpEntryPath); } catch { /* ignore */ }
        }

        job.itemsProcessed = i + 1;
        job.bytesProcessed = processedBytes;
        job.failedCount = failedCount;
        const pct = Math.min(98, 20 + Math.round(((i + 1) / validEntries.length) * 78));
        await database.collection('jobs').updateOne(
          { _id: job._id, status: 'running' },
          {
            $set: {
              stage: `extracting_${i + 1}_of_${validEntries.length}`,
              itemsProcessed: i + 1,
              bytesProcessed: processedBytes,
              failedCount,
              progressPct: pct,
              leaseUntil: new Date(Date.now() + JOB_LEASE_MS),
              updatedAt: new Date(),
            },
          }
        );
      }

      if (failedCount === validEntries.length) {
        throw new Error('All entries in the ZIP archive failed to extract or upload');
      }

      invalidateDriveCache(accountId);
      recordAuditEvent('archive_unzipped', {
        userId: p.userId ? String(p.userId) : null,
        accountId,
        sourceFileId: fileId,
        extractedCount: validEntries.length - failedCount,
        failedCount,
      });

      return { extractedCount: validEntries.length - failedCount, failedCount, totalEntries: validEntries.length };
    } finally {
      try { zipFile.close(); } catch { /* ignore */ }
    }
  } finally {
    try { await fs.promises.unlink(tmpZipPath); } catch { /* ignore */ }
  }
}

export function registerArchiveRoutes(
  app: any,
  deps: {
    bot: any;
    enqueueTransferJob: (database: any, payload: any, jobType: any) => Promise<any>;
    publicJob: (job: any) => any;
    collectAccountManifest: (database: any, account: any, rootFolderId?: string, maxFiles?: number, includeNoteContent?: boolean) => Promise<any>;
    runJobWorker?: () => Promise<void>;
  }
) {
  // 1. Issue a single-use short-lived streaming ZIP download ticket (no query tokens exposed)
  app.post('/api/archive/zip-ticket', requireAuth, async (req: any, res: any) => {
    const database = req.db || db || await connectToMongo();
    const { accountId, fileIds, folderIds, archiveName } = req.body || {};
    const cleanAccountId = String(accountId || '').trim();
    if (!cleanAccountId) {
      return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'accountId is required', req.requestId);
    }

    const rawFiles = Array.isArray(fileIds) ? fileIds.map(String).filter(Boolean) : [];
    const rawFolders = Array.isArray(folderIds) ? folderIds.map(String).filter(Boolean) : [];
    if (rawFiles.length === 0 && rawFolders.length === 0) {
      return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Select at least one file or folder to zip', req.requestId);
    }

    const { account, accessDenied } = await resolveAuthorizedAccount(database, cleanAccountId, req.userId, !!req.isAdmin);
    if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
    if (!account) return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);

    if (account.accountType === 'tgdrive') {
      const channelAccess = await checkTgChannelAccess(account.channelId, deps.bot);
      if (!channelAccess.ok) {
        return apiError(res, 403, 'TG_CHANNEL_ACCESS_DENIED', channelAccess.message || formatTgChannelError(new Error('CHANNEL_INVALID'), account.channelId), req.requestId);
      }
    }

    try {
      const { entries, totalBytes, skippedEncryptedCount } = await collectArchiveSelectionEntries(
        database,
        account,
        rawFiles,
        rawFolders,
        req.userId,
        !!req.isAdmin,
        deps.collectAccountManifest
      );
      if (entries.length === 0) {
        return apiError(
          res,
          skippedEncryptedCount > 0 ? 422 : 404,
          skippedEncryptedCount > 0 ? 'ENCRYPTED_OPERATION_UNSUPPORTED' : STANDARD_ERROR_CODES.NOT_FOUND,
          skippedEncryptedCount > 0
            ? 'Encrypted CYTE1 files cannot be archived on the server'
            : 'No downloadable files found in selection',
          req.requestId
        );
      }

      const rawArchiveName = normalizeSafeFilename(archiveName || 'archive.zip', 'archive.zip');
      const finalArchiveName = rawArchiveName.toLowerCase().endsWith('.zip') ? rawArchiveName : `${rawArchiveName}.zip`;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 300 * 1000);
      const ticket = `dlt_${nanoid(32)}`;

      await database.collection('download_tickets').insertOne({
        ticket,
        kind: 'archive_zip',
        userId: req.userId ? String(req.userId) : null,
        isAdmin: Boolean(req.isAdmin),
        accountId: String(account._id),
        archiveName: finalArchiveName,
        entries: entries.map((e) => ({ fileId: e.fileId, entryPath: e.entryPath, sizeBytes: e.sizeBytes })),
        totalBytes,
        singleUse: true,
        usedCount: 0,
        revoked: false,
        createdAt: now,
        expiresAt,
      });

      recordAuditEvent('archive_zip_ticket_created', {
        userId: req.userId ? String(req.userId) : null,
        accountId: String(account._id),
        entryCount: entries.length,
        totalBytes,
      });

      const envBase = (process.env.APP_URL || '').replace(/\/$/, '');
      const reqHost = req.get('host');
      const resolvedBaseUrl = envBase || (reqHost ? `${req.protocol}://${reqHost}` : '');
      const downloadPath = `/api/archive/zip/${encodeURIComponent(ticket)}`;
      return res.status(201).json({
        ticket,
        downloadPath,
        downloadUrl: `${resolvedBaseUrl}${downloadPath}`,
        archiveName: finalArchiveName,
        entryCount: entries.length,
        totalBytes,
        skippedEncryptedCount,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err: any) {
      return apiError(
        res,
        err?.status || 500,
        err?.code || STANDARD_ERROR_CODES.INTERNAL_ERROR,
        err?.message || 'Failed to prepare ZIP download',
        req.requestId
      );
    }
  });

  // 2. Stream ZIP archive directly to client using single-use ticket
  async function handleArchiveZipStream(req: any, res: any, isHead = false) {
    const database = db || await connectToMongo();
    const ticket = String(req.params.ticket || '').trim();
    if (!/^dlt_[A-Za-z0-9_-]{8,128}$/.test(ticket)) {
      return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Archive ticket is invalid or revoked', req.requestId);
    }

    const doc = isHead
      ? await database.collection('download_tickets').findOne({ ticket, kind: 'archive_zip' })
      : await (async () => {
          const r: any = await database.collection('download_tickets').findOneAndUpdate(
            {
              ticket,
              kind: 'archive_zip',
              revoked: { $ne: true },
              expiresAt: { $gt: new Date() },
              usedCount: { $lt: 1 },
            },
            { $inc: { usedCount: 1 }, $set: { lastUsedAt: new Date() } },
            { returnDocument: 'after' }
          );
          return r?.value ?? r;
        })();

    if (!doc || doc.revoked || doc.kind !== 'archive_zip') {
      return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Archive ticket is invalid, expired, or already used', req.requestId);
    }
    if (doc.expiresAt && new Date(doc.expiresAt).getTime() <= Date.now()) {
      return apiError(res, 410, STANDARD_ERROR_CODES.NOT_FOUND, 'Archive ticket has expired', req.requestId);
    }

    const archiveName = normalizeSafeFilename(doc.archiveName || 'archive.zip', 'archive.zip');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', buildSafeContentDisposition('attachment', archiveName));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (isHead) return res.status(200).end();

    const account = ObjectId.isValid(String(doc.accountId))
      ? await database.collection('accounts').findOne({ _id: new ObjectId(String(doc.accountId)) })
      : null;
    if (!account) {
      return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);
    }

    let clientClosed = false;
    const archive = new ZipArchive({ zlib: { level: 6 } });
    req.on('close', () => {
      if (!res.writableEnded) {
        clientClosed = true;
        try { archive.abort(); } catch { /* ignore */ }
      }
    });
    archive.on('error', (err: any) => {
      console.error('[Archive Stream] ZIP error:', err);
      if (!res.headersSent) {
        apiError(res, 500, STANDARD_ERROR_CODES.INTERNAL_ERROR, 'Failed while streaming ZIP archive', req.requestId);
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    });
    archive.pipe(res);

    try {
      const entries: ArchiveSourceEntry[] = Array.isArray(doc.entries) ? doc.entries : [];
      for (const entry of entries) {
        if (clientClosed) break;
        const readStream = await openProviderFileReadStream(
          database,
          account,
          entry,
          doc.userId,
          Boolean(doc.isAdmin),
          () => clientClosed
        );
        await waitForEntryStreamAppended(archive, readStream, entry.entryPath);
      }
      if (!clientClosed) {
        await archive.finalize();
      }
    } catch (err: any) {
      console.error('[Archive Stream] Failed:', err);
      if (!res.headersSent) {
        return apiError(res, 502, STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Failed to stream ZIP archive', req.requestId);
      }
      try { res.end(); } catch { /* ignore */ }
    }
  }

  app.head('/api/archive/zip/:ticket', (req: any, res: any) => handleArchiveZipStream(req, res, true));
  app.get('/api/archive/zip/:ticket', (req: any, res: any) => handleArchiveZipStream(req, res, false));

  // 3. Server-side Zip to Cloud (background job)
  app.post('/api/archive/zip', requireAuth, async (req: any, res: any) => {
    const database = req.db || db || await connectToMongo();
    const { accountId, fileIds, folderIds, targetFolderId = 'root', archiveName } = req.body || {};
    const cleanAccountId = String(accountId || '').trim();
    if (!cleanAccountId) {
      return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'accountId is required', req.requestId);
    }

    const rawFiles = Array.isArray(fileIds) ? fileIds.map(String).filter(Boolean) : [];
    const rawFolders = Array.isArray(folderIds) ? folderIds.map(String).filter(Boolean) : [];
    if (rawFiles.length === 0 && rawFolders.length === 0) {
      return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Select at least one file or folder to zip', req.requestId);
    }

    const folderCheck = validateSafeFolderId(targetFolderId);
    if (!folderCheck.ok) {
      return apiError(res, folderCheck.error.status, folderCheck.error.code, folderCheck.error.message, req.requestId);
    }

    const { account, accessDenied } = await resolveAuthorizedAccount(database, cleanAccountId, req.userId, !!req.isAdmin);
    if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
    if (!account) return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);

    if (account.accountType === 'tgdrive') {
      const channelAccess = await checkTgChannelAccess(account.channelId, deps.bot);
      if (!channelAccess.ok) {
        return apiError(res, 403, 'TG_CHANNEL_ACCESS_DENIED', channelAccess.message || formatTgChannelError(new Error('CHANNEL_INVALID'), account.channelId), req.requestId);
      }
    }

    const safeName = normalizeSafeFilename(archiveName || `archive_${Date.now()}.zip`, `archive_${Date.now()}.zip`);
    const finalName = safeName.toLowerCase().endsWith('.zip') ? safeName : `${safeName}.zip`;
    const driveLabel = account.name || account.email || 'Drive';

    try {
      const job = await deps.enqueueTransferJob(
        database,
        {
          accountId: cleanAccountId,
          sourceAccountId: cleanAccountId,
          targetAccountId: cleanAccountId,
          sourceAccountName: driveLabel,
          targetAccountName: driveLabel,
          fileIds: rawFiles,
          folderIds: rawFolders,
          targetFolderId: folderCheck.folderId || 'root',
          archiveName: finalName,
          fileName: finalName,
          displayName: finalName,
          userId: req.userId ? String(req.userId) : null,
          isAdmin: !!req.isAdmin,
          priority: 2,
        },
        'archive_zip_to_cloud'
      );
      deps.runJobWorker?.().catch(() => {});
      return res.status(202).json({ success: true, job: deps.publicJob(job) });
    } catch (err: any) {
      return apiError(res, err?.status || 500, err?.code || STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Failed to queue ZIP job', req.requestId);
    }
  });

  // 4. Server-side Unzip in Cloud (background job)
  app.post('/api/archive/unzip', requireAuth, async (req: any, res: any) => {
    const database = req.db || db || await connectToMongo();
    const { accountId, fileId, targetFolderId = 'root', conflictStrategy = 'rename' } = req.body || {};
    const cleanAccountId = String(accountId || '').trim();
    const cleanFileId = String(fileId || '').trim();
    if (!cleanAccountId || !cleanFileId || !isSafeProviderItemId(cleanFileId)) {
      return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Valid accountId and fileId are required', req.requestId);
    }

    const folderCheck = validateSafeFolderId(targetFolderId);
    if (!folderCheck.ok) {
      return apiError(res, folderCheck.error.status, folderCheck.error.code, folderCheck.error.message, req.requestId);
    }

    const { account, accessDenied } = await resolveAuthorizedAccount(database, cleanAccountId, req.userId, !!req.isAdmin);
    if (accessDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this account', req.requestId);
    if (!account) return apiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found', req.requestId);

    if (account.accountType === 'tgdrive') {
      const channelAccess = await checkTgChannelAccess(account.channelId, deps.bot);
      if (!channelAccess.ok) {
        return apiError(res, 403, 'TG_CHANNEL_ACCESS_DENIED', channelAccess.message || formatTgChannelError(new Error('CHANNEL_INVALID'), account.channelId), req.requestId);
      }
    }

    const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, account, cleanFileId, req.userId, !!req.isAdmin);
    if (fileDenied) return apiError(res, 403, 'ACCOUNT_ACCESS_DENIED', 'Access denied to this file', req.requestId);
    if (account.accountType === 'tgdrive' && !meta) {
      return apiError(res, 404, STANDARD_ERROR_CODES.NOT_FOUND, 'Archive file not found', req.requestId);
    }
    if (meta?.isEncrypted) {
      return apiError(res, 422, 'ENCRYPTED_OPERATION_UNSUPPORTED', 'Encrypted CYTE1 files cannot be unzipped on the server', req.requestId);
    }

    const displayName = normalizeSafeFilename(meta?.name || req.body?.fileName || 'archive.zip', 'archive.zip');
    const driveLabel = account.name || account.email || 'Drive';
    const strategy = conflictStrategy === 'skip' || conflictStrategy === 'overwrite' || conflictStrategy === 'rename'
      ? conflictStrategy
      : 'rename';

    try {
      const job = await deps.enqueueTransferJob(
        database,
        {
          accountId: cleanAccountId,
          sourceAccountId: cleanAccountId,
          targetAccountId: cleanAccountId,
          sourceAccountName: driveLabel,
          targetAccountName: driveLabel,
          fileId: cleanFileId,
          targetFolderId: folderCheck.folderId || 'root',
          conflictStrategy: strategy,
          fileName: displayName,
          displayName,
          userId: req.userId ? String(req.userId) : null,
          isAdmin: !!req.isAdmin,
          priority: 2,
        },
        'archive_unzip'
      );
      deps.runJobWorker?.().catch(() => {});
      return res.status(202).json({ success: true, job: deps.publicJob(job) });
    } catch (err: any) {
      return apiError(res, err?.status || 500, err?.code || STANDARD_ERROR_CODES.INTERNAL_ERROR, err?.message || 'Failed to queue unzip job', req.requestId);
    }
  });
}
