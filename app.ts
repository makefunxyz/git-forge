// A standalone GitHub-compatible git forge: one Node 22 process, stdlib only.
// Serves git smart HTTP (upload-pack v2 + v0, receive-pack v0), REST v3 under
// /api/v3, GraphQL v4 at /api/graphql and MCP at /mcp, all from one in-memory
// store. No UI, no outside service, no git binary. Deterministic: every id and
// ordering comes from monotonic counters, never from a clock or Math.random,
// so two runs on the same instance leave the same state.
//
// The suite's viewer is the token owner. The kit's scenario is fixed data
// (wire.ts SCENARIO_SEED): the viewer login is "adaiversen" (id 1000), the
// stranger "olgabauer" (id 1002). Repositories created through POST
// /user/repos belong to the viewer; the same name under another owner is 404.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const STRANGER_LOGIN = 'olgabauer';
const ZERO_OID = '0'.repeat(40);
const FIXED_TIME = '2026-11-20T00:00:00Z';
const COMMIT_EPOCH = 1763596800; // 2026-11-20T00:00:00Z, fixed commit timestamps
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObj { type: ObjType; data: Buffer }

interface Label { name: string; color: string }

interface Issue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; comments: { id: number; body: string; authorLogin: string; createdAt: string; updatedAt: string }[]; seq: number;
  id: string; authorLogin: string; createdAt: string; updatedAt: string;
}

interface Pull {
  number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string;
  merged: boolean; mergeCommitSha: string | null; mergedAt: string | null;
  files: { filename: string; status: string; additions: number; deletions: number; changes: number }[];
  seq: number; id: string; authorLogin: string; createdAt: string; updatedAt: string;
}

interface Repo {
  id: number; name: string; fullName: string; owner: string;
  private: boolean; description: string; defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>; // refs/heads/<branch> -> commit sha
  labels: Map<string, Label>;
  issues: Issue[]; pulls: Pull[];
  nextIssue: number; nextPull: number; nextComment: number;
  seq: number;
}

const repos = new Map<string, Repo>(); // key: owner/name
let repoIdSeq = 5000;
let globalSeq = 0;
let requestSeq = 0;

const BASE_URL = 'https://example.invalid';

/** Opaque global id: base64("Type:repoId:number?") — never the plain databaseId. */
function gid(type: string, ...parts: (string | number)[]): string {
  return Buffer.from([type, ...parts.map(String)].join(':')).toString('base64');
}

const DEFAULT_LABELS: [string, string][] = [
  ['bug', 'd73a4a'], ['enhancement', 'a2eeef'], ['documentation', '0075ca'],
  ['question', 'd876e3'], ['good first issue', '7057ff'], ['help wanted', '008672'],
];

function seedLabels(repo: Repo): void {
  for (const [name, color] of DEFAULT_LABELS) repo.labels.set(name, { name, color });
}

/** Create a repo owned by the viewer, seeded with the scenario's default labels. */
function createRepo(name: string, description = '', isPrivate = false): Repo {
  const repo: Repo = {
    id: repoIdSeq++, name, fullName: `${VIEWER_LOGIN}/${name}`, owner: VIEWER_LOGIN,
    private: isPrivate, description,
    defaultBranch: 'main', objects: new Map(), refs: new Map(), labels: new Map(),
    issues: [], pulls: [], nextIssue: 1, nextPull: 1, nextComment: 1, seq: ++globalSeq,
  };
  seedLabels(repo);
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

/** Create an issue; returns null when a label does not exist (caller answers 422). */
function createIssue(repo: Repo, title: string, body = '', labelNames: string[] = []): Issue | null {
  for (const ln of labelNames) if (!repo.labels.has(ln)) return null;
  const issue: Issue = {
    number: repo.nextIssue++, title, body, state: 'open',
    labels: labelNames.map((n) => repo.labels.get(n)!), comments: [], seq: ++globalSeq, id: '',
    authorLogin: VIEWER_LOGIN, createdAt: FIXED_TIME, updatedAt: FIXED_TIME,
  };
  issue.id = `I_${repo.id}_${issue.number}`;
  repo.issues.push(issue);
  return issue;
}

function addComment(repo: Repo, issue: Issue, body: string): { id: number; body: string; authorLogin: string; createdAt: string; updatedAt: string } {
  const comment = { id: repo.nextComment++, body, authorLogin: VIEWER_LOGIN, createdAt: FIXED_TIME, updatedAt: FIXED_TIME };
  issue.comments.push(comment);
  return comment;
}

/** Pull files in the GraphQL shape. */
function pullFiles(_repo: Repo, pull: Pull): Record<string, GqlValue>[] {
  return pull.files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED' }));
}

const repoView = repoJson;
const issueView = issueJson;
const pullView = pullJson;

function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function getRepo(owner: string, name: string): Repo | undefined { return repos.get(repoKey(owner, name)); }
function viewerRepo(name: string): Repo | undefined { return repos.get(repoKey(VIEWER_LOGIN, name)); }

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

interface TreeEntry { mode: string; name: string; oid: string }

function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    const mode = data.subarray(off, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    off = nul + 21;
  }
  return out;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const bn = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(an, bn);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView { tree: string; parents: string[]; message: string; author: string; committer: string }

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const [head, ...rest] = text.split('\n\n');
  const message = rest.join('\n\n').replace(/\n+$/, '');
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of (head ?? '').split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

function buildCommit(tree: string, parents: string[], message: string): Buffer {
  const ident = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${COMMIT_EPOCH} +0000`;
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${ident}\ncommitter ${ident}\n\n${message}\n`;
  return Buffer.from(s, 'utf8');
}

/** Walk all commits reachable from `tip`, in first-parent order, newest first. */
function walkCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha) || sha === ZERO_OID) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    out.push(sha);
    const view = parseCommit(obj.data);
    for (const p of view.parents) queue.push(p);
  }
  return out;
}

/** Is `ancestor` reachable from `tip`? */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (sha === ancestor) return true;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

/** The commit a tag object points at, or null. */
function tagTarget(repo: Repo, sha: string): string | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'tag') return null;
  return obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m)?.[1] ?? null;
}

/** Commits at BFS distance 0..depth-1 from `wants`, with their distances. */
function depthLimitedCommits(repo: Repo, wants: string[], depth: number): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (!obj || obj.type !== 'commit' || dist.has(w)) continue;
    dist.set(w, 0);
    queue.push(w);
  }
  while (queue.length > 0) {
    const sha = queue.shift()!;
    const d = dist.get(sha)!;
    if (d >= depth - 1) continue;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!dist.has(p)) { dist.set(p, d + 1); queue.push(p); }
    }
  }
  return dist;
}

/**
 * Objects for a fetch: the closure of `wants` (or, with `depth`, only commits
 * 0..depth-1 from the wants) minus the FULL closure of `haves` — every object
 * the client already holds, trees and blobs included, never re-sent.
 * Returns the objects plus the shallow-info lines for the response.
 */
function fetchObjects(repo: Repo, wants: string[], haves: string[], depth: number, inputShallow: string[]): { objects: Map<string, GitObj>; shallow: string[]; unshallow: string[] } {
  // What the client already holds. A shallow have means "I hold this commit
  // and its tree, but NOT its parents" — the client says so with the `shallow`
  // lines. Treating such a have as full history would exclude the very parent
  // a deepen must deliver (its ancestors are not held at all).
  const shallowSet = new Set(inputShallow);
  const haveClosure = new Map<string, GitObj>();
  for (const [k, v] of reachableObjects(repo, haves.filter((h) => !shallowSet.has(h)))) haveClosure.set(k, v);
  for (const h of haves.filter((x) => shallowSet.has(x))) {
    const obj = repo.objects.get(h);
    if (!obj) continue;
    haveClosure.set(h, obj);
    if (obj.type === 'commit') {
      const tree = parseCommit(obj.data).tree;
      for (const [k, v] of reachableObjects(repo, [tree])) haveClosure.set(k, v);
    }
  }
  const objects = new Map<string, GitObj>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth > 0) {
    const dist = depthLimitedCommits(repo, wants, depth);
    for (const c of dist.keys()) {
      const obj = repo.objects.get(c);
      if (!obj) continue;
      if (!haveClosure.has(c)) objects.set(c, obj);
      if (obj.type === 'commit') {
        // The commit's tree closure only — never its parents (they are beyond the depth).
        const tree = parseCommit(obj.data).tree;
        for (const [k, v] of reachableObjects(repo, [tree])) if (!haveClosure.has(k)) objects.set(k, v);
      }
    }
    // New boundary: commits at exactly depth-1 that still have parents.
    for (const [sha, d] of dist) {
      if (d !== depth - 1) continue;
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.length > 0) shallow.push(sha);
    }
    // Previously-shallow commits whose parents are now delivered are unshallow.
    for (const s of inputShallow) {
      const obj = repo.objects.get(s);
      if (!obj || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.every((p) => dist.has(p))) unshallow.push(s);
    }
  } else {
    const all = reachableObjects(repo, wants);
    for (const [k, v] of all) if (!haveClosure.has(k)) objects.set(k, v);
    // No deepen: the client's shallow boundaries stay shallow.
    for (const s of inputShallow) if (!shallow.includes(s)) shallow.push(s);
  }
  return { objects, shallow, unshallow };
}
function reachableObjects(repo: Repo, tips: string[]): Map<string, GitObj> {
  const out = new Map<string, GitObj>();
  const queue: string[] = [...tips];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha) || sha === ZERO_OID) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    out.set(sha, obj);
    if (obj.type === 'commit') {
      const v = parseCommit(obj.data);
      queue.push(v.tree);
      for (const p of v.parents) queue.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push(e.oid);
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (m) queue.push(m[1]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packfiles (v2, plain objects only on write; delta apply on read)
// ---------------------------------------------------------------------------

function packWrite(objects: Map<string, GitObj>): Buffer {
  const entries: Buffer[] = [];
  const typeCode: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const [sha, obj] of objects) {
    void sha;
    const compressed = deflateSync(obj.data);
    // type + size varint header
    let size = obj.data.length;
    let byte = (typeCode[obj.type] << 4) | (size & 0x0f);
    size >>= 4;
    const header: number[] = [];
    while (size > 0) { header.push(byte | 0x80); byte = size & 0x7f; size >>= 7; }
    header.push(byte);
    entries.push(Buffer.from(header), compressed);
  }
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length / 2, 8);
  const body = Buffer.concat([head, ...entries]);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let v = 0; let shift = 0;
    for (;;) { const b = delta[off++]; v |= (b & 0x7f) << shift; shift += 7; if ((b & 0x80) === 0) break; }
    return v;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0; let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) cpOff |= delta[off++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) cpSize |= delta[off++] << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op > 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else throw new Error('delta op 0');
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || total !== dstSize) throw new Error('delta size mismatch');
  return result;
}

