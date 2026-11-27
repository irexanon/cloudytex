#!/usr/bin/env node
/**
 * Cloudyte CLI — Upload, Download, Browse Drives & Temp Drop from Terminal
 * Zero external npm dependencies (requires Node.js 18+).
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

const CONFIG_PATH = process.env.CLOUDYTE_CLI_CONFIG || path.join(os.homedir(), '.cloudyte.json');
const CHUNK_THRESHOLD_BYTES = 8 * 1024 * 1024; // 8 MiB
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MiB

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
  } catch { /* ignore */ }
  return {};
}

function saveConfig(cfg) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* Windows ignore */ }
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function resolveContext(flags, { requireAuth = true } = {}) {
  const cfg = loadConfig();
  const baseUrl = String(flags.url || process.env.CLOUDYTE_URL || cfg.url || '').trim().replace(/\/$/, '');
  const token = String(flags.token || process.env.CLOUDYTE_TOKEN || cfg.token || '').trim();
  if (!baseUrl) {
    console.error('Error: Server URL not configured. Run:\n  node cloudyte.mjs login --url https://your-cloudyte-url --token <PAT>');
    process.exit(1);
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    console.error('Error: --url must start with http:// or https://');
    process.exit(1);
  }
  if (requireAuth && !token) {
    console.error('Error: API token missing. Create one in Settings -> API & AI Access, then run:\n  node cloudyte.mjs login --url ' + baseUrl + ' --token <cyt_...>');
    process.exit(1);
  }
  return { baseUrl, token };
}

function extractFilenameFromHeader(disposition, fallback) {
  if (typeof disposition === 'string') {
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      try {
        return path.basename(decodeURIComponent(utf8Match[1])).replace(/[\x00-\x1f/\\]/g, '_') || fallback;
      } catch { /* ignore */ }
    }
    const basicMatch = disposition.match(/filename="?([^";]+)"?/i);
    if (basicMatch?.[1]) {
      return path.basename(basicMatch[1]).replace(/[\x00-\x1f/\\]/g, '_') || fallback;
    }
  }
  return path.basename(fallback).replace(/[\x00-\x1f/\\]/g, '_') || 'download.bin';
}

async function computeFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 512 * 1024 })) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function readFileSlice(filePath, start, length) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await fh.read(buf, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === length ? buf : buf.subarray(0, offset);
  } finally {
    await fh.close();
  }
}

async function apiJson(baseUrl, pathname, { method = 'GET', token = '', headers = {}, body } = {}) {
  const reqHeaders = { ...headers };
  if (token) reqHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined && typeof body === 'object' && !(body instanceof FormData)) {
    reqHeaders['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${pathname}`, { method, headers: reqHeaders, body });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${res.status} ${res.statusText}`);
  }
  return data;
}

function renderProgress(label, done, total) {
  if (!process.stdout.isTTY || !total) return;
  const pct = Math.min(100, Math.round((done / total) * 100));
  process.stdout.write(`\r${label}: ${pct}% (${formatBytes(done)} / ${formatBytes(total)})`);
  if (done >= total) process.stdout.write('\n');
}

async function cmdLogin(flags) {
  const cfg = loadConfig();
  const url = String(flags.url || process.env.CLOUDYTE_URL || cfg.url || '').trim().replace(/\/$/, '');
  const token = String(flags.token || process.env.CLOUDYTE_TOKEN || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('Provide --url https://your-cloudyte-host');
  }
  const nextCfg = { ...cfg, url };
  if (token) nextCfg.token = token;
  saveConfig(nextCfg);
  console.log(`Saved Cloudyte URL (${url})${token ? ' and token' : ''} -> ${CONFIG_PATH}`);
  if (token) {
    const accounts = await apiJson(url, '/api/accounts', { token });
    console.log(`Authenticated! Connected drives: ${Array.isArray(accounts) ? accounts.length : 0}`);
  }
}

async function cmdDrives(flags) {
  const { baseUrl, token } = resolveContext(flags);
  const accounts = await apiJson(baseUrl, '/api/accounts', { token });
  if (!Array.isArray(accounts) || accounts.length === 0) {
    console.log('No connected drives found.');
    return;
  }
  console.table(
    accounts.map((a) => ({
      id: a.id,
      name: a.name || a.email || 'Drive',
      type: a.accountType,
      usage: a.usage || '-',
      total: a.total || '-',
      default: Boolean(a.isDefault),
    }))
  );
}

