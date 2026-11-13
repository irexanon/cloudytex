import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ObjectId } from 'mongodb';
import {
  parseGoogleRangeOffset,
  parseOneDriveNextOffset,
  withSessionLock,
  validateUploadRequest,
  validateKeyBackupInput,
  validateOpaqueFilename,
} from './provider-transfer-protocol.ts';

process.env.CLOUDYTE_TEST_MODE = '1';

const {
  app,
  setTestDependencies,
  sweepUploadSessions,
  runEncryptionMigration,
} = await import('./server.ts');

// ─── In-memory MongoDB Mock for Integration Tests ───────────────────────────
function matchesQuery(doc: any, query: any): boolean {
  if (!query || Object.keys(query).length === 0) return true;
  for (const [k, v] of Object.entries(query)) {
    if (k === '$or' && Array.isArray(v)) {
      if (!v.some((sub) => matchesQuery(doc, sub))) return false;
      continue;
    }
    if (k === '$and' && Array.isArray(v)) {
      if (!v.every((sub) => matchesQuery(doc, sub))) return false;
      continue;
    }
    const fieldVal = k.includes('.')
      ? k.split('.').reduce((acc, part) => (acc ? acc[part] : undefined), doc)
      : doc[k];

    if (v instanceof RegExp) {
      if (!v.test(String(fieldVal ?? ''))) return false;
      continue;
    }
    if (v instanceof ObjectId || fieldVal instanceof ObjectId) {
      if (String(fieldVal) !== String(v)) return false;
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      const cond = v as Record<string, any>;
      if ('$exists' in cond) {
        const exists = fieldVal !== undefined;
        if ( Boolean(cond.$exists) !== exists) return false;
      }
      if ('$in' in cond && Array.isArray(cond.$in)) {
        if (!cond.$in.some((item: any) => String(item) === String(fieldVal))) return false;
      }
      if ('$nin' in cond && Array.isArray(cond.$nin)) {
        if (cond.$nin.some((item: any) => String(item) === String(fieldVal))) return false;
      }
      if ('$ne' in cond) {
        if (String(fieldVal) === String(cond.$ne)) return false;
      }
      if ('$lte' in cond) {
        const left = fieldVal instanceof Date ? fieldVal.getTime() : Number(fieldVal);
        const right = cond.$lte instanceof Date ? cond.$lte.getTime() : Number(cond.$lte);
        if (!(left <= right)) return false;
      }
      if ('$lt' in cond) {
        const left = fieldVal instanceof Date ? fieldVal.getTime() : Number(fieldVal);
        const right = cond.$lt instanceof Date ? cond.$lt.getTime() : Number(cond.$lt);
        if (!(left < right)) return false;
      }
      if ('$gt' in cond) {
        const left = fieldVal instanceof Date ? fieldVal.getTime() : Number(fieldVal);
        const right = cond.$gt instanceof Date ? cond.$gt.getTime() : Number(cond.$gt);
        if (!(left > right)) return false;
      }
      if ('$regex' in cond) {
        const re = new RegExp(cond.$regex, cond.$options || '');
        if (!re.test(String(fieldVal ?? ''))) return false;
      }
      continue;
    }
    if (fieldVal !== v && String(fieldVal) !== String(v)) return false;
  }
  return true;
}

class InMemoryCollection {
  docs: any[] = [];
  indexes: any[] = [];

  async createIndex(keys: any, options?: any) {
    this.indexes.push({ keys, options });
    return 'idx';
  }
  async findOne(query: any = {}) {
    return this.docs.find((d) => matchesQuery(d, query)) || null;
  }
  find(query: any = {}) {
    let results = this.docs.filter((d) => matchesQuery(d, query));
    const cursor = {
      sort: (sortSpec: Record<string, number>) => {
        const entries = Object.entries(sortSpec);
        results = [...results].sort((a, b) => {
          for (const [field, dir] of entries) {
            const av = a[field];
            const bv = b[field];
            if (av === bv) continue;
            return (av > bv ? 1 : -1) * dir;
          }
          return 0;
        });
        return cursor;
      },
      limit: (n: number) => {
        results = results.slice(0, n);
        return cursor;
      },
      toArray: async () => results.map((d) => ({ ...d })),
    };
    return cursor;
  }
  async insertOne(doc: any) {
    const record = { _id: doc._id ?? new ObjectId(), ...doc };
    this.docs.push(record);
    return { insertedId: record._id };
  }
  async updateOne(query: any, update: any, options?: { upsert?: boolean }) {
    const idx = this.docs.findIndex((d) => matchesQuery(d, query));
    if (idx === -1) {
      if (options?.upsert) {
        const base: any = { _id: new ObjectId() };
        for (const [k, v] of Object.entries(query)) {
          if (!k.startsWith('$') && (typeof v !== 'object' || v instanceof ObjectId)) {
            base[k] = v;
          }
        }
        if (update.$setOnInsert) Object.assign(base, update.$setOnInsert);
        if (update.$set) Object.assign(base, update.$set);
        this.docs.push(base);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: base._id };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
    const target = { ...this.docs[idx] };
    if (update.$set) Object.assign(target, update.$set);
    if (update.$unset) {
      for (const k of Object.keys(update.$unset)) delete target[k];
    }
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) target[k] = Number(target[k] || 0) + Number(v);
    }
    this.docs[idx] = target;
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async updateMany(query: any, update: any) {
    let count = 0;
    this.docs = this.docs.map((d) => {
      if (!matchesQuery(d, query)) return d;
      count++;
      const copy = { ...d };
      if (update.$set) Object.assign(copy, update.$set);
      return copy;
    });
    return { matchedCount: count, modifiedCount: count };
  }
  async deleteOne(query: any) {
    const idx = this.docs.findIndex((d) => matchesQuery(d, query));
    if (idx === -1) return { deletedCount: 0 };
    this.docs.splice(idx, 1);
    return { deletedCount: 1 };
  }
  async deleteMany(query: any) {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !matchesQuery(d, query));
    return { deletedCount: before - this.docs.length };
  }
  async countDocuments(query: any = {}) {
    return this.docs.filter((d) => matchesQuery(d, query)).length;
  }
  aggregate(pipeline: any[]) {
    return {
      toArray: async () => {
        let items = [...this.docs];
        for (const stage of pipeline) {
          if (stage.$match) {
            items = items.filter((d) => matchesQuery(d, stage.$match));
          } else if (stage.$group) {
            const total = items.reduce((sum, d) => sum + Number(d.encryptedSizeBytes ?? d.size ?? 0), 0);
            return [{ _id: null, total, usedBytes: total, count: items.length, fileCount: items.length, images: 0, videos: 0, audio: 0, documents: 0, archives: 0, other: total }];
          }
        }
        return items;
      },
    };
  }
}

