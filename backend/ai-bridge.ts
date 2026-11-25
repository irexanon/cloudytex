import fs from 'fs';
import path from 'path';
import net from 'net';
import http from 'http';
import https from 'https';
import dns from 'dns/promises';
import axios from 'axios';
import express from 'express';

import {
  validateUploadRequest,
  validatePlaintextFilename,
  validateSafeFolderId,
  normalizeSafeFilename,
  sniffMagicMimeType,
  isSafeProviderItemId,
  escapeDriveQueryValue,
} from './protocol.ts';

import {
  TEMP_DIR,
  STANDARD_ERROR_CODES,
  systemMetrics,
  recordAuditEvent,
  acquireUserUploadSlot,
  providerLimit,
  apiError,
  hasTempDiskHeadroom,
  driveCache,
  invalidateDriveCache,
  nanoid,
  escapeRegex,
  requireAuth,
} from './core.ts';

import {
  checkTgChannelAccess,
  getDriveClient,
  getOneDriveClient,
  resolveAuthorizedAccount,
  resolveFileMetadataForAccount,
  normaliseTgFile,
  getAccountQuota,
  computeSingleAccountStorageSummary,
  uploadFileToProvider,
  permanentlyDeleteSingleFile,
} from './provider.ts';

import { crossAccountTransfer } from './jobs.ts';

const MAX_TEXT_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_URL_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MiB
const MAX_BATCH_MOVE_ITEMS = 50;
const MAX_URL_REDIRECTS = 3;
const URL_FETCH_TIMEOUT_MS = 60_000;

export interface AiBridgeDeps {
  getBot: () => any;
}

type ToolScope = 'read' | 'write' | 'delete' | 'share';

interface AiToolDefinition {
  name: string;
  description: string;
  requiredScope: ToolScope;
  inputSchema: Record<string, any>;
}

// ─── SSRF-Hardened External URL Validator & Fetcher ───────────────────────────

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out * 256) + n;
  }
  return out >>> 0;
}