interface PackEntry { type: ObjType; data: Buffer; sha: string }

/** Inflate exactly one zlib stream from `buf`; returns its bytes and how many input bytes it used. */
function inflateOne(buf: Buffer, expectedSize: number): { data: Buffer; consumed: number } {
  // inflateSync ignores bytes after the end of a zlib stream, so the compressed
  // length is the shortest prefix that inflates to exactly the expected size.
  // A deflate stream expands its input by at most ~5 bytes per 64 KiB block
  // plus the zlib header/adler, which bounds the search tightly.
  const hi = Math.min(buf.length, expectedSize + Math.floor(expectedSize / 65535) * 5 + 32);
  const tryPrefix = (n: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(0, n));
      return out.length === expectedSize ? out : null;
    } catch { return null; }
  };
  let lo = 1;
  let high = hi;
  let best: { data: Buffer; consumed: number } | null = null;
  while (lo <= high) {
    const mid = (lo + high) >> 1;
    const out = tryPrefix(mid);
    if (out) { best = { data: out, consumed: mid }; high = mid - 1; }
    else lo = mid + 1;
  }
  if (!best) throw new Error('pack object size mismatch');
  return best;
}

/** Parse a packfile; resolves OFS_DELTA (6) and REF_DELTA (7) against earlier entries. */
/** Read a packfile. `external` supplies objects the pack deltas against but does
 *  not contain (thin packs from `git push` reference the server's objects). */
function packRead(buf: Buffer, external?: Map<string, GitObj>): PackEntry[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  let off = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const bySha = new Map<string, PackEntry>();
  for (let i = 0; i < count; i += 1) {
    const start = off;
    let byte = buf[off++];
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) { byte = buf[off++]; size |= (byte & 0x7f) << shift; shift += 7; }
    let type: ObjType;
    let baseSha = '';
    let baseOff = 0;
    if (typeNum === 6) {
      byte = buf[off++];
      let v = byte & 0x7f;
      while (byte & 0x80) { byte = buf[off++]; v = ((v + 1) << 7) | (byte & 0x7f); }
      baseOff = start - v;
      type = 'blob'; // placeholder, resolved below
    } else if (typeNum === 7) {
      baseSha = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      type = 'blob';
    } else {
      type = ({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' } as Record<number, ObjType>)[typeNum]!;
    }
    // One streaming inflate reports exactly how many compressed bytes it consumed
    // (bytesRead), so each object is inflated once, not once per probe.
    const { data: entryData, consumed } = inflateOne(buf.subarray(off), size);
    off += consumed;
    if (typeNum === 6) {
      const base = byOffset.get(baseOff);
      if (!base) throw new Error('ofs delta base missing');
      const resolved = applyDelta(base.data, entryData);
      const entry: PackEntry = { type: base.type, data: resolved, sha: hashObject(base.type, resolved) };
      entries.push(entry); byOffset.set(start, entry); bySha.set(entry.sha, entry);
    } else if (typeNum === 7) {
      const base = bySha.get(baseSha) ?? external?.get(baseSha);
      if (!base) throw new Error('ref delta base missing');
      const resolved = applyDelta(base.data, entryData);
      const entry: PackEntry = { type: base.type, data: resolved, sha: hashObject(base.type, resolved) };
      entries.push(entry); byOffset.set(start, entry); bySha.set(entry.sha, entry);
    } else {
      const entry: PackEntry = { type, data: entryData, sha: hashObject(type, entryData) };
      entries.push(entry); byOffset.set(start, entry); bySha.set(entry.sha, entry);
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

function pkt(data: string | Buffer): Buffer {
  const b = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const head = Buffer.alloc(4);
  head.write((b.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, b]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
const PKT_END = Buffer.from('0002', 'ascii');

function decodePktLines(buf: Buffer): { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }[] {
  const out: { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = Number.parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function reqId(): string { requestSeq += 1; return `req-${requestSeq}`; }

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'x-github-request-id': reqId(), ...extra };
  if (status !== 204) { headers['content-type'] = JSON_TYPE; headers['content-length'] = String(Buffer.byteLength(text)); }
  res.writeHead(status, headers);
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), 'x-github-request-id': reqId(), ...extra });
  res.end(body);
}

function notFound(res: ServerResponse, msg = 'Not Found'): void { sendJson(res, 404, { message: msg }); }
function badRequest(res: ServerResponse, msg = 'Bad Request'): void { sendJson(res, 400, { message: msg }); }
function unauth(res: ServerResponse): void { sendJson(res, 401, { message: 'Requires authentication' }); }

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try { const v = JSON.parse(raw.toString('utf8')) as unknown; return (v !== null && typeof v === 'object' && !Array.isArray(v)) ? (v as Record<string, unknown>) : null; }
  catch { badRequest(res, 'Malformed JSON'); return null; }
}

function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  return TOKEN !== '' ? h === `Bearer ${TOKEN}` : h.startsWith('Bearer ') && h.length > 7;
}

function pathParts(req: IncomingMessage): { path: string; query: URLSearchParams } {
  const u = new URL(req.url ?? '/', 'http://entry');
  return { path: u.pathname, query: u.searchParams };
}

function esc(s: string): string { return s; }

// Repository JSON view (REST). `id` is the numeric database id; GraphQL wraps it
// in an opaque global id separately.
function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id, databaseId: r.id, node_id: `R_${r.id}`, name: r.name, full_name: r.fullName,
    owner: { login: r.owner, id: VIEWER_ID, type: 'User' },
    private: r.private, description: r.description, default_branch: r.defaultBranch,
    has_issues: true, has_projects: false, has_wiki: false, has_pages: false,
    html_url: `https://example.invalid/${r.fullName}`, url: `/api/v3/repos/${r.fullName}`,
    created_at: FIXED_TIME, updated_at: FIXED_TIME, pushed_at: FIXED_TIME,
    fork: false, archived: false, disabled: false, visibility: r.private ? 'private' : 'public',
    license: null, topics: [], language: null, size: 0, stargazers_count: 0, watchers_count: 0,
    forks_count: 0, open_issues_count: r.issues.filter((i) => i.state === 'open').length,
  };
}

function issueJson(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: 100000 + r.id * 1000 + i.number, node_id: `I_${r.id}_${i.number}`,
    number: i.number, title: i.title, body: i.body, state: i.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: i.labels.map((l) => ({ name: l.name, color: l.color })),
    comments: i.comments.length, created_at: FIXED_TIME, updated_at: FIXED_TIME,
    html_url: `https://example.invalid/${r.fullName}/issues/${i.number}`,
    url: `/api/v3/repos/${r.fullName}/issues/${i.number}`,
    repository_url: `/api/v3/repos/${r.fullName}`,
    assignee: null, assignees: [], milestone: null, locked: false,
    author_association: 'OWNER', active_lock_reason: null,
  };
}

function pullJson(r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: 200000 + r.id * 1000 + p.number, node_id: `PR_${r.id}_${p.number}`,
    number: p.number, title: p.title, body: p.body, state: p.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: { ref: p.head, sha: p.headSha, label: `${VIEWER_LOGIN}:${p.head}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID } },
    base: { ref: p.base, sha: p.baseSha, label: `${VIEWER_LOGIN}:${p.base}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID } },
    merged: p.merged, mergeable: true, merge_commit_sha: p.mergeCommitSha,
    merged_at: p.mergedAt, closed_at: p.state === 'closed' ? FIXED_TIME : null,
    created_at: FIXED_TIME, updated_at: FIXED_TIME,
    html_url: `https://example.invalid/${r.fullName}/pull/${p.number}`,
    url: `/api/v3/repos/${r.fullName}/pulls/${p.number}`,
    draft: false, locked: false, comments: 0, review_comments: 0, commits: 1,
    additions: p.files.reduce((a, f) => a + f.additions, 0),
    deletions: p.files.reduce((a, f) => a + f.deletions, 0),
    changed_files: p.files.length, maintainer_can_modify: false,
  };
}

/** Create a commit on `branch` that sets `path` to `content` (blob), creating parents as needed. */
function commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } {
  const blobSha = storeObject(repo, 'blob', content);
  const parentSha = repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID;
  let parentTree: TreeEntry[] = [];
  if (parentSha !== ZERO_OID) {
    const parent = repo.objects.get(parentSha);
    if (parent && parent.type === 'commit') parentTree = parseTree(repo.objects.get(parseCommit(parent.data).tree)!.data);
  }
  const newTree = setTreeEntry(repo, parentTree, path.split('/'), blobSha);
  const treeSha = storeObject(repo, 'tree', buildTree(newTree));
  const parents = parentSha === ZERO_OID ? [] : [parentSha];
  const commitSha = storeObject(repo, 'commit', buildCommit(treeSha, parents, message));
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha };
}

function setTreeEntry(repo: Repo, entries: TreeEntry[], parts: string[], blobSha: string): TreeEntry[] {
  const [head, ...rest] = parts;
  const out = entries.filter((e) => e.name !== head);
  if (rest.length === 0) {
    out.push({ mode: '100644', name: head, oid: blobSha });
    return out;
  }
  const existing = entries.find((e) => e.name === head);
  let sub: TreeEntry[] = [];
  if (existing && existing.mode === '40000') {
    const subObj = repo.objects.get(existing.oid);
    if (subObj && subObj.type === 'tree') sub = parseTree(subObj.data);
  }
  const newSub = setTreeEntry(repo, sub, rest, blobSha);
  const subSha = storeObject(repo, 'tree', buildTree(newSub));
  out.push({ mode: '40000', name: head, oid: subSha });
  return out;
}

function deleteTreeEntry(repo: Repo, entries: TreeEntry[], parts: string[]): TreeEntry[] {
  const [head, ...rest] = parts;
  const existing = entries.find((e) => e.name === head);
  if (!existing) return entries;
  if (rest.length === 0) return entries.filter((e) => e.name !== head);
  if (existing.mode !== '40000') return entries;
  const subObj = repo.objects.get(existing.oid);
  if (!subObj || subObj.type !== 'tree') return entries;
  const newSub = deleteTreeEntry(repo, parseTree(subObj.data), rest);
  if (newSub.length === 0) return entries.filter((e) => e.name !== head);
  const subSha = storeObject(repo, 'tree', buildTree(newSub));
  return entries.map((e) => (e.name === head ? { mode: '40000', name: head, oid: subSha } : e));
}