class InMemoryDatabase {
  collections = new Map<string, InMemoryCollection>();
  collection(name: string) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new InMemoryCollection());
    }
    return this.collections.get(name)!;
  }
}

// ─── Test Harness & Crypto Helpers ───────────────────────────────────────────
function buildCyte1Blob(plaintext: Buffer): { blob: Buffer; sha256: string } {
  const magic = Buffer.from('CYTE1', 'ascii');
  const header = crypto.randomBytes(28);
  const tag = crypto.randomBytes(16);
  const ciphertext = Buffer.from(plaintext.map((b, i) => b ^ header[i % header.length]));
  const blob = Buffer.concat([magic, header, ciphertext, tag]);
  const sha256 = crypto.createHash('sha256').update(blob).digest('hex');
  return { blob, sha256 };
}

function buildValidEncryptedMetadata(keyId = 'key_primary_01') {
  return {
    metadataVersion: 1 as const,
    algorithm: 'AES-256-GCM' as const,
    keyId,
    nonce: crypto.randomBytes(12).toString('base64url'),
    ciphertext: Buffer.from(JSON.stringify({ encrypted: 'opaque-envelope-payload' })).toString('base64url'),
  };
}

// ─── Existing Unit Tests ─────────────────────────────────────────────────────
test('OneDrive parses the first expected range as the committed exclusive offset', () => {
  assert.equal(parseOneDriveNextOffset(['0-'], 100), 0);
  assert.equal(parseOneDriveNextOffset(['3276800-'], 10_000_000), 3_276_800);
  assert.equal(parseOneDriveNextOffset(['100-200', '400-'], 1_000), 100);
});

test('OneDrive empty ranges use the caller fallback and malformed/out-of-range offsets fail', () => {
  assert.equal(parseOneDriveNextOffset([], 100, 45), 45);
  assert.throws(() => parseOneDriveNextOffset(['x-'], 100));
  assert.throws(() => parseOneDriveNextOffset(['101-'], 100));
});

test('Google Drive 308 Range is converted to an exclusive offset; missing Range means zero', () => {
  assert.equal(parseGoogleRangeOffset(undefined, 100), 0);
  assert.equal(parseGoogleRangeOffset('bytes=0-0', 100), 1);
  assert.equal(parseGoogleRangeOffset('bytes=0-8388607', 16_777_216), 8_388_608);
});

test('Google Drive rejects malformed and out-of-range acknowledgements', () => {
  assert.throws(() => parseGoogleRangeOffset('bytes=1-2', 100));
  assert.throws(() => parseGoogleRangeOffset('bytes=0-100', 100));
});

test('same-session operations serialize while different sessions remain independent', async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withSessionLock('same', async () => { order.push('first-start'); await gate; order.push('first-end'); });
  const second = withSessionLock('same', async () => { order.push('second-start'); });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(order, ['first-start']);
  release(); await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
});

test('committed chunk replay is only accepted when offset, size, and SHA-256 match', async () => {
  const bytes = Buffer.from('chunk-data');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const isExactReplay = (record: any, offset: number, data: Buffer) => record.offset === offset && record.length === data.length && record.checksum === crypto.createHash('sha256').update(data).digest('hex');
  const record = { offset: 0, length: bytes.length, checksum: digest };
  assert.equal(isExactReplay(record, 0, bytes), true);
  assert.equal(isExactReplay(record, 1, bytes), false);
  assert.equal(isExactReplay(record, 0, Buffer.from('different')), false);
});