function isDisallowedIpv4(ip: string): boolean {
  const n = ipv4ToUint32(ip);
  if (n === null) return true;
  const o1 = (n >>> 24) & 0xff;
  const o2 = (n >>> 16) & 0xff;
  const o3 = (n >>> 8) & 0xff;

  if (o1 === 0) return true; // 0.0.0.0/8 ("this network")
  if (o1 === 10) return true; // 10.0.0.0/8 RFC1918
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return true; // 100.64.0.0/10 CGNAT
  if (o1 === 127) return true; // 127.0.0.0/8 loopback
  if (o1 === 169 && o2 === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16.0.0/12 RFC1918
  if (o1 === 192 && o2 === 0 && o3 === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (o1 === 192 && o2 === 0 && o3 === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (o1 === 192 && o2 === 168) return true; // 192.168.0.0/16 RFC1918
  if (o1 === 198 && (o2 === 18 || o2 === 19)) return true; // 198.18.0.0/15 benchmarking
  if (o1 === 198 && o2 === 51 && o3 === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (o1 === 203 && o2 === 0 && o3 === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (o1 >= 224) return true; // 224.0.0.0/4 multicast & reserved
  return false;
}

function isDisallowedIp(rawIp: string): boolean {
  const ip = String(rawIp || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const ipVersion = net.isIP(ip);
  if (ipVersion === 4) return isDisallowedIpv4(ip);
  if (ipVersion !== 6) return true;

  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/i.test(ip) || /^fe[89ab][0-9a-f]$/i.test(ip)) return true; // fe80::/10 link-local
  if (ip.startsWith('ff')) return true; // ff00::/8 multicast

  const mappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedMatch) return isDisallowedIpv4(mappedMatch[1]);
  if (ip.startsWith('::ffff:')) {
    // Hex-encoded IPv4-mapped address e.g. ::ffff:7f00:1
    const hexPart = ip.slice('::ffff:'.length);
    const groups = hexPart.split(':');
    if (groups.length === 2) {
      const hi = parseInt(groups[0], 16);
      const lo = parseInt(groups[1], 16);
      if (Number.isInteger(hi) && Number.isInteger(lo)) {
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isDisallowedIpv4(ipv4);
      }
    }
    return true;
  }
  return false;
}

async function resolveAndValidateExternalUrl(rawUrl: string): Promise<{
  parsed: URL;
  pinnedAddresses: Array<{ address: string; family: 4 | 6 }>;
}> {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw Object.assign(new Error('Invalid URL format'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error('Only http:// and https:// URLs are allowed'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error('URLs with embedded credentials are not allowed'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw Object.assign(new Error('Private or internal hostnames are not allowed'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
  }

  const literalFamily = net.isIP(host);
  if (literalFamily) {
    if (isDisallowedIp(host)) {
      throw Object.assign(new Error('Target IP address is private or reserved'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
    }
    return { parsed, pinnedAddresses: [{ address: host, family: literalFamily as 4 | 6 }] };
  }

  let lookedUp: Array<{ address: string; family: number }>;
  try {
    lookedUp = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error(`Unable to resolve hostname '${host}'`), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
  }

  if (!Array.isArray(lookedUp) || lookedUp.length === 0) {
    throw Object.assign(new Error(`No DNS records found for '${host}'`), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
  }

  const pinnedAddresses: Array<{ address: string; family: 4 | 6 }> = [];
  for (const rec of lookedUp) {
    if (isDisallowedIp(rec.address)) {
      throw Object.assign(new Error('Resolved target IP is private, loopback, or reserved'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
    }
    pinnedAddresses.push({ address: rec.address, family: (rec.family === 6 ? 6 : 4) });
  }
  return { parsed, pinnedAddresses };
}

function buildPinnedLookup(pinnedAddresses: Array<{ address: string; family: 4 | 6 }>) {
  return (_hostname: string, options: any, callback: any) => {
    const cb = typeof options === 'function' ? options : callback;
    const all = typeof options === 'object' && options && Boolean(options.all);
    if (all) {
      return cb(null, pinnedAddresses);
    }
    const preferredFamily = typeof options === 'object' && options ? options.family : 0;
    const chosen = pinnedAddresses.find((a) => !preferredFamily || a.family === preferredFamily) || pinnedAddresses[0];
    return cb(null, chosen.address, chosen.family);
  };
}

function inferFileNameFromUrlAndHeaders(parsedUrl: URL, contentDisposition?: string, contentType?: string, explicitName?: string): string {
  if (typeof explicitName === 'string' && explicitName.trim()) {
    return normalizeSafeFilename(explicitName.trim());
  }
  if (typeof contentDisposition === 'string') {
    const utfMatch = contentDisposition.match(/filename\*=UTF-8''([^;\r\n]+)/i);
    const basicMatch = contentDisposition.match(/filename="?([^";\r\n]+)"?/i);
    const rawHeaderName = utfMatch?.[1] ? decodeURIComponent(utfMatch[1]) : basicMatch?.[1];
    if (rawHeaderName && rawHeaderName.trim()) {
      return normalizeSafeFilename(path.basename(rawHeaderName.trim()));
    }
  }
  const pathBase = path.basename(decodeURIComponent(parsedUrl.pathname || '')).trim();
  if (pathBase && pathBase !== '/' && pathBase !== '.') {
    return normalizeSafeFilename(pathBase);
  }
  const extMap: Record<string, string> = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3',
    'application/zip': '.zip',
    'application/json': '.json',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'text/csv': '.csv',
    'text/html': '.html',
  };
  const cleanMime = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = extMap[cleanMime] || '.bin';
  return `downloaded_${Date.now()}${ext}`;
}

function inferMimeTypeFromFilename(name: string, fallback = 'application/octet-stream'): string {
  const ext = String(name || '').split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    markdown: 'text/markdown; charset=utf-8',
    json: 'application/json; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    html: 'text/html; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    yaml: 'text/yaml; charset=utf-8',
    yml: 'text/yaml; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    ts: 'text/typescript; charset=utf-8',
    py: 'text/x-python; charset=utf-8',
    log: 'text/plain; charset=utf-8',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    zip: 'application/zip',
  };
  return map[ext] || fallback;
}

function buildSafeTempFilePath(prefix: string): string {
  const resolvedBase = path.resolve(TEMP_DIR);
  if (!fs.existsSync(resolvedBase)) {
    fs.mkdirSync(resolvedBase, { recursive: true });
  }
  const filePath = path.resolve(resolvedBase, `${prefix}_${Date.now()}_${nanoid(8)}.tmp`);
  if (!filePath.startsWith(resolvedBase + path.sep)) {
    throw new Error('Invalid temp path');
  }
  return filePath;
}

async function downloadPublicUrlToTempFile(
  rawUrl: string,
  explicitFileName?: string
): Promise<{ tempPath: string; fileName: string; mimeType: string; sizeBytes: number; finalUrl: string }> {
  let currentUrl = rawUrl;
  let response: any = null;
  let finalParsedUrl!: URL;

  for (let hop = 0; hop <= MAX_URL_REDIRECTS; hop++) {
    const { parsed, pinnedAddresses } = await resolveAndValidateExternalUrl(currentUrl);
    finalParsedUrl = parsed;
    const pinnedLookup = buildPinnedLookup(pinnedAddresses);

    const res = await axios.get(parsed.toString(), {
      responseType: 'stream',
      timeout: URL_FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      httpAgent: new http.Agent({ keepAlive: false, lookup: pinnedLookup as any }),
      httpsAgent: new https.Agent({ keepAlive: false, lookup: pinnedLookup as any }),
      headers: {
        'User-Agent': 'Cloudyte-Fetcher/1.0',
      },
    });

    if (res.status >= 300 && res.status < 400) {
      res.data?.destroy?.();
      const loc = res.headers?.location;
      if (!loc || hop >= MAX_URL_REDIRECTS) {
        throw Object.assign(new Error('Too many redirects or invalid redirect target'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
      }
      currentUrl = new URL(String(loc), parsed).toString();
      continue;
    }

    response = res;
    break;
  }

  if (!response) {
    throw Object.assign(new Error('Failed to fetch URL'), { status: 502, code: STANDARD_ERROR_CODES.PROVIDER_ERROR });
  }

  const contentLengthHeader = Number(response.headers?.['content-length'] || 0);
  if (Number.isFinite(contentLengthHeader) && contentLengthHeader > MAX_URL_UPLOAD_BYTES) {
    response.data?.destroy?.();
    throw Object.assign(new Error(`Remote file exceeds maximum allowed size (${Math.round(MAX_URL_UPLOAD_BYTES / (1024 * 1024))} MB)`), {
      status: 413,
      code: STANDARD_ERROR_CODES.BAD_REQUEST,
    });
  }
  if (!hasTempDiskHeadroom(contentLengthHeader || 0)) {
    response.data?.destroy?.();
    throw Object.assign(new Error('Server temporary storage is too low for this URL upload'), {
      status: 507,
      code: STANDARD_ERROR_CODES.INSUFFICIENT_STORAGE,
    });
  }

  const contentTypeRaw = String(response.headers?.['content-type'] || '').split(';')[0].trim() || 'application/octet-stream';
  const fileName = inferFileNameFromUrlAndHeaders(
    finalParsedUrl,
    response.headers?.['content-disposition'],
    contentTypeRaw,
    explicitFileName
  );
  const nameErr = validatePlaintextFilename(fileName);
  if (!nameErr.ok) {
    response.data?.destroy?.();
    throw Object.assign(new Error(nameErr.error.message), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
  }

  const tempPath = buildSafeTempFilePath('aiurl');
  let receivedBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(tempPath);
      const rs = response.data;
      let settled = false;

      const fail = (err: any) => {
        if (settled) return;
        settled = true;
        try { rs.destroy(); } catch { /* ignore */ }
        try { ws.destroy(); } catch { /* ignore */ }
        reject(err);
      };

      rs.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_URL_UPLOAD_BYTES) {
          fail(Object.assign(new Error(`Remote file exceeds ${Math.round(MAX_URL_UPLOAD_BYTES / (1024 * 1024))} MB limit`), {
            status: 413,
            code: STANDARD_ERROR_CODES.BAD_REQUEST,
          }));
        }
      });
      rs.on('error', fail);
      ws.on('error', fail);
      ws.on('finish', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      rs.pipe(ws);
    });
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
    throw err;
  }

  return {
    tempPath,
    fileName,
    mimeType: contentTypeRaw === 'application/octet-stream' ? inferMimeTypeFromFilename(fileName) : contentTypeRaw,
    sizeBytes: receivedBytes,
    finalUrl: finalParsedUrl.toString(),
  };
}

// ─── PAT Scope & Confinement Helpers ──────────────────────────────────────────

function checkTokenScope(req: any, requiredScope: ToolScope): { ok: boolean; error?: string } {
  const scopes: string[] | undefined = req.tokenScopes;
  if (!Array.isArray(scopes)) return { ok: true };
  if (scopes.includes(requiredScope) || scopes.includes('*')) return { ok: true };
  return { ok: false, error: `Personal access token missing required '${requiredScope}' scope` };
}

function checkTokenAccountConfinement(req: any, accountId?: string | null): { ok: boolean; error?: string } {
  const confinedAcc = req.tokenConfinement?.accountId;
  if (!confinedAcc) return { ok: true };
  if (!accountId || accountId === 'all') return { ok: true };
  if (String(accountId) !== String(confinedAcc)) {
    return { ok: false, error: 'Token is confined to a different storage account' };
  }
  return { ok: true };
}

function resolveConfinedFolderId(req: any, requestedFolderId?: string | null): { ok: boolean; folderId: string; error?: string } {
  const folderCheck = validateSafeFolderId(requestedFolderId);
  if (!folderCheck.ok) {
    return { ok: false, folderId: 'root', error: folderCheck.error.message };
  }
  const confinedRoot = req.tokenConfinement?.rootFolderId ? String(req.tokenConfinement.rootFolderId) : '';
  const cleanRequested = folderCheck.folderId === 'root' ? '' : folderCheck.folderId;

  if (confinedRoot) {
    if (!cleanRequested) {
      return { ok: true, folderId: confinedRoot };
    }
    if (cleanRequested !== confinedRoot && !cleanRequested.startsWith(`${confinedRoot}/`)) {
      return { ok: false, folderId: confinedRoot, error: `Token is confined to root folder '${confinedRoot}'` };
    }
    return { ok: true, folderId: cleanRequested };
  }
  return { ok: true, folderId: folderCheck.folderId || 'root' };
}

// ─── Shared Core Operations (Used by both REST /api/ai/* & MCP tools) ────────

async function executeListDrives(req: any, database: any) {
  const query: any = {};
  if (req.isAdmin) {
    // Allow admin to list their drives cleanly
    if (req.userId) query.userId = req.userId;
  } else {
    query.userId = req.userId;
  }
  const rawAccounts = await database.collection('accounts').find(query).toArray();
  const seen = new Map<string, boolean>();
  const unique = rawAccounts.filter((a: any) => {
    const key = a.accountType === 'tgdrive' ? `tgdrive:${a.channelId}` : (a.email || a._id.toString());
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });

  const confinedAccountId = req.tokenConfinement?.accountId ? String(req.tokenConfinement.accountId) : null;
  const scopedAccounts = confinedAccountId
    ? unique.filter((a: any) => a._id.toString() === confinedAccountId)
    : unique;

  return Promise.all(scopedAccounts.map(async (acc: any) => {
    if (acc.accountType === 'tgdrive') {
      const summary = await computeSingleAccountStorageSummary(acc, database).catch(() => ({ usedBytes: 0, fileCount: 0 }));
      return {
        id: acc._id.toString(),
        name: acc.name || 'TG Drive',
        accountType: 'tgdrive',
        email: acc.channelId,
        isForum: Boolean(acc.isForum),
        usage: `${((summary.usedBytes || 0) / (1024 ** 3)).toFixed(2)} GB`,
        total: '∞',
        fileCount: summary.fileCount || 0,
        isDefault: Boolean(acc.isDefault),
      };
    }
    try {
      const { quotaUsage, quotaLimit, displayName } = await getAccountQuota(acc, database);
      const usageNum = Number(quotaUsage) || 0;
      const limitNum = Number(quotaLimit) || 0;
      return {
        id: acc._id.toString(),
        name: displayName || acc.name || 'Drive',
        accountType: acc.accountType || 'google',
        email: acc.email || '',
        usage: `${(usageNum / (1024 ** 3)).toFixed(1)} GB`,
        total: limitNum > 1 ? `${(limitNum / (1024 ** 3)).toFixed(0)} GB` : '∞',
        isDefault: Boolean(acc.isDefault),
      };
    } catch {
      return {
        id: acc._id.toString(),
        name: acc.name || 'Disconnected',
        accountType: acc.accountType || 'google',
        email: acc.email || '',
        error: true,
        isDefault: Boolean(acc.isDefault),
      };
    }
  }));
}

async function executeListFiles(req: any, database: any, args: { accountId: string; folderId?: string; search?: string; limit?: number }) {
  const accConf = checkTokenAccountConfinement(req, args.accountId);
  if (!accConf.ok) throw Object.assign(new Error(accConf.error), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });

  const folderResolution = resolveConfinedFolderId(req, args.folderId);
  if (!folderResolution.ok) throw Object.assign(new Error(folderResolution.error), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });

  const { account, accessDenied } = await resolveAuthorizedAccount(database, args.accountId, req.userId, req.isAdmin);
  if (accessDenied) throw Object.assign(new Error('Access denied to this account'), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
  if (!account) throw Object.assign(new Error('Account not found'), { status: 404, code: STANDARD_ERROR_CODES.NOT_FOUND });

  const limit = Math.min(200, Math.max(1, Number(args.limit) || 100));
  const search = typeof args.search === 'string' ? args.search.trim() : '';

  if (account.accountType === 'tgdrive') {
    const currentFolder = folderResolution.folderId === 'root' ? '' : folderResolution.folderId;
    const fileFilter: any = { accountId: account._id, trashed: { $ne: true } };
    if (search) {
      fileFilter.name = new RegExp(escapeRegex(search), 'i');
      if (req.tokenConfinement?.rootFolderId) {
        const rootF = String(req.tokenConfinement.rootFolderId);
        fileFilter.$or = [{ folder: rootF }, { folder: new RegExp(`^${escapeRegex(rootF)}/`) }];
      }
    } else {
      fileFilter.folder = currentFolder;
    }

    const rawTgFiles = await database.collection('tg_files').find(fileFilter).sort({ date: -1, _id: -1 }).limit(limit).toArray();
    let folders: any[] = [];
    if (!search) {
      const escapedFolder = currentFolder ? escapeRegex(currentFolder) + '/' : '';
      const folderDocs = await database.collection('tg_folders').find({
        accountId: account._id,
        path: { $regex: `^${escapedFolder}[^/]+$` },
      }).toArray();
      folders = folderDocs.map((f: any) => ({
        id: `folder:${f.path}`,
        name: f.name,
        type: 'folder',
        folder: f.path,
        sizeBytes: 0,
      }));
    }
    const normalized = rawTgFiles.map((f: any) => {
      const item = normaliseTgFile(f, args.accountId);
      return {
        id: item.id,
        name: item.name,
        type: item.type,
        mimeType: item.mimeType,
        size: item.size,
        sizeBytes: item.sizeBytes,
        folder: f.folder || '',
        isEncrypted: item.isEncrypted,
      };
    });
    return { accountId: args.accountId, folderId: currentFolder || 'root', items: [...folders, ...normalized] };
  }

  if (account.accountType === 'onedrive') {
    const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
    let rawFiles: any[] = [];
    const confinedRoot = req.tokenConfinement?.rootFolderId ? String(req.tokenConfinement.rootFolderId) : '';
    if (search) {
      const cleanSearch = search.replace(/[\r\n\0]/g, '').replace(/'/g, "''");
      const searchBase = confinedRoot && confinedRoot !== 'root'
        ? `/me/drive/items/${encodeURIComponent(confinedRoot)}`
        : '/me/drive/root';
      const r = await c.api(`${searchBase}/search(q='${cleanSearch}')`).top(limit).get();
      rawFiles = r.value || [];
    } else {
      const fid = folderResolution.folderId || 'root';
      if (fid !== 'root' && !isSafeProviderItemId(fid)) {
        throw Object.assign(new Error('Invalid folder identifier'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
      }
      const itemPath = fid === 'root' ? '/me/drive/root' : `/me/drive/items/${fid}`;
      const r = await c.api(`${itemPath}/children`).top(limit).get();
      rawFiles = r.value || [];
    }
    const items = rawFiles.map((f: any) => ({
      id: f.id,
      name: f.name,
      type: f.folder ? 'folder' : 'file',
      mimeType: f.folder ? 'folder' : (f.file?.mimeType || 'application/octet-stream'),
      sizeBytes: Number(f.size) || 0,
      modifiedTime: f.lastModifiedDateTime,
    }));
    return { accountId: args.accountId, folderId: folderResolution.folderId, items };
  }

  // Google Drive
  const drive = await getDriveClient(account.tokens || account.credentials);
  const qParts = ['trashed = false'];
  const confinedRoot = req.tokenConfinement?.rootFolderId ? String(req.tokenConfinement.rootFolderId) : '';
  if (search) {
    qParts.push(`name contains '${escapeDriveQueryValue(search)}'`);
    if (confinedRoot && confinedRoot !== 'root') {
      qParts.push(`'${escapeDriveQueryValue(confinedRoot)}' in parents`);
    }
  } else {
    const fid = folderResolution.folderId || 'root';
    if (fid !== 'root' && !isSafeProviderItemId(fid)) {
      throw Object.assign(new Error('Invalid folder identifier'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
    }
    qParts.push(`'${escapeDriveQueryValue(fid)}' in parents`);
  }
  const list = await drive.files.list({
    pageSize: limit,
    q: qParts.join(' and '),
    fields: 'files(id,name,mimeType,size,modifiedTime)',
    orderBy: 'folder,name',
  });
  const items = (list.data.files || []).map((f: any) => ({
    id: f.id,
    name: f.name,
    type: f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
    mimeType: f.mimeType || 'application/octet-stream',
    sizeBytes: Number(f.size) || 0,
    modifiedTime: f.modifiedTime,
  }));
  return { accountId: args.accountId, folderId: folderResolution.folderId, items };
}

async function executeCreateFolder(
  req: any,
  database: any,
  bot: any,
  args: { accountId: string; name: string; parentId?: string }
) {
  const accConf = checkTokenAccountConfinement(req, args.accountId);
  if (!accConf.ok) throw Object.assign(new Error(accConf.error), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });

  const nameErr = validatePlaintextFilename(args.name);
  if (!nameErr.ok) throw Object.assign(new Error(nameErr.error.message), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });

  const folderResolution = resolveConfinedFolderId(req, args.parentId);
  if (!folderResolution.ok) throw Object.assign(new Error(folderResolution.error), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });

  const { account, accessDenied } = await resolveAuthorizedAccount(database, args.accountId, req.userId, req.isAdmin);
  if (accessDenied) throw Object.assign(new Error('Access denied to this account'), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
  if (!account) throw Object.assign(new Error('Account not found'), { status: 404, code: STANDARD_ERROR_CODES.NOT_FOUND });

  const name = args.name.trim();
  if (account.accountType === 'tgdrive') {
    const parentPath = folderResolution.folderId === 'root' ? '' : folderResolution.folderId;
    const folderPath = parentPath ? `${parentPath}/${name}` : name;
    let createdThreadId: number | null = null;
    if (account.isForum && !parentPath && bot?.telegram) {
      try {
        const topic = await bot.telegram.createForumTopic(account.channelId, name);
        if (topic && Number.isInteger(Number(topic.message_thread_id))) {
          createdThreadId = Number(topic.message_thread_id);
        }
      } catch { /* ignore forum topic creation fallback */ }
    }
    await database.collection('tg_folders').updateOne(
      { accountId: account._id, path: folderPath },
      {
        $set: {
          accountId: account._id,
          userId: String(req.userId || account.userId || ''),
          name,
          path: folderPath,
          ...(createdThreadId ? { threadId: createdThreadId } : {}),
          createdAt: Math.floor(Date.now() / 1000),
        },
      },
      { upsert: true }
    );
    invalidateDriveCache(args.accountId);
    return { success: true, folderId: `folder:${folderPath}`, path: folderPath, name };
  }

  const safeParent = folderResolution.folderId || 'root';
  if (safeParent !== 'root' && !isSafeProviderItemId(safeParent)) {
    throw Object.assign(new Error('Invalid parent folder identifier'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
  }
  if (account.accountType === 'onedrive') {
    const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
    const parentPath = safeParent === 'root' ? '/me/drive/root' : `/me/drive/items/${safeParent}`;
    const created = await c.api(`${parentPath}/children`).post({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' });
    invalidateDriveCache(args.accountId);
    return { success: true, folderId: created?.id || null, name: created?.name || name };
  }

  const drive = await getDriveClient(account.tokens || account.credentials);
  const created = await drive.files.create({
    requestBody: { name, parents: [safeParent], mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id,name',
  });
  invalidateDriveCache(args.accountId);
  return { success: true, folderId: created.data.id || null, name: created.data.name || name };
}

async function executeMoveOrCopySingleFile(
  req: any,
  database: any,
  args: { sourceAccountId: string; fileId: string; targetAccountId?: string; targetFolderId?: string; isMove: boolean }
) {
  const sourceAccId = String(args.sourceAccountId || '').trim();
  const targetAccId = String(args.targetAccountId || sourceAccId).trim();
  const fileId = String(args.fileId || '').trim();

  if (!isSafeProviderItemId(fileId)) {
    throw Object.assign(new Error('Invalid file identifier'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
  }
  const srcConf = checkTokenAccountConfinement(req, sourceAccId);
  if (!srcConf.ok) throw Object.assign(new Error(srcConf.error), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
  const dstConf = checkTokenAccountConfinement(req, targetAccId);
  if (!dstConf.ok) throw Object.assign(new Error(dstConf.error), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });

  const folderResolution = resolveConfinedFolderId(req, args.targetFolderId);
  if (!folderResolution.ok) throw Object.assign(new Error(folderResolution.error), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });

  const { account: sourceAccount, accessDenied: sourceDenied } = await resolveAuthorizedAccount(database, sourceAccId, req.userId, req.isAdmin);
  if (sourceDenied) throw Object.assign(new Error('Access denied to source account'), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
  if (!sourceAccount) throw Object.assign(new Error('Source account not found'), { status: 404, code: STANDARD_ERROR_CODES.NOT_FOUND });

  const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, sourceAccount, fileId, req.userId, req.isAdmin);
  if (fileDenied) throw Object.assign(new Error('Access denied to this file'), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });

  // If confined to rootFolderId on TG Drive, ensure source file is inside confined rootFolderId
  if (req.tokenConfinement?.rootFolderId && sourceAccount.accountType === 'tgdrive' && meta) {
    const confinedRoot = String(req.tokenConfinement.rootFolderId);
    const curFolder = String(meta.folder || '');
    if (curFolder !== confinedRoot && !curFolder.startsWith(`${confinedRoot}/`)) {
      throw Object.assign(new Error(`Source file is outside confined root folder '${confinedRoot}'`), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
    }
  }

  if (sourceAccId !== targetAccId) {
    const { account: targetAccount, accessDenied: targetDenied } = await resolveAuthorizedAccount(database, targetAccId, req.userId, req.isAdmin);
    if (targetDenied) throw Object.assign(new Error('Access denied to target account'), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
    if (!targetAccount) throw Object.assign(new Error('Target account not found'), { status: 404, code: STANDARD_ERROR_CODES.NOT_FOUND });

    await providerLimit(`transfer:${sourceAccId}:${targetAccId}`, 1)(() =>
      crossAccountTransfer(sourceAccId, fileId, targetAccId, folderResolution.folderId, req.userId, !!req.isAdmin, database, args.isMove)
    );
    invalidateDriveCache(sourceAccId);
    invalidateDriveCache(targetAccId);
    return { success: true, fileId, sourceAccountId: sourceAccId, targetAccountId: targetAccId, targetFolderId: folderResolution.folderId };
  }

  if (sourceAccount.accountType === 'tgdrive') {
    if (!meta) throw Object.assign(new Error('File not found'), { status: 404, code: STANDARD_ERROR_CODES.NOT_FOUND });
    const realTargetId = folderResolution.folderId === 'root' ? '' : folderResolution.folderId;
    if (args.isMove) {
      await database.collection('tg_files').updateOne({ _id: meta._id }, { $set: { folder: realTargetId, updatedAt: new Date() } });
    } else {
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
    }
    invalidateDriveCache(sourceAccId);
    return { success: true, fileId, targetFolderId: folderResolution.folderId };
  }

  const realTargetId = folderResolution.folderId || 'root';
  if (realTargetId !== 'root' && !isSafeProviderItemId(realTargetId)) {
    throw Object.assign(new Error('Invalid target folder identifier'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });
  }

  if (sourceAccount.accountType === 'google') {
    const drive = await getDriveClient(sourceAccount.tokens || sourceAccount.credentials);
    if (args.isMove) {
      const file = await drive.files.get({ fileId, fields: 'parents' });
      const previousParents = file.data.parents?.join(',') || '';
      await drive.files.update({ fileId, addParents: realTargetId, removeParents: previousParents, fields: 'id,parents' });
    } else {
      await drive.files.copy({
        fileId,
        requestBody: {
          parents: [realTargetId],
          ...(meta?.isEncrypted ? { name: meta.opaqueRemoteName || meta.name } : {}),
        },
        fields: 'id,name',
      });
    }
    invalidateDriveCache(sourceAccId);
    return { success: true, fileId, targetFolderId: realTargetId };
  }

  const c = await getOneDriveClient(sourceAccount.tokens || sourceAccount.credentials, sourceAccount._id.toString());
  const resolvedParentId = realTargetId === 'root' ? (await c.api('/me/drive/root').get()).id : realTargetId;
  if (args.isMove) {
    await c.api(`/me/drive/items/${fileId}`).patch({ parentReference: { id: resolvedParentId } });
  } else {
    await c.api(`/me/drive/items/${fileId}/copy`).post({
      parentReference: { id: resolvedParentId },
      ...(meta?.isEncrypted ? { name: meta.opaqueRemoteName || meta.name } : {}),
    });
  }
  invalidateDriveCache(sourceAccId);
  return { success: true, fileId, targetFolderId: realTargetId };
}

async function executeRenameFile(
  req: any,
  database: any,
  args: { accountId: string; fileId: string; name: string }
) {
  const accConf = checkTokenAccountConfinement(req, args.accountId);
  if (!accConf.ok) throw Object.assign(new Error(accConf.error), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
  if (!isSafeProviderItemId(args.fileId)) throw Object.assign(new Error('Invalid file identifier'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });

  const nameErr = validatePlaintextFilename(args.name);
  if (!nameErr.ok) throw Object.assign(new Error(nameErr.error.message), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });

  const { account, accessDenied } = await resolveAuthorizedAccount(database, args.accountId, req.userId, req.isAdmin);
  if (accessDenied) throw Object.assign(new Error('Access denied to this account'), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
  if (!account) throw Object.assign(new Error('Account not found'), { status: 404, code: STANDARD_ERROR_CODES.NOT_FOUND });

  const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, account, args.fileId, req.userId, req.isAdmin);
  if (fileDenied) throw Object.assign(new Error('Access denied to this file'), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
  if (meta?.isEncrypted) throw Object.assign(new Error('Renaming encrypted files via AI tools is blocked to preserve metadata integrity'), { status: 409, code: STANDARD_ERROR_CODES.CONFLICT });

  if (account.accountType === 'tgdrive') {
    if (!meta) throw Object.assign(new Error('File not found'), { status: 404, code: STANDARD_ERROR_CODES.NOT_FOUND });
    await database.collection('tg_files').updateOne({ _id: meta._id }, { $set: { name: args.name.trim(), updatedAt: new Date() } });
  } else if (account.accountType === 'onedrive') {
    const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
    await c.api(`/me/drive/items/${args.fileId}`).patch({ name: args.name.trim() });
  } else {
    const drive = await getDriveClient(account.tokens || account.credentials);
    await drive.files.update({ fileId: args.fileId, requestBody: { name: args.name.trim() } });
  }
  invalidateDriveCache(args.accountId);
  return { success: true, fileId: args.fileId, name: args.name.trim() };
}

async function executeUploadFromTempFile(
  req: any,
  database: any,
  args: { accountId: string; folderId?: string; tempPath: string; fileName: string; mimeType: string; sizeBytes: number }
) {
  const cleanupTemp = () => {
    if (args.tempPath && fs.existsSync(args.tempPath)) {
      try { fs.unlinkSync(args.tempPath); } catch { /* ignore */ }
    }
  };

  const accConf = checkTokenAccountConfinement(req, args.accountId);
  if (!accConf.ok) {
    cleanupTemp();
    throw Object.assign(new Error(accConf.error), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
  }

  const folderResolution = resolveConfinedFolderId(req, args.folderId);
  if (!folderResolution.ok) {
    cleanupTemp();
    throw Object.assign(new Error(folderResolution.error), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
  }

  const slot = acquireUserUploadSlot(String(req.userId || 'anonymous'));
  if (!slot.ok) {
    cleanupTemp();
    throw Object.assign(new Error(slot.reason || 'Too many concurrent uploads'), { status: 429, code: STANDARD_ERROR_CODES.RATE_LIMITED });
  }

  try {
    const { account, accessDenied } = await resolveAuthorizedAccount(database, args.accountId, req.userId, req.isAdmin);
    if (accessDenied) throw Object.assign(new Error('Access denied to this account'), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
    if (!account) throw Object.assign(new Error('Account not found'), { status: 404, code: STANDARD_ERROR_CODES.NOT_FOUND });

    const validation = validateUploadRequest({
      fileName: args.fileName,
      mimeType: args.mimeType,
      size: args.sizeBytes,
      folderId: folderResolution.folderId,
    });
    if (!validation.ok) {
      throw Object.assign(new Error(validation.error.message), { status: validation.error.status, code: validation.error.code });
    }
    const spec = validation.spec;

    const sniffed = await sniffMagicMimeType(args.tempPath);
    if (sniffed.suspiciousArchive) {
      throw Object.assign(new Error('Uploaded archive has an abnormal compression ratio and was rejected'), {
        status: 422,
        code: 'SUSPICIOUS_ARCHIVE_DETECTED',
      });
    }

    const uploadResult: any = await uploadFileToProvider(
      account,
      args.accountId,
      {
        path: args.tempPath,
        size: args.sizeBytes,
        originalname: normalizeSafeFilename(spec.fileName),
        mimetype: spec.mimeType,
      },
      spec.folderId,
      undefined,
      undefined,
      undefined,
      spec,
      String(req.userId || account.userId || '')
    );

    systemMetrics.uploadsCompleted++;
    systemMetrics.uploadBytesTotal += Number(args.sizeBytes || 0);
    recordAuditEvent('ai_file_uploaded', {
      userId: String(req.userId || account.userId || ''),
      accountId: args.accountId,
      fileName: spec.fileName,
      sizeBytes: args.sizeBytes,
      tokenId: req.tokenId || null,
    });
    invalidateDriveCache(args.accountId);
    return {
      success: true,
      fileId: uploadResult?.id ? String(uploadResult.id) : (uploadResult?._id ? String(uploadResult._id) : null),
      fileName: spec.fileName,
      folderId: spec.folderId,
      sizeBytes: args.sizeBytes,
      mimeType: spec.mimeType,
    };
  } finally {
    slot.release();
    cleanupTemp();
  }
}

async function executeDeleteFile(
  req: any,
  database: any,
  args: { accountId: string; fileId: string; permanent?: boolean }
) {
  const accConf = checkTokenAccountConfinement(req, args.accountId);
  if (!accConf.ok) throw Object.assign(new Error(accConf.error), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
  if (!isSafeProviderItemId(args.fileId)) throw Object.assign(new Error('Invalid file identifier'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });

  const { account, accessDenied } = await resolveAuthorizedAccount(database, args.accountId, req.userId, req.isAdmin);
  if (accessDenied) throw Object.assign(new Error('Access denied to this account'), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
  if (!account) throw Object.assign(new Error('Account not found'), { status: 404, code: STANDARD_ERROR_CODES.NOT_FOUND });

  if (args.permanent) {
    await permanentlyDeleteSingleFile(database, account, args.fileId, req.userId, !!req.isAdmin);
    invalidateDriveCache(args.accountId);
    return { success: true, permanent: true, fileId: args.fileId };
  }

  const now = new Date();
  if (account.accountType === 'tgdrive') {
    const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, account, args.fileId, req.userId, req.isAdmin, true);
    if (fileDenied) throw Object.assign(new Error('Access denied to this file'), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
    if (!meta) throw Object.assign(new Error('File not found'), { status: 404, code: STANDARD_ERROR_CODES.NOT_FOUND });
    await database.collection('tg_files').updateOne({ _id: meta._id }, { $set: { trashed: true, trashedAt: now, updatedAt: Date.now() } });
  } else if (account.accountType === 'onedrive') {
    const c = await getOneDriveClient(account.tokens || account.credentials, account._id.toString());
    await c.api(`/me/drive/items/${args.fileId}`).delete();
  } else {
    const drive = await getDriveClient(account.tokens || account.credentials);
    await drive.files.update({ fileId: args.fileId, requestBody: { trashed: true } });
  }
  invalidateDriveCache(args.accountId);
  return { success: true, trashed: true, fileId: args.fileId };
}

async function executeCreateShareLink(
  req: any,
  database: any,
  args: { accountId: string; fileId: string; expiresInHours?: number; maxDownloads?: number; pin?: string; allowDownload?: boolean }
) {
  const accConf = checkTokenAccountConfinement(req, args.accountId);
  if (!accConf.ok) throw Object.assign(new Error(accConf.error), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
  if (!isSafeProviderItemId(args.fileId)) throw Object.assign(new Error('Invalid file identifier'), { status: 400, code: STANDARD_ERROR_CODES.BAD_REQUEST });

  const { account, accessDenied } = await resolveAuthorizedAccount(database, args.accountId, req.userId, req.isAdmin);
  if (accessDenied) throw Object.assign(new Error('Access denied to this account'), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
  if (!account) throw Object.assign(new Error('Account not found'), { status: 404, code: STANDARD_ERROR_CODES.NOT_FOUND });

  const { meta, accessDenied: fileDenied } = await resolveFileMetadataForAccount(database, account, args.fileId, req.userId, req.isAdmin);
  if (fileDenied) throw Object.assign(new Error('Access denied to this file'), { status: 403, code: STANDARD_ERROR_CODES.FORBIDDEN });
  if (meta?.isEncrypted === true) {
    throw Object.assign(new Error('Encrypted file sharing is not supported'), { status: 409, code: 'ENCRYPTED_SHARE_UNSUPPORTED' });
  }

  const envBase = (process.env.APP_URL || '').replace(/\/$/, '');
  const reqHost = req.get?.('host');
  const shareBase = envBase || (reqHost ? `${req.protocol}://${reqHost}` : '');

  const expiresAt = Number.isFinite(Number(args.expiresInHours)) && Number(args.expiresInHours) > 0
    ? new Date(Date.now() + Number(args.expiresInHours) * 3600 * 1000)
    : null;
  const cleanMaxDownloads = Number.isFinite(Number(args.maxDownloads)) && Number(args.maxDownloads) > 0 ? Math.floor(Number(args.maxDownloads)) : null;
  const cleanPin = typeof args.pin === 'string' && args.pin.trim() ? args.pin.trim().slice(0, 32) : null;
  const allowDownload = args.allowDownload === undefined ? true : Boolean(args.allowDownload);

  let shareId = meta?.shareId || nanoid(6);
  if (account.accountType === 'tgdrive') {
    if (!meta) throw Object.assign(new Error('File not found'), { status: 404, code: STANDARD_ERROR_CODES.NOT_FOUND });
    if (!meta.shareId) {
      await database.collection('tg_files').updateOne({ _id: meta._id }, { $set: { shareId } });
    }
    await database.collection('shares').updateOne(
      { shareId },
      {
        $set: {
          shareId,
          userId: req.userId ? String(req.userId) : null,
          accountId: account._id,
          fileId: String(meta._id),
          active: true,
          revoked: false,
          allowDownload,
          expiresAt,
          maxDownloads: cleanMaxDownloads,
          pin: cleanPin,
          updatedAt: new Date(),
        },
        $setOnInsert: { downloadCount: 0, createdAt: new Date().toISOString() },
      },
      { upsert: true }
    );
  } else {
    shareId = nanoid(6);
    await database.collection('shares').insertOne({
      shareId,
      userId: req.userId ? String(req.userId) : null,
      accountId: account._id,
      fileId: args.fileId,
      active: true,
      revoked: false,
      allowDownload,
      expiresAt,
      maxDownloads: cleanMaxDownloads,
      downloadCount: 0,
      pin: cleanPin,
      createdAt: new Date().toISOString(),
    });
  }

  recordAuditEvent('ai_share_created', { userId: req.userId ? String(req.userId) : null, accountId: args.accountId, fileId: args.fileId, shareId });
  return {
    success: true,
    shareId,
    shareUrl: `${shareBase}/s/${shareId}`,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    maxDownloads: cleanMaxDownloads,
  };
}

// ─── MCP Tool Catalog ─────────────────────────────────────────────────────────

const MCP_TOOLS: AiToolDefinition[] = [
  {
    name: 'list_drives',
    description: 'List connected Cloudyte storage drives (Google Drive, OneDrive, Telegram Cloud) with IDs and quota usage.',
    requiredScope: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_storage_summary',
    description: 'Get storage summary and category usage breakdown for a specific drive or all connected drives.',
    requiredScope: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Optional drive account ID. Omit for all drives.' },
      },
    },
  },
  {
    name: 'list_files',
    description: 'List or search files and folders inside a Cloudyte drive.',
    requiredScope: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Drive account ID from list_drives.' },
        folderId: { type: 'string', description: 'Folder ID or path (default "root"). Use folder IDs returned by list_files.' },
        search: { type: 'string', description: 'Optional filename search query.' },
        limit: { type: 'number', description: 'Max items to return (1-200, default 100).' },
      },
      required: ['accountId'],
    },
  },
  {
    name: 'create_folder',
    description: 'Create a new folder in a Cloudyte drive.',
    requiredScope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Target drive account ID.' },
        name: { type: 'string', description: 'New folder name.' },
        parentId: { type: 'string', description: 'Optional parent folder ID or path (default "root").' },
      },
      required: ['accountId', 'name'],
    },
  },
  {
    name: 'move_file',
    description: 'Move a file to another folder inside the same drive or to a different connected drive.',
    requiredScope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAccountId: { type: 'string', description: 'Source drive account ID.' },
        fileId: { type: 'string', description: 'File ID to move.' },
        targetAccountId: { type: 'string', description: 'Destination drive account ID (defaults to sourceAccountId).' },
        targetFolderId: { type: 'string', description: 'Destination folder ID or path (default "root").' },
      },
      required: ['sourceAccountId', 'fileId'],
    },
  },
  {
    name: 'batch_move_files',
    description: 'Move up to 50 files at once into a destination folder or drive.',
    requiredScope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAccountId: { type: 'string', description: 'Source drive account ID.' },
        fileIds: { type: 'array', items: { type: 'string' }, description: 'List of file IDs to move (max 50).' },
        targetAccountId: { type: 'string', description: 'Destination drive account ID (defaults to sourceAccountId).' },
        targetFolderId: { type: 'string', description: 'Destination folder ID or path (default "root").' },
      },
      required: ['sourceAccountId', 'fileIds'],
    },
  },
  {
    name: 'copy_file',
    description: 'Copy a file to another folder or another connected drive.',
    requiredScope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAccountId: { type: 'string', description: 'Source drive account ID.' },
        fileId: { type: 'string', description: 'File ID to copy.' },
        targetAccountId: { type: 'string', description: 'Destination drive account ID (defaults to sourceAccountId).' },
        targetFolderId: { type: 'string', description: 'Destination folder ID or path (default "root").' },
      },
      required: ['sourceAccountId', 'fileId'],
    },
  },
  {
    name: 'rename_file',
    description: 'Rename an existing file or folder.',
    requiredScope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Drive account ID.' },
        fileId: { type: 'string', description: 'File ID to rename.' },
        name: { type: 'string', description: 'New filename.' },
      },
      required: ['accountId', 'fileId', 'name'],
    },
  },
  {
    name: 'upload_text_file',
    description: 'Create and upload a text, markdown, JSON, CSV, or code file directly into a Cloudyte drive.',
    requiredScope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Target drive account ID.' },
        fileName: { type: 'string', description: 'Filename including extension (e.g. notes.md, report.json).' },
        content: { type: 'string', description: 'UTF-8 file content (max 10 MB).' },
        folderId: { type: 'string', description: 'Optional destination folder ID or path (default "root").' },
        mimeType: { type: 'string', description: 'Optional MIME type.' },
      },
      required: ['accountId', 'fileName', 'content'],
    },
  },
  {
    name: 'upload_from_url',
    description: 'Fetch a file from a public http/https URL and upload it directly into a Cloudyte drive.',
    requiredScope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Target drive account ID.' },
        url: { type: 'string', description: 'Public http:// or https:// URL to download.' },
        fileName: { type: 'string', description: 'Optional filename override.' },
        folderId: { type: 'string', description: 'Optional destination folder ID or path (default "root").' },
      },
      required: ['accountId', 'url'],
    },
  },
  {
    name: 'create_share_link',
    description: 'Generate a public Cloudyte share link for a file.',
    requiredScope: 'share',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Drive account ID.' },
        fileId: { type: 'string', description: 'File ID to share.' },
        expiresInHours: { type: 'number', description: 'Optional link expiry in hours.' },
        maxDownloads: { type: 'number', description: 'Optional maximum download count.' },
        pin: { type: 'string', description: 'Optional PIN protection.' },
      },
      required: ['accountId', 'fileId'],
    },
  },
  {
    name: 'delete_file',
    description: 'Move a file to Trash (soft delete).',
    requiredScope: 'delete',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Drive account ID.' },
        fileId: { type: 'string', description: 'File ID to move to Trash.' },
      },
      required: ['accountId', 'fileId'],
    },
  },
];

function getPermittedTools(req: any): AiToolDefinition[] {
  return MCP_TOOLS.filter((tool) => checkTokenScope(req, tool.requiredScope).ok);
}

// ─── OpenAPI 3.1 Specification Builder ────────────────────────────────────────

function buildOpenApiSpec(baseUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Cloudyte AI & Automation API',
      version: '1.0.0',
      description: 'Unified REST API for managing files, folders, uploads, batch moves, and public shares across Google Drive, OneDrive, and Telegram Cloud.',
    },
    servers: [{ url: baseUrl }],
    security: [{ BearerAuth: [] }],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'PAT',
          description: 'Cloudyte Personal Access Token (pat_...) generated in Settings -> Access Tokens.',
        },
      },
    },
    paths: {
      '/api/accounts': {
        get: {
          operationId: 'listDrives',
          summary: 'List connected cloud drives',
          responses: { '200': { description: 'Array of connected drives with IDs, types, and quota usage.' } },
        },
      },
      '/api/storage/summary': {
        get: {
          operationId: 'getStorageSummary',
          summary: 'Get storage usage summary',
          parameters: [{ name: 'accountId', in: 'query', required: false, schema: { type: 'string' } }],
          responses: { '200': { description: 'Storage quota and category breakdown.' } },
        },
      },
      '/api/files': {
        get: {
          operationId: 'listFiles',
          summary: 'List or search files and folders in a drive',
          parameters: [
            { name: 'accountId', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'folderId', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'search', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
          ],
          responses: { '200': { description: 'Array of files and folders.' } },
        },
      },
      '/api/folders': {
        post: {
          operationId: 'createFolder',
          summary: 'Create a folder in a drive',
          parameters: [{ name: 'accountId', in: 'query', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string' },
                    parentId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Folder created.' } },
        },
      },
      '/api/files/move': {
        post: {
          operationId: 'moveFile',
          summary: 'Move a single file within a drive or across drives',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['sourceAccountId', 'fileId', 'targetAccountId'],
                  properties: {
                    sourceAccountId: { type: 'string' },
                    fileId: { type: 'string' },
                    targetAccountId: { type: 'string' },
                    targetFolderId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'File moved.' } },
        },
      },
      '/api/ai/files/batch-move': {
        post: {
          operationId: 'batchMoveFiles',
          summary: 'Move up to 50 files in a single request',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['sourceAccountId', 'fileIds'],
                  properties: {
                    sourceAccountId: { type: 'string' },
                    fileIds: { type: 'array', items: { type: 'string' } },
                    targetAccountId: { type: 'string' },
                    targetFolderId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Batch move summary.' } },
        },
      },
      '/api/files/copy': {
        post: {
          operationId: 'copyFile',
          summary: 'Copy a file within a drive or across drives',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['sourceAccountId', 'fileId', 'targetAccountId'],
                  properties: {
                    sourceAccountId: { type: 'string' },
                    fileId: { type: 'string' },
                    targetAccountId: { type: 'string' },
                    targetFolderId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'File copied.' } },
        },
      },
      '/api/files/{fileId}': {
        patch: {
          operationId: 'renameFile',
          summary: 'Rename a file or folder',
          parameters: [
            { name: 'fileId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'accountId', in: 'query', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
              },
            },
          },
          responses: { '200': { description: 'File renamed.' } },
        },
        delete: {
          operationId: 'deleteFile',
          summary: 'Move a file to Trash',
          parameters: [
            { name: 'fileId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'accountId', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'File moved to Trash.' } },
        },
      },
      '/api/ai/upload-text/{accountId}': {
        post: {
          operationId: 'uploadTextFile',
          summary: 'Create and upload a text, markdown, JSON, or code file directly',
          parameters: [{ name: 'accountId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['fileName', 'content'],
                  properties: {
                    fileName: { type: 'string' },
                    content: { type: 'string' },
                    folderId: { type: 'string' },
                    mimeType: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Text file uploaded.' } },
        },
      },
      '/api/ai/upload-from-url/{accountId}': {
        post: {
          operationId: 'uploadFromUrl',
          summary: 'Fetch a public http/https URL and upload it into a drive',
          parameters: [{ name: 'accountId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url'],
                  properties: {
                    url: { type: 'string' },
                    fileName: { type: 'string' },
                    folderId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Remote file uploaded.' } },
        },
      },
      '/api/share': {
        post: {
          operationId: 'createShareLink',
          summary: 'Create a public share link for a file',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['accountId', 'fileId'],
                  properties: {
                    accountId: { type: 'string' },
                    fileId: { type: 'string' },
                    expiresInHours: { type: 'number' },
                    maxDownloads: { type: 'integer' },
                    pin: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Share URL generated.' } },
        },
      },
    },
  };
}

// ─── Route Registration ───────────────────────────────────────────────────────

export function registerAiBridgeRoutes(app: any, deps: AiBridgeDeps) {
  // Allow larger JSON payloads for direct text uploads and MCP JSON-RPC batches
  app.use('/api/ai/upload-text', express.json({ limit: '12mb' }));
  app.use('/mcp', express.json({ limit: '12mb' }));
  app.use('/api/mcp', express.json({ limit: '12mb' }));

  // 1. OpenAPI Schema Discovery
  app.get('/api/openapi.json', (req: any, res: any) => {
    const envBase = (process.env.APP_URL || '').replace(/\/$/, '');
    const reqHost = req.get?.('host');
    const baseUrl = envBase || (reqHost ? `${req.protocol}://${reqHost}` : 'http://localhost:3000');
    res.setHeader('Cache-Control', 'no-store');
    res.json(buildOpenApiSpec(baseUrl));
  });

  // 2. Direct Text / Markdown / JSON File Upload
  app.post('/api/ai/upload-text/:accountId', requireAuth, async (req: any, res: any) => {
    const { accountId } = req.params;
    const { fileName, content, folderId, mimeType } = req.body || {};

    if (typeof content !== 'string') {
      return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'content string is required', req.requestId);
    }
    const nameErr = validatePlaintextFilename(fileName);
    if (!nameErr.ok) {
      return apiError(res, nameErr.error.status, nameErr.error.code, nameErr.error.message, req.requestId);
    }

    const buf = Buffer.from(content, 'utf8');
    if (buf.byteLength > MAX_TEXT_UPLOAD_BYTES) {
      return apiError(res, 413, STANDARD_ERROR_CODES.BAD_REQUEST, 'Text content exceeds 10 MB limit', req.requestId);
    }
    if (!hasTempDiskHeadroom(buf.byteLength)) {
      return apiError(res, 507, STANDARD_ERROR_CODES.INSUFFICIENT_STORAGE, 'Server temporary storage is too low', req.requestId);
    }

    const tempPath = buildSafeTempFilePath('aitext');
    try {
      await fs.promises.writeFile(tempPath, buf);
      const safeName = normalizeSafeFilename(String(fileName).trim());
      const resolvedMime = typeof mimeType === 'string' && mimeType.trim()
        ? mimeType.trim()
        : inferMimeTypeFromFilename(safeName, 'text/plain; charset=utf-8');

      const result = await executeUploadFromTempFile(req, req.db, {
        accountId,
        folderId,
        tempPath,
        fileName: safeName,
        mimeType: resolvedMime,
        sizeBytes: buf.byteLength,
      });
      res.json(result);
    } catch (err: any) {
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
      }
      const status = Number(err?.status) || 500;
      return apiError(res, status, err?.code || STANDARD_ERROR_CODES.UPLOAD_FAILED, err?.message || 'Text upload failed', req.requestId);
    }
  });

  // 3. SSRF-Protected Upload from Public URL
  app.post('/api/ai/upload-from-url/:accountId', requireAuth, async (req: any, res: any) => {
    const { accountId } = req.params;
    const { url, fileName, folderId } = req.body || {};
    if (typeof url !== 'string' || !url.trim()) {
      return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'url is required', req.requestId);
    }

    let downloaded: Awaited<ReturnType<typeof downloadPublicUrlToTempFile>> | null = null;
    try {
      downloaded = await downloadPublicUrlToTempFile(url.trim(), typeof fileName === 'string' ? fileName : undefined);
      const result = await executeUploadFromTempFile(req, req.db, {
        accountId,
        folderId,
        tempPath: downloaded.tempPath,
        fileName: downloaded.fileName,
        mimeType: downloaded.mimeType,
        sizeBytes: downloaded.sizeBytes,
      });
      res.json({ ...result, sourceUrl: downloaded.finalUrl });
    } catch (err: any) {
      if (downloaded?.tempPath && fs.existsSync(downloaded.tempPath)) {
        try { fs.unlinkSync(downloaded.tempPath); } catch { /* ignore */ }
      }
      const status = Number(err?.status) || 500;
      return apiError(res, status, err?.code || STANDARD_ERROR_CODES.UPLOAD_FAILED, err?.message || 'URL upload failed', req.requestId);
    }
  });

  // 4. Batch Move Files (up to 50 files per request)
  app.post('/api/ai/files/batch-move', requireAuth, async (req: any, res: any) => {
    const { sourceAccountId, fileIds, targetAccountId, targetFolderId, items } = req.body || {};

    const operations: Array<{ sourceAccountId: string; fileId: string; targetAccountId: string; targetFolderId?: string }> = [];
    if (Array.isArray(items) && items.length > 0) {
      for (const entry of items) {
        if (!entry || typeof entry !== 'object') continue;
        operations.push({
          sourceAccountId: String(entry.sourceAccountId || sourceAccountId || ''),
          fileId: String(entry.fileId || ''),
          targetAccountId: String(entry.targetAccountId || targetAccountId || entry.sourceAccountId || sourceAccountId || ''),
          targetFolderId: typeof entry.targetFolderId === 'string' ? entry.targetFolderId : targetFolderId,
        });
      }
    } else if (Array.isArray(fileIds) && fileIds.length > 0 && typeof sourceAccountId === 'string') {
      for (const fid of fileIds) {
        operations.push({
          sourceAccountId: String(sourceAccountId),
          fileId: String(fid || ''),
          targetAccountId: String(targetAccountId || sourceAccountId),
          targetFolderId: typeof targetFolderId === 'string' ? targetFolderId : undefined,
        });
      }
    }

    if (operations.length === 0) {
      return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, 'Provide fileIds or items array to move', req.requestId);
    }
    if (operations.length > MAX_BATCH_MOVE_ITEMS) {
      return apiError(res, 400, STANDARD_ERROR_CODES.BAD_REQUEST, `Maximum ${MAX_BATCH_MOVE_ITEMS} files per batch move`, req.requestId);
    }

    const results: Array<{ fileId: string; success: boolean; error?: string }> = [];
    for (const op of operations) {
      try {
        await executeMoveOrCopySingleFile(req, req.db, { ...op, isMove: true });
        results.push({ fileId: op.fileId, success: true });
      } catch (err: any) {
        results.push({ fileId: op.fileId, success: false, error: err?.message || 'Move failed' });
      }
    }

    const movedCount = results.filter((r) => r.success).length;
    res.json({
      success: movedCount > 0,
      movedCount,
      failedCount: results.length - movedCount,
      results,
    });
  });

  // 5. Remote MCP Endpoint (/mcp & /api/mcp)
  const handleMcpGet = (req: any, res: any) => {
    const permittedTools = getPermittedTools(req).map((t) => ({
      name: t.name,
      description: t.description,
      scope: t.requiredScope,
    }));
    res.json({
      name: 'cloudyte-mcp',
      version: '1.0.0',
      protocol: 'mcp-streamable-http',
      transport: 'POST JSON-RPC 2.0 to this endpoint',
      tools: permittedTools,
    });
  };

  const handleMcpDelete = (_req: any, res: any) => {
    res.status(204).end();
  };

  const dispatchMcpRpc = async (req: any, rpc: any) => {
    const id = rpc?.id ?? null;
    const method = typeof rpc?.method === 'string' ? rpc.method : '';
    const params = rpc?.params && typeof rpc.params === 'object' ? rpc.params : {};

    if (!rpc || rpc.jsonrpc !== '2.0' || !method) {
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' } };
    }

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null; // notification, no response body required
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'cloudyte-mcp', version: '1.0.0' },
          instructions: 'Use list_drives first to inspect connected storage IDs, then list_files, create_folder, move_file, batch_move_files, upload_text_file, or upload_from_url.',
        },
      };
    }

    if (method === 'tools/list') {
      const tools = getPermittedTools(req).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return { jsonrpc: '2.0', id, result: { tools } };
    }

    if (method === 'tools/call') {
      const toolName = String(params.name || '').trim();
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const toolDef = MCP_TOOLS.find((t) => t.name === toolName);
      if (!toolDef) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool '${toolName}'` } };
      }

      const scopeCheck = checkTokenScope(req, toolDef.requiredScope);
      if (!scopeCheck.ok) {
        return {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: scopeCheck.error || 'Insufficient token scope' }] },
        };
      }

      try {
        const database = req.db;
        let payload: any;
        switch (toolName) {
          case 'list_drives': {
            payload = await executeListDrives(req, database);
            break;
          }
          case 'get_storage_summary': {
            const targetAcc = typeof args.accountId === 'string' && args.accountId.trim() ? args.accountId.trim() : null;
            if (targetAcc) {
              const accConf = checkTokenAccountConfinement(req, targetAcc);
              if (!accConf.ok) throw Object.assign(new Error(accConf.error), { status: 403 });
              const { account, accessDenied } = await resolveAuthorizedAccount(database, targetAcc, req.userId, req.isAdmin);
              if (accessDenied) throw Object.assign(new Error('Access denied'), { status: 403 });
              if (!account) throw Object.assign(new Error('Account not found'), { status: 404 });
              payload = await computeSingleAccountStorageSummary(account, database);
            } else {
              const drives = await executeListDrives(req, database);
              payload = { drives };
            }
            break;
          }
          case 'list_files': {
            payload = await executeListFiles(req, database, {
              accountId: String(args.accountId || ''),
              folderId: typeof args.folderId === 'string' ? args.folderId : undefined,
              search: typeof args.search === 'string' ? args.search : undefined,
              limit: args.limit,
            });
            break;
          }
          case 'create_folder': {
            payload = await executeCreateFolder(req, database, deps.getBot(), {
              accountId: String(args.accountId || ''),
              name: String(args.name || ''),
              parentId: typeof args.parentId === 'string' ? args.parentId : undefined,
            });
            break;
          }
          case 'move_file': {
            payload = await executeMoveOrCopySingleFile(req, database, {
              sourceAccountId: String(args.sourceAccountId || ''),
              fileId: String(args.fileId || ''),
              targetAccountId: typeof args.targetAccountId === 'string' ? args.targetAccountId : undefined,
              targetFolderId: typeof args.targetFolderId === 'string' ? args.targetFolderId : undefined,
              isMove: true,
            });
            break;
          }
          case 'batch_move_files': {
            const fileIds = Array.isArray(args.fileIds) ? args.fileIds.map(String) : [];
            if (fileIds.length === 0 || fileIds.length > MAX_BATCH_MOVE_ITEMS) {
              throw Object.assign(new Error(`fileIds must contain 1-${MAX_BATCH_MOVE_ITEMS} IDs`), { status: 400 });
            }
            const results: Array<{ fileId: string; success: boolean; error?: string }> = [];
            for (const fid of fileIds) {
              try {
                await executeMoveOrCopySingleFile(req, database, {
                  sourceAccountId: String(args.sourceAccountId || ''),
                  fileId: fid,
                  targetAccountId: typeof args.targetAccountId === 'string' ? args.targetAccountId : undefined,
                  targetFolderId: typeof args.targetFolderId === 'string' ? args.targetFolderId : undefined,
                  isMove: true,
                });
                results.push({ fileId: fid, success: true });
              } catch (err: any) {
                results.push({ fileId: fid, success: false, error: err?.message || 'Move failed' });
              }
            }
            const movedCount = results.filter((r) => r.success).length;
            payload = { movedCount, failedCount: results.length - movedCount, results };
            break;
          }
          case 'copy_file': {
            payload = await executeMoveOrCopySingleFile(req, database, {
              sourceAccountId: String(args.sourceAccountId || ''),
              fileId: String(args.fileId || ''),
              targetAccountId: typeof args.targetAccountId === 'string' ? args.targetAccountId : undefined,
              targetFolderId: typeof args.targetFolderId === 'string' ? args.targetFolderId : undefined,
              isMove: false,
            });
            break;
          }
          case 'rename_file': {
            payload = await executeRenameFile(req, database, {
              accountId: String(args.accountId || ''),
              fileId: String(args.fileId || ''),
              name: String(args.name || ''),
            });
            break;
          }
          case 'upload_text_file': {
            const content = typeof args.content === 'string' ? args.content : '';
            const rawName = String(args.fileName || '').trim();
            const nameErr = validatePlaintextFilename(rawName);
            if (!nameErr.ok) throw Object.assign(new Error(nameErr.error.message), { status: 400 });
            const buf = Buffer.from(content, 'utf8');
            if (buf.byteLength > MAX_TEXT_UPLOAD_BYTES) throw Object.assign(new Error('Text content exceeds 10 MB limit'), { status: 413 });
            const tempPath = buildSafeTempFilePath('aimcptext');
            await fs.promises.writeFile(tempPath, buf);
            const safeName = normalizeSafeFilename(rawName);
            payload = await executeUploadFromTempFile(req, database, {
              accountId: String(args.accountId || ''),
              folderId: typeof args.folderId === 'string' ? args.folderId : undefined,
              tempPath,
              fileName: safeName,
              mimeType: typeof args.mimeType === 'string' && args.mimeType.trim() ? args.mimeType.trim() : inferMimeTypeFromFilename(safeName, 'text/plain; charset=utf-8'),
              sizeBytes: buf.byteLength,
            });
            break;
          }
          case 'upload_from_url': {
            const urlStr = typeof args.url === 'string' ? args.url.trim() : '';
            if (!urlStr) throw Object.assign(new Error('url is required'), { status: 400 });
            const dl = await downloadPublicUrlToTempFile(urlStr, typeof args.fileName === 'string' ? args.fileName : undefined);
            payload = await executeUploadFromTempFile(req, database, {
              accountId: String(args.accountId || ''),
              folderId: typeof args.folderId === 'string' ? args.folderId : undefined,
              tempPath: dl.tempPath,
              fileName: dl.fileName,
              mimeType: dl.mimeType,
              sizeBytes: dl.sizeBytes,
            });
            break;
          }
          case 'create_share_link': {
            payload = await executeCreateShareLink(req, database, {
              accountId: String(args.accountId || ''),
              fileId: String(args.fileId || ''),
              expiresInHours: args.expiresInHours,
              maxDownloads: args.maxDownloads,
              pin: typeof args.pin === 'string' ? args.pin : undefined,
            });
            break;
          }
          case 'delete_file': {
            payload = await executeDeleteFile(req, database, {
              accountId: String(args.accountId || ''),
              fileId: String(args.fileId || ''),
              permanent: false,
            });
            break;
          }
        }

        recordAuditEvent('ai_mcp_tool_call', {
          userId: req.userId ? String(req.userId) : null,
          tokenId: req.tokenId || null,
          tool: toolName,
        });
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
            structuredContent: payload,
          },
        };
      } catch (err: any) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: err?.message || 'Tool execution failed' }],
          },
        };
      }
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method '${method}' not found` } };
  };

  const handleMcpPost = async (req: any, res: any) => {
    const body = req.body;
    res.setHeader('Cache-Control', 'no-store');
    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map((item) => dispatchMcpRpc(req, item)))).filter(Boolean);
      if (responses.length === 0) return res.status(202).end();
      return res.status(200).json(responses);
    }
    const result = await dispatchMcpRpc(req, body);
    if (!result) return res.status(202).end();
    return res.status(200).json(result);
  };

  app.get('/mcp', requireAuth, handleMcpGet);
  app.post('/mcp', requireAuth, handleMcpPost);
  app.delete('/mcp', requireAuth, handleMcpDelete);

  app.get('/api/mcp', requireAuth, handleMcpGet);
  app.post('/api/mcp', requireAuth, handleMcpPost);
  app.delete('/api/mcp', requireAuth, handleMcpDelete);
}
