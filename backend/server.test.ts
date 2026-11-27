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
  computeFileSha256,
} from './protocol.ts';

process.env.CLOUDYTE_TEST_MODE = '1';

const {
  app,
  setTestDependencies,
  sweepUploadSessions,
  sweepExpiredTrash,
  sweepExpiredTempDrop,
  runJobWorker,
  runEncryptionMigration,
  TEMP_DIR,
} = await import('./server.ts');
const { clearTgChannelAccessCache, withTgPoolClient, getTgBotPoolStatus } = await import('./provider.ts');

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
      if (update.$unset) {
        for (const k of Object.keys(update.$unset)) delete copy[k];
      }
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
  async findOneAndDelete(query: any) {
    const idx = this.docs.findIndex((d) => matchesQuery(d, query));
    if (idx === -1) return null;
    const [removed] = this.docs.splice(idx, 1);
    return { ...removed };
  }
  async findOneAndUpdate(query: any, update: any, options?: { returnDocument?: string }) {
    const idx = this.docs.findIndex((d) => matchesQuery(d, query));
    if (idx === -1) return null;
    const before = { ...this.docs[idx] };
    const after = { ...this.docs[idx] };
    if (update.$set) Object.assign(after, update.$set);
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) after[k] = Number(after[k] || 0) + Number(v);
    }
    this.docs[idx] = after;
    return options?.returnDocument === 'after' ? after : before;
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