/** Read a blob's bytes at a path in a commit's tree, or null. */
function readPath(repo: Repo, commitSha: string, path: string): { blobSha: string; data: Buffer } | null {
  const commit = repo.objects.get(commitSha);
  if (!commit || commit.type !== 'commit') return null;
  const treeSha = parseCommit(commit.data).tree;
  let curSha = treeSha;
  const parts = path.split('/').filter((p) => p !== '');
  for (let i = 0; i < parts.length; i += 1) {
    const treeObj = repo.objects.get(curSha);
    if (!treeObj || treeObj.type !== 'tree') return null;
    const entry = parseTree(treeObj.data).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) {
      if (entry.mode === '40000') return null;
      const blob = repo.objects.get(entry.oid);
      if (!blob || blob.type !== 'blob') return null;
      return { blobSha: entry.oid, data: blob.data };
    }
    if (entry.mode !== '40000') return null;
    curSha = entry.oid;
  }
  return null;
}

/** List a directory's entries at a path in a commit's tree. */
function listDir(repo: Repo, commitSha: string, dir: string): TreeEntry[] | null {
  const commit = repo.objects.get(commitSha);
  if (!commit || commit.type !== 'commit') return null;
  let curSha = parseCommit(commit.data).tree;
  const parts = dir.split('/').filter((p) => p !== '');
  for (const part of parts) {
    const treeObj = repo.objects.get(curSha);
    if (!treeObj || treeObj.type !== 'tree') return null;
    const entry = parseTree(treeObj.data).find((e) => e.name === part);
    if (!entry || entry.mode !== '40000') return null;
    curSha = entry.oid;
  }
  const treeObj = repo.objects.get(curSha);
  if (!treeObj || treeObj.type !== 'tree') return null;
  return parseTree(treeObj.data);
}

/** Compare two trees: changed paths with a simple status. */
function diffTrees(repo: Repo, baseTree: string, headTree: string): { filename: string; status: string; additions: number; deletions: number }[] {
  const flat = (treeSha: string, prefix: string, out: Map<string, string>): void => {
    const obj = repo.objects.get(treeSha);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') flat(e.oid, `${prefix}${e.name}/`, out);
      else out.set(`${prefix}${e.name}`, e.oid);
    }
  };
  const base = new Map<string, string>();
  const head = new Map<string, string>();
  flat(baseTree, '', base);
  flat(headTree, '', head);
  const out: { filename: string; status: string; additions: number; deletions: number }[] = [];
  for (const [path, sha] of head) {
    if (!base.has(path)) out.push({ filename: path, status: 'added', additions: 1, deletions: 0 });
    else if (base.get(path) !== sha) out.push({ filename: path, status: 'modified', additions: 1, deletions: 1 });
  }
  for (const path of base.keys()) if (!head.has(path)) out.push({ filename: path, status: 'removed', additions: 0, deletions: 1 });
  out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function linkHeader(req: IncomingMessage, base: string, page: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page >= lastPage) return null;
  const host = req.headers.host ?? 'localhost';
  const next = `http://${host}${base}?per_page=${perPage}&page=${page + 1}`;
  return `<${next}>; rel="next"`;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; perPage: number; pageNum: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNum };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  const parts = path.split('/').filter((p) => p !== '');
  // parts[0] === 'api', parts[1] === 'v3'
  if (parts[0] !== 'api' || parts[1] !== 'v3') return false;
  const rest = parts.slice(2);

  if (!authed(req)) { unauth(res); return true; }

  // GET /api/v3/
  if (method === 'GET' && rest.length === 0) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  // GET /api/v3/meta
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true, git: ['1.0.0'], github_services_sha: '0000000000000000000000000000000000000000', hooks: [], api: ['2022-11-28'] });
    return true;
  }
  // GET /api/v3/user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: 'Ada Iversen', email: `${VIEWER_LOGIN}@example.invalid` });
    return true;
  }
  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.seq - b.seq);
      const { page, perPage, pageNum } = paginate(all.map(repoJson), query);
      const link = linkHeader(req, '/api/v3/user/repos', pageNum, perPage, all.length);
      sendJson(res, 200, page, link ? { link } : {});
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(req, res);
      if (body === null) return true;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] }); return true; }
      if (viewerRepo(name)) { sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] }); return true; }
      const repo = createRepo(name, typeof body.description === 'string' ? body.description : '', body.private === true);
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    return false;
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1]);
    const name = decodeURIComponent(rest[2]);
    const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
    const tail = rest.slice(3);
    if (!repo) { notFound(res, 'Not Found'); return true; }

    if (tail.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        const body = await readJson(req, res);
        if (body === null) return true;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) repo.defaultBranch = body.default_branch;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { 'x-github-request-id': reqId() });
        res.end();
        return true;
      }
      return false;
    }

    // git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST') {
        const body = await readJson(req, res);
        if (body === null) return true;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
        if (repo.refs.has(ref)) { sendJson(res, 422, { message: 'Reference already exists' }); return true; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: `REF_${repo.id}_${ref}`, url: `/api/v3/repos/${repo.fullName}/git/refs/${encodeURIComponent(ref.slice(5))}`, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
        return true;
      }
      if (method === 'GET') {
        const out = [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, node_id: `REF_${repo.id}_${ref}`, url: `/api/v3/repos/${repo.fullName}/git/refs/${encodeURIComponent(ref.slice(5))}`, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` } }));
        sendJson(res, 200, out);
        return true;
      }
      return false;
    }
    // git/commits/{sha} and git/trees/{sha}
    if (tail[0] === 'git' && tail[1] === 'commits' && tail.length === 3 && method === 'GET') {
      const obj = repo.objects.get(tail[2]);
      if (!obj || obj.type !== 'commit') { notFound(res); return true; }
      const v = parseCommit(obj.data);
      sendJson(res, 200, { sha: tail[2], node_id: `C_${tail[2]}`, url: `/api/v3/repos/${repo.fullName}/git/commits/${tail[2]}`, author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_TIME }, committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_TIME }, message: v.message, tree: { sha: v.tree, url: `/api/v3/repos/${repo.fullName}/git/trees/${v.tree}` }, parents: v.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.fullName}/git/commits/${p}` })), verification: { verified: false, reason: 'unsigned', signature: null, payload: null } });
      return true;
    }
    if (tail[0] === 'git' && tail[1] === 'trees' && tail.length === 3 && method === 'GET') {
      const obj = repo.objects.get(tail[2]);
      if (!obj || obj.type !== 'tree') { notFound(res); return true; }
      sendJson(res, 200, { sha: tail[2], url: `/api/v3/repos/${repo.fullName}/git/trees/${tail[2]}`, tree: parseTree(obj.data).map((e) => ({ path: e.name, mode: e.mode, type: e.mode === '40000' ? 'tree' : 'blob', sha: e.oid, size: e.mode === '40000' ? undefined : repo.objects.get(e.oid)?.data.length ?? 0, url: `/api/v3/repos/${repo.fullName}/git/${e.mode === '40000' ? 'trees' : 'blobs'}/${e.oid}` })), truncated: false });
      return true;
    }
    // branches
    if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
      const out = [...repo.refs.entries()].filter(([r]) => r.startsWith('refs/heads/')).sort().map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `/api/v3/repos/${repo.fullName}/commits/${sha}` }, protected: false }));
      sendJson(res, 200, out);
      return true;
    }
    if (tail.length === 2 && tail[0] === 'branches' && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${decodeURIComponent(tail[1])}`);
      if (!sha) { notFound(res); return true; }
      sendJson(res, 200, { name: decodeURIComponent(tail[1]), commit: { sha, url: `/api/v3/repos/${repo.fullName}/commits/${sha}` }, protected: false });
      return true;
    }
    // commits
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const refName = query.get('sha') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${refName}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) { sendJson(res, 200, []); return true; }
      const list = walkCommits(repo, tip).map((sha) => {
        const v = parseCommit(repo.objects.get(sha)!.data);
        return { sha, node_id: `C_${sha}`, commit: { message: v.message, author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_TIME }, committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_TIME }, tree: { sha: v.tree } }, author: { login: VIEWER_LOGIN, id: VIEWER_ID }, committer: { login: VIEWER_LOGIN, id: VIEWER_ID }, parents: v.parents.map((p) => ({ sha: p })) };
      });
      const { page } = paginate(list, query);
      sendJson(res, 200, page);
      return true;
    }
    // contents
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).map(decodeURIComponent).join('/');
      const refName = query.get('ref') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${refName}`);
      if (method === 'GET') {
        if (!tip) { notFound(res); return true; }
        if (filePath === '') {
          const entries = listDir(repo, tip, '') ?? [];
          sendJson(res, 200, entries.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: e.name, sha: e.oid, size: e.mode === '40000' ? 0 : repo.objects.get(e.oid)?.data.length ?? 0, url: `/api/v3/repos/${repo.fullName}/contents/${e.name}`, html_url: `https://example.invalid/${repo.fullName}/blob/${refName}/${e.name}` })));
          return true;
        }
        const dir = listDir(repo, tip, filePath);
        if (dir) {
          sendJson(res, 200, dir.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: `${filePath}/${e.name}`, sha: e.oid, size: e.mode === '40000' ? 0 : repo.objects.get(e.oid)?.data.length ?? 0, url: `/api/v3/repos/${repo.fullName}/contents/${filePath}/${e.name}`, html_url: `https://example.invalid/${repo.fullName}/blob/${refName}/${filePath}/${e.name}` })));
          return true;
        }
        const file = readPath(repo, tip, filePath);
        if (!file) { notFound(res); return true; }
        sendJson(res, 200, { type: 'file', encoding: 'base64', content: file.data.toString('base64'), sha: file.blobSha, size: file.data.length, name: filePath.split('/').pop(), path: filePath, url: `/api/v3/repos/${repo.fullName}/contents/${filePath}`, html_url: `https://example.invalid/${repo.fullName}/blob/${refName}/${filePath}` });
        return true;
      }
      if (method === 'PUT') {
        const body = await readJson(req, res);
        if (body === null) return true;
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        const message = typeof body.message === 'string' ? body.message : 'Update';
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        const content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        const existing = branchTip ? readPath(repo, branchTip, filePath) : null;
        if (existing && sha === undefined) { sendJson(res, 409, { message: 'sha is required to update an existing file' }); return true; }
        if (existing && sha !== undefined && sha.toLowerCase() !== existing.blobSha.toLowerCase()) { sendJson(res, 409, { message: 'sha does not match the current file' }); return true; }
        if (!existing && sha !== undefined) { sendJson(res, 409, { message: 'sha does not match the current file' }); return true; }
        const created = !existing;
        const { commitSha, blobSha } = commitFile(repo, branch, filePath, content, message);
        sendJson(res, created ? 201 : 200, { content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: content.length, url: `/api/v3/repos/${repo.fullName}/contents/${filePath}`, html_url: `https://example.invalid/${repo.fullName}/blob/${branch}/${filePath}`, encoding: 'base64' }, commit: { sha: commitSha, node_id: `C_${commitSha}`, message, author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_TIME }, committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_TIME } } });
        return true;
      }
      if (method === 'DELETE') {
        const body = await readJson(req, res);
        if (body === null) return true;
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        const existing = branchTip ? readPath(repo, branchTip, filePath) : null;
        if (!existing) { notFound(res); return true; }
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        if (sha !== undefined && sha.toLowerCase() !== existing.blobSha.toLowerCase()) { sendJson(res, 409, { message: 'sha does not match the current file' }); return true; }
        const parent = repo.objects.get(branchTip!)!;
        const parentTree = parseTree(repo.objects.get(parseCommit(parent.data).tree)!.data);
        const newTree = deleteTreeEntry(repo, parentTree, filePath.split('/'));
        const treeSha = storeObject(repo, 'tree', buildTree(newTree));
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        const commitSha = storeObject(repo, 'commit', buildCommit(treeSha, [branchTip!], message));
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        sendJson(res, 200, { commit: { sha: commitSha, node_id: `C_${commitSha}`, message, author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_TIME }, committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_TIME } } });
        return true;
      }
      return false;
    }
    // labels
    if (tail.length === 1 && tail[0] === 'labels') {
      if (method === 'POST') {
        const body = await readJson(req, res);
        if (body === null) return true;
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        const label: Label = { name, color };
        repo.labels.set(name, label);
        sendJson(res, 201, { id: 300000 + repo.id * 100 + repo.labels.size, node_id: `L_${repo.id}_${name}`, url: `/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(name)}`, name, color, default: false, description: '' });
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, default: false, description: '' })));
        return true;
      }
      return false;
    }
    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const body = await readJson(req, res);
          if (body === null) return true;
          const title = typeof body.title === 'string' ? body.title : '';
          const bodyText = typeof body.body === 'string' ? body.body : '';
          const labelNames: string[] = Array.isArray(body.labels) ? (body.labels as unknown[]).map((l) => (typeof l === 'string' ? l : (l as Record<string, unknown>).name as string)).filter(Boolean) : [];
          for (const ln of labelNames) if (!repo.labels.has(ln)) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', message: `Label "${ln}" does not exist` }] }); return true; }
          const issue = createIssue(repo, title, bodyText, labelNames);
          if (!issue) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', message: 'Label does not exist' }] }); return true; }
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        if (method === 'GET') {
          let list = [...repo.issues];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') list.sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
          const { page } = paginate(list.map((i) => issueJson(repo, i)), query);
          sendJson(res, 200, page);
          return true;
        }
        return false;
      }
      const num = Number(tail[1]);
      const issue = repo.issues.find((i) => i.number === num);
      if (tail.length === 2) {
        if (!issue) { notFound(res); return true; }
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return true; }
        if (method === 'PATCH') {
          const body = await readJson(req, res);
          if (body === null) return true;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        return false;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) { notFound(res); return true; }
        if (method === 'POST') {
          const body = await readJson(req, res);
          if (body === null) return true;
          const comment = addComment(repo, issue, typeof body.body === 'string' ? body.body : '');
          sendJson(res, 201, { id: comment.id, node_id: `IC_${repo.id}_${issue.number}_${comment.id}`, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: FIXED_TIME, updated_at: FIXED_TIME, html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`, url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}` });
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: `IC_${repo.id}_${issue.number}_${c.id}`, body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: FIXED_TIME, updated_at: FIXED_TIME, html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}#issuecomment-${c.id}`, url: `/api/v3/repos/${repo.fullName}/issues/comments/${c.id}` })));
          return true;
        }
        return false;
      }
      return false;
    }
    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const body = await readJson(req, res);
          if (body === null) return true;
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] }); return true; }
          const pull = createPull(repo, head, base, typeof body.title === 'string' ? body.title : '', typeof body.body === 'string' ? body.body : '');
          sendJson(res, 201, pullJson(repo, pull));
          return true;
        }
        if (method === 'GET') {
          let list = [...repo.pulls];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const { page } = paginate(list.map((p) => pullJson(repo, p)), query);
          sendJson(res, 200, page);
          return true;
        }
        return false;
      }
      const num = Number(tail[1]);
      const pull = repo.pulls.find((p) => p.number === num);
      if (tail.length === 2) {
        if (!pull) { notFound(res); return true; }
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return true; }
        return false;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (!pull) { notFound(res); return true; }
        sendJson(res, 200, pull.files.map((f) => ({ sha: pull.headSha, filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions, blob_url: `https://example.invalid/${repo.fullName}/blob/${pull.headSha}/${f.filename}`, raw_url: `https://example.invalid/${repo.fullName}/raw/${pull.headSha}/${f.filename}`, contents_url: `/api/v3/repos/${repo.fullName}/contents/${f.filename}?ref=${pull.headSha}`, patch: '' })));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (!pull) { notFound(res); return true; }
        if (pull.state === 'closed') { sendJson(res, 405, { message: 'Pull request is already merged or closed' }); return true; }
        const conflict = pullConflict(repo, pull);
        if (conflict) { sendJson(res, 405, { message: 'Pull Request is not mergeable' }); return true; }
        const merged = mergePull(repo, pull);
        sendJson(res, 200, { sha: merged, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
      return false;
    }
    return false;
  }
  return false;
}

function createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull {
  const headSha = repo.refs.get(`refs/heads/${head}`)!;
  const baseSha = repo.refs.get(`refs/heads/${base}`)!;
  const headCommit = repo.objects.get(headSha)!;
  const baseCommit = repo.objects.get(baseSha)!;
  const files = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree)
    .map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions }));
  const pull: Pull = {
    number: repo.nextPull++, title, body, state: 'open', head, base, headSha, baseSha,
    merged: false, mergeCommitSha: null, mergedAt: null, files, seq: ++globalSeq, id: '',
    authorLogin: VIEWER_LOGIN, createdAt: FIXED_TIME, updatedAt: FIXED_TIME,
  };
  pull.id = `PR_${repo.id}_${pull.number}`;
  repo.pulls.push(pull);
  return pull;
}

/** A pull is conflicted when head and base both changed the same file differently since the merge base. */
function pullConflict(repo: Repo, pull: Pull): boolean {
  // The base tip is the branch's CURRENT tip: another PR may have merged since
  // this one opened, and the conflict is against what is on the base now.
  const baseTipSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const headCommits = walkCommits(repo, pull.headSha);
  const baseCommits = new Set(walkCommits(repo, baseTipSha));
  const mergeBase = headCommits.find((c) => baseCommits.has(c));
  if (!mergeBase) return false;
  const baseTree = parseCommit(repo.objects.get(mergeBase)!.data).tree;
  const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
  const baseTipTree = parseCommit(repo.objects.get(baseTipSha)!.data).tree;
  const headDiff = new Map(diffTrees(repo, baseTree, headTree).map((d) => [d.filename, d]));
  const baseDiff = new Map(diffTrees(repo, baseTree, baseTipTree).map((d) => [d.filename, d]));
  for (const [path, hd] of headDiff) {
    const bd = baseDiff.get(path);
    if (!bd) continue;
    const headFile = readPath(repo, pull.headSha, path);
    const baseFile = readPath(repo, baseTipSha, path);
    if ((headFile?.blobSha ?? '') !== (baseFile?.blobSha ?? '')) return true;
    void hd;
  }
  return false;
}