async function cmdLs(positionals, flags) {
  const { baseUrl, token } = resolveContext(flags);
  const accountId = positionals[1];
  const folderId = flags.folder || positionals[2] || 'root';
  if (!accountId) throw new Error('Usage: cloudyte ls <accountId> [folderId] [--search query]');
  const qs = new URLSearchParams({ accountId, folderId });
  if (flags.search) qs.set('search', String(flags.search));
  const items = await apiJson(baseUrl, `/api/files?${qs.toString()}`, { token });
  if (!Array.isArray(items) || items.length === 0) {
    console.log('Folder is empty.');
    return;
  }
  console.table(
    items.map((it) => ({
      id: it.id,
      type: it.type === 'folder' ? 'FOLDER' : (it.type || 'file'),
      name: it.name,
      size: it.type === 'folder' ? '-' : (it.size || formatBytes(it.sizeBytes || 0)),
      modified: it.modified || '-',
    }))
  );
}

async function cmdMkdir(positionals, flags) {
  const { baseUrl, token } = resolveContext(flags);
  const accountId = positionals[1];
  const name = positionals[2];
  const parentId = flags.parent || positionals[3] || 'root';
  if (!accountId || !name) throw new Error('Usage: cloudyte mkdir <accountId> <folderName> [parentId]');
  const data = await apiJson(baseUrl, `/api/folders?accountId=${encodeURIComponent(accountId)}`, {
    method: 'POST',
    token,
    body: { name, parentId },
  });
  console.log(`Created folder "${name}" (id: ${data.id || data.folderId || 'ok'})`);
}

async function cmdUpload(positionals, flags) {
  const { baseUrl, token } = resolveContext(flags);
  const accountId = positionals[1];
  const filePath = positionals[2];
  const folderId = String(flags.folder || positionals[3] || 'root');
  if (!accountId || !filePath) throw new Error('Usage: cloudyte upload <accountId> <localFilePath> [--folder <folderId>]');

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);
  const fileName = path.basename(resolvedPath);
  const fileSize = stat.size;
  const sha256 = await computeFileSha256(resolvedPath);

  if (fileSize <= CHUNK_THRESHOLD_BYTES) {
    const fileBuf = await fs.promises.readFile(resolvedPath);
    const form = new FormData();
    form.append('folderId', folderId);
    form.append('checksum', sha256);
    form.append('file', new Blob([fileBuf], { type: 'application/octet-stream' }), fileName);

    const data = await apiJson(baseUrl, `/api/upload/${encodeURIComponent(accountId)}`, {
      method: 'POST',
      token,
      body: form,
    });
    console.log(`Uploaded "${fileName}" (${formatBytes(fileSize)}) -> fileId: ${data.fileId || data.id || 'ok'}`);
    return;
  }

  // Resumable chunked upload for large files
  const idempotencyKey = `cli_${sha256.slice(0, 16)}_${fileSize}`;
  const initData = await apiJson(baseUrl, `/api/upload-sessions/${encodeURIComponent(accountId)}`, {
    method: 'POST',
    token,
    body: {
      fileName,
      mimeType: 'application/octet-stream',
      size: fileSize,
      folderId,
      checksum: sha256,
      idempotencyKey,
      desiredChunkSize: DEFAULT_CHUNK_BYTES,
    },
  });
  const sessionId = initData.sessionId || initData.session?.sessionId;
  const chunkSize = Number(initData.chunkSize || initData.session?.chunkSize || DEFAULT_CHUNK_BYTES);
  let offset = Number(initData.receivedBytes || initData.session?.receivedBytes || 0);

  while (offset < fileSize) {
    const len = Math.min(chunkSize, fileSize - offset);
    const end = offset + len - 1;
    const slice = await readFileSlice(resolvedPath, offset, len);
    const res = await fetch(`${baseUrl}/api/upload-sessions/${encodeURIComponent(sessionId)}/chunks`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${offset}-${end}/${fileSize}`,
      },
      body: slice,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Chunk upload failed at offset ${offset}: ${errText || res.status}`);
    }
    offset += len;
    renderProgress(`Uploading ${fileName}`, offset, fileSize);
  }

  const completeData = await apiJson(baseUrl, `/api/upload-sessions/${encodeURIComponent(sessionId)}/complete`, {
    method: 'POST',
    token,
    body: { checksum: sha256 },
  });
  console.log(`Uploaded "${fileName}" (${formatBytes(fileSize)}) -> fileId: ${completeData.fileId || completeData.file?.id || 'ok'}`);
}