test('computeFileSha256 streams multi-chunk files without full memory buffering', async () => {
  const tmpFile = path.join(os.tmpdir(), `cloudyte-sha-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
  const payload = crypto.randomBytes(700 * 1024);
  fs.writeFileSync(tmpFile, payload);
  try {
    const actual = await computeFileSha256(tmpFile, fs);
    const expected = crypto.createHash('sha256').update(payload).digest('hex');
    assert.equal(actual, expected);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// ─── Full Backend E2EE Integration Suite (Tests 1..39) ───────────────────────
test('Cloudyte E2EE Backend Suite (Tests 1-39)', async (t) => {
  const mockDb = new InMemoryDatabase();
  const telegramBlobs = new Map<number, { bytes: Buffer; caption: string; fileName: string }>();
  const googleBlobs = new Map<string, { bytes: Buffer; name: string; mimeType: string; parents: string[]; trashed?: boolean }>();
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
      if (opts.offset !== undefined && typeof opts.offset?.divide !== 'function') {
        throw new TypeError('offset.divide is not a function');
      }
      const offset = opts.offset !== undefined
        ? (typeof opts.offset.toJSNumber === 'function' ? opts.offset.toJSNumber() : Number(opts.offset))
        : 0;
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
    about: {
      get: async () => ({
        data: {
          storageQuota: { usage: '1234', limit: '0' },
          user: { emailAddress: 'alice@gmail.com' },
        },
      }),
    },
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
      list: async ({ q }: any = {}) => {
        const wantTrashed = typeof q === 'string' && q.includes('trashed = true');
        const wantNotTrashed = typeof q === 'string' && q.includes('trashed = false');
        const files = Array.from(googleBlobs.entries())
          .filter(([, g]) => {
            if (wantTrashed) return g.trashed === true;
            if (wantNotTrashed) return !g.trashed;
            return true;
          })
          .map(([id, g]) => ({
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
          if (typeof requestBody?.trashed === 'boolean') item.trashed = requestBody.trashed;
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
        if (apiPath === '/me/drive') {
          return { quota: { used: 2048, total: 0 } };
        }
        if (apiPath === '/me/drive/root') {
          return { id: 'od_root' };
        }
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
        if (m && oneDriveBlobs.has(m[1])) {
          const item = oneDriveBlobs.get(m[1])!;
          if (body?.name) item.name = body.name;
          if (body?.parentReference?.id) item.parentId = body.parentReference.id;
        }
      },
      post: async (body: any) => {
        const copyMatch = apiPath.match(/\/me\/drive\/items\/([^/]+)\/copy$/);
        if (copyMatch) {
          const orig = oneDriveBlobs.get(copyMatch[1]);
          if (!orig) throw new Error('OneDrive source item not found');
          const id = `od_${++nextOneDriveId}`;
          oneDriveBlobs.set(id, {
            bytes: Buffer.from(orig.bytes),
            name: body?.name || orig.name,
            mimeType: orig.mimeType,
            parentId: body?.parentReference?.id || orig.parentId,
          });
          return { id };
        }
        return {};
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
      assert.equal(Object.prototype.hasOwnProperty.call(c, 'shareId'), false);
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

  // ── 40. Security: NoSQL operator injection rejected on auth & login ──
  await t.test('40. Rejects NoSQL operator injection in query token and login body', async () => {
    const queryInjectRes = await fetch(`${baseUrl}/api/accounts?token[$ne]=invalid`);
    assert.equal(queryInjectRes.status, 401);

    const loginInjectRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: { $ne: '' }, password: { $ne: '' } }),
    });
    assert.equal(loginInjectRes.status, 400);
  });

  // ── 41. Security: OAuth account-takeover bypass and unauthenticated link blocked ──
  await t.test('41. Blocks unauthenticated /auth/link and forged JSON state in OAuth callbacks', async () => {
    const linkUnauth = await fetch(`${baseUrl}/auth/link?tgId=12345`);
    assert.equal(linkUnauth.status, 401);

    const forgedState = encodeURIComponent(JSON.stringify({ userId: user1Id }));
    const gCb = await fetch(`${baseUrl}/auth/google/callback?code=fake&state=${forgedState}`);
    assert.equal(gCb.status, 401);

    const msCb = await fetch(`${baseUrl}/auth/microsoft/callback?code=fake&state=${forgedState}`);
    assert.equal(msCb.status, 401);
  });

  // ── 42. Security: Thumbnail endpoint rejects path traversal ──
  await t.test('42. Rejects path traversal fileId on /api/thumb', async () => {
    const badThumb = await apiFetch(`/api/thumb/${tgAccount1Id}/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(badThumb.status, 400);
  });

  // ── 43. Android parity: POST /api/upload honors ?folderId, X-File-Checksum, and Idempotency-Key ──
  await t.test('43. POST /api/upload honors folderId query param, X-File-Checksum header, and Idempotency-Key header', async () => {
    const content = Buffer.from('Android header parity check payload');
    const sha = crypto.createHash('sha256').update(content).digest('hex');

    // Mismatched X-File-Checksum rejected with 422
    const badForm = new FormData();
    badForm.append('file', new Blob([content], { type: 'text/plain' }), 'bad-hdr.txt');
    const badRes = await apiFetch(`/api/upload/${tgAccount1Id}?folderId=android_dir`, {
      method: 'POST',
      headers: { 'X-File-Checksum': '0'.repeat(64) },
      body: badForm,
    });
    assert.equal(badRes.status, 422);

    // Valid X-File-Checksum + Idempotency-Key + ?folderId=
    const goodForm = new FormData();
    goodForm.append('file', new Blob([content], { type: 'text/plain' }), 'hdr-ok.txt');
    const okRes = await apiFetch(`/api/upload/${tgAccount1Id}?folderId=android_dir`, {
      method: 'POST',
      headers: {
        'X-File-Checksum': sha,
        'Idempotency-Key': 'android_idem_1',
      },
      body: goodForm,
    });
    assert.equal(okRes.status, 200);
    const okJson: any = await okRes.json();
    assert.equal(okJson.success, true);

    const stored = await mockDb.collection('tg_files').findOne({ accountId: tgAccount1Id, idempotencyKey: 'android_idem_1' });
    assert.ok(stored);
    assert.equal(stored.folder, 'android_dir');

    // Duplicate Idempotency-Key returns cached record without creating a second tg_files entry
    const dupForm = new FormData();
    dupForm.append('file', new Blob([content], { type: 'text/plain' }), 'hdr-ok.txt');
    const dupRes = await apiFetch(`/api/upload/${tgAccount1Id}?folderId=android_dir`, {
      method: 'POST',
      headers: {
        'X-File-Checksum': sha,
        'Idempotency-Key': 'android_idem_1',
      },
      body: dupForm,
    });
    assert.equal(dupRes.status, 200);
    const dupJson: any = await dupRes.json();
    assert.equal(dupJson.fileId, okJson.fileId);
    const storedAll = await mockDb.collection('tg_files').find({ accountId: tgAccount1Id, idempotencyKey: 'android_idem_1' }).toArray();
    assert.equal(storedAll.length, 1);
  });

  // ── 44. OneDrive move & copy use getOneDriveClient instead of stale access_token ──
  await t.test('44. OneDrive move and copy work via getOneDriveClient even with stale account.tokens', async () => {
    const plain = Buffer.from('OneDrive move copy payload');
    const upRes = await uploadMultipart(String(odAccount1Id), plain, 'od-move-src.txt', {
      fileName: 'od-move-src.txt',
      mimeType: 'text/plain',
    });
    assert.equal(upRes.status, 200);
    const upJson: any = await upRes.json();
    const odFileId = upJson.fileId;

    const mvRes = await apiFetch('/api/files/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceAccountId: String(odAccount1Id),
        fileId: odFileId,
        targetAccountId: String(odAccount1Id),
        targetFolderId: 'od_target_dir',
      }),
    });
    assert.equal(mvRes.status, 200);
    assert.equal(oneDriveBlobs.get(odFileId)?.parentId, 'od_target_dir');

    const cpRes = await apiFetch('/api/files/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceAccountId: String(odAccount1Id),
        fileId: odFileId,
        targetAccountId: String(odAccount1Id),
        targetFolderId: 'od_copy_dir',
      }),
    });
    assert.equal(cpRes.status, 200);
    const copied = Array.from(oneDriveBlobs.values()).find((b) => b.parentId === 'od_copy_dir');
    assert.ok(copied);
  });

  // ── 45. /api/accounts includes isDefault and handles zero quota limit without NaN/Infinity ──
  await t.test('45. /api/accounts returns isDefault and safe quota percentage on zero limit', async () => {
    const res = await apiFetch('/api/accounts');
    assert.equal(res.status, 200);
    const list: any[] = await res.json();
    assert.equal(list.length, 3);
    for (const acc of list) {
      assert.equal(typeof acc.isDefault, 'boolean');
      assert.equal(Number.isFinite(acc.percentage), true);
      assert.equal(acc.percentage >= 0 && acc.percentage <= 100, true);
      assert.equal(String(acc.usage).includes('NaN'), false);
      assert.equal(String(acc.total).includes('Infinity'), false);
    }
  });

  // ── 46. Public share page validates shareId, sets CSP, and escapes HTML/XSS payloads ──
  await t.test('46. /s/:shareId validates shareId format, escapes HTML, and sets CSP header', async () => {
    const badRes = await fetch(`${baseUrl}/s/bad$id!!`);
    assert.equal(badRes.status, 400);

    const xssShareId = 'share_xss_test_01';
    const xssDoc = await mockDb.collection('tg_files').insertOne({
      accountId: tgAccount1Id,
      messageId: 99999,
      name: '<script>alert(1)</script>.txt',
      size: 12,
      mimeType: 'text/plain',
      folder: 'root',
      isEncrypted: false,
      shareId: xssShareId,
      createdAt: new Date(),
    });
    assert.ok(xssDoc.insertedId);
    const shareRes = await fetch(`${baseUrl}/s/${xssShareId}`);
    assert.equal(shareRes.status, 200);
    assert.ok(shareRes.headers.get('content-security-policy')?.includes("default-src 'none'"));
    const html = await shareRes.text();
    assert.equal(html.includes('<script>alert(1)</script>'), false);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  // ── 47. Storage summary supports omitted/"all" accountId and populates Google/OneDrive categories ──
  await t.test('47. /api/storage/summary supports omitted or "all" accountId and computes Google/OneDrive categories', async () => {
    const gdRes = await apiFetch(`/api/storage/summary?accountId=${gdAccount1Id}`);
    assert.equal(gdRes.status, 200);
    const gdSummary: any = await gdRes.json();
    assert.equal(gdSummary.accountType, 'google');
    assert.equal(typeof gdSummary.fileCount, 'number');
    assert.ok(gdSummary.fileCount >= 1);
    assert.ok(gdSummary.categories);
    assert.equal(typeof gdSummary.categories.documents, 'number');

    const odRes = await apiFetch(`/api/storage/summary?accountId=${odAccount1Id}`);
    assert.equal(odRes.status, 200);
    const odSummary: any = await odRes.json();
    assert.equal(odSummary.accountType, 'onedrive');
    assert.equal(typeof odSummary.fileCount, 'number');
    assert.ok(odSummary.categories);

    const allRes1 = await apiFetch('/api/storage/summary');
    assert.equal(allRes1.status, 200);
    const allSummary1: any = await allRes1.json();
    assert.equal(allSummary1.accountId, 'all');
    assert.ok(allSummary1.usedBytes >= gdSummary.usedBytes + odSummary.usedBytes);
    assert.ok(allSummary1.fileCount >= gdSummary.fileCount + odSummary.fileCount);
    assert.ok(allSummary1.categories);

    const allRes2 = await apiFetch('/api/storage/summary?accountId=all');
    assert.equal(allRes2.status, 200);
    const allSummary2: any = await allRes2.json();
    assert.equal(allSummary2.usedBytes, allSummary1.usedBytes);
  });

  // ── 48. Trash soft-delete, list, restore, permanent delete, and expired sweep ──
  await t.test('48. Soft-deletes files to Trash, hides from /api/files, restores, and permanently deletes', async () => {
    const payload = Buffer.from('Trash lifecycle test file content');
    const upRes = await uploadMultipart(String(tgAccount1Id), payload, 'trash-me.txt', {
      fileName: 'trash-me.txt',
      mimeType: 'text/plain',
    });
    assert.equal(upRes.status, 200);
    const { fileId } = (await upRes.json()) as any;
    assert.ok(fileId);

    // Soft-delete (default DELETE /api/files/:fileId)
    const delRes = await apiFetch(`/api/files/${fileId}?accountId=${tgAccount1Id}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const delJson: any = await delRes.json();
    assert.equal(delJson.trashed, true);

    // Hidden from /api/files
    const filesRes = await apiFetch(`/api/files?accountId=${tgAccount1Id}`);
    const filesList: any[] = await filesRes.json();
    assert.equal(filesList.some((f) => String(f.id) === String(fileId)), false);

    // Appears in /api/trash
    const trashRes = await apiFetch(`/api/trash?accountId=${tgAccount1Id}`);
    assert.equal(trashRes.status, 200);
    const trashList: any[] = await trashRes.json();
    assert.equal(trashList.some((f) => String(f.id) === String(fileId)), true);

    // Restore from trash
    const restoreRes = await apiFetch('/api/trash/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: String(tgAccount1Id), fileId }),
    });
    assert.equal(restoreRes.status, 200);

    // Back in /api/files
    const filesAfterRestore: any[] = await (await apiFetch(`/api/files?accountId=${tgAccount1Id}`)).json();
    assert.equal(filesAfterRestore.some((f) => String(f.id) === String(fileId)), true);

    // Soft-delete again and permanently delete via DELETE /api/trash/:fileId
    await apiFetch(`/api/files/${fileId}?accountId=${tgAccount1Id}`, { method: 'DELETE' });
    const permRes = await apiFetch(`/api/trash/${fileId}?accountId=${tgAccount1Id}`, { method: 'DELETE' });
    assert.equal(permRes.status, 200);
    const trashAfterPerm: any[] = await (await apiFetch(`/api/trash?accountId=${tgAccount1Id}`)).json();
    assert.equal(trashAfterPerm.some((f) => String(f.id) === String(fileId)), false);

    // Expired 31-day old trash item is purged by sweepExpiredTrash()
    const expiredInsert = await mockDb.collection('tg_files').insertOne({
      accountId: tgAccount1Id,
      messageId: 88888,
      name: 'old-trashed.txt',
      size: 10,
      mimeType: 'text/plain',
      trashed: true,
      trashedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    const purgedCount = await sweepExpiredTrash();
    assert.equal(purgedCount >= 1, true);
    const checkExpired = await mockDb.collection('tg_files').findOne({ _id: expiredInsert.insertedId });
    assert.equal(checkExpired, null);
  });

  // ── 49. Active Sessions listing, token non-exposure, revocation, and expiry enforcement ──
  await t.test('49. Lists active sessions without exposing raw tokens, revokes sessions, and rejects expired sessions', async () => {
    const sessTokenA = 'tok_session_device_a';
    const sessTokenB = 'tok_session_device_b';
    const expiredToken = 'tok_session_expired';

    await mockDb.collection('sessions').insertOne({
      sessionId: 'sess_dev_a',
      token: sessTokenA,
      userId: user1Id,
      username: 'alice',
      deviceName: 'Pixel 9 Pro',
      userAgent: 'Cloudyte/Android',
      createdAt: new Date(),
      lastActiveAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
    });
    await mockDb.collection('sessions').insertOne({
      sessionId: 'sess_dev_b',
      token: sessTokenB,
      userId: user1Id,
      username: 'alice',
      deviceName: 'Chrome Linux',
      userAgent: 'Mozilla/5.0',
      createdAt: new Date(),
      lastActiveAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
    });
    await mockDb.collection('sessions').insertOne({
      sessionId: 'sess_expired',
      token: expiredToken,
      userId: user1Id,
      username: 'alice',
      deviceName: 'Old Phone',
      createdAt: new Date(Date.now() - 40 * 86400 * 1000),
      lastActiveAt: new Date(Date.now() - 40 * 86400 * 1000),
      expiresAt: new Date(Date.now() - 1000),
    });

    // Expired session token is rejected with 401
    const expCheck = await fetch(`${baseUrl}/api/accounts`, {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    assert.equal(expCheck.status, 401);

    // GET /api/sessions lists active sessions and never leaks raw token
    const listRes = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${sessTokenA}` },
    });
    assert.equal(listRes.status, 200);
    const sessions: any[] = await listRes.json();
    assert.ok(sessions.length >= 2);
    for (const s of sessions) {
      assert.equal(s.token, undefined);
      assert.equal(typeof s.deviceName, 'string');
    }
    const currentSess = sessions.find((s) => s.id === 'sess_dev_a');
    assert.ok(currentSess);
    assert.equal(currentSess.isCurrent, true);

    // Revoke single session B
    const revRes = await fetch(`${baseUrl}/api/sessions/sess_dev_b`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessTokenA}` },
    });
    assert.equal(revRes.status, 200);
    const bCheck = await fetch(`${baseUrl}/api/accounts`, {
      headers: { Authorization: `Bearer ${sessTokenB}` },
    });
    assert.equal(bCheck.status, 401);
  });

  // ── 50. Async Cross-Account Transfer Job & SSE Progress Stream ──
  await t.test('50. Streams real-time progress for async cross-account transfer jobs via SSE', async () => {
    const payload = Buffer.from('Async SSE cross-account transfer payload');
    const upRes = await uploadMultipart(String(tgAccount1Id), payload, 'sse-transfer.txt', {
      fileName: 'sse-transfer.txt',
      mimeType: 'text/plain',
    });
    assert.equal(upRes.status, 200);
    const { fileId } = (await upRes.json()) as any;

    const asyncCopyRes = await apiFetch('/api/files/copy?async=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceAccountId: String(tgAccount1Id),
        fileId,
        targetAccountId: String(gdAccount1Id),
        targetFolderId: 'root',
      }),
    });
    assert.equal(asyncCopyRes.status, 202);
    const asyncCopyJson: any = await asyncCopyRes.json();
    assert.equal(asyncCopyJson.async, true);
    assert.ok(asyncCopyJson.jobId);

    const sseRes = await apiFetch(`/api/jobs/${asyncCopyJson.jobId}/stream`);
    assert.equal(sseRes.status, 200);
    assert.ok(sseRes.headers.get('content-type')?.includes('text/event-stream'));
    const sseText = await sseRes.text();
    const events = sseText
      .split('\n\n')
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice(6)));

    assert.ok(events.length >= 1);
    const finalEvent = events[events.length - 1];
    assert.equal(finalEvent.status, 'completed');
    assert.equal(finalEvent.progressPct, 100);
  });

  // ── 51. Upload Session Pause, Resume, and Dedicated TEMP_DIR Verification ──
  await t.test('51. Supports pausing and resuming upload sessions and stages files in dedicated TEMP_DIR', async () => {
    const payload = Buffer.from('Resumable pause-and-resume test payload');
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

    const createRes = await apiFetch(`/api/upload-sessions/${tgAccount1Id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'pause-resume.txt',
        mimeType: 'text/plain',
        size: payload.length,
        folderId: 'root',
        checksum: sha256,
        idempotencyKey: `idem_pause_resume_${Date.now()}`,
      }),
    });
    assert.equal(createRes.status, 201);
    const session: any = await createRes.json();
    assert.equal(session.status, 'active');

    // Verify stored tempPath is inside the dedicated TEMP_DIR
    const rawSessionDoc = await mockDb.collection('upload_sessions').findOne({ sessionId: session.sessionId });
    assert.ok(rawSessionDoc);
    assert.equal(path.dirname(rawSessionDoc.tempPath), path.resolve(TEMP_DIR));

    const sendChunk = async (sid: string, buf: Buffer) => {
      const form = new FormData();
      form.append('chunk', new Blob([buf]), 'chunk.bin');
      return apiFetch(`/api/upload-sessions/${sid}/chunks`, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes 0-${buf.length - 1}/${buf.length}` },
        body: form,
      });
    };

    // Pause session
    const pauseRes = await apiFetch(`/api/upload-sessions/${session.sessionId}/pause`, { method: 'POST' });
    assert.equal(pauseRes.status, 200);
    const pausedJson: any = await pauseRes.json();
    assert.equal(pausedJson.status, 'paused');

    // Uploading a chunk while paused fails with 409 UPLOAD_SESSION_NOT_ACTIVE
    const chunkWhilePaused = await sendChunk(session.sessionId, payload);
    assert.equal(chunkWhilePaused.status, 409);
    const pausedErr: any = await chunkWhilePaused.json();
    assert.equal(pausedErr.code, 'UPLOAD_SESSION_NOT_ACTIVE');

    // Resume session
    const resumeRes = await apiFetch(`/api/upload-sessions/${session.sessionId}/resume`, { method: 'POST' });
    assert.equal(resumeRes.status, 200);
    const resumedJson: any = await resumeRes.json();
    assert.equal(resumedJson.status, 'active');

    // Upload chunk and complete
    const chunkAfterResume = await sendChunk(session.sessionId, payload);
    assert.equal(chunkAfterResume.status, 200);
    const completeRes = await apiFetch(`/api/upload-sessions/${session.sessionId}/complete`, { method: 'POST' });
    assert.equal(completeRes.status, 200);
    const completeJson: any = await completeRes.json();
    assert.equal(completeJson.success, true);
  });

  // ── 52. Transfer Manifest Verification, Job Listing, and Job Cancellation ──
  await t.test('52. Records transfer manifests on cross-account transfer and supports job listing and cancellation', async () => {
    const manifests = await mockDb.collection('transfer_manifests').find({}).toArray();
    assert.ok(manifests.length >= 1);
    const completedManifest = manifests.find((m: any) => m.status === 'completed');
    assert.ok(completedManifest);
    assert.equal(typeof completedManifest.checksum, 'string');

    // List jobs for user
    const listJobsRes = await apiFetch('/api/jobs');
    assert.equal(listJobsRes.status, 200);
    const jobsList: any[] = await listJobsRes.json();
    assert.ok(jobsList.length >= 1);

    // Enqueue a new async transfer job and cancel it before worker runs
    const filesInTg = await mockDb.collection('tg_files').find({ accountId: tgAccount1Id }).toArray();
    const sampleFile = filesInTg[0];
    assert.ok(sampleFile);

    const asyncMoveRes = await apiFetch('/api/files/copy?async=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceAccountId: String(tgAccount1Id),
        fileId: String(sampleFile._id),
        targetAccountId: String(gdAccount1Id),
        targetFolderId: 'root',
      }),
    });
    assert.equal(asyncMoveRes.status, 202);
    const { jobId } = (await asyncMoveRes.json()) as any;

    const cancelRes = await apiFetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    assert.equal(cancelRes.status, 200);
    const cancelledJob: any = await cancelRes.json();
    assert.equal(cancelledJob.status, 'cancelled');
  });

  // ── 53. Health, Readiness, and Admin Observability Metrics ──
  await t.test('53. Exposes /healthz, /readyz, and admin-protected /api/admin/metrics observability snapshot', async () => {
    const healthRes = await fetch(`${baseUrl}/healthz`);
    assert.equal(healthRes.status, 200);
    const healthJson: any = await healthRes.json();
    assert.equal(healthJson.ok, true);

    const readyRes = await fetch(`${baseUrl}/readyz`);
    assert.equal(readyRes.status, 200);
    const readyJson: any = await readyRes.json();
    assert.equal(readyJson.status, 'ready');
    assert.equal(readyJson.mongo, true);

    // Non-admin user is denied access to /api/admin/metrics
    const nonAdminMetrics = await apiFetch('/api/admin/metrics');
    assert.equal(nonAdminMetrics.status, 403);

    // Admin basic auth receives full observability metrics
    const adminAuth = Buffer.from('admin:password').toString('base64');
    const adminMetricsRes = await fetch(`${baseUrl}/api/admin/metrics`, {
      headers: { Authorization: `Basic ${adminAuth}` },
    });
    assert.equal(adminMetricsRes.status, 200);
    const metricsJson: any = await adminMetricsRes.json();
    assert.equal(typeof metricsJson.uptimeSeconds, 'number');
    assert.ok(metricsJson.memoryUsage);
    assert.ok(metricsJson.disk);
    assert.ok(metricsJson.jobs);
    assert.ok(metricsJson.uploads);
    assert.ok(metricsJson.cache);
    assert.ok(Array.isArray(metricsJson.alerts));
  });

  // ── 54. Batch Backup Partial-Failure Resilience, Verification, and Conflict-Safe Restore ──
  await t.test('54. Runs batch backups with partial-failure resilience, verifies manifests, and creates conflict copies on restore', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('batch-backup-payload')], { type: 'text/plain' }), 'backup-doc.txt');
    const upRes = await apiFetch(`/api/upload/${tgAccount1Id}`, { method: 'POST', body: fd });
    assert.equal(upRes.status, 200);

    const tgFiles = await mockDb.collection('tg_files').find({ accountId: tgAccount1Id, name: 'backup-doc.txt' }).toArray();
    assert.equal(tgFiles.length, 1);
    const validFileId = String(tgFiles[0]._id);

    // Enqueue batch backup with 1 valid file and 1 missing file to test partial failure resilience
    const batchRes = await apiFetch('/api/backups/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceAccountId: String(tgAccount1Id),
        targetAccountId: String(gdAccount1Id),
        targetFolderId: 'root',
        fileIds: [validFileId, '000000000000000000000999'],
        conflictStrategy: 'rename',
      }),
    });
    assert.equal(batchRes.status, 202);
    const { jobId: batchJobId } = (await batchRes.json()) as any;

    for (let i = 0; i < 30; i++) {
      await runJobWorker();
      const jobDoc = await mockDb.collection('jobs').findOne({ _id: batchJobId });
      if (jobDoc?.status === 'completed' || jobDoc?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const batchManifest = await mockDb.collection('transfer_manifests').findOne({ jobId: batchJobId });
    assert.ok(batchManifest, 'Batch backup manifest should be recorded');
    assert.equal(batchManifest.succeededCount, 1);
    assert.equal(batchManifest.failedCount, 1);
    assert.equal(batchManifest.status, 'completed_with_errors');

    // Verify backup manifest via endpoint
    const verifyRes = await apiFetch(`/api/backups/${batchJobId}/verify`, { method: 'POST' });
    assert.equal(verifyRes.status, 200);
    const verifyJson: any = await verifyRes.json();
    assert.equal(verifyJson.verifiedCount, 1);
    assert.equal(verifyJson.totalItems, 2);

    // Also test a clean single-item batch backup between TG accounts and non-destructive restore with conflict copy
    const tgAccount2Id = new ObjectId('65f000000000000000000099');
    await mockDb.collection('accounts').insertOne({
      _id: tgAccount2Id,
      userId: 'user_1',
      accountType: 'tgdrive',
      channelId: '-1001234567890',
      name: 'Secondary TG Drive',
    });

    const cleanBatchRes = await apiFetch('/api/backups/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceAccountId: String(tgAccount1Id),
        targetAccountId: String(tgAccount2Id),
        targetFolderId: 'root',
        fileIds: [validFileId],
        conflictStrategy: 'rename',
      }),
    });
    assert.equal(cleanBatchRes.status, 202);
    const { jobId: cleanJobId } = (await cleanBatchRes.json()) as any;
    for (let i = 0; i < 20; i++) {
      await runJobWorker();
      const jobDoc = await mockDb.collection('jobs').findOne({ _id: cleanJobId });
      if (jobDoc?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const cleanVerifyRes = await apiFetch(`/api/backups/${cleanJobId}/verify`, { method: 'POST' });
    const cleanVerifyJson: any = await cleanVerifyRes.json();
    assert.equal(cleanVerifyJson.verified, true);

    // Restore back to tgAccount1Id where 'backup-doc.txt' already exists -> should create 'backup-doc (conflict copy).txt'
    const restoreRes = await apiFetch(`/api/backups/${cleanJobId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAccountId: String(tgAccount1Id),
        targetFolderId: 'root',
      }),
    });
    assert.equal(restoreRes.status, 202);
    const { jobId: restoreJobId } = (await restoreRes.json()) as any;
    for (let i = 0; i < 20; i++) {
      await runJobWorker();
      const jobDoc = await mockDb.collection('jobs').findOne({ _id: restoreJobId });
      if (jobDoc?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const restoredFiles = await mockDb.collection('tg_files').find({ accountId: tgAccount1Id }).toArray();
    const conflictCopy = restoredFiles.find((f: any) => f.name === 'backup-doc (conflict copy).txt');
    assert.ok(conflictCopy, 'Restore must create a conflict copy rather than overwriting existing file silently');
  });

  await t.test('55. Zero-double-write raw stream chunk uploads, OneDrive trash lifecycle, and sliding session expiry', async () => {
    // 1. Raw binary stream chunk upload (application/octet-stream) without intermediate multer disk write
    const rawPayload = Buffer.from('Zero-double-write direct stream upload payload for Cloudyte!');
    const rawSha256 = crypto.createHash('sha256').update(rawPayload).digest('hex');

    const initRes = await apiFetch(`/api/upload-sessions/${String(tgAccount1Id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'raw-stream-test.txt',
        mimeType: 'text/plain',
        totalBytes: rawPayload.length,
        chunkSize: 32,
        folderId: 'root',
        checksum: rawSha256,
        idempotencyKey: `idem_raw_stream_${Date.now()}`,
      }),
    });
    assert.equal(initRes.status, 201);
    const { sessionId } = (await initRes.json()) as any;

    const part1 = rawPayload.subarray(0, 32);
    const part2 = rawPayload.subarray(32);

    const c1Res = await apiFetch(`/api/upload-sessions/${sessionId}/chunks`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(part1.length),
        'X-Chunk-Offset': '0',
      },
      body: part1,
    });
    assert.equal(c1Res.status, 200);
    const c1Json: any = await c1Res.json();
    assert.equal(c1Json.receivedBytes, part1.length);

    // Exact replay of chunk 1 via raw stream should be idempotently accepted
    const replayRes = await apiFetch(`/api/upload-sessions/${sessionId}/chunks`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(part1.length),
        'X-Chunk-Offset': '0',
      },
      body: part1,
    });
    assert.equal(replayRes.status, 200);

    const c2Res = await apiFetch(`/api/upload-sessions/${sessionId}/chunks`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(part2.length),
        'X-Chunk-Offset': String(part1.length),
      },
      body: part2,
    });
    assert.equal(c2Res.status, 200);
    const c2Json: any = await c2Res.json();
    assert.equal(c2Json.complete, true);

    const completeRes = await apiFetch(`/api/upload-sessions/${sessionId}/complete`, { method: 'POST' });
    assert.equal(completeRes.status, 200);

    // 2. OneDrive Trash lifecycle: soft-delete -> list trash -> restore -> soft-delete -> empty trash
    const odTrashFileId = 'od_trash_item_99';
    const delOdRes = await apiFetch(`/api/files/${odTrashFileId}?accountId=${String(odAccount1Id)}`, {
      method: 'DELETE',
    });
    assert.equal(delOdRes.status, 200);
    const delOdJson: any = await delOdRes.json();
    assert.equal(delOdJson.trashed, true);

    const listOdTrashRes = await apiFetch(`/api/trash?accountId=${String(odAccount1Id)}`);
    assert.equal(listOdTrashRes.status, 200);
    const odTrashItems: any[] = await listOdTrashRes.json();
    assert.ok(odTrashItems.some((it: any) => String(it.id) === odTrashFileId), 'OneDrive trashed item must be listed in /api/trash');

    const restoreOdRes = await apiFetch('/api/trash/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: String(odAccount1Id), fileId: odTrashFileId }),
    });
    assert.equal(restoreOdRes.status, 200);

    const listAfterRestore = await apiFetch(`/api/trash?accountId=${String(odAccount1Id)}`);
    const afterRestoreItems: any[] = await listAfterRestore.json();
    assert.ok(!afterRestoreItems.some((it: any) => String(it.id) === odTrashFileId), 'Restored OneDrive item should leave trash');

    // Soft-delete again and Empty Trash
    await apiFetch(`/api/files/${odTrashFileId}?accountId=${String(odAccount1Id)}`, { method: 'DELETE' });
    const emptyOdTrashRes = await apiFetch(`/api/trash?accountId=${String(odAccount1Id)}`, { method: 'DELETE' });
    assert.equal(emptyOdTrashRes.status, 200);
    const emptyOdJson: any = await emptyOdTrashRes.json();
    assert.ok(emptyOdJson.deletedCount >= 1);

    // 3. Personal Access Tokens (plaintext in DB, scope & account confinement enforcement)
    const createPatRes = await apiFetch('/api/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Read-Only Confined Token',
        scopes: ['read'],
        accountId: String(tgAccount1Id),
        expiresInDays: 7,
      }),
    });
    assert.equal(createPatRes.status, 201);
    const patData: any = await createPatRes.json();
    assert.ok(patData.token.startsWith('pat_'));

    // Read on confined account succeeds
    const patReadOk = await fetch(`${baseUrl}/api/files?accountId=${String(tgAccount1Id)}`, {
      headers: { Authorization: `Bearer ${patData.token}` },
    });
    assert.equal(patReadOk.status, 200);

    // Read on a different account is blocked by account confinement (403)
    const patReadWrongAcc = await fetch(`${baseUrl}/api/files?accountId=${String(gdAccount1Id)}`, {
      headers: { Authorization: `Bearer ${patData.token}` },
    });
    assert.equal(patReadWrongAcc.status, 403);

    // Write operation with read-only PAT is blocked by scope enforcement (403)
    const patWriteDenied = await fetch(`${baseUrl}/api/folders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${patData.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accountId: String(tgAccount1Id), name: 'forbidden-folder' }),
    });
    assert.equal(patWriteDenied.status, 403);

    // Revoking PAT immediately invalidates it
    const revokePatRes = await apiFetch(`/api/tokens/${patData.tokenId}`, { method: 'DELETE' });
    assert.equal(revokePatRes.status, 200);
    const patAfterRevoke = await fetch(`${baseUrl}/api/files?accountId=${String(tgAccount1Id)}`, {
      headers: { Authorization: `Bearer ${patData.token}` },
    });
    assert.equal(patAfterRevoke.status, 401);

    // 4. 7-Point Public Share Validation (maxDownloads, PIN, revocation)
    const sharedTgId = new ObjectId();
    await mockDb.collection('tg_files').insertOne({
      _id: sharedTgId,
      accountId: tgAccount1Id,
      userId: 'user_1',
      messageId: 7771,
      name: 'shared-report.pdf',
      mimeType: 'application/pdf',
      size: 12,
      folder: '',
      date: Math.floor(Date.now() / 1000),
      isEncrypted: false,
    });
    const shareCreateRes = await apiFetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: String(tgAccount1Id),
        fileId: String(sharedTgId),
        maxDownloads: 1,
        pin: '4321',
      }),
    });
    assert.equal(shareCreateRes.status, 200);
    const shareJson: any = await shareCreateRes.json();
    assert.ok(shareJson.shareId);

    // Accessing share page without PIN returns 403
    const shareNoPin = await fetch(`${baseUrl}/s/${shareJson.shareId}`);
    assert.equal(shareNoPin.status, 403);

    // Accessing share page with valid PIN succeeds
    const shareWithPin = await fetch(`${baseUrl}/s/${shareJson.shareId}?pin=4321`);
    assert.equal(shareWithPin.status, 200);

    // Revoking share blocks public access with 404/410
    const revokeShareRes = await apiFetch(`/api/share/${shareJson.shareId}`, { method: 'DELETE' });
    assert.equal(revokeShareRes.status, 200);
    const shareAfterRevoke = await fetch(`${baseUrl}/s/${shareJson.shareId}?pin=4321`);
    assert.ok(shareAfterRevoke.status === 404 || shareAfterRevoke.status === 410);

    // 5. One-Time Download Tickets (using the uploaded raw-stream-test.txt which exists in mock tgMessages)
    const uploadedRawDoc = await mockDb.collection('tg_files').findOne({ accountId: tgAccount1Id, name: 'raw-stream-test.txt' });
    assert.ok(uploadedRawDoc);
    const ticketRes = await apiFetch('/api/download-tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: String(tgAccount1Id),
        fileId: String(uploadedRawDoc._id),
        singleUse: true,
        ttlSeconds: 120,
      }),
    });
    assert.equal(ticketRes.status, 201);
    const ticketJson: any = await ticketRes.json();
    assert.ok(ticketJson.ticket.startsWith('dlt_'));

    const firstTicketDl = await fetch(`${baseUrl}/api/download/ticket/${ticketJson.ticket}`);
    assert.equal(firstTicketDl.status, 200);
    await firstTicketDl.arrayBuffer();

    // Second use of single-use ticket must fail with 410
    const secondTicketDl = await fetch(`${baseUrl}/api/download/ticket/${ticketJson.ticket}`);
    assert.equal(secondTicketDl.status, 410);

    // 6. Queue Health & Admin Audit Logs
    const qHealthRes = await apiFetch('/api/jobs/health');
    assert.equal(qHealthRes.status, 200);
    const qHealth: any = await qHealthRes.json();
    assert.equal(qHealth.ok, true);
    assert.ok(qHealth.queues.cross_account_transfer);

    const adminBasicAuth = Buffer.from('admin:password').toString('base64');
    const auditRes = await fetch(`${baseUrl}/api/admin/audit-logs?limit=20`, {
      headers: { Authorization: `Basic ${adminBasicAuth}` },
    });
    assert.equal(auditRes.status, 200);
    const auditJson: any = await auditRes.json();
    assert.ok(Array.isArray(auditJson.logs));
    assert.ok(auditJson.logs.length > 0);
  });

  await t.test('56. Downloads preserve Content-Length (no gzip stripping), support HEAD probes, HTTP Range 206 resume, If-Range, and 416', async () => {
    // Upload a compressible >1KB text/plain file (> compression default 1024B threshold) to prove compression bypass works
    const payloadStr = Array.from({ length: 64 }, (_, i) => `CLOUDYTE-CHUNK-${String(i).padStart(2, '0')}-0123456789ABCDEF`).join('');
    const payload = Buffer.from(payloadStr, 'utf8');
    assert.ok(payload.length > 1500, 'Payload must exceed 1024-byte compression threshold');
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

    const initRes = await apiFetch(`/api/upload-sessions/${String(tgAccount1Id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'resumable-range-test.txt',
        mimeType: 'text/plain',
        totalBytes: payload.length,
        chunkSize: payload.length,
        folderId: 'root',
        checksum: sha256,
        idempotencyKey: `idem_range_test_${Date.now()}`,
      }),
    });
    assert.equal(initRes.status, 201);
    const { sessionId } = (await initRes.json()) as any;

    const putChunkRes = await apiFetch(`/api/upload-sessions/${sessionId}/chunks`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(payload.length),
        'X-Chunk-Offset': '0',
      },
      body: payload,
    });
    assert.equal(putChunkRes.status, 200);

    const completeRes = await apiFetch(`/api/upload-sessions/${sessionId}/complete`, { method: 'POST' });
    assert.equal(completeRes.status, 200);

    const fileDoc = await mockDb.collection('tg_files').findOne({ accountId: tgAccount1Id, name: 'resumable-range-test.txt' });
    assert.ok(fileDoc);

    // 1. HEAD probe on a single-use ticket returns exact Content-Length & Accept-Ranges without burning the ticket
    const oneTimeRes = await apiFetch('/api/download-tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: String(tgAccount1Id),
        fileId: String(fileDoc._id),
        singleUse: true,
        ttlSeconds: 300,
      }),
    });
    assert.equal(oneTimeRes.status, 201);
    const { ticket: oneTimeTicket } = (await oneTimeRes.json()) as any;

    const headOneTime = await fetch(`${baseUrl}/api/download/ticket/${oneTimeTicket}`, {
      method: 'HEAD',
      headers: { 'Accept-Encoding': 'gzip, deflate, br' },
    });
    assert.equal(headOneTime.status, 200);
    assert.equal(headOneTime.headers.get('content-length'), String(payload.length));
    assert.equal(headOneTime.headers.get('accept-ranges'), 'bytes');
    assert.equal(headOneTime.headers.get('content-encoding'), null);
    assert.ok((headOneTime.headers.get('cache-control') || '').includes('no-transform'));

    // First GET on single-use ticket still succeeds after HEAD probe
    const getOneTime = await fetch(`${baseUrl}/api/download/ticket/${oneTimeTicket}`, {
      headers: { 'Accept-Encoding': 'gzip, deflate, br' },
    });
    assert.equal(getOneTime.status, 200);
    assert.equal(getOneTime.headers.get('content-length'), String(payload.length));
    assert.equal(getOneTime.headers.get('content-encoding'), null);
    const oneTimeBody = Buffer.from(await getOneTime.arrayBuffer());
    assert.equal(Buffer.compare(oneTimeBody, payload), 0);

    // Second GET on single-use ticket is still rejected with 410
    const replayOneTime = await fetch(`${baseUrl}/api/download/ticket/${oneTimeTicket}`);
    assert.equal(replayOneTime.status, 410);

    // 2. Resumable ticket (singleUse: false) supports multi-request byte-range resume, suffix ranges, If-Range, and 416
    const resumableRes = await apiFetch('/api/download-tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: String(tgAccount1Id),
        fileId: String(fileDoc._id),
        singleUse: false,
        ttlSeconds: 3600,
      }),
    });
    assert.equal(resumableRes.status, 201);
    const { ticket: resumableTicket } = (await resumableRes.json()) as any;

    // Part 1: bytes=0-511
    const part1Res = await fetch(`${baseUrl}/api/download/ticket/${resumableTicket}`, {
      headers: { Range: 'bytes=0-511', 'Accept-Encoding': 'gzip, deflate, br' },
    });
    assert.equal(part1Res.status, 206);
    assert.equal(part1Res.headers.get('accept-ranges'), 'bytes');
    assert.equal(part1Res.headers.get('content-range'), `bytes 0-511/${payload.length}`);
    assert.equal(part1Res.headers.get('content-length'), '512');
    assert.equal(part1Res.headers.get('content-encoding'), null);
    const etag = part1Res.headers.get('etag');
    assert.ok(etag);
    const part1Buf = Buffer.from(await part1Res.arrayBuffer());
    assert.equal(Buffer.compare(part1Buf, payload.subarray(0, 512)), 0);

    // Part 2 (Resume from offset 512 with matching If-Range)
    const part2Res = await fetch(`${baseUrl}/api/download/ticket/${resumableTicket}`, {
      headers: { Range: 'bytes=512-', 'If-Range': etag!, 'Accept-Encoding': 'gzip, deflate, br' },
    });
    assert.equal(part2Res.status, 206);
    assert.equal(part2Res.headers.get('content-range'), `bytes 512-${payload.length - 1}/${payload.length}`);
    assert.equal(part2Res.headers.get('content-length'), String(payload.length - 512));
    const part2Buf = Buffer.from(await part2Res.arrayBuffer());
    assert.equal(Buffer.compare(Buffer.concat([part1Buf, part2Buf]), payload), 0);

    // Suffix byte-range: last 64 bytes
    const suffixRes = await fetch(`${baseUrl}/api/download/ticket/${resumableTicket}`, {
      headers: { Range: 'bytes=-64' },
    });
    assert.equal(suffixRes.status, 206);
    assert.equal(suffixRes.headers.get('content-range'), `bytes ${payload.length - 64}-${payload.length - 1}/${payload.length}`);
    assert.equal(suffixRes.headers.get('content-length'), '64');
    const suffixBuf = Buffer.from(await suffixRes.arrayBuffer());
    assert.equal(Buffer.compare(suffixBuf, payload.subarray(payload.length - 64)), 0);

    // Stale If-Range must fall back to full 200 OK instead of returning corrupt partial bytes
    const staleIfRangeRes = await fetch(`${baseUrl}/api/download/ticket/${resumableTicket}`, {
      headers: { Range: 'bytes=0-127', 'If-Range': '"stale-etag-mismatch"' },
    });
    assert.equal(staleIfRangeRes.status, 200);
    assert.equal(staleIfRangeRes.headers.get('content-length'), String(payload.length));
    const staleBody = Buffer.from(await staleIfRangeRes.arrayBuffer());
    assert.equal(Buffer.compare(staleBody, payload), 0);

    // Out-of-bounds and malformed byte-range must return 416 Range Not Satisfiable
    const oobRes = await fetch(`${baseUrl}/api/download/ticket/${resumableTicket}`, {
      headers: { Range: `bytes=${payload.length + 100}-${payload.length + 200}` },
    });
    assert.equal(oobRes.status, 416);
    assert.equal(oobRes.headers.get('content-range'), `bytes */${payload.length}`);

    const malformedRangeRes = await fetch(`${baseUrl}/api/download/ticket/${resumableTicket}`, {
      headers: { Range: 'bytes=not-a-number' },
    });
    assert.equal(malformedRangeRes.status, 416);

    // 3. Public share download supports HEAD + byte-range resume without double-counting HEAD or resume chunks
    const shareRes = await apiFetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: String(tgAccount1Id),
        fileId: String(fileDoc._id),
        maxDownloads: 2,
      }),
    });
    assert.equal(shareRes.status, 200);
    const { shareId } = (await shareRes.json()) as any;

    const publicHead = await fetch(`${baseUrl}/api/public/download/${shareId}`, {
      method: 'HEAD',
      headers: { 'Accept-Encoding': 'gzip, deflate, br' },
    });
    assert.equal(publicHead.status, 200);
    assert.equal(publicHead.headers.get('content-length'), String(payload.length));
    assert.equal(publicHead.headers.get('accept-ranges'), 'bytes');
    assert.equal(publicHead.headers.get('content-encoding'), null);

    const publicPart1 = await fetch(`${baseUrl}/api/public/download/${shareId}`, {
      headers: { Range: 'bytes=0-511' },
    });
    assert.equal(publicPart1.status, 206);
    assert.equal(publicPart1.headers.get('content-range'), `bytes 0-511/${payload.length}`);
    assert.equal(publicPart1.headers.get('content-length'), '512');
    const pubBuf1 = Buffer.from(await publicPart1.arrayBuffer());

    const publicPart2 = await fetch(`${baseUrl}/api/public/download/${shareId}`, {
      headers: { Range: 'bytes=512-' },
    });
    assert.equal(publicPart2.status, 206);
    assert.equal(publicPart2.headers.get('content-range'), `bytes 512-${payload.length - 1}/${payload.length}`);
    const pubBuf2 = Buffer.from(await publicPart2.arrayBuffer());
    assert.equal(Buffer.compare(Buffer.concat([pubBuf1, pubBuf2]), payload), 0);

    // Verify share downloadCount was only incremented once (HEAD + offset>0 resume chunk did not double-count)
    const shareDoc = await mockDb.collection('shares').findOne({ shareId });
    assert.equal(Number(shareDoc?.downloadCount || 0), 1);
  });

  await t.test('57. Telegram CHANNEL_INVALID surfaces clear 403 TG_CHANNEL_ACCESS_DENIED on downloads, tickets, and /api/accounts', async () => {
    const fileDoc = await mockDb.collection('tg_files').findOne({ accountId: tgAccount1Id, name: 'resumable-range-test.txt' });
    assert.ok(fileDoc);
    const origGetMessages = mockTgClient.getMessages;
    try {
      mockTgClient.getMessages = async () => {
        const rpcErr: any = new Error('400: CHANNEL_INVALID (caused by channels.GetChannels)');
        rpcErr.code = 400;
        rpcErr.errorMessage = 'CHANNEL_INVALID';
        throw rpcErr;
      };

      // 1. Direct download returns 403 JSON with actionable message (not generic 500 Streaming error)
      const dlRes = await apiFetch(`/api/download/${String(tgAccount1Id)}/${String(fileDoc._id)}`);
      assert.equal(dlRes.status, 403);
      const dlErr: any = await dlRes.json();
      assert.equal(dlErr.code, 'TG_CHANNEL_ACCESS_DENIED');
      assert.ok(String(dlErr.error || '').toLowerCase().includes('admin'));

      // 2. /api/accounts immediately flags this TG Drive account with error: true and errorMessage
      const accsRes = await apiFetch('/api/accounts');
      assert.equal(accsRes.status, 200);
      const accs: any[] = await accsRes.json();
      const tgAcc = accs.find((a) => a.id === String(tgAccount1Id));
      assert.ok(tgAcc);
      assert.equal(tgAcc.error, true);
      assert.equal(tgAcc.errorCode, 'TG_CHANNEL_ACCESS_DENIED');
      assert.ok(String(tgAcc.errorMessage || '').toLowerCase().includes('channel'));

      // 3. /api/download-tickets pre-checks channel access and returns 403 TG_CHANNEL_ACCESS_DENIED
      const ticketRes = await apiFetch('/api/download-tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: String(tgAccount1Id),
          fileId: String(fileDoc._id),
          singleUse: false,
          ttlSeconds: 3600,
        }),
      });
      assert.equal(ticketRes.status, 403);
      const ticketErr: any = await ticketRes.json();
      assert.equal(ticketErr.code, 'TG_CHANNEL_ACCESS_DENIED');
    } finally {
      mockTgClient.getMessages = origGetMessages;
      const tgAccDoc = await mockDb.collection('accounts').findOne({ _id: tgAccount1Id });
      if (tgAccDoc?.channelId) clearTgChannelAccessCache(tgAccDoc.channelId);
    }
  });

  await t.test('58. TG Drive JSON bulk import maps Forum Topics to folders, General topic to root, infers MIME, and skips duplicates', async () => {
    const forumAccId = new ObjectId();
    await mockDb.collection('accounts').insertOne({
      _id: forumAccId,
      userId: user1Id,
      accountType: 'tgdrive',
      channelId: '-100777888999',
      name: 'Forum Archive Group',
      email: 'Forum Group: -100777888999',
      chatType: 'supergroup',
      isForum: false,
      createdAt: new Date(),
    });

    const payload = {
      isForum: true,
      topics: [
        { threadId: 1, name: 'General' },
        { threadId: 12, name: 'Movies' },
        { topic_id: 45, title: 'Docs/Work' },
      ],
      files: [
        {
          messageId: 501,
          threadId: 1,
          name: 'readme.pdf',
          size: 2048,
          date: 1732000000,
        },
        {
          message_id: 502,
          topic_id: 12,
          file_name: 'Interstellar.mkv',
          file_size: 104857600,
          date: '2026-01-15T10:00:00Z',
          caption: '1080p',
        },
        {
          messageId: 503,
          threadId: 45,
          name: 'report.zip',
          size: 4096,
          mime_type: 'application/zip',
        },
        {
          // References a topic not pre-listed in topics[] -> should auto-create folder
          messageId: 504,
          threadId: 99,
          topicName: 'Music',
          name: 'track.mp3',
          size: 512000,
        },
      ],
    };

    const importRes = await apiFetch(`/api/tgdrive/${String(forumAccId)}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(importRes.status, 200);
    const importData: any = await importRes.json();
    assert.equal(importData.success, true);
    assert.equal(importData.isForum, true);
    assert.equal(importData.importedTopics, 3); // Movies, Docs - Work, Music (General threadId=1 maps to root)
    assert.equal(importData.importedFiles, 4);
    assert.equal(importData.skippedDuplicates, 0);

    // Re-importing the exact same JSON must be idempotent and skip all 4 duplicate messageIds
    const reimportRes = await apiFetch(`/api/tgdrive/${String(forumAccId)}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(reimportRes.status, 200);
    const reimportData: any = await reimportRes.json();
    assert.equal(reimportData.importedFiles, 0);
    assert.equal(reimportData.skippedDuplicates, 4);

    // Verify /api/accounts reflects isForum: true and fileCount: 4
    const accsRes = await apiFetch('/api/accounts');
    assert.equal(accsRes.status, 200);
    const accs: any[] = await accsRes.json();
    const forumAcc = accs.find((a) => a.id === String(forumAccId));
    assert.ok(forumAcc);
    assert.equal(forumAcc.isForum, true);
    assert.equal(forumAcc.fileCount, 4);

    // Verify root listing contains General-topic file + 3 topic folders
    const rootRes = await apiFetch(`/api/files?accountId=${String(forumAccId)}`);
    assert.equal(rootRes.status, 200);
    const rootItems: any[] = await rootRes.json();
    const folderNames = rootItems.filter((i) => i.type === 'folder').map((i) => i.name).sort();
    assert.deepEqual(folderNames, ['Docs - Work', 'Movies', 'Music']);
    const rootFile = rootItems.find((i) => i.type !== 'folder' && i.name === 'readme.pdf');
    assert.ok(rootFile);
    assert.equal(rootFile.type, 'pdf');
    assert.equal(rootFile.mimeType, 'application/pdf');

    // Verify Movies topic folder listing returns Interstellar.mkv with inferred video/x-matroska MIME
    const moviesRes = await apiFetch(`/api/files?accountId=${String(forumAccId)}&folderId=Movies`);
    assert.equal(moviesRes.status, 200);
    const moviesItems: any[] = await moviesRes.json();
    assert.equal(moviesItems.length, 1);
    assert.equal(moviesItems[0].name, 'Interstellar.mkv');
    assert.equal(moviesItems[0].type, 'video');
    assert.equal(moviesItems[0].mimeType, 'video/x-matroska');
    assert.equal(moviesItems[0].sizeBytes, 104857600);
  });

  await t.test('59. TG Drive JSON bulk import converts text messages into .txt notes with full download, HEAD, and byte-range support', async () => {
    const notesAccId = new ObjectId();
    await mockDb.collection('accounts').insertOne({
      _id: notesAccId,
      userId: user1Id,
      accountType: 'tgdrive',
      channelId: '-100555666777',
      name: 'Notes Forum Group',
      email: 'Forum Group: -100555666777',
      chatType: 'supergroup',
      isForum: true,
      createdAt: new Date(),
    });

    const sampleText = 'Deployment Checklist\n1. Add bot as admin\n2. Import JSON archive\n';
    const expectedBytes = Buffer.byteLength(sampleText, 'utf8');

    const importRes = await apiFetch(`/api/tgdrive/${String(notesAccId)}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        isForum: true,
        topics: [{ threadId: 77, name: 'Guides' }],
        files: [
          {
            messageId: 801,
            threadId: 77,
            text: sampleText,
            date: 1732100000,
          },
          {
            // Explicit note without inline text -> falls back to Telegram message.message on download
            messageId: 802,
            threadId: 77,
            type: 'note',
            name: 'Live Fetched Note',
          },
        ],
      }),
    });
    assert.equal(importRes.status, 200);
    const importBody: any = await importRes.json();
    assert.equal(importBody.importedFiles, 2);

    const listRes = await apiFetch(`/api/files?accountId=${String(notesAccId)}&folderId=Guides`);
    assert.equal(listRes.status, 200);
    const items: any[] = await listRes.json();
    assert.equal(items.length, 2);

    const note1 = items.find((i) => i.messageId === 801);
    assert.ok(note1);
    assert.equal(note1.name, 'Deployment Checklist.txt');
    assert.equal(note1.mimeType, 'text/plain');
    assert.equal(note1.type, 'doc');
    assert.equal(note1.isNote, true);
    assert.ok(String(note1.textPreview || '').includes('Deployment Checklist'));
    assert.equal(note1.sizeBytes, expectedBytes);

    const note2 = items.find((i) => i.messageId === 802);
    assert.ok(note2);
    assert.equal(note2.name, 'Live Fetched Note.txt');
    assert.equal(note2.mimeType, 'text/plain');

    // HEAD probe returns exact UTF-8 byte length and Accept-Ranges: bytes
    const headRes = await apiFetch(`/api/download/${String(notesAccId)}/${note1.id}`, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-length'), String(expectedBytes));
    assert.equal(headRes.headers.get('accept-ranges'), 'bytes');
    assert.ok((headRes.headers.get('content-type') || '').includes('text/plain'));

    // Full download returns exact UTF-8 text
    const fullRes = await apiFetch(`/api/download/${String(notesAccId)}/${note1.id}?preview=1`);
    assert.equal(fullRes.status, 200);
    assert.equal(await fullRes.text(), sampleText);

    // Byte-range 206 partial request returns exact slice
    const rangeRes = await apiFetch(`/api/download/${String(notesAccId)}/${note1.id}`, {
      headers: { Range: 'bytes=0-9' },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('content-range'), `bytes 0-9/${expectedBytes}`);
    assert.equal(await rangeRes.text(), sampleText.slice(0, 10));

    // Live Telegram fallback when textContent was omitted in JSON
    const origGetMessages = mockTgClient.getMessages;
    try {
      mockTgClient.getMessages = async () => [{ id: 802, message: 'Fetched straight from Telegram message text' }] as any;
      const liveRes = await apiFetch(`/api/download/${String(notesAccId)}/${note2.id}?preview=1`);
      assert.equal(liveRes.status, 200);
      assert.equal(await liveRes.text(), 'Fetched straight from Telegram message text');
    } finally {
      mockTgClient.getMessages = origGetMessages;
    }
  });

  await t.test('60. TG Drive JSON export returns topics, media, and notes in re-importable format', async () => {
    const srcAccId = new ObjectId();
    await mockDb.collection('accounts').insertOne({
      _id: srcAccId,
      userId: user1Id,
      accountType: 'tgdrive',
      channelId: '-100444333222',
      name: 'Backup Export Drive',
      email: 'Forum Group: -100444333222',
      chatType: 'supergroup',
      isForum: true,
      createdAt: new Date(),
    });

    await apiFetch(`/api/tgdrive/${String(srcAccId)}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        isForum: true,
        topics: [{ threadId: 21, name: 'Archives' }],
        files: [
          { messageId: 901, threadId: 21, name: 'backup.zip', size: 20480, mimeType: 'application/zip', date: 1732200000 },
          { messageId: 902, threadId: 21, text: 'Important backup note', date: 1732200100 },
        ],
      }),
    });

    // Other user must not export this account
    const deniedRes = await apiFetch(`/api/tgdrive/${String(srcAccId)}/export`, {}, token2);
    assert.equal(deniedRes.status, 403);

    const exportRes = await apiFetch(`/api/tgdrive/${String(srcAccId)}/export`);
    assert.equal(exportRes.status, 200);
    assert.ok((exportRes.headers.get('content-disposition') || '').includes('backup-export-drive-export.json'));
    const exported: any = await exportRes.json();

    assert.equal(exported.isForum, true);
    assert.equal(exported.driveName, 'Backup Export Drive');
    assert.equal(exported.topics.length, 1);
    assert.equal(exported.topics[0].threadId, 21);
    assert.equal(exported.topics[0].name, 'Archives');
    assert.equal(exported.files.length, 2);
    const exportedNote = exported.files.find((f: any) => f.messageId === 902);
    assert.equal(exportedNote.isNote, true);
    assert.equal(exportedNote.text, 'Important backup note');

    // Round-trip: import exported JSON into a brand new TG Drive account
    const dstAccId = new ObjectId();
    await mockDb.collection('accounts').insertOne({
      _id: dstAccId,
      userId: user1Id,
      accountType: 'tgdrive',
      channelId: '-100444333223',
      name: 'Restored Drive',
      email: 'Forum Group: -100444333223',
      chatType: 'supergroup',
      isForum: false,
      createdAt: new Date(),
    });

    const reimportRes = await apiFetch(`/api/tgdrive/${String(dstAccId)}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exported),
    });
    assert.equal(reimportRes.status, 200);
    const reimportData: any = await reimportRes.json();
    assert.equal(reimportData.importedTopics, 1);
    assert.equal(reimportData.importedFiles, 2);
  });

  await t.test('61. Multi-Bot Worker Pool handles FLOOD_WAIT cooldowns and per-channel ineligibility failover seamlessly', async () => {
    const calls: string[] = [];
    const mainClient = {
      connected: true,
      tag: 'main',
    };
    const worker1Client = {
      connected: true,
      tag: 'worker-1',
    };
    const worker2Client = {
      connected: true,
      tag: 'worker-2',
    };

    setTestDependencies({
      tgWorkerPool: [
        { id: 'main', role: 'main', client: mainClient },
        { id: 'worker-1', role: 'worker', client: worker1Client },
        { id: 'worker-2', role: 'worker', client: worker2Client },
      ],
    });

    try {
      // 1. Worker-1 hits FLOOD_WAIT_30; pool must immediately fail over to Worker-2 without failing caller
      const res1 = await withTgPoolClient(
        '-100777111000',
        async (client, slotId) => {
          calls.push(`op1:${slotId}`);
          if (slotId === 'worker-1') {
            const fw: any = new Error('FLOOD_WAIT_30');
            fw.seconds = 30;
            throw fw;
          }
          return { ok: true, slotId, tag: client.tag };
        },
        { preferWorker: true }
      );
      assert.equal(res1.ok, true);
      assert.equal(res1.slotId, 'worker-2');

      const statusAfterFlood = getTgBotPoolStatus();
      assert.equal(statusAfterFlood.totalBots, 3);
      assert.equal(statusAfterFlood.workerCount, 2);
      assert.equal(statusAfterFlood.healthyBots, 2);
      const w1Status = statusAfterFlood.bots.find((b) => b.id === 'worker-1');
      assert.equal(w1Status?.coolingDown, true);
      assert.ok((w1Status?.cooldownRemainingSec || 0) > 0);
      // Ensure tokens are never exposed in pool status
      assert.equal('token' in (w1Status as any), false);

      // 2. Worker-2 is not an admin in private channel -100777222000 (CHANNEL_INVALID); pool remembers ineligibility and routes to main
      const res2 = await withTgPoolClient(
        '-100777222000',
        async (_client, slotId) => {
          calls.push(`op2:${slotId}`);
          if (slotId === 'worker-2') {
            const err: any = new Error('400: CHANNEL_INVALID');
            err.errorMessage = 'CHANNEL_INVALID';
            throw err;
          }
          return { ok: true, slotId };
        },
        { preferWorker: true }
      );
      assert.equal(res2.ok, true);
      assert.equal(res2.slotId, 'main');

      // 3. Subsequent call on the same private channel skips worker-2 directly and uses main
      const res3 = await withTgPoolClient(
        '-100777222000',
        async (_client, slotId) => {
          calls.push(`op3:${slotId}`);
          return slotId;
        },
        { preferWorker: true }
      );
      assert.equal(res3, 'main');
      assert.ok(!calls.includes('op3:worker-2'));
    } finally {
      setTestDependencies({ tgWorkerPool: null });
    }
  });

  await t.test('62. GET /api/accounts/:accountId/manifest returns recursive folders/files for whole-drive Android downloads and enforces ownership', async () => {
    const manifestAccId = new ObjectId();
    await mockDb.collection('accounts').insertOne({
      _id: manifestAccId,
      userId: user1Id,
      accountType: 'tgdrive',
      channelId: '-100555666777',
      name: 'Android Sync Drive',
      email: 'Channel: -100555666777',
      createdAt: new Date(),
    });

    for (const folderDoc of [
      { accountId: manifestAccId, name: 'Photos', path: 'Photos', parent: '' },
      { accountId: manifestAccId, name: '2026', path: 'Photos/2026', parent: 'Photos' },
      { accountId: manifestAccId, name: 'Docs', path: 'Docs', parent: '' },
    ]) {
      await mockDb.collection('tg_folders').insertOne(folderDoc);
    }

    for (const fileDoc of [
      { accountId: manifestAccId, messageId: 1001, name: 'readme.txt', folder: '', size: 120, mimeType: 'text/plain', date: 1733000000, isNote: true, textContent: 'hello' },
      { accountId: manifestAccId, messageId: 1002, name: 'trip.jpg', folder: 'Photos/2026', size: 4096, mimeType: 'image/jpeg', date: 1733000100 },
      { accountId: manifestAccId, messageId: 1003, name: 'invoice.pdf', folder: 'Docs', size: 8192, mimeType: 'application/pdf', date: 1733000200 },
      { accountId: manifestAccId, messageId: 1004, name: 'deleted.bin', folder: 'Docs', size: 999, mimeType: 'application/octet-stream', date: 1733000300, trashed: true },
    ]) {
      await mockDb.collection('tg_files').insertOne(fileDoc);
    }

    // Cross-user access must be denied
    const denied = await apiFetch(`/api/accounts/${String(manifestAccId)}/manifest`, {}, token2);
    assert.equal(denied.status, 403);

    // Whole-drive manifest excludes trashed files and returns exact relative paths & byte totals
    const res = await apiFetch(`/api/accounts/${String(manifestAccId)}/manifest`);
    assert.equal(res.status, 200);
    const manifest: any = await res.json();
    assert.equal(manifest.accountId, String(manifestAccId));
    assert.equal(manifest.driveName, 'Android Sync Drive');
    assert.equal(manifest.totalFiles, 3);
    assert.equal(manifest.totalBytes, 120 + 4096 + 8192);
    assert.deepEqual(manifest.folders, ['Docs', 'Photos', 'Photos/2026']);
    const relPaths = manifest.files.map((f: any) => f.relativePath).sort();
    assert.deepEqual(relPaths, ['Docs/invoice.pdf', 'Photos/2026/trip.jpg', 'readme.txt']);

    // Subfolder-scoped manifest returns relative paths inside Photos/
    const subRes = await apiFetch(`/api/accounts/${String(manifestAccId)}/manifest?folderId=Photos`);
    assert.equal(subRes.status, 200);
    const subManifest: any = await subRes.json();
    assert.equal(subManifest.totalFiles, 1);
    assert.deepEqual(subManifest.folders, ['2026']);
    assert.equal(subManifest.files[0].relativePath, '2026/trip.jpg');
  });

  await t.test('63. POST /api/transfers/drive executes server-side whole-drive copy & move with folder replication, TG->TG fast-copy, note clone, and conflict skip', async () => {
    const srcDriveId = new ObjectId();
    const dstDriveId = new ObjectId();
    for (const accDoc of [
      {
        _id: srcDriveId,
        userId: user1Id,
        accountType: 'tgdrive',
        channelId: '-100888111001',
        name: 'Source TG Vault',
        email: 'Channel: -100888111001',
        createdAt: new Date(),
      },
      {
        _id: dstDriveId,
        userId: user1Id,
        accountType: 'tgdrive',
        channelId: '-100888111002',
        name: 'Target TG Vault',
        email: 'Channel: -100888111002',
        createdAt: new Date(),
      },
    ]) {
      await mockDb.collection('accounts').insertOne(accDoc);
    }

    await mockDb.collection('tg_folders').insertOne({
      accountId: srcDriveId,
      name: 'Work',
      path: 'Work',
      parent: '',
    });

    for (const fileDoc of [
      {
        accountId: srcDriveId,
        messageId: 2001,
        name: 'report.pdf',
        folder: 'Work',
        size: 5000,
        mimeType: 'application/pdf',
        date: 1733100000,
      },
      {
        accountId: srcDriveId,
        messageId: 2002,
        name: 'meeting-notes.txt',
        folder: 'Work',
        size: 19,
        mimeType: 'text/plain; charset=utf-8',
        isNote: true,
        textContent: 'Action items: ship!',
        textPreview: 'Action items: ship!',
        date: 1733100100,
      },
    ]) {
      await mockDb.collection('tg_files').insertOne(fileDoc);
    }

    // Same-account root-to-root must be rejected with 400
    const badRes = await apiFetch('/api/transfers/drive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceAccountId: String(srcDriveId),
        targetAccountId: String(srcDriveId),
        isMove: false,
      }),
    });
    assert.equal(badRes.status, 400);

    // Cross-user target account must be rejected with 403
    const otherUserAccId = new ObjectId();
    await mockDb.collection('accounts').insertOne({
      _id: otherUserAccId,
      userId: user2Id,
      accountType: 'tgdrive',
      channelId: '-100888999999',
      name: 'Other User Vault',
      email: 'Channel: -100888999999',
      createdAt: new Date(),
    });
    const forbiddenRes = await apiFetch('/api/transfers/drive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceAccountId: String(srcDriveId),
        targetAccountId: String(otherUserAccId),
        isMove: false,
      }),
    });
    assert.equal(forbiddenRes.status, 403);

    // Mock GramJS ForwardMessages zero-bandwidth fast-copy
    let forwardedCount = 0;
    const origInvoke = (mockTgClient as any).invoke;
    (mockTgClient as any).invoke = async () => {
      forwardedCount++;
      return { updates: [{ id: 9000 + forwardedCount }] };
    };

    try {
      // 1. Whole-drive COPY with target subfolder & fast-copy
      const copyRes = await apiFetch('/api/transfers/drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceAccountId: String(srcDriveId),
          targetAccountId: String(dstDriveId),
          targetFolderId: 'Mirrored',
          isMove: false,
          conflictStrategy: 'skip',
        }),
      });
      assert.equal(copyRes.status, 202);
      const copyJson: any = await copyRes.json();
      assert.ok(copyJson.jobId);

      // Wait for worker completion
      let jobState: any = null;
      for (let i = 0; i < 40; i++) {
        await runJobWorker();
        const jRes = await apiFetch(`/api/jobs/${copyJson.jobId}`);
        jobState = await jRes.json();
        if (jobState.status === 'completed' || jobState.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(jobState.status, 'completed');
      assert.equal(jobState.type, 'drive_transfer');
      assert.equal(jobState.totalItems, 2);
      assert.equal(jobState.itemsProcessed, 2);
      assert.equal(forwardedCount, 1);

      // Verify folders and files exist in destination under Mirrored/Work
      const dstFolders = await mockDb.collection('tg_folders').find({ accountId: dstDriveId }).toArray();
      assert.ok(dstFolders.some((f: any) => f.path === 'Mirrored/Work'));
      const dstFiles = await mockDb.collection('tg_files').find({ accountId: dstDriveId }).toArray();
      assert.equal(dstFiles.length, 2);
      const dstPdf = dstFiles.find((f: any) => f.name === 'report.pdf');
      assert.equal(dstPdf.folder, 'Mirrored/Work');
      assert.equal(dstPdf.messageId, 9001);
      const dstNote = dstFiles.find((f: any) => f.name === 'meeting-notes.txt');
      assert.equal(dstNote.folder, 'Mirrored/Work');
      assert.equal(dstNote.isNote, true);
      assert.equal(dstNote.textContent, 'Action items: ship!');

      // Source files remain untouched on COPY
      const srcFilesAfterCopy = await mockDb.collection('tg_files').find({ accountId: srcDriveId }).toArray();
      assert.equal(srcFilesAfterCopy.length, 2);

      // 2. Re-running COPY with conflictStrategy='skip' must skip both existing files (zero duplicates)
      const skipRes = await apiFetch('/api/transfers/drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceAccountId: String(srcDriveId),
          targetAccountId: String(dstDriveId),
          targetFolderId: 'Mirrored',
          isMove: false,
          conflictStrategy: 'skip',
        }),
      });
      assert.equal(skipRes.status, 202);
      const skipJson: any = await skipRes.json();
      let skipState: any = null;
      for (let i = 0; i < 40; i++) {
        await runJobWorker();
        const jRes = await apiFetch(`/api/jobs/${skipJson.jobId}`);
        skipState = await jRes.json();
        if (skipState.status === 'completed' || skipState.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(skipState.status, 'completed');
      const dstFilesAfterSkip = await mockDb.collection('tg_files').find({ accountId: dstDriveId }).toArray();
      assert.equal(dstFilesAfterSkip.length, 2);

      // 3. Whole-drive MOVE into 'MovedHere' transfers both files and removes them from source
      const moveRes = await apiFetch('/api/transfers/drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceAccountId: String(srcDriveId),
          targetAccountId: String(dstDriveId),
          targetFolderId: 'MovedHere',
          isMove: true,
          conflictStrategy: 'overwrite',
        }),
      });
      assert.equal(moveRes.status, 202);
      const moveJson: any = await moveRes.json();
      let moveState: any = null;
      for (let i = 0; i < 40; i++) {
        await runJobWorker();
        const jRes = await apiFetch(`/api/jobs/${moveJson.jobId}`);
        moveState = await jRes.json();
        if (moveState.status === 'completed' || moveState.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(moveState.status, 'completed');
      assert.equal(moveState.isMove, true);
      assert.equal(moveState.sourceDeleteApproved, true);

      const srcFilesAfterMove = await mockDb.collection('tg_files').find({ accountId: srcDriveId }).toArray();
      assert.equal(srcFilesAfterMove.length, 0);
      const movedDstFiles = await mockDb.collection('tg_files').find({ accountId: dstDriveId, folder: 'MovedHere/Work' }).toArray();
      assert.equal(movedDstFiles.length, 2);
    } finally {
      if (origInvoke) (mockTgClient as any).invoke = origInvoke;
      else delete (mockTgClient as any).invoke;
    }
  });

  await t.test('64. Server-side ZIP download tickets, ZIP-to-cloud, and Unzip background jobs preserve folders and enforce security', async () => {
    const zipAccId = new ObjectId();
    await mockDb.collection('accounts').insertOne({
      _id: zipAccId,
      userId: user1Id,
      accountType: 'tgdrive',
      channelId: '-100999888777',
      name: 'Archive Vault',
      email: 'Channel: -100999888777',
      createdAt: new Date(),
    });

    await mockDb.collection('tg_folders').insertOne({
      accountId: zipAccId,
      userId: user1Id,
      name: 'Docs',
      path: 'Docs',
      parent: '',
      createdAt: Math.floor(Date.now() / 1000),
    });

    const msgId1 = ++nextTgMsgId;
    telegramBlobs.set(msgId1, { bytes: Buffer.from('root-file-content'), caption: '', fileName: 'hello.txt' });
    const f1 = await mockDb.collection('tg_files').insertOne({
      accountId: zipAccId,
      userId: user1Id,
      messageId: msgId1,
      name: 'hello.txt',
      size: Buffer.byteLength('root-file-content'),
      mimeType: 'text/plain',
      folder: '',
      date: Math.floor(Date.now() / 1000),
      isEncrypted: false,
    });

    const msgId2 = ++nextTgMsgId;
    telegramBlobs.set(msgId2, { bytes: Buffer.from('nested-doc-content'), caption: '', fileName: 'guide.md' });
    await mockDb.collection('tg_files').insertOne({
      accountId: zipAccId,
      userId: user1Id,
      messageId: msgId2,
      name: 'guide.md',
      size: Buffer.byteLength('nested-doc-content'),
      mimeType: 'text/markdown',
      folder: 'Docs',
      date: Math.floor(Date.now() / 1000),
      isEncrypted: false,
    });

    const encFile = await mockDb.collection('tg_files').insertOne({
      accountId: zipAccId,
      userId: user1Id,
      messageId: ++nextTgMsgId,
      name: 'cyte_secret.cyte1',
      opaqueRemoteName: 'cyte_secret.cyte1',
      size: 64,
      mimeType: 'application/octet-stream',
      folder: '',
      date: Math.floor(Date.now() / 1000),
      isEncrypted: true,
    });

    // Encrypted CYTE1 unzip must be blocked with 422
    const encUnzipRes = await apiFetch('/api/archive/unzip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: String(zipAccId), fileId: String(encFile.insertedId) }),
    });
    assert.equal(encUnzipRes.status, 422);

    // 1. Streaming ZIP download ticket works once and burns on GET
    const ticketRes = await apiFetch('/api/archive/zip-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: String(zipAccId),
        fileIds: [String(f1.insertedId)],
        folderIds: ['folder:Docs'],
        archiveName: 'bundle.zip',
      }),
    });
    assert.equal(ticketRes.status, 201);
    const ticketJson: any = await ticketRes.json();
    assert.ok(ticketJson.downloadUrl);
    assert.ok(ticketJson.downloadPath);
    assert.equal(ticketJson.entryCount, 2);

    const testZipUrl = `${baseUrl}${ticketJson.downloadPath}`;
    const headZip = await fetch(testZipUrl, { method: 'HEAD' });
    assert.equal(headZip.status, 200);

    const streamZip = await fetch(testZipUrl);
    assert.equal(streamZip.status, 200);
    const zipBytes = Buffer.from(await streamZip.arrayBuffer());
    assert.equal(zipBytes.subarray(0, 2).toString('ascii'), 'PK');

    const secondUse = await fetch(testZipUrl);
    assert.equal(secondUse.status, 404);

    // 2. Server-side Zip-to-Cloud job creates bundle_cloud.zip in root
    const zipCloudRes = await apiFetch('/api/archive/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: String(zipAccId),
        fileIds: [String(f1.insertedId)],
        folderIds: ['Docs'],
        targetFolderId: 'root',
        archiveName: 'bundle_cloud.zip',
      }),
    });
    assert.equal(zipCloudRes.status, 202);
    const zipCloudJson: any = await zipCloudRes.json();
    let zipJobState: any = null;
    for (let i = 0; i < 40; i++) {
      await runJobWorker();
      const jRes = await apiFetch(`/api/jobs/${zipCloudJson.job.id}`);
      zipJobState = await jRes.json();
      if (zipJobState.status === 'completed' || zipJobState.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(zipJobState.status, 'completed');
    const createdZipDoc = await mockDb.collection('tg_files').findOne({ accountId: zipAccId, name: 'bundle_cloud.zip' });
    assert.ok(createdZipDoc, 'Created ZIP should be saved in target folder');

    // 3. Server-side Unzip job extracts bundle_cloud.zip into Extracted/ preserving Docs/guide.md
    const unzipRes = await apiFetch('/api/archive/unzip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: String(zipAccId),
        fileId: String(createdZipDoc._id),
        targetFolderId: 'Extracted',
        conflictStrategy: 'rename',
      }),
    });
    assert.equal(unzipRes.status, 202);
    const unzipJson: any = await unzipRes.json();
    let unzipJobState: any = null;
    for (let i = 0; i < 40; i++) {
      await runJobWorker();
      const jRes = await apiFetch(`/api/jobs/${unzipJson.job.id}`);
      unzipJobState = await jRes.json();
      if (unzipJobState.status === 'completed' || unzipJobState.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(unzipJobState.status, 'completed');

    const extractedRootFile = await mockDb.collection('tg_files').findOne({ accountId: zipAccId, folder: 'Extracted', name: 'hello.txt' });
    const extractedNestedFile = await mockDb.collection('tg_files').findOne({ accountId: zipAccId, folder: 'Extracted/Docs', name: 'guide.md' });
    assert.ok(extractedRootFile, 'Root file should be extracted into Extracted/');
    assert.ok(extractedNestedFile, 'Nested file should be extracted into Extracted/Docs/');
  });

  // ── 65. Multiple encrypted uploads and copies omit shareId (no duplicate null) & migration unsets stale shareId: null ──
  await t.test('65. Encrypted uploads & copies omit shareId and runEncryptionMigration unsets stale shareId: null', async () => {
    const legacyId = new ObjectId();
    await mockDb.collection('tg_files').insertOne({
      _id: legacyId,
      accountId: tgAccount1Id,
      userId: user1Id,
      messageId: 99001,
      name: 'c1e2a3b4c5d6e7f8a9b0c1d2e3f4a5b6.cyte',
      opaqueRemoteName: 'c1e2a3b4c5d6e7f8a9b0c1d2e3f4a5b6.cyte',
      isEncrypted: true,
      shareId: null,
      date: Math.floor(Date.now() / 1000),
    });

    await runEncryptionMigration(mockDb);
    const migrated = await mockDb.collection('tg_files').findOne({ _id: legacyId });
    assert.ok(migrated, 'Legacy encrypted doc should exist');
    assert.equal(Object.prototype.hasOwnProperty.call(migrated, 'shareId'), false, 'Migration must unset shareId: null');

    const encIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const cyte = buildCyte1Blob(Buffer.from(`android-encrypted-payload-${i}`, 'utf8'));
      const opaqueName = `cyte_android_multi_0${i}.cyte1`;
      const meta = buildValidEncryptedMetadata(`key_multi_${i}`);
      const sessRes = await apiFetch(`/api/upload-sessions/${String(tgAccount1Id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: opaqueName,
          opaqueRemoteName: opaqueName,
          mimeType: 'application/octet-stream',
          size: cyte.blob.length,
          encryptedSizeBytes: cyte.blob.length,
          checksum: cyte.sha256,
          idempotencyKey: `idem_multi_enc_${i}`,
          isEncrypted: true,
          encryptionFormatVersion: 1,
          encryptionKeyId: `key_multi_${i}`,
          encryptedMetadata: meta,
        }),
      });
      assert.equal(sessRes.status, 201);
      const { sessionId } = (await sessRes.json()) as any;
      const chunkRes = await apiFetch(`/api/upload-sessions/${sessionId}/chunks`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes 0-${cyte.blob.length - 1}/${cyte.blob.length}`,
        },
        body: cyte.blob,
      });
      assert.equal(chunkRes.status, 200);
      const completeRes = await apiFetch(`/api/upload-sessions/${sessionId}/complete`, { method: 'POST' });
      assert.equal(completeRes.status, 200);
      const storedDoc = await mockDb.collection('tg_files').findOne({ opaqueRemoteName: opaqueName });
      assert.ok(storedDoc, `Encrypted doc ${i} should be stored`);
      assert.equal(Object.prototype.hasOwnProperty.call(storedDoc, 'shareId'), false, `Encrypted doc ${i} must omit shareId`);
      encIds.push(String(storedDoc._id));
    }

    const copyRes = await apiFetch('/api/files/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceAccountId: String(tgAccount1Id),
        fileId: encIds[0],
        targetAccountId: String(tgAccount1Id),
        targetFolderId: 'CopiedVault',
      }),
    });
    assert.equal(copyRes.status, 200);
    const copiedDocs = await mockDb.collection('tg_files').find({ accountId: tgAccount1Id, folder: 'CopiedVault' }).toArray();
    assert.equal(copiedDocs.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(copiedDocs[0], 'shareId'), false, 'Copied encrypted doc must omit shareId');
  });

  // ── 66. Temp Drop Area: no-auth creation/upload/download/range/ZIP, passcode, upload_only, save-to-drive & expiry sweep ──
  await t.test('66. Temp Drop Area allows no-auth upload/access, enforces passcode & upload_only, supports save-to-drive, and sweeps expired rooms', async () => {
    // 1. Anonymous user creates a Temp Room without auth
    const createAnonRes = await fetch(`${baseUrl}/api/temp-rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Public Drop Room', note: 'Drop files here', ttlHours: 12 }),
    });
    assert.equal(createAnonRes.status, 201);
    const createdAnon: any = await createAnonRes.json();
    assert.ok(createdAnon.room?.roomCode);
    assert.ok(createdAnon.creatorToken);
    const anonCode = createdAnon.room.roomCode;

    // 2. Anonymous visitor uploads a file with zero auth
    const payloadBuf = Buffer.from('Hello Cloudyte Temp Drop 0123456789', 'utf8');
    const fd = new FormData();
    fd.append('file', new Blob([payloadBuf], { type: 'text/html' }), '../evil<script>.html');
    fd.append('uploadedByLabel', 'VisitorAli');
    const upRes = await fetch(`${baseUrl}/api/temp-rooms/${anonCode}/upload`, {
      method: 'POST',
      body: fd,
    });
    assert.equal(upRes.status, 201);
    const upJson: any = await upRes.json();
    assert.ok(upJson.file?.id);
    assert.equal(upJson.file.uploadedByLabel, 'VisitorAli');
    assert.ok(!upJson.file.name.includes('..'));

    // 3. Another anonymous visitor lists and downloads full + Range + ZIP with safe CSP/attachment headers
    const roomGetRes = await fetch(`${baseUrl}/api/temp-rooms/${anonCode}`);
    assert.equal(roomGetRes.status, 200);
    const roomGetJson: any = await roomGetRes.json();
    assert.equal(roomGetJson.files.length, 1);
    assert.equal(roomGetJson.room.isOwner, false);

    const dlRes = await fetch(`${baseUrl}/api/temp-rooms/${anonCode}/files/${upJson.file.id}/download`);
    assert.equal(dlRes.status, 200);
    assert.match(String(dlRes.headers.get('content-disposition') || ''), /^attachment;/);
    assert.match(String(dlRes.headers.get('content-security-policy') || ''), /sandbox/);
    assert.deepEqual(Buffer.from(await dlRes.arrayBuffer()), payloadBuf);

    const rangeRes = await fetch(`${baseUrl}/api/temp-rooms/${anonCode}/files/${upJson.file.id}/download`, {
      headers: { Range: 'bytes=0-4' },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(Buffer.from(await rangeRes.arrayBuffer()).toString('utf8'), 'Hello');

    const zipRes = await fetch(`${baseUrl}/api/temp-rooms/${anonCode}/zip`);
    assert.equal(zipRes.status, 200);
    const zipBytes = Buffer.from(await zipRes.arrayBuffer());
    assert.equal(zipBytes.subarray(0, 2).toString('utf8'), 'PK');

    // 4. Random visitor cannot delete room (403), while creator with X-Temp-Creator-Token can switch to upload_only
    const badDelRes = await fetch(`${baseUrl}/api/temp-rooms/${anonCode}`, { method: 'DELETE' });
    assert.equal(badDelRes.status, 403);

    const patchModeRes = await fetch(`${baseUrl}/api/temp-rooms/${anonCode}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Temp-Creator-Token': createdAnon.creatorToken },
      body: JSON.stringify({ accessMode: 'upload_only' }),
    });
    assert.equal(patchModeRes.status, 200);

    const visitorAfterMode = await fetch(`${baseUrl}/api/temp-rooms/${anonCode}`);
    assert.equal(visitorAfterMode.status, 200);
    const visitorAfterJson: any = await visitorAfterMode.json();
    assert.equal(visitorAfterJson.filesHidden, true);
    assert.equal(visitorAfterJson.files.length, 0);

    const visitorDlBlocked = await fetch(`${baseUrl}/api/temp-rooms/${anonCode}/files/${upJson.file.id}/download`);
    assert.equal(visitorDlBlocked.status, 403);

    // 5. Optional passcode protection blocks unauthorized access and unlocks with X-Temp-Passcode
    const passPatchRes = await fetch(`${baseUrl}/api/temp-rooms/${anonCode}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Temp-Creator-Token': createdAnon.creatorToken },
      body: JSON.stringify({ accessMode: 'both', passcode: 'drop999' }),
    });
    assert.equal(passPatchRes.status, 200);

    const lockedRes = await fetch(`${baseUrl}/api/temp-rooms/${anonCode}`);
    assert.equal(lockedRes.status, 403);
    const unlockedRes = await fetch(`${baseUrl}/api/temp-rooms/${anonCode}`, {
      headers: { 'X-Temp-Passcode': 'drop999' },
    });
    assert.equal(unlockedRes.status, 200);

    // 6. Authenticated owner creates room, visitor uploads, owner saves file directly to TG Drive
    const ownerRoomRes = await apiFetch('/api/temp-rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Owner Vault Drop', ttlHours: 24 }),
    });
    assert.equal(ownerRoomRes.status, 201);
    const ownerRoomJson: any = await ownerRoomRes.json();
    const ownerCode = ownerRoomJson.room.roomCode;

    const fd2 = new FormData();
    fd2.append('file', new Blob([Buffer.from('Save me to TG Drive', 'utf8')], { type: 'text/plain' }), 'guest_note.txt');
    const up2Res = await fetch(`${baseUrl}/api/temp-rooms/${ownerCode}/upload`, { method: 'POST', body: fd2 });
    assert.equal(up2Res.status, 201);
    const up2Json: any = await up2Res.json();

    const saveRes = await apiFetch(`/api/temp-rooms/${ownerCode}/files/${up2Json.file.id}/save-to-drive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAccountId: String(tgAccount1Id), targetFolderId: 'root' }),
    });
    assert.equal(saveRes.status, 200);
    const savedDoc = await mockDb.collection('tg_files').findOne({ accountId: tgAccount1Id, name: 'guest_note.txt' });
    assert.ok(savedDoc, 'Temp file should be saved to TG Drive');

    // 7. Expired temp room & disk files are purged cleanly by sweepExpiredTempDrop
    await mockDb.collection('temp_rooms').updateOne(
      { roomCode: ownerCode },
      { $set: { expiresAt: new Date(Date.now() - 60_000) } }
    );
    const sweepResult = await sweepExpiredTempDrop(mockDb);
    assert.ok(sweepResult.expiredRooms >= 1);
    const goneRoomRes = await fetch(`${baseUrl}/api/temp-rooms/${ownerCode}`);
    assert.equal(goneRoomRes.status, 404);
  });

  await t.test('67. Drive-backed Temp Drop rooms require owner auth to bind Drive, accept zero-auth uploads/downloads/ZIP, and preserve files on expiry', async () => {
    // 1. Anonymous user cannot bind another user's Drive account
    const unauthBindRes = await fetch(`${baseUrl}/api/temp-rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Unauthorized Bind',
        targetAccountId: String(tgAccount1Id),
      }),
    });
    assert.equal(unauthBindRes.status, 401);

    // 2. Owner creates a Drive-backed Temp Drop room targeting TG Drive folder 'TempInbox'
    const createDriveRoomRes = await apiFetch('/api/temp-rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Client Inbox on TG Drive',
        targetAccountId: String(tgAccount1Id),
        targetFolderId: 'folder:TempInbox',
        targetFolderName: 'TempInbox',
        deleteOnExpire: false,
        ttlHours: 24,
      }),
    });
    assert.equal(createDriveRoomRes.status, 201);
    const createdJson: any = await createDriveRoomRes.json();
    const driveRoomCode = createdJson.room.roomCode;
    assert.equal(createdJson.room.storageMode, 'drive');
    assert.equal(createdJson.room.targetAccountId, String(tgAccount1Id));
    assert.equal(createdJson.room.targetFolderId, 'TempInbox');
    assert.equal(createdJson.room.deleteOnExpire, false);

    // 3. Anonymous visitor uploads directly into the Drive-backed room (no auth header)
    const drivePayload = Buffer.from('Stored straight in Telegram Drive via Temp Drop!', 'utf8');
    const fd = new FormData();
    fd.append('uploadedByLabel', 'ExternalClient');
    fd.append('file', new Blob([drivePayload], { type: 'text/plain' }), 'drive_backed_drop.txt');

    const upRes = await fetch(`${baseUrl}/api/temp-rooms/${driveRoomCode}/upload`, {
      method: 'POST',
      body: fd,
    });
    assert.equal(upRes.status, 201);
    const upJson: any = await upRes.json();
    assert.equal(upJson.file.storageMode, 'drive');

    const tgDoc = await mockDb.collection('tg_files').findOne({
      accountId: tgAccount1Id,
      folder: 'TempInbox',
      name: 'drive_backed_drop.txt',
    });
    assert.ok(tgDoc, 'Uploaded temp file should be persisted straight into TG Drive');

    // 4. Anonymous visitor downloads full + Range + ZIP directly from Drive-backed temp room
    const dlRes = await fetch(`${baseUrl}/api/temp-rooms/${driveRoomCode}/files/${upJson.file.id}/download`);
    assert.equal(dlRes.status, 200);
    assert.deepEqual(Buffer.from(await dlRes.arrayBuffer()), drivePayload);

    const zipRes = await fetch(`${baseUrl}/api/temp-rooms/${driveRoomCode}/zip`);
    assert.equal(zipRes.status, 200);
    const zipBytes = Buffer.from(await zipRes.arrayBuffer());
    assert.equal(zipBytes.subarray(0, 2).toString('utf8'), 'PK');

    // 5. Expiring room closes the public link while preserving the file in TG Drive (deleteOnExpire: false)
    await mockDb.collection('temp_rooms').updateOne(
      { roomCode: driveRoomCode },
      { $set: { expiresAt: new Date(Date.now() - 60_000) } }
    );
    await sweepExpiredTempDrop(mockDb);

    const expiredGet = await fetch(`${baseUrl}/api/temp-rooms/${driveRoomCode}`);
    assert.equal(expiredGet.status, 404);
    const stillInDrive = await mockDb.collection('tg_files').findOne({ _id: tgDoc._id });
    assert.ok(stillInDrive, 'Drive file must remain preserved when deleteOnExpire is false');
  });
});