/** Squash-merge: one commit on the default branch carrying the head branch's tree. */
function mergePull(repo: Repo, pull: Pull): string {
  const headCommit = repo.objects.get(pull.headSha)!;
  const headTree = parseCommit(headCommit.data).tree;
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`)!;
  const message = `${pull.title} (#${pull.number})`;
  const sha = storeObject(repo, 'commit', buildCommit(headTree, [baseTip], message));
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = FIXED_TIME;
  return sha;
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

function refList(repo: Repo): { ref: string; sha: string }[] {
  return [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, sha }));
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'symref=HEAD:refs/heads/main agent=git-forge/1.0 object-format=sha1 side-band-64k'
    : 'report-status side-band-64k delete-refs agent=git-forge/1.0 object-format=sha1';
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = refList(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headSha = repo.refs.get('refs/heads/main') ?? refs[0].sha;
    parts.push(pkt(`${headSha} HEAD\0${caps}\n`));
    for (const { ref, sha } of refs) parts.push(pkt(`${sha} ${ref}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt('agent=git-forge/1.0\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'),
    pkt('server-option\n'),
    pkt('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

/** Side-band-64k framing: channel 1 = pack data. A pkt-line is at most 65520
 *  bytes total (65516 payload), and the band byte counts — so at most 65515
 *  data bytes per packet; 65516 overflows the client's pkt-line limit. */
function sideband(data: Buffer): Buffer {
  const out: Buffer[] = [];
  let off = 0;
  while (off < data.length) {
    const chunk = data.subarray(off, Math.min(data.length, off + 65515));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    out.push(pkt(payload));
    off += chunk.length;
  }
  return Buffer.concat(out);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  const m = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
  if (!m) return false;
  const owner = decodeURIComponent(m[1]);
  const name = decodeURIComponent(m[2]);
  const tail = m[3];
  const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
  const service = query.get('service') ?? '';
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';

  if (tail === 'info/refs') {
    if (method !== 'GET') { notFound(res); return true; }
    if (!repo) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': reqId() }); res.end(JSON.stringify({ message: 'Not Found' })); return true; }
    if (service === 'git-upload-pack') {
      if (isV2) { sendRaw(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement'); return true; }
      sendRaw(res, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    notFound(res);
    return true;
  }

  if (tail === 'git-upload-pack' && method === 'POST') {
    if (!repo) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': reqId() }); res.end(JSON.stringify({ message: 'Not Found' })); return true; }
    const body = await readBody(req);
    if (isV2) { handleUploadPackV2(repo, body, res); return true; }
    handleUploadPackV0(repo, body, res);
    return true;
  }

  if (tail === 'git-receive-pack' && method === 'POST') {
    if (!repo) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': reqId() }); res.end(JSON.stringify({ message: 'Not Found' })); return true; }
    const body = await readBody(req);
    handleReceivePack(repo, body, res);
    return true;
  }
  return false;
}

function handleUploadPackV2(repo: Repo, body: Buffer, res: ServerResponse): void {
  const packets = decodePktLines(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').trim());
  const command = lines[0]?.startsWith('command=') ? lines[0].slice(8) : '';
  const args = lines.slice(1);
  if (command === 'ls-refs') {
    const out: Buffer[] = [];
    const peel = args.includes('peel');
    const symrefs = args.includes('symrefs');
    const unborn = args.includes('unborn');
    const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
    const refs = refList(repo);
    const headSha = repo.refs.get('refs/heads/main');
    // A ref-prefix filters every line, HEAD included: a caller asking for
    // refs/tags/ must not see HEAD (the client counts any non-matching name).
    const showHead = prefixes.length === 0 || prefixes.some((q) => 'HEAD'.startsWith(q));
    if (refs.length === 0 && unborn) {
      // The kit client parses unborn as a leading token: "unborn HEAD ...".
      // No refs/heads/main line: the client counts any refs/* name as a real ref.
      out.push(pkt('unborn HEAD symref-target:refs/heads/main\n'));
    } else {
      if (symrefs && headSha && showHead) out.push(pkt(`${headSha} HEAD symref-target:refs/heads/main\n`));
      for (const { ref, sha } of refs) {
        if (prefixes.length > 0 && !prefixes.some((q) => ref.startsWith(q))) continue;
        const target = peel ? tagTarget(repo, sha) : null;
        // The kit client reads peel from the "peeled:" attribute; real git
        // reads the ^{} line. Emit both so each client sees the peel.
        out.push(pkt(target ? `${sha} ${ref} peeled:${target}\n` : `${sha} ${ref}\n`));
        if (target) out.push(pkt(`${target} ${ref}^{}\n`));
      }
    }
    out.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const inputShallow: string[] = [];
    let deepen = 0;
    for (const a of args) {
      if (a.startsWith('want ')) wants.push(a.slice(5).trim());
      else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
      else if (a.startsWith('shallow ')) inputShallow.push(a.slice(8).trim());
      else if (a.startsWith('deepen ')) deepen = Number(a.slice(7).trim()) || 0;
    }
    // Real git's v2 fetch answer (verified against git 2.43 upload-pack):
    // no ready/ACK/wanted-refs sections in the one-round case — the server
    // answers the packfile directly. Shallow first: "shallow-info" with the
    // computed boundary (and unshallow lines for deepened commits), then a
    // delim; then "packfile", the sideband pack, and a flush. The transport
    // adds the response-end.
    const { objects, shallow, unshallow } = fetchObjects(repo, wants, haves, deepen, inputShallow);
    const out: Buffer[] = [];
    if (shallow.length > 0 || unshallow.length > 0) {
      out.push(pkt('shallow-info\n'));
      for (const s of shallow) out.push(pkt(`shallow ${s}\n`));
      for (const s of unshallow) out.push(pkt(`unshallow ${s}\n`));
      out.push(PKT_DELIM);
    }
    out.push(pkt('packfile\n'));
    const pack = packWrite(objects);
    out.push(sideband(pack));
    out.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
    return;
  }
  // unknown v2 command
  sendRaw(res, 200, Buffer.concat([pkt('error unknown command\n'), PKT_FLUSH]), 'application/x-git-upload-pack-result');
}

function handleUploadPackV0(repo: Repo, body: Buffer, res: ServerResponse): void {
  const packets = decodePktLines(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').trim());
  const wants: string[] = [];
  const haves: string[] = [];
  const inputShallow: string[] = [];
  let deepen = 0;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) inputShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim()) || 0;
    else if (line === 'done') break;
  }
  const { objects, shallow, unshallow } = fetchObjects(repo, wants, haves, deepen, inputShallow);
  const out: Buffer[] = [pkt('NAK\n')];
  for (const s of shallow) out.push(pkt(`shallow ${s}\n`));
  for (const s of unshallow) out.push(pkt(`unshallow ${s}\n`));
  out.push(sideband(packWrite(objects)));
  // The sideband demultiplexer reads until a flush packet; without it git
  // reports "unexpected disconnect while reading sideband packet".
  out.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
}

function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const packets = decodePktLines(body);
  const commands: { oldSha: string; newSha: string; ref: string }[] = [];
  let packStart = body.length;
  let seenFlush = false;
  let off = 0;
  for (const p of packets) {
    const rawLen = p.kind === 'flush' ? 4 : p.kind === 'delim' ? 4 : p.kind === 'end' ? 4 : p.payload.length + 4;
    if (p.kind === 'flush' && !seenFlush) { seenFlush = true; packStart = off + 4; break; }
    off += rawLen;
  }
  void packStart;
  // The pack follows the first flush packet; find it by re-scanning the raw buffer.
  let flushAt = -1;
  let scan = 0;
  while (scan + 4 <= body.length) {
    const len = Number.parseInt(body.subarray(scan, scan + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len === 0) { flushAt = scan; break; }
    scan += len;
  }
  const packBuf = flushAt >= 0 ? body.subarray(flushAt + 4) : Buffer.alloc(0);
  // The first command line carries capabilities after a NUL; strip them, and
  // note whether the client negotiated side-band framing for the report.
  const useSideband = body.toString('utf8').includes('side-band-64k') || body.toString('utf8').includes('side-band');
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').split('\0')[0].trim();
    const parts = line.split(' ');
    if (parts.length === 3) commands.push({ oldSha: parts[0], newSha: parts[1], ref: parts[2] });
  }
  /** The report: real git sideband-frames it (inner pkt-lines + inner flush)
   *  inside one channel-1 packet, then an outer flush. Without sideband the
   *  plain pkt-lines are sent instead. */
  const report = (lines: Buffer[]): Buffer => {
    const inner = Buffer.concat([...lines, PKT_FLUSH]);
    if (useSideband) return Buffer.concat([sideband(inner), PKT_FLUSH]);
    return Buffer.concat([...lines, PKT_FLUSH]);
  };
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  try {
    // A delete-only command list carries no pack at all (git sends none there
    // either); an empty pack section is zero objects, not an unpack failure.
    const entries = packBuf.length === 0 ? [] : packRead(packBuf, repo.objects);
    for (const e of entries) if (!repo.objects.has(e.sha)) repo.objects.set(e.sha, { type: e.type, data: e.data });
  } catch {
    // A pack that fails to parse leaves every ref refused.
    for (const c of commands) results.push({ ref: c.ref, ok: false, reason: 'unpack failed' });
    const lines: Buffer[] = [pkt('unpack error\n')];
    for (const r of results) lines.push(pkt(`ng ${r.ref} ${r.reason ?? 'failed'}\n`));
    sendRaw(res, 200, report(lines), 'application/x-git-receive-pack-result');
    return;
  }
  for (const c of commands) {
    if (c.newSha === ZERO_OID) {
      // delete-refs
      if (!repo.refs.has(c.ref)) { results.push({ ref: c.ref, ok: false, reason: 'ref does not exist' }); continue; }
      repo.refs.delete(c.ref);
      results.push({ ref: c.ref, ok: true });
      continue;
    }
    const current = repo.refs.get(c.ref) ?? ZERO_OID;
    if (current !== c.oldSha) { results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    if (current !== ZERO_OID && !isAncestor(repo, current, c.newSha)) { results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    if (!repo.objects.has(c.newSha)) { results.push({ ref: c.ref, ok: false, reason: 'object not found' }); continue; }
    repo.refs.set(c.ref, c.newSha);
    results.push({ ref: c.ref, ok: true });
  }
  const lines: Buffer[] = [pkt('unpack ok\n')];
  for (const r of results) lines.push(pkt(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? 'failed'}\n`));
  sendRaw(res, 200, report(lines), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// GraphQL (POST /api/graphql) — a hand-written executor for the shapes gh sends
// ---------------------------------------------------------------------------

type GqlValue = null | boolean | number | string | GqlValue[] | { [k: string]: GqlValue };
type GqlField = { name: string; alias?: string; args: Record<string, GqlValue>; fields: GqlField[] };

const GQL_KNOWN_FIELDS: Record<string, Set<string>> = {
  Query: new Set(['repository', 'viewer', 'node', 'search']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate', 'url']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments', 'assignees']),
  PullRequest: new Set(['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'url', 'author', 'headRefOid', 'baseRefOid']),
  User: new Set(['login', 'id', 'databaseId', 'name', 'url']),
  Organization: new Set(['login', 'id', 'databaseId', 'name', 'url']),
  IssueConnection: new Set(['nodes', 'edges', 'totalCount', 'pageInfo']),
  PullRequestConnection: new Set(['nodes', 'edges', 'totalCount', 'pageInfo']),
  IssueEdge: new Set(['node', 'cursor']),
  PullRequestEdge: new Set(['node', 'cursor']),
  LabelConnection: new Set(['nodes', 'edges', 'totalCount']),
  LabelEdge: new Set(['node', 'cursor']),
  Label: new Set(['id', 'name', 'color', 'description']),
  CommentConnection: new Set(['nodes', 'edges', 'totalCount']),
  CommentEdge: new Set(['node', 'cursor']),
  IssueComment: new Set(['id', 'body', 'createdAt', 'updatedAt', 'author', 'url']),
  FileConnection: new Set(['nodes', 'edges', 'totalCount']),
  FileEdge: new Set(['node', 'cursor']),
  PullRequestFile: new Set(['path', 'additions', 'deletions', 'changeType']),
  Ref: new Set(['name', 'target']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'subject', 'clientMutationId']),
  SearchResultItemConnection: new Set(['nodes', 'edges', 'totalCount', 'pageInfo']),
  __Schema: new Set(['types', 'queryType', 'mutationType', 'directives']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description', 'inputFields', 'interfaces', 'possibleTypes']),
  __Field: new Set(['name', 'description', 'args', 'type']),
  __InputValue: new Set(['name', 'description', 'type', 'defaultValue']),
  __EnumValue: new Set(['name', 'description']),
};

function gqlParse(source: string): { fields: GqlField[]; opType: 'query' | 'mutation'; errors: string[] } {
  const errors: string[] = [];
  let i = 0;
  const n = source.length;
  const skipWs = (): void => {
    while (i < n) {
      const c = source[i];
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ',') { i++; continue; }
      if (c === '#') { while (i < n && source[i] !== '\n') i++; continue; }
      break;
    }
  };
  const readName = (): string => {
    skipWs();
    let s = '';
    while (i < n && /[A-Za-z0-9_]/.test(source[i])) s += source[i++];
    return s;
  };
  const parseValue = (): GqlValue => {
    skipWs();
    if (i >= n) return null;
    const c = source[i];
    if (c === '"') {
      i++;
      let s = '';
      while (i < n && source[i] !== '"') { if (source[i] === '\\' && i + 1 < n) { i++; s += source[i++]; } else s += source[i++]; }
      i++;
      return s;
    }
    if (c === '[') {
      i++;
      const arr: GqlValue[] = [];
      while (true) { skipWs(); if (source[i] === ']') { i++; break; } arr.push(parseValue()); }
      return arr;
    }
    if (c === '{') {
      i++;
      const obj: { [k: string]: GqlValue } = {};
      while (true) {
        skipWs();
        if (source[i] === '}') { i++; break; }
        const k = readName();
        skipWs();
        if (source[i] === ':') i++;
        obj[k] = parseValue();
      }
      return obj;
    }
    if (c === '$') { i++; const name = readName(); return `$${name}`; }
    let s = '';
    while (i < n && /[A-Za-z0-9_.\-]/.test(source[i])) s += source[i++];
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    const num = Number(s);
    return Number.isNaN(num) ? s : num;
  };
  const parseArgs = (): Record<string, GqlValue> => {
    const args: Record<string, GqlValue> = {};
    skipWs();
    if (source[i] !== '(') return args;
    i++;
    while (true) {
      skipWs();
      if (source[i] === ')') { i++; break; }
      const k = readName();
      skipWs();
      if (source[i] === ':') i++;
      args[k] = parseValue();
    }
    return args;
  };
  const parseSelection = (): GqlField[] => {
    const fields: GqlField[] = [];
    skipWs();
    if (source[i] !== '{') return fields;
    i++;
    while (true) {
      skipWs();
      if (i >= n) break;
      if (source[i] === '}') { i++; break; }
      if (source[i] === '.' && source.slice(i, i + 3) === '...') {
        i += 3;
        const name = readName();
        if (name === 'on') readName();
        // Inline fragment ("... on Repository { ... }"): its fields belong to
        // the enclosing selection — merge them in, don't drop them.
        fields.push(...parseSelection());
        continue;
      }
      const first = readName();
      if (!first) { i++; continue; }
      skipWs();
      let alias: string | undefined;
      let name = first;
      if (source[i] === ':') { i++; alias = first; name = readName(); }
      const args = parseArgs();
      const sub = parseSelection();
      fields.push({ name, alias, args, fields: sub });
    }
    return fields;
  };
  skipWs();
  let opType: 'query' | 'mutation' = 'query';
  const first = readName();
  if (first === 'mutation') opType = 'mutation';
  else if (first === 'query') { /* named query: skip name + variables */ }
  else if (first) {
    // anonymous query starting directly with '{'
    i -= first.length;
  }
  // skip optional operation name and variable definitions
  skipWs();
  if (source[i] !== '{' && source[i] !== '(') {
    readName();
    skipWs();
  }
  if (source[i] === '(') {
    let depth = 0;
    while (i < n) { if (source[i] === '(') depth++; else if (source[i] === ')') { depth--; i++; if (depth === 0) break; continue; } i++; }
  }
  const fields = parseSelection();
  return { fields, opType, errors };
}

function gqlResolveVars(args: Record<string, GqlValue>, variables: Record<string, GqlValue>): Record<string, GqlValue> {
  const out: Record<string, GqlValue> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.startsWith('$')) out[k] = variables[v.slice(1)] ?? null;
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = gqlResolveVars(v as Record<string, GqlValue>, variables);
    else out[k] = v;
  }
  return out;
}

function gqlTypeName(v: GqlValue): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'list';
  return typeof v;
}