// ─── Full Backend E2EE Integration Suite (Tests 1..39) ───────────────────────
test('Cloudyte E2EE Backend Suite (Tests 1-39)', async (t) => {
  const mockDb = new InMemoryDatabase();
  const telegramBlobs = new Map<number, { bytes: Buffer; caption: string; fileName: string }>();
  const googleBlobs = new Map<string, { bytes: Buffer; name: string; mimeType: string; parents: string[] }>();
  const oneDriveBlobs = new Map<string, { bytes: Buffer; name: string; mimeType: string; parentId: string }>();
  let nextTgMsgId = 1000;
  let nextGoogleId = 2000;
  let nextOneDriveId = 3000;
  let thumbGenerationCalls = 0;

  const user1Id = 'user_1';
  const user2Id = 'user_2';
  const token1 = 'tok_user_1_valid';
  const token2 = 'tok_user_2_valid';

  const tgAccount1Id = new ObjectId('65f000000000000000000001');
  const gdAccount1Id = new ObjectId('65f000000000000000000002');
  const odAccount1Id = new ObjectId('65f000000000000000000003');
  const tgAccount2Id = new ObjectId('65f000000000000000000004');

  await mockDb.collection('users').insertOne({ _id: user1Id, username: 'alice', isActive: true, isAdmin: false });
  await mockDb.collection('users').insertOne({ _id: user2Id, username: 'bob', isActive: true, isAdmin: false });
  await mockDb.collection('sessions').insertOne({ token: token1, userId: user1Id, username: 'alice' });
  await mockDb.collection('sessions').insertOne({ token: token2, userId: user2Id, username: 'bob' });

  await mockDb.collection('accounts').insertOne({ _id: tgAccount1Id, userId: user1Id, accountType: 'tgdrive', channelId: '-100111', name: 'Alice TG' });
  await mockDb.collection('accounts').insertOne({ _id: gdAccount1Id, userId: user1Id, accountType: 'google', email: 'alice@gmail.com', tokens: { access_token: 'gd_tok' }, name: 'Alice GDrive' });
  await mockDb.collection('accounts').insertOne({ _id: odAccount1Id, userId: user1Id, accountType: 'onedrive', email: 'alice@outlook.com', tokens: { access_token: 'od_tok' }, name: 'Alice OneDrive' });
  await mockDb.collection('accounts').insertOne({ _id: tgAccount2Id, userId: user2Id, accountType: 'tgdrive', channelId: '-100222', name: 'Bob TG' });

  const mockTgClient = {
    sendFile: async (_peer: any, opts: any) => {
      const msgId = ++nextTgMsgId;
      const bytes = typeof opts.file === 'string' ? fs.readFileSync(opts.file) : Buffer.from(opts.file);
      const attrName = opts.attributes?.[0]?.fileName || 'unknown';
      telegramBlobs.set(msgId, { bytes, caption: opts.caption || '', fileName: attrName });
      return { id: msgId };
    },
    getMessages: async (_peer: any, { ids }: { ids: number[] }) => {
      const msgId = ids[0];
      const item = telegramBlobs.get(msgId);
      if (!item) return [];
      return [{ id: msgId, media: { msgId, document: { size: item.bytes.length, thumbs: [{ w: 320, h: 320 }] } } }];
    },
    iterDownload: async function* (opts: any) {
      const msgId = opts.file.msgId;
      const item = telegramBlobs.get(msgId);
      if (!item) return;
      const offset = Number(opts.offset || 0);
      const slice = item.bytes.subarray(offset);
      const chunkSize = Number(opts.requestSize || 65536);
      for (let i = 0; i < slice.length; i += chunkSize) {
        yield slice.subarray(i, Math.min(i + chunkSize, slice.length));
      }
    },
    downloadMedia: async () => {
      thumbGenerationCalls++;
      return Buffer.alloc(0);
    },
    deleteMessages: async (_peer: any, ids: number[]) => {
      for (const id of ids) telegramBlobs.delete(id);
    },
  };

  const mockDriveFactory = async () => ({
    context: { _options: { auth: { getAccessToken: async () => 'gd_access_token' } } },
    files: {
      create: async ({ requestBody, media }: any) => {
        const id = `gd_${++nextGoogleId}`;
        const chunks: Buffer[] = [];
        if (media?.body) {
          for await (const ch of media.body) chunks.push(Buffer.from(ch));
        }
        googleBlobs.set(id, {
          bytes: Buffer.concat(chunks),
          name: requestBody.name,
          mimeType: media?.mimeType || requestBody.mimeType || 'application/octet-stream',
          parents: requestBody.parents || ['root'],
        });
        return { data: { id, name: requestBody.name } };
      },
      list: async () => {
        const files = Array.from(googleBlobs.entries()).map(([id, g]) => ({
          id,
          name: g.name,
          mimeType: g.mimeType,
          size: String(g.bytes.length),
          modifiedTime: new Date().toISOString(),
          createdTime: new Date().toISOString(),
          webViewLink: `https://drive.google.com/file/d/${id}`,
        }));
        return { data: { files } };
      },
      get: async ({ fileId, alt }: any, options?: any) => {
        const item = googleBlobs.get(String(fileId));
        if (!item) throw new Error('Google file not found');
        if (alt === 'media') {
          const rangeHeader = options?.headers?.Range as string | undefined;
          if (rangeHeader && rangeHeader.startsWith('bytes=')) {
            const [sStr, eStr] = rangeHeader.replace('bytes=', '').split('-');
            const start = parseInt(sStr, 10);
            const end = eStr ? parseInt(eStr, 10) : item.bytes.length - 1;
            const slice = item.bytes.subarray(start, end + 1);
            return {
              status: 206,
              headers: {
                'content-range': `bytes ${start}-${end}/${item.bytes.length}`,
                'content-length': String(slice.length),
                'accept-ranges': 'bytes',
              },
              data: Readable.from(slice),
            };
          }
          return {
            status: 200,
            headers: {
              'content-length': String(item.bytes.length),
              'accept-ranges': 'bytes',
            },
            data: Readable.from(item.bytes),
          };
        }
        return { data: { id: fileId, name: item.name, mimeType: item.mimeType, parents: item.parents, size: String(item.bytes.length) } };
      },
      update: async ({ fileId, requestBody, addParents }: any) => {
        const item = googleBlobs.get(String(fileId));
        if (item) {
          if (requestBody?.name) item.name = requestBody.name;
          if (addParents) item.parents = [addParents];
        }
        return { data: { id: fileId, parents: item?.parents || [] } };
      },
      copy: async ({ fileId, requestBody }: any) => {
        const orig = googleBlobs.get(String(fileId));
        if (!orig) throw new Error('Source not found');
        const id = `gd_${++nextGoogleId}`;
        googleBlobs.set(id, {
          bytes: Buffer.from(orig.bytes),
          name: requestBody?.name || orig.name,
          mimeType: orig.mimeType,
          parents: requestBody?.parents || orig.parents,
        });
        return { data: { id, name: requestBody?.name || orig.name } };
      },
      delete: async ({ fileId }: any) => {
        googleBlobs.delete(String(fileId));
      },
    },
  });

  // Start local test HTTP server for Express app + mock OneDrive download endpoint
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Add a mock internal route to serve OneDrive raw bytes for axios stream downloads
  app.get('/__test_onedrive_dl/:itemId', (req: any, res: any) => {
    const item = oneDriveBlobs.get(req.params.itemId);
    if (!item) return res.status(404).end();
    const range = req.headers.range;
    if (range && range.startsWith('bytes=')) {
      const [sStr, eStr] = range.replace('bytes=', '').split('-');
      const start = parseInt(sStr, 10);
      const end = eStr ? parseInt(eStr, 10) : item.bytes.length - 1;
      const slice = item.bytes.subarray(start, end + 1);
      res.status(206);
      res.setHeader('content-range', `bytes ${start}-${end}/${item.bytes.length}`);
      res.setHeader('content-length', String(slice.length));
      res.setHeader('accept-ranges', 'bytes');
      return res.end(slice);
    }
    res.setHeader('content-length', String(item.bytes.length));
    res.setHeader('accept-ranges', 'bytes');
    return res.end(item.bytes);
  });

  const mockOneDriveFactory = async () => ({
    api: (apiPath: string) => ({
      put: async (stream: NodeJS.ReadableStream) => {
        const chunks: Buffer[] = [];
        for await (const ch of stream) chunks.push(Buffer.from(ch));
        const match = apiPath.match(/:\/([^:]+):\/content$/);
        const name = match ? decodeURIComponent(match[1]) : 'od_file';
        const id = `od_${++nextOneDriveId}`;
        oneDriveBlobs.set(id, { bytes: Buffer.concat(chunks), name, mimeType: 'application/octet-stream', parentId: 'root' });
        return { id, name };
      },
      get: async () => {
        if (apiPath.endsWith('/children')) {
          return {
            value: Array.from(oneDriveBlobs.entries()).map(([id, item]) => ({
              id,
              name: item.name,
              file: { mimeType: item.mimeType },
              size: item.bytes.length,
              lastModifiedDateTime: new Date().toISOString(),
              createdDateTime: new Date().toISOString(),
              webUrl: `https://onedrive.live.com/${id}`,
            })),
          };
        }
        const m = apiPath.match(/\/me\/drive\/items\/([^/]+)$/);
        if (m) {
          const item = oneDriveBlobs.get(m[1]);
          if (!item) throw new Error('OneDrive item not found');
          return {
            id: m[1],
            name: item.name,
            size: item.bytes.length,
            file: { mimeType: item.mimeType },
            '@microsoft.graph.downloadUrl': `${baseUrl}/__test_onedrive_dl/${m[1]}`,
          };
        }
        return { value: [] };
      },
      delete: async () => {
        const m = apiPath.match(/\/me\/drive\/items\/([^/]+)$/);
        if (m) oneDriveBlobs.delete(m[1]);
      },
      patch: async (body: any) => {
        const m = apiPath.match(/\/me\/drive\/items\/([^/]+)$/);
        if (m && oneDriveBlobs.has(m[1]) && body?.name) {
          oneDriveBlobs.get(m[1])!.name = body.name;
        }
      },
    }),
  });

  setTestDependencies({
    db: mockDb,
    getTgClient: async () => mockTgClient,
    resolvePeer: async (_tg: any, channelId: string) => ({ channelId }),
    getDriveClient: mockDriveFactory,
    getOneDriveClient: mockOneDriveFactory,
  });

  t.after(() => {
    setTestDependencies(null);
    server.close();
  });

  async function apiFetch(urlPath: string, init: RequestInit = {}, token = token1) {
    const headers = new Headers(init.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(`${baseUrl}${urlPath}`, { ...init, headers });
  }

  async function uploadMultipart(accountId: string, fileBytes: Buffer, fileName: string, fields: Record<string, string>, token = token1) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', new Blob([fileBytes], { type: fields.mimeType || 'application/octet-stream' }), fileName);
    return apiFetch(`/api/upload/${accountId}`, { method: 'POST', body: form }, token);
  }

  // ── 1. Direct plaintext upload still works and sets isEncrypted = false ──
  await t.test('1. Direct plaintext upload sets isEncrypted = false', async () => {
    const plainBytes = Buffer.from('Hello Cloudyte Plaintext World!');
    const res = await uploadMultipart(String(tgAccount1Id), plainBytes, 'notes.txt', {
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      folderId: 'root',
    });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.isEncrypted, false);

    const listRes = await apiFetch(`/api/files?accountId=${tgAccount1Id}`);
    const files: any[] = await listRes.json();
    const uploaded = files.find((f) => f.name === 'notes.txt');
    assert.ok(uploaded);
    assert.equal(uploaded.isEncrypted, false);
    assert.equal(uploaded.encryptionFormatVersion, null);
    assert.equal(uploaded.encryptedMetadata, null);
  });

  // ── 2. Direct encrypted upload stores encrypted metadata and opaque filename ──
  let tgEncryptedFileId = '';
  const tgEncryptedPayload = buildCyte1Blob(Buffer.from('Top secret financial report 2026'));
  const tgEncryptedMeta = buildValidEncryptedMetadata('key_tg_1');
  const tgOpaqueName = 'cyte_tg01secretblob9999.cyte1';

  await t.test('2. Direct encrypted upload stores encrypted metadata and opaque filename', async () => {
    const res = await uploadMultipart(String(tgAccount1Id), tgEncryptedPayload.blob, tgOpaqueName, {
      fileName: tgOpaqueName,
      opaqueRemoteName: tgOpaqueName,
      mimeType: 'application/octet-stream',
      size: String(tgEncryptedPayload.blob.length),
      encryptedSizeBytes: String(tgEncryptedPayload.blob.length),
      checksum: tgEncryptedPayload.sha256,
      isEncrypted: 'true',
      encryptionFormatVersion: '1',
      encryptionKeyId: 'key_tg_1',
      encryptedMetadata: JSON.stringify(tgEncryptedMeta),
    });
    assert.equal(res.status, 200);
    const data: any = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.isEncrypted, true);
    assert.equal(data.encryptedChecksum, tgEncryptedPayload.sha256);

    const storedDoc = await mockDb.collection('tg_files').findOne({ accountId: tgAccount1Id, name: tgOpaqueName });
    assert.ok(storedDoc);
    tgEncryptedFileId = String(storedDoc._id);
    assert.equal(storedDoc.isEncrypted, true);
    assert.equal(storedDoc.opaqueRemoteName, tgOpaqueName);
    assert.equal(storedDoc.plaintextSizeBytes, null);
    assert.equal(storedDoc.plaintextChecksum, null);
    // Verify Telegram caption contains no plaintext filename/MIME
    const tgMsg = telegramBlobs.get(storedDoc.messageId);
    assert.ok(tgMsg);
    assert.equal(tgMsg.caption, 'cloudyte:c1');
  });

  // ── 3. Direct encrypted upload rejects checksum mismatch with 422 ENCRYPTED_CHECKSUM_MISMATCH ──
  await t.test('3. Direct encrypted upload rejects checksum mismatch', async () => {
    const res = await uploadMultipart(String(tgAccount1Id), tgEncryptedPayload.blob, 'cyte_badchecksum1234.bin', {
      fileName: 'cyte_badchecksum1234.bin',
      mimeType: 'application/octet-stream',
      checksum: '0'.repeat(64),
      isEncrypted: 'true',
      encryptionFormatVersion: '1',
      encryptionKeyId: 'key_tg_1',
      encryptedMetadata: JSON.stringify(tgEncryptedMeta),
    });
    assert.equal(res.status, 422);
    const err: any = await res.json();
    assert.equal(err.code, 'ENCRYPTED_CHECKSUM_MISMATCH');
  });

  // ── 4. Direct encrypted upload rejects missing encryptedMetadata ──
  await t.test('4. Direct encrypted upload rejects missing encryptedMetadata', async () => {
    const res = await uploadMultipart(String(tgAccount1Id), tgEncryptedPayload.blob, 'cyte_nometa12345.bin', {
      fileName: 'cyte_nometa12345.bin',
      mimeType: 'application/octet-stream',
      checksum: tgEncryptedPayload.sha256,
      isEncrypted: 'true',
      encryptionFormatVersion: '1',
      encryptionKeyId: 'key_tg_1',
    });
    assert.equal(res.status, 400);
    const err: any = await res.json();
    assert.equal(err.code, 'ENCRYPTED_METADATA_INVALID');
  });

  // ── 5. Direct encrypted upload rejects non-opaque filename ──
  await t.test('5. Direct encrypted upload rejects non-opaque filename', async () => {
    const res = await uploadMultipart(String(tgAccount1Id), tgEncryptedPayload.blob, 'MySecretPassport.pdf', {
      fileName: 'MySecretPassport.pdf',
      mimeType: 'application/octet-stream',
      checksum: tgEncryptedPayload.sha256,
      isEncrypted: 'true',
      encryptionFormatVersion: '1',
      encryptionKeyId: 'key_tg_1',
      encryptedMetadata: JSON.stringify(tgEncryptedMeta),
    });
    assert.equal(res.status, 400);
    const err: any = await res.json();
    assert.equal(err.code, 'OPAQUE_FILENAME_REQUIRED');
  });

  // ── 6. Direct encrypted upload rejects non-octet-stream MIME type ──
  await t.test('6. Direct encrypted upload rejects non-octet-stream MIME type', async () => {
    const res = await uploadMultipart(String(tgAccount1Id), tgEncryptedPayload.blob, 'cyte_badmime1234.bin', {
      fileName: 'cyte_badmime1234.bin',
      mimeType: 'image/jpeg',
      checksum: tgEncryptedPayload.sha256,
      isEncrypted: 'true',
      encryptionFormatVersion: '1',
      encryptionKeyId: 'key_tg_1',
      encryptedMetadata: JSON.stringify(tgEncryptedMeta),
    });
    assert.equal(res.status, 400);
    const err: any = await res.json();
    assert.equal(err.code, 'ENCRYPTED_MIME_INVALID');
  });

  // ── 7. Direct encrypted upload rejects unsupported encryptionFormatVersion ──
  await t.test('7. Direct encrypted upload rejects unsupported encryptionFormatVersion', async () => {
    const res = await uploadMultipart(String(tgAccount1Id), tgEncryptedPayload.blob, 'cyte_badver1234.bin', {
      fileName: 'cyte_badver1234.bin',
      mimeType: 'application/octet-stream',
      checksum: tgEncryptedPayload.sha256,
      isEncrypted: 'true',
      encryptionFormatVersion: '99',
      encryptionKeyId: 'key_tg_1',
      encryptedMetadata: JSON.stringify(tgEncryptedMeta),
    });
    assert.equal(res.status, 400);
    const err: any = await res.json();
    assert.equal(err.code, 'UNSUPPORTED_ENCRYPTION_VERSION');
  });

  // ── 8. Resumable plaintext upload session still works ──
  await t.test('8. Resumable plaintext upload session works end-to-end', async () => {
    const plainData = Buffer.from('Resumable plaintext content chunk 1 + chunk 2');
    const sha = crypto.createHash('sha256').update(plainData).digest('hex');
    const createRes = await apiFetch(`/api/upload-sessions/${tgAccount1Id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'resumable-plain.txt',
        mimeType: 'text/plain',
        size: plainData.length,
        checksum: sha,
        idempotencyKey: 'idem_plain_1',
      }),
    });
    assert.equal(createRes.status, 201);
    const session: any = await createRes.json();
    assert.equal(session.isEncrypted, false);

    const chunkForm = new FormData();
    chunkForm.append('chunk', new Blob([plainData]), 'chunk.bin');
    const putRes = await apiFetch(`/api/upload-sessions/${session.sessionId}/chunks`, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes 0-${plainData.length - 1}/${plainData.length}` },
      body: chunkForm,
    });
    assert.equal(putRes.status, 200);

    const compRes = await apiFetch(`/api/upload-sessions/${session.sessionId}/complete`, { method: 'POST' });
    assert.equal(compRes.status, 200);
    const compBody: any = await compRes.json();
    assert.equal(compBody.success, true);
    assert.equal(compBody.isEncrypted, false);
  });

  // ── 9 & 10. Resumable encrypted upload session stores fields and returns them on GET ──
  let encSessionId = '';
  const sessionCyte = buildCyte1Blob(Buffer.from('Session encrypted payload across multiple chunks!'));
  const sessionMeta = buildValidEncryptedMetadata('key_sess_1');
  const sessionOpaqueName = 'cyte_sess_multi_chunk_01.cyte1';

  await t.test('9 & 10. Resumable encrypted upload session stores and returns encryption fields', async () => {
    const createRes = await apiFetch(`/api/upload-sessions/${tgAccount1Id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: sessionOpaqueName,
        opaqueRemoteName: sessionOpaqueName,
        mimeType: 'application/octet-stream',
        size: sessionCyte.blob.length,
        encryptedSizeBytes: sessionCyte.blob.length,
        checksum: sessionCyte.sha256,
        idempotencyKey: 'idem_enc_sess_1',
        isEncrypted: true,
        encryptionFormatVersion: 1,
        encryptionKeyId: 'key_sess_1',
        encryptedMetadata: sessionMeta,
      }),
    });
    assert.equal(createRes.status, 201);
    const created: any = await createRes.json();
    encSessionId = created.sessionId;
    assert.equal(created.isEncrypted, true);
    assert.equal(created.encryptionKeyId, 'key_sess_1');
    assert.deepEqual(created.encryptedMetadata, sessionMeta);

    const getRes = await apiFetch(`/api/upload-sessions/${encSessionId}`);
    assert.equal(getRes.status, 200);
    const statusBody: any = await getRes.json();
    assert.equal(statusBody.isEncrypted, true);
    assert.equal(statusBody.receivedBytes, 0);
    assert.equal(statusBody.totalBytes, sessionCyte.blob.length);
    assert.equal(statusBody.opaqueRemoteName, sessionOpaqueName);
  });

  // ── 11, 12, 13, 15. Chunk upload, idempotent replay, conflicting replay, and incomplete completion ──
  await t.test('11, 12, 13, 15. Resumable encrypted chunk upload, replay, conflict, and incomplete check', async () => {
    const split = Math.floor(sessionCyte.blob.length / 2);
    const chunk1 = sessionCyte.blob.subarray(0, split);
    const chunk2 = sessionCyte.blob.subarray(split);

    // Upload chunk 1
    const f1 = new FormData();
    f1.append('chunk', new Blob([chunk1]), 'c1.bin');
    const r1 = await apiFetch(`/api/upload-sessions/${encSessionId}/chunks`, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes 0-${chunk1.length - 1}/${sessionCyte.blob.length}` },
      body: f1,
    });
    assert.equal(r1.status, 200);

    // 12. Idempotent replay of chunk 1 with identical bytes succeeds
    const f1Replay = new FormData();
    f1Replay.append('chunk', new Blob([chunk1]), 'c1.bin');
    const rReplay = await apiFetch(`/api/upload-sessions/${encSessionId}/chunks`, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes 0-${chunk1.length - 1}/${sessionCyte.blob.length}` },
      body: f1Replay,
    });
    assert.equal(rReplay.status, 200);

    // 13. Conflicting replay of chunk 1 with altered bytes fails with 409 UPLOAD_SESSION_OFFSET_CONFLICT
    const badChunk1 = Buffer.from(chunk1);
    badChunk1[0] ^= 0xff;
    const f1Conflict = new FormData();
    f1Conflict.append('chunk', new Blob([badChunk1]), 'c1.bin');
    const rConflict = await apiFetch(`/api/upload-sessions/${encSessionId}/chunks`, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes 0-${chunk1.length - 1}/${sessionCyte.blob.length}` },
      body: f1Conflict,
    });
    assert.equal(rConflict.status, 409);
    const conflictErr: any = await rConflict.json();
    assert.equal(conflictErr.code, 'UPLOAD_SESSION_OFFSET_CONFLICT');

    // 15. Completing before chunk 2 is uploaded fails with 409 ENCRYPTED_UPLOAD_INCOMPLETE
    const rIncomplete = await apiFetch(`/api/upload-sessions/${encSessionId}/complete`, { method: 'POST' });
    assert.equal(rIncomplete.status, 409);
    const incErr: any = await rIncomplete.json();
    assert.equal(incErr.code, 'ENCRYPTED_UPLOAD_INCOMPLETE');

    // Upload chunk 2 and complete
    const f2 = new FormData();
    f2.append('chunk', new Blob([chunk2]), 'c2.bin');
    const r2 = await apiFetch(`/api/upload-sessions/${encSessionId}/chunks`, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes ${split}-${sessionCyte.blob.length - 1}/${sessionCyte.blob.length}` },
      body: f2,
    });
    assert.equal(r2.status, 200);

    const rComp = await apiFetch(`/api/upload-sessions/${encSessionId}/complete`, { method: 'POST' });
    assert.equal(rComp.status, 200);
    const compJson: any = await rComp.json();
    assert.equal(compJson.success, true);
    assert.equal(compJson.isEncrypted, true);
  });

  // ── 14. Resumable encrypted session complete verifies full encrypted file SHA-256 ──
  await t.test('14. Resumable encrypted session complete rejects full-file SHA-256 mismatch', async () => {
    const payload = buildCyte1Blob(Buffer.from('Corrupted session test'));
    const createRes = await apiFetch(`/api/upload-sessions/${tgAccount1Id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'cyte_bad_sess_hash.bin',
        mimeType: 'application/octet-stream',
        size: payload.blob.length,
        checksum: 'f'.repeat(64), // wrong expected hash
        idempotencyKey: 'idem_bad_hash_sess',
        isEncrypted: true,
        encryptionFormatVersion: 1,
        encryptionKeyId: 'key_sess_1',
        encryptedMetadata: sessionMeta,
      }),
    });
    const sess: any = await createRes.json();
    const form = new FormData();
    form.append('chunk', new Blob([payload.blob]), 'c.bin');
    await apiFetch(`/api/upload-sessions/${sess.sessionId}/chunks`, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes 0-${payload.blob.length - 1}/${payload.blob.length}` },
      body: form,
    });
    const compRes = await apiFetch(`/api/upload-sessions/${sess.sessionId}/complete`, { method: 'POST' });
    assert.equal(compRes.status, 422);
    const err: any = await compRes.json();
    assert.equal(err.code, 'ENCRYPTED_CHECKSUM_MISMATCH');
  });

  // ── 16 & 17. Cancelling active session andexpired session cleanup deletes temporary encrypted file ──
  await t.test('16 & 17. Cancelling or expiring encrypted upload session deletes temp file', async () => {
    const payload = buildCyte1Blob(Buffer.from('Temp cleanup test bytes'));
    const cRes = await apiFetch(`/api/upload-sessions/${tgAccount1Id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'cyte_cancel_test_01.bin',
        mimeType: 'application/octet-stream',
        size: payload.blob.length,
        checksum: payload.sha256,
        idempotencyKey: 'idem_cancel_01',
        isEncrypted: true,
        encryptionFormatVersion: 1,
        encryptionKeyId: 'key_sess_1',
        encryptedMetadata: sessionMeta,
      }),
    });
    const sess: any = await cRes.json();
    const f = new FormData();
    f.append('chunk', new Blob([payload.blob]), 'c.bin');
    await apiFetch(`/api/upload-sessions/${sess.sessionId}/chunks`, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes 0-${payload.blob.length - 1}/${payload.blob.length}` },
      body: f,
    });
    const dbSess = await mockDb.collection('upload_sessions').findOne({ sessionId: sess.sessionId });
    assert.ok(fs.existsSync(dbSess.tempPath));

    const delRes = await apiFetch(`/api/upload-sessions/${sess.sessionId}`, { method: 'DELETE' });
    assert.equal(delRes.status, 204);
    assert.equal(fs.existsSync(dbSess.tempPath), false);

    // 17. Expired session sweep
    const cRes2 = await apiFetch(`/api/upload-sessions/${tgAccount1Id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'cyte_expire_test_02.bin',
        mimeType: 'application/octet-stream',
        size: 0,
        checksum: crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
        idempotencyKey: 'idem_expire_02',
        isEncrypted: true,
        encryptionFormatVersion: 1,
        encryptionKeyId: 'key_sess_1',
        encryptedMetadata: sessionMeta,
      }),
    });
    const sess2: any = await cRes2.json();
    await mockDb.collection('upload_sessions').updateOne(
      { sessionId: sess2.sessionId },
      { $set: { expiresAt: new Date(Date.now() - 10000) } }
    );
    const dbSess2Before = await mockDb.collection('upload_sessions').findOne({ sessionId: sess2.sessionId });
    assert.ok(fs.existsSync(dbSess2Before.tempPath));
    await sweepUploadSessions();
    assert.equal(fs.existsSync(dbSess2Before.tempPath), false);
  });

  // ── 18 & 19. GET /api/files returns encrypted metadata and thumbUrl = null ──
  await t.test('18 & 19. GET /api/files returns encrypted metadata and thumbUrl = null', async () => {
    const res = await apiFetch(`/api/files?accountId=${tgAccount1Id}`);
    assert.equal(res.status, 200);
    const items: any[] = await res.json();
    const encItem = items.find((i) => i.id === tgEncryptedFileId);
    assert.ok(encItem);
    assert.equal(encItem.isEncrypted, true);
    assert.equal(encItem.encryptionFormatVersion, 1);
    assert.equal(encItem.encryptionKeyId, 'key_tg_1');
    assert.equal(encItem.encryptedChecksum, tgEncryptedPayload.sha256);
    assert.deepEqual(encItem.encryptedMetadata, tgEncryptedMeta);
    assert.equal(encItem.thumbUrl, null);
    assert.equal(encItem.type, 'other');
    assert.equal(encItem.mimeType, 'application/octet-stream');
  });

  // ── 20, 21, 22, 23. GET /api/download returns exact encrypted bytes & supports Range ──
  await t.test('20, 21, 22, 23. GET /api/download streams exact CYTE1 bytes and supports Range requests', async () => {
    const res = await apiFetch(`/api/download/${tgAccount1Id}/${tgEncryptedFileId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition') || '', new RegExp(tgOpaqueName));
    const downloaded = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(downloaded, tgEncryptedPayload.blob);

    // 21 & 22. Valid Range request returns 206 Partial Content with exact encrypted slice
    const rangeRes = await apiFetch(`/api/download/${tgAccount1Id}/${tgEncryptedFileId}`, {
      headers: { Range: 'bytes=5-24' },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('content-range'), `bytes 5-24/${tgEncryptedPayload.blob.length}`);
    const slice = Buffer.from(await rangeRes.arrayBuffer());
    assert.deepEqual(slice, tgEncryptedPayload.blob.subarray(5, 25));

    // 23. Invalid Range returns 416
    const badRangeRes = await apiFetch(`/api/download/${tgAccount1Id}/${tgEncryptedFileId}`, {
      headers: { Range: `bytes=${tgEncryptedPayload.blob.length + 100}-${tgEncryptedPayload.blob.length + 200}` },
    });
    assert.equal(badRangeRes.status, 416);
  });

  // ── 24 & 25. GET /api/thumb returns 409 ENCRYPTED_PREVIEW_UNAVAILABLE without calling Sharp/provider ──
  await t.test('24 & 25. GET /api/thumb returns 409 ENCRYPTED_PREVIEW_UNAVAILABLE and never invokes thumbnail generator', async () => {
    const beforeCalls = thumbGenerationCalls;
    const res = await apiFetch(`/api/thumb/${tgAccount1Id}/${tgEncryptedFileId}?s=256`);
    assert.equal(res.status, 409);
    const body: any = await res.json();
    assert.equal(body.code, 'ENCRYPTED_PREVIEW_UNAVAILABLE');
    assert.equal(thumbGenerationCalls, beforeCalls);
  });

  // ── 26 & 27. POST /api/share returns 409 ENCRYPTED_SHARE_UNSUPPORTED for encrypted files, works for plaintext ──
  await t.test('26 & 27. POST /api/share rejects encrypted files with 409 and allows plaintext files', async () => {
    const encShareRes = await apiFetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: String(tgAccount1Id), fileId: tgEncryptedFileId }),
    });
    assert.equal(encShareRes.status, 409);
    const errBody: any = await encShareRes.json();
    assert.equal(errBody.code, 'ENCRYPTED_SHARE_UNSUPPORTED');

    const plainDoc = await mockDb.collection('tg_files').findOne({ accountId: tgAccount1Id, name: 'notes.txt' });
    const plainShareRes = await apiFetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: String(tgAccount1Id), fileId: String(plainDoc._id) }),
    });
    assert.equal(plainShareRes.status, 200);
    const plainShareBody: any = await plainShareRes.json();
    assert.equal(plainShareBody.success, true);
    assert.ok(plainShareBody.shareUrl);
  });

  // ── 28, 29, 30, 31. Move & Copy within same account and across accounts preserves encryption fields ──
  await t.test('28, 29, 30, 31. Move and copy preserve encryption fields within and across accounts', async () => {
    // 28. Move within same account
    const moveRes = await apiFetch('/api/files/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceAccountId: String(tgAccount1Id),
        fileId: tgEncryptedFileId,
        targetAccountId: String(tgAccount1Id),
        targetFolderId: 'vault_folder',
      }),
    });
    assert.equal(moveRes.status, 200);
    const movedDoc = await mockDb.collection('tg_files').findOne({ _id: new ObjectId(tgEncryptedFileId) });
    assert.equal(movedDoc.folder, 'vault_folder');
    assert.equal(movedDoc.isEncrypted, true);
    assert.deepEqual(movedDoc.encryptedMetadata, tgEncryptedMeta);

    // 29. Copy within same account preserves opaque name (no " - Copy" suffix) and encryption fields
    const copyRes = await apiFetch('/api/files/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceAccountId: String(tgAccount1Id),
        fileId: tgEncryptedFileId,
        targetAccountId: String(tgAccount1Id),
        targetFolderId: 'vault_folder',
      }),
    });
    assert.equal(copyRes.status, 200);
    const copies = await mockDb.collection('tg_files').find({ accountId: tgAccount1Id, folder: 'vault_folder', name: tgOpaqueName }).toArray();
    assert.equal(copies.length, 2);
    for (const c of copies) {
      assert.equal(c.isEncrypted, true);
      assert.equal(c.name, tgOpaqueName);
      assert.equal(c.shareId, null);
    }

    // 30 & 31. Cross-account copy from Telegram to Google Drive and OneDrive preserves encrypted bytes & metadata
    const crossGdRes = await apiFetch('/api/files/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceAccountId: String(tgAccount1Id),
        fileId: tgEncryptedFileId,
        targetAccountId: String(gdAccount1Id),
        targetFolderId: 'root',
      }),
    });
    assert.equal(crossGdRes.status, 200);
    const gdListRes = await apiFetch(`/api/files?accountId=${gdAccount1Id}`);
    const gdFiles: any[] = await gdListRes.json();
    const gdEnc = gdFiles.find((f) => f.name === tgOpaqueName);
    assert.ok(gdEnc);
    assert.equal(gdEnc.isEncrypted, true);
    assert.deepEqual(gdEnc.encryptedMetadata, tgEncryptedMeta);

    const gdDlRes = await apiFetch(`/api/download/${gdAccount1Id}/${gdEnc.id}`);
    assert.equal(gdDlRes.status, 200);
    assert.deepEqual(Buffer.from(await gdDlRes.arrayBuffer()), tgEncryptedPayload.blob);
  });

  // ── 32, 33, 34, 35. Key Backup PUT, GET, DELETE, and validation ──
  await t.test('32, 33, 34, 35. Key backup PUT, GET, DELETE, and validation', async () => {
    const validBackup = {
      backupVersion: 1,
      keyId: 'key_tg_1',
      kdfAlgorithm: 'PBKDF2-HMAC-SHA256',
      kdfIterations: 310000,
      salt: crypto.randomBytes(16).toString('base64url'),
      wrapAlgorithm: 'AES-256-GCM',
      nonce: crypto.randomBytes(12).toString('base64url'),
      wrappedKey: crypto.randomBytes(48).toString('base64url'),
    };

    // 32. PUT stores key backup
    const putRes = await apiFetch(`/api/accounts/${tgAccount1Id}/encryption/key-backup`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBackup),
    });
    assert.equal(putRes.status, 200);
    const putJson: any = await putRes.json();
    assert.equal(putJson.keyId, 'key_tg_1');
    assert.equal(putJson.kdfIterations, 310000);

    // 33. GET returns key backup for owner
    const getRes = await apiFetch(`/api/accounts/${tgAccount1Id}/encryption/key-backup`);
    assert.equal(getRes.status, 200);
    const getJson: any = await getRes.json();
    assert.equal(getJson.wrappedKey, validBackup.wrappedKey);

    // 35. Rejects low kdfIterations or forbidden secret fields
    const lowIterRes = await apiFetch(`/api/accounts/${tgAccount1Id}/encryption/key-backup`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validBackup, kdfIterations: 1000 }),
    });
    assert.equal(lowIterRes.status, 400);
    assert.equal(((await lowIterRes.json()) as any).code, 'KEY_BACKUP_INVALID');

    const secretFieldRes = await apiFetch(`/api/accounts/${tgAccount1Id}/encryption/key-backup`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validBackup, recoveryPassphrase: 'leaked-password' }),
    });
    assert.equal(secretFieldRes.status, 400);
    assert.equal(((await secretFieldRes.json()) as any).code, 'KEY_BACKUP_INVALID');

    // 34. DELETE removes key backup and subsequent GET returns 404 KEY_BACKUP_NOT_FOUND
    const delRes = await apiFetch(`/api/accounts/${tgAccount1Id}/encryption/key-backup`, { method: 'DELETE' });
    assert.equal(delRes.status, 204);

    const getAfterDel = await apiFetch(`/api/accounts/${tgAccount1Id}/encryption/key-backup`);
    assert.equal(getAfterDel.status, 404);
    assert.equal(((await getAfterDel.json()) as any).code, 'KEY_BACKUP_NOT_FOUND');
  });

  // ── 36. Cross-user access to encrypted file, session, or key backup returns 403 ACCOUNT_ACCESS_DENIED ──
  await t.test('36. Cross-user access to encrypted file, session, or key backup returns 403 ACCOUNT_ACCESS_DENIED', async () => {
    const dlRes = await apiFetch(`/api/download/${tgAccount1Id}/${tgEncryptedFileId}`, {}, token2);
    assert.equal(dlRes.status, 403);
    assert.equal(((await dlRes.json()) as any).code, 'ACCOUNT_ACCESS_DENIED');

    const thumbRes = await apiFetch(`/api/thumb/${tgAccount1Id}/${tgEncryptedFileId}`, {}, token2);
    assert.equal(thumbRes.status, 403);
    assert.equal(((await thumbRes.json()) as any).code, 'ACCOUNT_ACCESS_DENIED');

    const kbRes = await apiFetch(`/api/accounts/${tgAccount1Id}/encryption/key-backup`, {}, token2);
    assert.equal(kbRes.status, 403);
    assert.equal(((await kbRes.json()) as any).code, 'ACCOUNT_ACCESS_DENIED');

    const sessRes = await apiFetch(`/api/upload-sessions/${encSessionId}`, {}, token2);
    assert.equal(sessRes.status, 403);
    assert.equal(((await sessRes.json()) as any).code, 'ACCOUNT_ACCESS_DENIED');
  });

  // ── 37, 38, 39. Provider coverage: Telegram, Google Drive, OneDrive encrypted upload/list/download ──
  await t.test('37, 38, 39. Telegram, Google Drive, and OneDrive encrypted upload, listing, and range download', async () => {
    for (const [label, accId] of [
      ['telegram', tgAccount1Id],
      ['google_drive', gdAccount1Id],
      ['onedrive', odAccount1Id],
    ] as const) {
      const cyte = buildCyte1Blob(Buffer.from(`Provider ${label} E2EE payload 1234567890`));
      const meta = buildValidEncryptedMetadata(`key_${label}`);
      const opaqueName = `cyte_${label}_test01.cyte1`;

      const upRes = await uploadMultipart(String(accId), cyte.blob, opaqueName, {
        fileName: opaqueName,
        opaqueRemoteName: opaqueName,
        mimeType: 'application/octet-stream',
        size: String(cyte.blob.length),
        encryptedSizeBytes: String(cyte.blob.length),
        checksum: cyte.sha256,
        isEncrypted: 'true',
        encryptionFormatVersion: '1',
        encryptionKeyId: `key_${label}`,
        encryptedMetadata: JSON.stringify(meta),
      });
      assert.equal(upRes.status, 200, `${label} upload should succeed`);

      const listRes = await apiFetch(`/api/files?accountId=${accId}`);
      assert.equal(listRes.status, 200);
      const files: any[] = await listRes.json();
      const found = files.find((f) => f.name === opaqueName);
      assert.ok(found, `${label} listing should include uploaded encrypted file`);
      assert.equal(found.isEncrypted, true);
      assert.equal(found.encryptionKeyId, `key_${label}`);
      assert.deepEqual(found.encryptedMetadata, meta);
      assert.equal(found.thumbUrl, null);

      const dlRes = await apiFetch(`/api/download/${accId}/${found.id}`);
      assert.equal(dlRes.status, 200);
      assert.deepEqual(Buffer.from(await dlRes.arrayBuffer()), cyte.blob);

      const rangeRes = await apiFetch(`/api/download/${accId}/${found.id}`, {
        headers: { Range: 'bytes=0-15' },
      });
      assert.equal(rangeRes.status, 206);
      assert.deepEqual(Buffer.from(await rangeRes.arrayBuffer()), cyte.blob.subarray(0, 16));
    }
  });

  // ── Migration test: Legacy documents without isEncrypted get backfilled to isEncrypted: false ──
  await t.test('Database migration backfills isEncrypted: false on legacy documents', async () => {
    const legacyId = new ObjectId();
    await mockDb.collection('tg_files').insertOne({
      _id: legacyId,
      accountId: tgAccount1Id,
      name: 'legacy_photo.jpg',
      size: 1024,
      mimeType: 'image/jpeg',
    });
    await runEncryptionMigration(mockDb);
    const migrated = await mockDb.collection('tg_files').findOne({ _id: legacyId });
    assert.equal(migrated.isEncrypted, false);
    assert.equal(migrated.encryptionFormatVersion, null);
    assert.equal(migrated.encryptedMetadata, null);
  });
});