async function cmdDownload(positionals, flags) {
  const { baseUrl, token } = resolveContext(flags);
  const accountId = positionals[1];
  const fileId = positionals[2];
  const explicitOut = positionals[3] || flags.out;
  if (!accountId || !fileId) throw new Error('Usage: cloudyte download <accountId> <fileId> [outputPath]');

  const res = await fetch(`${baseUrl}/api/download/${encodeURIComponent(accountId)}/${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Download failed (${res.status}): ${errText}`);
  }
  const serverName = extractFilenameFromHeader(res.headers.get('content-disposition'), `cloudyte_${fileId}`);
  const outPath = explicitOut
    ? (fs.existsSync(String(explicitOut)) && fs.statSync(String(explicitOut)).isDirectory()
        ? path.join(String(explicitOut), serverName)
        : path.resolve(String(explicitOut)))
    : path.resolve(process.cwd(), serverName);

  const total = Number(res.headers.get('content-length') || 0);
  let downloaded = 0;
  const bodyStream = Readable.fromWeb(res.body);
  bodyStream.on('data', (chunk) => {
    downloaded += chunk.length;
    if (total > 0) renderProgress(`Downloading ${path.basename(outPath)}`, downloaded, total);
  });
  await pipeline(bodyStream, fs.createWriteStream(outPath));
  console.log(`Saved -> ${outPath} (${formatBytes(downloaded || fs.statSync(outPath).size)})`);
}

async function cmdShare(positionals, flags) {
  const { baseUrl, token } = resolveContext(flags);
  const accountId = positionals[1];
  const fileId = positionals[2];
  if (!accountId || !fileId) throw new Error('Usage: cloudyte share <accountId> <fileId>');
  const data = await apiJson(baseUrl, '/api/share', {
    method: 'POST',
    token,
    body: { accountId, fileId },
  });
  console.log(`Share URL: ${data.url || `${baseUrl}/s/${data.shareId}`}`);
}

async function cmdTemp(positionals, flags) {
  const sub = positionals[1];
  if (!sub) throw new Error('Usage: cloudyte temp <create|ls|upload|download> ...');

  if (sub === 'create') {
    const useDrive = Boolean(flags.drive);
    const { baseUrl, token } = resolveContext(flags, { requireAuth: useDrive });
    const data = await apiJson(baseUrl, '/api/temp-rooms', {
      method: 'POST',
      token: useDrive || flags.token ? token : '',
      body: {
        title: flags.title ? String(flags.title) : 'CLI Temp Drop',
        ttlHours: flags.ttl ? Number(flags.ttl) : 24,
        accessMode: flags.mode ? String(flags.mode) : 'both',
        ...(flags.passcode ? { passcode: String(flags.passcode) } : {}),
        ...(useDrive ? {
          targetAccountId: String(flags.drive),
          targetFolderId: flags.folder ? String(flags.folder) : 'root',
          deleteOnExpire: Boolean(flags['delete-on-expire']),
        } : {}),
      },
    });
    console.log(`Room Code : ${data.room?.roomCode}`);
    console.log(`Share URL : ${data.shareUrl}`);
    console.log(`Storage   : ${data.room?.storageMode === 'drive' ? `Drive (${data.room.targetAccountName})` : 'Server Temp Storage'}`);
    console.log(`Creator Token (save to delete/edit): ${data.creatorToken}`);
    return;
  }

  const { baseUrl } = resolveContext(flags, { requireAuth: false });
  const tempHeaders = {};
  if (flags.passcode) tempHeaders['X-Temp-Passcode'] = String(flags.passcode);

  if (sub === 'ls') {
    const roomCode = positionals[2];
    if (!roomCode) throw new Error('Usage: cloudyte temp ls <roomCode> [--passcode code]');
    const data = await apiJson(baseUrl, `/api/temp-rooms/${encodeURIComponent(roomCode)}`, { headers: tempHeaders });
    console.log(`Room: ${data.room.title} (${data.room.roomCode}) | Expires: ${data.room.expiresAt}`);
    if (!Array.isArray(data.files) || data.files.length === 0) {
      console.log(data.filesHidden ? 'Files hidden (upload-only room).' : 'No files yet.');
      return;
    }
    console.table(
      data.files.map((f) => ({
        id: f.id,
        name: f.name,
        size: formatBytes(f.size),
        sender: f.uploadedByLabel,
        downloads: f.downloadCount,
      }))
    );
    return;
  }

  if (sub === 'upload') {
    const roomCode = positionals[2];
    const filePath = positionals[3];
    if (!roomCode || !filePath) throw new Error('Usage: cloudyte temp upload <roomCode> <localFilePath> [--name Label] [--passcode code]');
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
      throw new Error(`File not found: ${resolvedPath}`);
    }
    const fileBlob = typeof fs.openAsBlob === 'function'
      ? await fs.openAsBlob(resolvedPath, { type: 'application/octet-stream' })
      : new Blob([await fs.promises.readFile(resolvedPath)], { type: 'application/octet-stream' });
    const form = new FormData();
    if (flags.name) form.append('uploadedByLabel', String(flags.name));
    form.append('file', fileBlob, path.basename(resolvedPath));

    const data = await apiJson(baseUrl, `/api/temp-rooms/${encodeURIComponent(roomCode)}/upload`, {
      method: 'POST',
      headers: tempHeaders,
      body: form,
    });
    console.log(`Uploaded "${data.file?.name}" (${formatBytes(data.file?.size)}) -> id: ${data.file?.id}`);
    console.log(`Direct Download: ${baseUrl}${data.file?.downloadPath}`);
    return;
  }

  if (sub === 'download') {
    const roomCode = positionals[2];
    const target = positionals[3];
    const explicitOut = positionals[4] || flags.out;
    if (!roomCode || !target) throw new Error('Usage: cloudyte temp download <roomCode> <fileId|all> [outputPath] [--passcode code]');
    const endpoint = target === 'all'
      ? `/api/temp-rooms/${encodeURIComponent(roomCode)}/zip`
      : `/api/temp-rooms/${encodeURIComponent(roomCode)}/files/${encodeURIComponent(target)}/download`;
    const res = await fetch(`${baseUrl}${endpoint}`, { headers: tempHeaders });
    if (!res.ok) {
      throw new Error(`Download failed (${res.status}): ${await res.text()}`);
    }
    const serverName = extractFilenameFromHeader(
      res.headers.get('content-disposition'),
      target === 'all' ? `${roomCode}.zip` : `temp_${target}`
    );
    const outPath = explicitOut ? path.resolve(String(explicitOut)) : path.resolve(process.cwd(), serverName);
    const total = Number(res.headers.get('content-length') || 0);
    let downloaded = 0;
    const bodyStream = Readable.fromWeb(res.body);
    bodyStream.on('data', (chunk) => {
      downloaded += chunk.length;
      if (total > 0) renderProgress(`Downloading ${path.basename(outPath)}`, downloaded, total);
    });
    await pipeline(bodyStream, fs.createWriteStream(outPath));
    console.log(`Saved -> ${outPath} (${formatBytes(downloaded || fs.statSync(outPath).size)})`);
    return;
  }

  throw new Error(`Unknown temp subcommand: ${sub}`);
}