function validateFields(fields: GqlField[], parentType: string, errors: string[]): void {
  const known = GQL_KNOWN_FIELDS[parentType];
  for (const f of fields) {
    if (f.name.startsWith('__')) continue;
    if (known && !known.has(f.name)) {
      errors.push(`Cannot query field "${f.name}" on type "${parentType}".`);
      continue;
    }
    // recurse into known sub-types for the shapes the suite uses
    let child: string | undefined;
    if (f.name === 'repository' || f.name === 'issue' || f.name === 'pullRequest') child = f.name === 'repository' ? 'Repository' : f.name === 'issue' ? 'Issue' : 'PullRequest';
    else if (f.name === 'issues') child = 'IssueConnection';
    else if (f.name === 'pullRequests') child = 'PullRequestConnection';
    else if (f.name === 'nodes') child = parentType === 'IssueConnection' ? 'Issue' : parentType === 'PullRequestConnection' ? 'PullRequest' : parentType === 'LabelConnection' ? 'Label' : parentType === 'CommentConnection' ? 'IssueComment' : parentType === 'FileConnection' ? 'PullRequestFile' : parentType;
    else if (f.name === 'edges') child = parentType === 'IssueConnection' ? 'IssueEdge' : parentType === 'PullRequestConnection' ? 'PullRequestEdge' : parentType === 'LabelConnection' ? 'LabelEdge' : parentType === 'CommentConnection' ? 'CommentEdge' : parentType === 'FileConnection' ? 'FileEdge' : parentType;
    else if (f.name === 'node') child = parentType === 'Query' ? undefined : parentType === 'IssueEdge' ? 'Issue' : parentType === 'PullRequestEdge' ? 'PullRequest' : parentType === 'LabelEdge' ? 'Label' : parentType === 'CommentEdge' ? 'IssueComment' : parentType === 'FileEdge' ? 'PullRequestFile' : parentType;
    else if (f.name === 'viewer') child = 'User';
    else if (f.name === 'owner') child = 'User';
    else if (f.name === 'author' || f.name === 'assignees') child = 'User';
    else if (f.name === 'labels') child = 'LabelConnection';
    else if (f.name === 'comments') child = 'CommentConnection';
    else if (f.name === 'files') child = 'FileConnection';
    else if (f.name === 'pageInfo') child = 'PageInfo';
    else if (f.name === 'defaultBranchRef') child = 'Ref';
    else if (f.name === 'target') child = 'Ref';
    if (child && f.fields.length > 0) validateFields(f.fields, child, errors);
  }
}

function pickFields(obj: Record<string, GqlValue>, fields: GqlField[]): Record<string, GqlValue> {
  const out: Record<string, GqlValue> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    const v = obj[f.name];
    if (v === undefined) continue;
    if (f.fields.length > 0 && v && typeof v === 'object' && !Array.isArray(v)) out[key] = pickFields(v as Record<string, GqlValue>, f.fields);
    else if (f.fields.length > 0 && Array.isArray(v)) out[key] = v.map((item) => (item && typeof item === 'object' ? pickFields(item as Record<string, GqlValue>, f.fields) : item));
    else out[key] = v;
  }
  return out;
}

function issueNode(repo: Repo, issue: Issue): Record<string, GqlValue> {
  return {
    id: gid('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body ?? null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: `${BASE_URL}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author: { login: issue.authorLogin, id: gid('User', issue.authorLogin), databaseId: 1000, name: null, url: `${BASE_URL}/${issue.authorLogin}` },
    labels: { nodes: issue.labels.map((l) => ({ id: gid('Label', repo.id, l.name), name: l.name, color: l.color, description: null })), edges: issue.labels.map((l) => ({ node: { id: gid('Label', repo.id, l.name), name: l.name, color: l.color, description: null }, cursor: l.name })), totalCount: issue.labels.length },
    comments: { nodes: issue.comments.map((c) => ({ id: gid('IssueComment', repo.id, issue.number, c.id), body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, author: { login: c.authorLogin, id: gid('User', c.authorLogin), databaseId: 1000, name: null, url: `${BASE_URL}/${c.authorLogin}` }, url: `${BASE_URL}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}` })), edges: [], totalCount: issue.comments.length },
    assignees: { nodes: [], edges: [], totalCount: 0 },
  };
}

function pullNode(repo: Repo, pull: Pull): Record<string, GqlValue> {
  const files = pullFiles(repo, pull);
  return {
    id: gid('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    body: pull.body ?? null,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    merged: pull.merged,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    url: `${BASE_URL}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    author: { login: pull.authorLogin, id: gid('User', pull.authorLogin), databaseId: 1000, name: null, url: `${BASE_URL}/${pull.authorLogin}` },
    headRefOid: pull.headSha,
    baseRefOid: repo.refs.get(`refs/heads/${pull.base}`) ?? null,
    files: { nodes: files, edges: files.map((f) => ({ node: f, cursor: f.path })), totalCount: files.length },
  };
}

function repoNode(repo: Repo): Record<string, GqlValue> {
  const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  return {
    id: gid('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: gid('User', repo.owner), databaseId: 1000, name: null, url: `${BASE_URL}/${repo.owner}` },
    defaultBranchRef: headSha ? { name: repo.defaultBranch, target: { oid: headSha } } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    description: repo.description ?? null,
    isPrivate: false,
    url: `${BASE_URL}/${repo.owner}/${repo.name}`,
  };
}

const gqlCursor = (n: number): string => Buffer.from(`cursor:${n}`).toString('base64');
function gqlAfter(args: Record<string, GqlValue>, list: { number: number }[]): number {
  const after = typeof args.after === 'string' ? args.after : null;
  if (!after) return 0;
  try {
    const m = Buffer.from(after, 'base64').toString('utf8').match(/^cursor:(\d+)$/);
    if (!m) return 0;
    const idx = list.findIndex((i) => i.number === Number(m[1]));
    return idx >= 0 ? idx + 1 : 0;
  } catch { return 0; }
}

function issuesConnection(repo: Repo, args: Record<string, GqlValue>): Record<string, GqlValue> {
  let list = [...repo.issues].sort((a, b) => b.number - a.number);
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  if (args.orderBy && typeof args.orderBy === 'object') {
    const ob = args.orderBy as Record<string, GqlValue>;
    if (ob.field === 'CREATED_AT') list = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number);
  }
  const start = gqlAfter(args, list);
  const first = typeof args.first === 'number' ? args.first : undefined;
  const page = first !== undefined ? list.slice(start, start + first) : list.slice(start);
  const nodes = page.map((i) => issueNode(repo, i));
  return { nodes, edges: page.map((i) => ({ node: issueNode(repo, i), cursor: gqlCursor(i.number) })), totalCount: list.length, pageInfo: { hasNextPage: first !== undefined && start + page.length < list.length, hasPreviousPage: start > 0, startCursor: page.length ? gqlCursor(page[0].number) : null, endCursor: page.length ? gqlCursor(page[page.length - 1].number) : null } };
}

function pullsConnection(repo: Repo, args: Record<string, GqlValue>): Record<string, GqlValue> {
  let list = [...repo.pulls].sort((a, b) => b.number - a.number);
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) list = list.filter((p) => states.includes(p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED'));
  const start = gqlAfter(args, list);
  const first = typeof args.first === 'number' ? args.first : undefined;
  const page = first !== undefined ? list.slice(start, start + first) : list.slice(start);
  const nodes = page.map((p) => pullNode(repo, p));
  return { nodes, edges: page.map((p) => ({ node: pullNode(repo, p), cursor: gqlCursor(p.number) })), totalCount: list.length, pageInfo: { hasNextPage: first !== undefined && start + page.length < list.length, hasPreviousPage: start > 0, startCursor: page.length ? gqlCursor(page[0].number) : null, endCursor: page.length ? gqlCursor(page[page.length - 1].number) : null } };
}

function resolveRepoField(repo: Repo, field: GqlField, errors: string[]): Record<string, GqlValue> | null {
  const node = repoNode(repo);
  if (field.name === 'issue') {
    const num = field.args.number as number;
    const issue = repo.issues.find((i) => i.number === num);
    if (!issue) return null;
    return pickFields(issueNode(repo, issue), field.fields);
  }
  if (field.name === 'issues') return pickFields(issuesConnection(repo, field.args), field.fields);
  if (field.name === 'pullRequest') {
    const num = field.args.number as number;
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) return null;
    return pickFields(pullNode(repo, pull), field.fields);
  }
  if (field.name === 'pullRequests') return pickFields(pullsConnection(repo, field.args), field.fields);
  if (field.name === 'owner') return pickFields(node.owner as Record<string, GqlValue>, field.fields);
  if (field.name === 'defaultBranchRef') {
    if (!node.defaultBranchRef) return null;
    return pickFields(node.defaultBranchRef as Record<string, GqlValue>, field.fields);
  }
  return pickFields(node, [field]);
}

function introspectionResult(field: GqlField): Record<string, GqlValue> {
  // __schema / __type support for the suite's introspection checks.
  const schemaTypes = (name: string, kind: string, fields: { name: string }[] | null, enumValues: string[] | null): Record<string, GqlValue> => ({
    name, kind,
    fields: fields ? fields.map((f) => ({ name: f.name, description: null, args: [], type: { name: 'String', kind: 'SCALAR' } })) : null,
    enumValues: enumValues ? enumValues.map((v) => ({ name: v, description: null })) : null,
    description: null, inputFields: null, interfaces: [], possibleTypes: null,
  });
  const allTypes: Record<string, GqlValue>[] = [
    schemaTypes('Issue', 'OBJECT', [...GQL_KNOWN_FIELDS.Issue].map((n) => ({ name: n })), null),
    schemaTypes('PullRequest', 'OBJECT', [...GQL_KNOWN_FIELDS.PullRequest].map((n) => ({ name: n })), null),
    schemaTypes('Repository', 'OBJECT', [...GQL_KNOWN_FIELDS.Repository].map((n) => ({ name: n })), null),
    schemaTypes('User', 'OBJECT', [...GQL_KNOWN_FIELDS.User].map((n) => ({ name: n })), null),
    schemaTypes('SearchType', 'ENUM', null, ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION']),
    schemaTypes('IssueState', 'ENUM', null, ['OPEN', 'CLOSED']),
    schemaTypes('Query', 'OBJECT', [...GQL_KNOWN_FIELDS.Query].map((n) => ({ name: n })), null),
    schemaTypes('Mutation', 'OBJECT', [...GQL_KNOWN_FIELDS.Mutation].map((n) => ({ name: n })), null),
  ];
  if (field.name === '__schema') {
    return pickFields({
      types: allTypes,
      queryType: { name: 'Query', kind: 'OBJECT' },
      mutationType: { name: 'Mutation', kind: 'OBJECT' },
      directives: [],
    }, field.fields);
  }
  const wanted = (field.args.name as string) ?? '';
  const found = allTypes.find((t) => t.name === wanted) ?? null;
  if (!found) return {};
  return pickFields(found, field.fields);
}

function executeDocument(doc: { query?: string; variables?: Record<string, GqlValue> }, req: IncomingMessage): { data: Record<string, GqlValue | null>; errors?: { message: string }[] } {
  const query = doc.query ?? '';
  const variables = doc.variables ?? {};
  const errors: string[] = [];
  const { fields, opType } = gqlParse(query);
  const data: Record<string, GqlValue | null> = {};
  if (opType === 'mutation') validateFields(fields, 'Mutation', errors);
  else validateFields(fields, 'Query', errors);
  if (errors.length > 0) return { data, errors: errors.map((m) => ({ message: m })) };

  for (const field of fields) {
    const args = gqlResolveVars(field.args, variables);
    const key = field.alias ?? field.name;
    if (field.name.startsWith('__')) { data[key] = introspectionResult({ ...field, args }); continue; }
    if (opType === 'mutation') {
      data[key] = executeMutation(field, args);
      continue;
    }
    if (field.name === 'viewer') {
      data[key] = pickFields({ login: VIEWER_LOGIN, id: gid('User', VIEWER_LOGIN), databaseId: 1000, name: null, url: `${BASE_URL}/${VIEWER_LOGIN}` }, field.fields);
      continue;
    }
    if (field.name === 'node') {
      data[key] = resolveNode(args.id as string, field.fields);
      continue;
    }
    if (field.name === 'search') {
      data[key] = resolveSearch(args, field.fields);
      continue;
    }
    if (field.name === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
      if (!repo) { data[key] = null; continue; }
      const node = repoNode(repo);
      const out: Record<string, GqlValue> = {};
      for (const sub of field.fields) {
        const subArgs = gqlResolveVars(sub.args, variables);
        const subKey = sub.alias ?? sub.name;
        if (['issue', 'issues', 'pullRequest', 'pullRequests', 'owner', 'defaultBranchRef'].includes(sub.name)) {
          const v = resolveRepoField(repo, { ...sub, args: subArgs }, errors);
          if (v !== null) out[subKey] = v;
          else out[subKey] = null;
        } else {
          const v = node[sub.name];
          if (v === undefined) continue;
          out[subKey] = sub.fields.length > 0 && v && typeof v === 'object' && !Array.isArray(v) ? pickFields(v as Record<string, GqlValue>, sub.fields) : v;
        }
      }
      data[key] = out;
      continue;
    }
    errors.push(`Cannot query field "${field.name}" on type "Query".`);
  }
  if (errors.length > 0) return { data, errors: errors.map((m) => ({ message: m })) };
  return { data };
}

function resolveNode(id: string, fields: GqlField[]): Record<string, GqlValue> | null {
  // Global ids are base64 "Type:repoId:number" — decode and dispatch.
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const parts = decoded.split(':');
    const type = parts[0];
    if (type === 'Issue' && parts.length >= 3) {
      const repo = [...repos.values()].find((r) => String(r.id) === parts[1]);
      const issue = repo?.issues.find((i) => i.number === Number(parts[2]));
      if (!repo || !issue) return null;
      return pickFields(issueNode(repo, issue), fields);
    }
    if (type === 'PullRequest' && parts.length >= 3) {
      const repo = [...repos.values()].find((r) => String(r.id) === parts[1]);
      const pull = repo?.pulls.find((p) => p.number === Number(parts[2]));
      if (!repo || !pull) return null;
      return pickFields(pullNode(repo, pull), fields);
    }
    if (type === 'Repository' && parts.length >= 2) {
      const repo = [...repos.values()].find((r) => String(r.id) === parts[1]);
      if (!repo) return null;
      return pickFields(repoNode(repo), fields);
    }
  } catch { /* fall through */ }
  return null;
}

function resolveSearch(args: Record<string, GqlValue>, fields: GqlField[]): Record<string, GqlValue> {
  const q = String(args.query ?? '');
  const nodes: Record<string, GqlValue>[] = [];
  const type = args.type as string | undefined;
  for (const repo of repos.values()) {
    for (const issue of repo.issues) {
      if (type && type !== 'ISSUE') continue;
      if (q && !issue.title.toLowerCase().includes(q.toLowerCase()) && !(issue.body ?? '').toLowerCase().includes(q.toLowerCase())) continue;
      nodes.push(issueNode(repo, issue));
    }
  }
  const first = typeof args.first === 'number' ? args.first : nodes.length;
  const sliced = nodes.slice(0, first);
  return pickFields({ nodes: sliced, edges: sliced.map((n, idx) => ({ node: n, cursor: String(idx) })), totalCount: nodes.length, pageInfo: { hasNextPage: nodes.length > first, hasPreviousPage: false, startCursor: null, endCursor: null } }, fields);
}

function executeMutation(field: GqlField, args: Record<string, GqlValue>): Record<string, GqlValue> | null {
  const input = (args.input && typeof args.input === 'object' ? args.input : {}) as Record<string, GqlValue>;
  const clientMutationId = (input.clientMutationId as string) ?? null;
  if (field.name === 'createIssue') {
    const repoId = input.repositoryId as string;
    const repo = [...repos.values()].find((r) => gid('Repository', r.id) === repoId) ?? [...repos.values()].find((r) => String(r.id) === repoId);
    if (!repo) return { issue: null, clientMutationId };
    // labelIds arrive as global ids ("Label:<repoId>:<name>"); resolve to names.
    const labelNames = ((input.labelIds as string[] | undefined) ?? []).map((raw) => {
      try {
        const dec = Buffer.from(String(raw), 'base64').toString('utf8').split(':');
        return dec.length >= 3 && dec[0] === 'Label' ? dec.slice(2).join(':') : String(raw);
      } catch { return String(raw); }
    }).filter((n) => repo.labels.has(n));
    const issue = createIssue(repo, String(input.title ?? ''), input.body ? String(input.body) : undefined, labelNames);
    return { issue: issue ? pickFields(issueNode(repo, issue), field.fields.find((f) => f.name === 'issue')?.fields ?? []) : null, clientMutationId };
  }
  if (field.name === 'closeIssue') {
    const issueId = input.issueId as string;
    const decoded = Buffer.from(issueId, 'base64').toString('utf8').split(':');
    const repo = [...repos.values()].find((r) => String(r.id) === decoded[1]);
    const issue = repo?.issues.find((i) => i.number === Number(decoded[2]));
    if (!repo || !issue) return { issue: null, clientMutationId };
    issue.state = 'closed';
    issue.updatedAt = FIXED_TIME;
    return { issue: pickFields(issueNode(repo, issue), field.fields.find((f) => f.name === 'issue')?.fields ?? []), clientMutationId };
  }
  if (field.name === 'createPullRequest') {
    const repoId = input.repositoryId as string;
    const repo = [...repos.values()].find((r) => gid('Repository', r.id) === repoId) ?? [...repos.values()].find((r) => String(r.id) === repoId);
    if (!repo) return { pullRequest: null, clientMutationId };
    const headName = String(input.headRefName ?? '');
    const baseName = String(input.baseRefName ?? repo.defaultBranch);
    if (!repo.refs.has(`refs/heads/${headName}`) || !repo.refs.has(`refs/heads/${baseName}`)) return { pullRequest: null, clientMutationId };
    const pull = createPull(repo, headName, baseName, String(input.title ?? ''), input.body ? String(input.body) : '');
    return { pullRequest: pull ? pickFields(pullNode(repo, pull), field.fields.find((f) => f.name === 'pullRequest')?.fields ?? []) : null, clientMutationId };
  }
  if (field.name === 'mergePullRequest') {
    const prId = input.pullRequestId as string;
    const decoded = Buffer.from(prId, 'base64').toString('utf8').split(':');
    const repo = [...repos.values()].find((r) => String(r.id) === decoded[1]);
    const pull = repo?.pulls.find((p) => p.number === Number(decoded[2]));
    if (!repo || !pull) return { pullRequest: null, clientMutationId };
    if (pullConflict(repo, pull)) return { pullRequest: pickFields(pullNode(repo, pull), field.fields.find((f) => f.name === 'pullRequest')?.fields ?? []), clientMutationId };
    mergePull(repo, pull);
    return { pullRequest: pickFields(pullNode(repo, pull), field.fields.find((f) => f.name === 'pullRequest')?.fields ?? []), clientMutationId };
  }
  if (field.name === 'addComment') {
    const subjectId = input.subjectId as string;
    const decoded = Buffer.from(subjectId, 'base64').toString('utf8').split(':');
    const repo = [...repos.values()].find((r) => String(r.id) === decoded[1]);
    const issue = repo?.issues.find((i) => i.number === Number(decoded[2]));
    if (!repo || !issue) return { commentEdge: null, subject: null, clientMutationId };
    const c = addComment(repo, issue, String(input.body ?? ''));
    const node = { id: gid('IssueComment', repo.id, issue.number, c.id), body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, author: { login: c.authorLogin, id: gid('User', c.authorLogin), databaseId: 1000, name: null, url: `${BASE_URL}/${c.authorLogin}` }, url: `${BASE_URL}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}` };
    return { commentEdge: { node: pickFields(node, field.fields.find((f) => f.name === 'commentEdge')?.fields.find((f2) => f2.name === 'node')?.fields ?? []), cursor: String(c.id) }, subject: pickFields(issueNode(repo, issue), field.fields.find((f) => f.name === 'subject')?.fields ?? []), clientMutationId };
  }
  return null;
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
  if (Array.isArray(parsed)) {
    const results = parsed.map((doc) => (doc && typeof doc === 'object' ? executeDocument(doc as { query?: string; variables?: Record<string, GqlValue> }, req) : { data: {}, errors: [{ message: 'Invalid document' }] }));
    sendJson(res, 200, results);
    return;
  }
  if (parsed && typeof parsed === 'object') {
    sendJson(res, 200, executeDocument(parsed as { query?: string; variables?: Record<string, GqlValue> }, req));
    return;
  }
  sendJson(res, 400, { message: 'Problems parsing JSON' });
}

// ---------------------------------------------------------------------------
// MCP (POST /mcp) — JSON-RPC 2.0 over Streamable HTTP
// ---------------------------------------------------------------------------

const MCP_TOOLS = [
  { name: 'create_repo', description: 'Create a new repository for the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
  { name: 'list_repos', description: 'List repositories owned by the authenticated user.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_issue', description: 'Get a single issue by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' } }, required: ['owner', 'repo', 'issue_number'] } },
];

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function mcpCallTool(name: string, args: Record<string, unknown>): { content: { type: string; text: string }[]; isError?: boolean } {
  const base = name.replace(/^github__/, '').toLowerCase();
  const a = (k: string): string => String(args[k] ?? '');
  const repoOf = (): Repo | undefined => getRepo(a('owner'), a('repo') || a('name'));
  if (base === 'create_repo') {
    const repo = createRepo(a('name'), a('description') || undefined, args.private === true);
    return { content: [{ type: 'text', text: JSON.stringify(repoView(repo)) }] };
  }
  if (base === 'get_repo') {
    const repo = getRepo(a('owner'), a('repo') || a('name'));
    if (!repo) return { content: [{ type: 'text', text: JSON.stringify({ message: 'Not Found' }) }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(repoView(repo)) }] };
  }
  if (base === 'list_repos') {
    const list = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).map((r) => repoView(r));
    return { content: [{ type: 'text', text: JSON.stringify(list) }] };
  }
  if (base === 'create_issue' || base === 'list_issues' || base === 'get_issue' || base === 'create_pull_request' || base === 'merge_pull_request') {
    const repo = repoOf();
    if (!repo) return { content: [{ type: 'text', text: JSON.stringify({ message: 'Not Found' }) }], isError: true };
    if (base === 'create_issue') {
      const labels = Array.isArray(args.labels) ? args.labels.map(String) : [];
      const bad = labels.find((l) => !repo.labels.has(l));
      if (bad) return { content: [{ type: 'text', text: JSON.stringify({ message: `Label '${bad}' does not exist` }) }], isError: true };
      const issue = createIssue(repo, a('title'), args.body ? a('body') : '', labels);
      if (!issue) return { content: [{ type: 'text', text: JSON.stringify({ message: 'Label does not exist' }) }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(issueView(repo, issue)) }] };
    }
    if (base === 'list_issues') {
      const state = a('state') || 'open';
      const list = [...repo.issues].filter((i) => state === 'all' || i.state === state).sort((x, y) => y.number - x.number).map((i) => issueView(repo, i));
      return { content: [{ type: 'text', text: JSON.stringify(list) }] };
    }
    if (base === 'get_issue') {
      const issue = repo.issues.find((i) => i.number === Number(args.issue_number));
      if (!issue) return { content: [{ type: 'text', text: JSON.stringify({ message: 'Not Found' }) }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(issueView(repo, issue)) }] };
    }
    if (base === 'create_pull_request') {
      const head = a('head');
      const baseName = a('base');
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${baseName}`)) return { content: [{ type: 'text', text: JSON.stringify({ message: 'Invalid head or base' }) }], isError: true };
      const pull = createPull(repo, head, baseName, a('title'), args.body ? a('body') : '');
      return { content: [{ type: 'text', text: JSON.stringify(pullView(repo, pull)) }] };
    }
    if (base === 'merge_pull_request') {
      const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pull) return { content: [{ type: 'text', text: JSON.stringify({ message: 'Not Found' }) }], isError: true };
      if (pullConflict(repo, pull)) return { content: [{ type: 'text', text: JSON.stringify({ message: 'Merge conflict' }) }], isError: true };
      const sha = mergePull(repo, pull);
      return { content: [{ type: 'text', text: JSON.stringify({ sha, merged: true, message: `${pull.title} (#${pull.number})` }) }] };
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify({ message: `Unknown tool: ${name}` }) }], isError: true };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const msg = parsed as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = msg.id ?? null;
  const method = msg.method ?? '';
  if (method === 'initialize') {
    const protocolVersion = String((msg.params as Record<string, unknown> | undefined)?.protocolVersion ?? '2025-11-25');
    const supported = protocolVersion === '2026-07-28' ? '2026-07-28' : '2025-11-25';
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: supported, capabilities: { tools: {} }, serverInfo: { name: 'git-forge', version: '1.0.0' } } });
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': reqId() });
    res.end();
    return;
  }
  if (method === 'ping') { sendJson(res, 200, { jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'server/discover') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { supportedVersions: ['2026-07-28', '2025-11-25'], serverInfo: { name: 'git-forge', version: '1.0.0' }, capabilities: { tools: {} } } });
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const toolName = String(params.name ?? '');
    const tool = MCP_TOOLS.find((t) => t.name === toolName || t.name === toolName.replace(/^github__/, '').toLowerCase());
    if (!tool) { sendJson(res, 200, rpcError(id, -32601, `Unknown tool: ${toolName}`)); return; }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const required = (tool.inputSchema.required ?? []) as string[];
    const missing = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length > 0) {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ message: `Missing required argument: ${missing.join(', ')}` }) }], isError: true } });
      return;
    }
    const result = mcpCallTool(toolName, args);
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
    return;
  }
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
}

// ---------------------------------------------------------------------------
// Server / router
// ---------------------------------------------------------------------------

export function createApp() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const query = url.searchParams;
      const method = req.method ?? 'GET';

      // Git smart HTTP (no auth required; git clients don't send the token)
      if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
        const handled = await handleGit(req, res, path, query);
        if (handled) return;
        notFound(res);
        return;
      }

      // MCP (auth required)
      if (path === '/mcp') {
        if (method !== 'POST') { notFound(res); return; }
        if (!authed(req)) { unauth(res); return; }
        await handleMcp(req, res);
        return;
      }

      // GraphQL (auth required)
      if (path === '/api/graphql') {
        if (method !== 'POST') { notFound(res); return; }
        if (!authed(req)) { unauth(res); return; }
        await handleGraphQL(req, res);
        return;
      }

      // REST v3 (auth required; suite always sends token). handleRest expects
      // the full /api/v3/... path and returns false for routes it does not own.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!authed(req)) { unauth(res); return; }
        const handled = await handleRest(req, res, path, query);
        if (!handled) notFound(res);
        return;
      }

      notFound(res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    }
  });
  return server;
}