function printHelp() {
  console.log(`Cloudyte CLI — Terminal Upload, Download & Temp Drop

Setup:
  node cloudyte.mjs login --url <SERVER_URL> --token <PAT_TOKEN>

Drive Commands (requires token or CLOUDYTE_URL + CLOUDYTE_TOKEN):
  node cloudyte.mjs drives
  node cloudyte.mjs ls <accountId> [folderId] [--search <query>]
  node cloudyte.mjs mkdir <accountId> <folderName> [parentId]
  node cloudyte.mjs upload <accountId> <localFilePath> [--folder <folderId>]
  node cloudyte.mjs download <accountId> <fileId> [outputPath]
  node cloudyte.mjs share <accountId> <fileId>

Temp Drop Commands (NO login required for public rooms):
  node cloudyte.mjs temp create [--title "My Drop"] [--ttl 24] [--drive <accountId>] [--folder <folderId>]
  node cloudyte.mjs temp ls <roomCode> [--passcode <code>]
  node cloudyte.mjs temp upload <roomCode> <localFilePath> [--name "Ali"] [--passcode <code>]
  node cloudyte.mjs temp download <roomCode> <fileId|all> [outputPath] [--passcode <code>]
`);
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0];
  if (!cmd || flags.help || cmd === 'help') {
    printHelp();
    return;
  }

  if (cmd === 'login') return cmdLogin(flags);
  if (cmd === 'drives' || cmd === 'accounts') return cmdDrives(flags);
  if (cmd === 'ls' || cmd === 'list') return cmdLs(positionals, flags);
  if (cmd === 'mkdir') return cmdMkdir(positionals, flags);
  if (cmd === 'upload' || cmd === 'up' || cmd === 'put') return cmdUpload(positionals, flags);
  if (cmd === 'download' || cmd === 'dl' || cmd === 'get') return cmdDownload(positionals, flags);
  if (cmd === 'share') return cmdShare(positionals, flags);
  if (cmd === 'temp' || cmd === 'drop') return cmdTemp(positionals, flags);

  throw new Error(`Unknown command "${cmd}". Run with --help to see available commands.`);
}

main().catch((err) => {
  console.error('Error:', err?.message || err);
  process.exit(1);
});
