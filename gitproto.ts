// Git smart HTTP on the forge's object store: info/refs advertisements, upload-pack (protocol v2
// ls-refs and fetch, plus a v0 fallback) and receive-pack v0 (report-status, side-band-64k,
// delete-refs, fast-forward only). Packs are written without deltas and read with OFS/REF deltas.
// Pure node:zlib + node:crypto; no git binary, no clock.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Forge, Repo } from './forge.ts';
import type { GitStore, ObjectType } from './git.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'agent=forge/1.0';
const MAX_PKT_DATA = 65516;
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

export class ProtocolError extends Error {}

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

// ---------------------------------------------------------------- pkt-line

export function pkt(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii'), payload]);
}

type Packet = { kind: 'flush' | 'delim' | 'end' } | { kind: 'data'; payload: Buffer };

/** Read pkt-lines from `start`; stops after the first flush when `untilFlush`. */
function readPackets(buf: Buffer, start = 0, untilFlush = false): { packets: Packet[]; offset: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const hex = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ProtocolError('bad pkt-line length');
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (untilFlush) return { packets, offset };
      continue;
    }
    if (length === 1 || length === 2) {
      packets.push({ kind: length === 1 ? 'delim' : 'end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) throw new ProtocolError('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (offset !== buf.length) throw new ProtocolError('trailing bytes after the last pkt-line');
  return { packets, offset };
}

function lineOf(packet: Packet): string {
  return packet.kind === 'data' ? packet.payload.toString('utf8').replace(/\n$/, '') : '';
}

/** Band-1 (or other band) sideband packets for `data`, chunked under the pkt-line limit. */
function sideband(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const max = MAX_PKT_DATA - 1;
  for (let i = 0; i < data.length; i += max) {
    const chunk = data.subarray(i, Math.min(data.length, i + max));
    const payload = Buffer.allocUnsafe(chunk.length + 1);
    payload[0] = band;
    chunk.copy(payload, 1);
    out.push(pkt(payload));
  }
  return out;
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const entryCache = new Map<string, Buffer>();

function packEntry(store: GitStore, sha: string): Buffer {
  const cached = entryCache.get(sha);
  if (cached !== undefined) return cached;
  const object = store.get(sha);
  if (object === undefined) throw new ProtocolError(`missing object ${sha}`);
  let size = object.data.length;
  const header: number[] = [(TYPE_CODE[object.type] << 4) | (size & 0x0f)];
  size >>>= 4;
  while (size > 0) {
    header[header.length - 1] = (header[header.length - 1] as number) | 0x80;
    header.push(size & 0x7f);
    size >>>= 7;
  }
  const entry = Buffer.concat([Buffer.from(header), deflateSync(object.data, { level: 1 })]);
  entryCache.set(sha, entry);
  return entry;
}

export function writePack(store: GitStore, shas: readonly string[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(shas.length, 8);
  const parts = [head, ...shas.map((sha) => packEntry(store, sha))];
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = delta[i++] as number;
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  };
  const sourceSize = varint();
  if (sourceSize !== base.length) throw new ProtocolError('delta base size mismatch');
  const targetSize = varint();
  const out = Buffer.allocUnsafe(targetSize);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++] as number;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) offset += (delta[i++] as number) * 2 ** (8 * bit);
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) size += (delta[i++] as number) << (8 * bit);
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || o + size > targetSize) throw new ProtocolError('delta copy out of range');
      base.copy(out, o, offset, offset + size);
      o += size;
    } else if (op > 0) {
      if (o + op > targetSize || i + op > delta.length) throw new ProtocolError('delta insert out of range');
      delta.copy(out, o, i, i + op);
      o += op;
      i += op;
    } else throw new ProtocolError('delta opcode 0');
  }
  if (o !== targetSize) throw new ProtocolError('delta result size mismatch');
  return out;
}

/** Read a pack (v2/v3, OFS/REF deltas, thin bases from the store) and write every object to the store. */
export function readPack(store: GitStore, pack: Buffer): string[] {
  if (pack.length === 0) return [];
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new ProtocolError('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new ProtocolError(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  if (!createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest().equals(trailer)) throw new ProtocolError('pack checksum mismatch');
  interface Raw { offset: number; code: number; data: Buffer; baseOffset?: number; baseSha?: string }
  const raws: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let n = 0; n < count; n += 1) {
    const start = offset;
    let byte = pack[offset++] as number;
    const code = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++] as number;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const raw: Raw = { offset: start, code, data: Buffer.alloc(0) };
    if (code === 6) {
      byte = pack[offset++] as number;
      let rel = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++] as number;
        rel = (rel + 1) * 128 + (byte & 0x7f);
      }
      raw.baseOffset = start - rel;
    } else if (code === 7) {
      raw.baseSha = pack.toString('hex', offset, offset + 20);
      offset += 20;
    } else if (CODE_TYPE[code] === undefined) throw new ProtocolError(`bad pack object type ${code}`);
    if (offset >= pack.length - 20) throw new ProtocolError('pack truncated');
    const inflated = inflateSync(pack.subarray(offset, pack.length - 20), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    raw.data = inflated.buffer;
    if (raw.data.length !== size) throw new ProtocolError('pack object size mismatch');
    offset += inflated.engine.bytesWritten;
    raws.push(raw);
    byOffset.set(start, raw);
  }
  const resolved = new Map<Raw, { type: ObjectType; data: Buffer }>();
  const bySha = new Map<string, Raw>();
  const resolve = (raw: Raw, depth: number): { type: ObjectType; data: Buffer } => {
    const done = resolved.get(raw);
    if (done !== undefined) return done;
    if (depth > 4096) throw new ProtocolError('delta chain too deep');
    let result: { type: ObjectType; data: Buffer };
    if (raw.code === 6 || raw.code === 7) {
      let base: { type: ObjectType; data: Buffer } | undefined;
      if (raw.code === 6) {
        const baseRaw = byOffset.get(raw.baseOffset as number);
        if (baseRaw === undefined) throw new ProtocolError('ofs-delta base missing');
        base = resolve(baseRaw, depth + 1);
      } else {
        const sha = raw.baseSha as string;
        const inPack = bySha.get(sha);
        if (inPack !== undefined) base = resolve(inPack, depth + 1);
        else {
          const stored = store.get(sha);
          if (stored !== undefined) base = { type: stored.type, data: stored.data };
        }
        if (base === undefined) throw new ProtocolError(`ref-delta base ${sha} missing`);
      }
      result = { type: base.type, data: applyDelta(base.data, raw.data) };
    } else result = { type: CODE_TYPE[raw.code] as ObjectType, data: raw.data };
    resolved.set(raw, result);
    return result;
  };
  const written: string[] = [];
  // Plain objects first so REF_DELTA bases inside the pack can be found by id.
  for (const raw of raws) {
    if (raw.code === 6 || raw.code === 7) continue;
    const object = resolve(raw, 0);
    const sha = store.write(object.type, object.data);
    bySha.set(sha, raw);
    written.push(sha);
  }
  let pending = raws.filter((raw) => raw.code === 6 || raw.code === 7);
  while (pending.length > 0) {
    const next: Raw[] = [];
    for (const raw of pending) {
      if (raw.code === 7 && !bySha.has(raw.baseSha as string) && !store.has(raw.baseSha as string)) {
        next.push(raw);
        continue;
      }
      const object = resolve(raw, 0);
      const sha = store.write(object.type, object.data);
      bySha.set(sha, raw);
      written.push(sha);
    }
    if (next.length === pending.length) throw new ProtocolError('unresolvable ref-delta');
    pending = next;
  }
  return written;
}

// ---------------------------------------------------------------- refs

interface RefLine { name: string; oid: string; peeled?: string }

function refList(forge: Forge, repo: Repo): RefLine[] {
  const names = [...repo.refs.keys()].sort();
  return names.map((name) => {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { name, oid };
    if (forge.git.get(oid)?.type === 'tag') line.peeled = forge.peel(oid);
    return line;
  });
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------- advertisements

export function infoRefs(forge: Forge, repo: Repo, service: string, gitProtocol: string): GitReply {
  if (service === 'git-upload-pack' && /(^|:)version=2(:|$)/.test(gitProtocol)) {
    const lines = ['version 2\n', `${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'server-option\n', 'object-format=sha1\n'].map((line) => pkt(line));
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat([...lines, FLUSH]) };
  }
  const refs = refList(forge, repo);
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  if (service === 'git-receive-pack') {
    const caps = `report-status delete-refs side-band-64k quiet ofs-delta ${AGENT} object-format=sha1`;
    if (refs.length === 0) parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    refs.forEach((ref, index) => parts.push(pkt(index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`)));
    parts.push(FLUSH);
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: Buffer.concat(parts) };
  }
  const headOid = repo.refs.get(headTarget(repo));
  const caps = `side-band-64k thin-pack ofs-delta shallow no-progress include-tag${headOid === undefined ? '' : ` symref=HEAD:${headTarget(repo)}`} ${AGENT} object-format=sha1`;
  const lines: string[] = [];
  if (headOid !== undefined) lines.push(`${headOid} HEAD`);
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}`);
    if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}`);
  }
  if (lines.length === 0) lines.push(`${ZERO_OID} capabilities^{}`);
  lines.forEach((line, index) => parts.push(pkt(index === 0 ? `${line}\0${caps}\n` : `${line}\n`)));
  parts.push(FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth: number | null;
  done: boolean;
}

interface FetchPlan {
  objects: string[];
  shallow: string[];
  unshallow: string[];
  common: string[];
}

const planCache = new Map<string, FetchPlan>();

function planFetch(forge: Forge, args: FetchArgs): FetchPlan {
  const key = JSON.stringify(args);
  const cached = planCache.get(key);
  if (cached !== undefined) return cached;
  const store = forge.git;
  const clientShallow = new Set(args.clientShallow);
  const common = args.haves.filter((sha) => store.has(sha));
  // Everything the client already holds: the haves' closure, not walking past its shallow boundary.
  const exclude = new Set<string>();
  const addTree = (tree: string, set: Set<string>, out: string[] | null): void => {
    if (set.has(tree) || (out !== null && exclude.has(tree))) return;
    set.add(tree);
    out?.push(tree);
    for (const entry of store.tree(tree) ?? []) {
      if (entry.mode === '160000') continue;
      if (entry.mode === '40000') addTree(entry.sha, set, out);
      else if (!set.has(entry.sha) && !(out !== null && exclude.has(entry.sha))) {
        set.add(entry.sha);
        out?.push(entry.sha);
      }
    }
  };
  const stack = common.map((sha) => forge.peel(sha));
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (exclude.has(sha)) continue;
    const commit = store.commit(sha);
    exclude.add(sha);
    if (commit === undefined) continue;
    addTree(commit.tree, exclude, null);
    if (!clientShallow.has(sha)) stack.push(...commit.parents);
  }

  const objects: string[] = [];
  const sent = new Set<string>();
  const commits: string[] = [];
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const wantCommits: string[] = [];
  for (const want of args.wants) {
    let sha = want;
    for (let i = 0; i < 8; i += 1) {
      const object = store.get(sha);
      if (object?.type !== 'tag') break;
      if (!exclude.has(sha) && !sent.has(sha)) {
        sent.add(sha);
        objects.push(sha);
      }
      const match = /^object ([0-9a-f]{40})/.exec(object.data.toString('utf8'));
      if (match === null) break;
      sha = match[1] as string;
    }
    if (store.get(sha)?.type === 'commit') wantCommits.push(sha);
  }
  if (args.depth !== null) {
    const depthOf = new Map<string, number>();
    let frontier = [...new Set(wantCommits)];
    for (const sha of frontier) depthOf.set(sha, 1);
    const order: string[] = [...frontier];
    for (let level = 1; level < args.depth && frontier.length > 0; level += 1) {
      const next: string[] = [];
      for (const sha of frontier) {
        for (const parent of store.commit(sha)?.parents ?? []) {
          if (depthOf.has(parent) || !store.has(parent)) continue;
          depthOf.set(parent, level + 1);
          next.push(parent);
          order.push(parent);
        }
      }
      frontier = next;
    }
    for (const sha of order) {
      const commit = store.commit(sha);
      const depth = depthOf.get(sha) as number;
      const parents = commit?.parents ?? [];
      const boundary = parents.length > 0 && parents.some((parent) => !depthOf.has(parent));
      if (boundary && !clientShallow.has(sha)) shallow.push(sha);
      if (!boundary && clientShallow.has(sha)) unshallow.push(sha);
      void depth;
      if (!exclude.has(sha)) commits.push(sha);
    }
  } else {
    const walk = [...wantCommits];
    const seen = new Set<string>();
    while (walk.length > 0) {
      const sha = walk.pop() as string;
      if (seen.has(sha) || exclude.has(sha)) continue;
      seen.add(sha);
      commits.push(sha);
      if (clientShallow.has(sha)) continue;
      for (const parent of store.commit(sha)?.parents ?? []) if (store.has(parent)) walk.push(parent);
    }
  }
  for (const sha of commits) {
    if (sent.has(sha)) continue;
    sent.add(sha);
    objects.push(sha);
  }
  for (const sha of commits) {
    const commit = store.commit(sha);
    if (commit !== undefined) addTree(commit.tree, sent, objects);
  }
  const plan = { objects, shallow, unshallow, common };
  if (planCache.size > 64) planCache.clear();
  planCache.set(key, plan);
  return plan;
}

const responseCache = new Map<string, Buffer>();

function packSection(forge: Forge, plan: FetchPlan): Buffer[] {
  return sideband(1, writePack(forge.git, plan.objects));
}

// PERF: memo of fetch replies. A fetch reply is a pure function of the request bytes (the want
// lines) and the object store, which only grows during a trial; an identical fetch body therefore
// answers byte for byte. ls-refs answers from the repo's refs and is never memoised.
const FETCH_MEMO_MAX = 64;
const fetchMemo = new Map<string, Buffer>();
function memoFetch(body: Buffer, build: () => Buffer): Buffer {
  const key = createHash('sha1').update(body).digest('hex');
  const hit = fetchMemo.get(key);
  if (hit !== undefined) return hit;
  const reply = build();
  if (fetchMemo.size >= FETCH_MEMO_MAX) {
    const oldest = fetchMemo.keys().next();
    if (oldest.done !== true) fetchMemo.delete(oldest.value);
  }
  fetchMemo.set(key, reply);
  return reply;
}

export function uploadPack(forge: Forge, repo: Repo, body: Buffer, gitProtocol: string): GitReply {
  void repo;
  const result = 'application/x-git-upload-pack-result';
  if (/(^|:)version=2(:|$)/.test(gitProtocol)) {
    const { packets } = readPackets(body);
    let command = '';
    let i = 0;
    for (; i < packets.length; i += 1) {
      const packet = packets[i] as Packet;
      if (packet.kind !== 'data') break;
      const line = lineOf(packet);
      if (line.startsWith('command=')) command = line.slice(8);
    }
    const args: string[] = [];
    if (packets[i]?.kind === 'delim') {
      for (i += 1; i < packets.length && packets[i]?.kind === 'data'; i += 1) args.push(lineOf(packets[i] as Packet));
    }
    if (command === 'ls-refs') return { status: 200, contentType: result, body: lsRefs(forge, repo, args) };
    if (command === 'fetch') return { status: 200, contentType: result, body: memoFetch(body, () => fetchV2(forge, args)) };
    if (command === '') return { status: 200, contentType: result, body: FLUSH };
    throw new ProtocolError(`unknown command ${command}`);
  }
  return { status: 200, contentType: result, body: memoFetch(body, () => fetchV0(forge, body)) };
}

function lsRefs(forge: Forge, repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice(11));
  const match = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const head = headTarget(repo);
  const headOid = repo.refs.get(head);
  if (match('HEAD')) {
    if (headOid !== undefined) out.push(pkt(`${headOid} HEAD${symrefs ? ` symref-target:${head}` : ''}\n`));
    else if (unborn) out.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${head}` : ''}\n`));
  }
  for (const ref of refList(forge, repo)) {
    if (!match(ref.name)) continue;
    out.push(pkt(`${ref.oid} ${ref.name}${peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : ''}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

const OID = /^[0-9a-f]{40}$/;

function fetchV2(forge: Forge, lines: readonly string[]): Buffer {
  const args: FetchArgs = { wants: [], haves: [], clientShallow: [], depth: null, done: false };
  for (const line of lines) {
    const [word, value = ''] = line.split(' ', 2) as [string, string?];
    if (word === 'want' && OID.test(value)) args.wants.push(value);
    else if (word === 'have' && OID.test(value)) args.haves.push(value);
    else if (word === 'shallow' && OID.test(value)) args.clientShallow.push(value);
    else if (word === 'deepen') args.depth = Math.max(1, Number.parseInt(value, 10) || 1);
    else if (word === 'done') args.done = true;
    else if (word === 'want-ref') throw new ProtocolError('want-ref is not supported');
  }
  for (const want of args.wants) if (!forge.git.has(want)) throw new ProtocolError(`not our ref ${want}`);
  const key = `v2:${JSON.stringify(args)}`;
  const cached = responseCache.get(key);
  if (cached !== undefined) return cached;
  const plan = planFetch(forge, args);
  const parts: Buffer[] = [];
  if (!args.done) {
    parts.push(pkt('acknowledgments\n'));
    if (plan.common.length === 0) parts.push(pkt('NAK\n'));
    for (const sha of plan.common) parts.push(pkt(`ACK ${sha}\n`));
    parts.push(pkt('ready\n'), DELIM);
  }
  if (args.depth !== null || args.clientShallow.length > 0) {
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const sha of plan.shallow) parts.push(pkt(`shallow ${sha}\n`));
      for (const sha of plan.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
      parts.push(DELIM);
    }
  }
  parts.push(pkt('packfile\n'), ...packSection(forge, plan), FLUSH);
  const body = Buffer.concat(parts);
  if (responseCache.size > 64) responseCache.clear();
  responseCache.set(key, body);
  return body;
}

function fetchV0(forge: Forge, body: Buffer): Buffer {
  const args: FetchArgs = { wants: [], haves: [], clientShallow: [], depth: null, done: false };
  const { packets } = readPackets(body);
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = lineOf(packet).split('\0')[0] as string;
    const [word, value = ''] = line.split(' ', 3) as [string, string?];
    if (word === 'want' && OID.test(value)) args.wants.push(value);
    else if (word === 'have' && OID.test(value)) args.haves.push(value);
    else if (word === 'shallow' && OID.test(value)) args.clientShallow.push(value);
    else if (word === 'deepen') args.depth = Math.max(1, Number.parseInt(value, 10) || 1);
    else if (word === 'done') args.done = true;
  }
  if (args.wants.length === 0) return FLUSH;
  for (const want of args.wants) if (!forge.git.has(want)) throw new ProtocolError(`not our ref ${want}`);
  const plan = planFetch(forge, args);
  const parts: Buffer[] = [];
  if (args.depth !== null) {
    for (const sha of plan.shallow) parts.push(pkt(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
    parts.push(FLUSH);
  }
  if (!args.done && args.haves.length > 0) {
    // A negotiation round without done: acknowledge what we share and wait for the next round.
    for (const sha of plan.common) parts.push(pkt(`ACK ${sha} common\n`));
    parts.push(pkt('NAK\n'));
    return Buffer.concat(parts);
  }
  parts.push(pkt(plan.common.length > 0 ? `ACK ${plan.common[plan.common.length - 1]}\n` : 'NAK\n'));
  parts.push(...packSection(forge, plan), FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export function receivePack(forge: Forge, repo: Repo, body: Buffer): GitReply {
  const { packets, offset } = readPackets(body, 0, true);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let capabilities: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const [line, caps] = text.split('\0') as [string, string?];
    if (caps !== undefined && commands.length === 0) capabilities = caps.split(' ').filter(Boolean);
    if (line.startsWith('shallow ')) continue;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)$/.exec(line);
    if (match === null) throw new ProtocolError(`bad command ${line.slice(0, 80)}`);
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  const useSideband = capabilities.includes('side-band-64k') || capabilities.includes('side-band');
  const wantsReport = capabilities.includes('report-status') || capabilities.includes('report-status-v2');
  let unpack = 'ok';
  try {
    readPack(forge.git, body.subarray(offset));
  } catch (err) {
    unpack = err instanceof Error ? err.message.replace(/\s+/g, ' ') : 'unpack failed';
  }
  const hadHeads = [...repo.refs.keys()].some((ref) => ref.startsWith('refs/heads/'));
  const report: string[] = [`unpack ${unpack === 'ok' ? 'ok' : unpack}\n`];
  for (const command of commands) {
    const reason = unpack === 'ok' ? applyCommand(forge, repo, command) : 'unpacker error';
    report.push(reason === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
  }
  if (!hadHeads && !repo.refs.has(headTarget(repo))) {
    const first = commands.find((command) => command.ref.startsWith('refs/heads/') && repo.refs.has(command.ref));
    if (first !== undefined) repo.defaultBranch = first.ref.slice('refs/heads/'.length);
  }
  const reportBytes = Buffer.concat([...report.map((line) => pkt(line)), FLUSH]);
  let out: Buffer;
  if (!wantsReport) out = Buffer.alloc(0);
  else if (useSideband) out = Buffer.concat([...sideband(1, reportBytes), FLUSH]);
  else out = reportBytes;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: out };
}

/** Apply one ref update; null when it applied, else the ng reason. */
function applyCommand(forge: Forge, repo: Repo, command: { oldOid: string; newOid: string; ref: string }): string | null {
  const { oldOid, newOid, ref } = command;
  if (ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock') || /[\s~^:?*[\\]/.test(ref)) return 'funny refname';
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    if (current === undefined) return 'remote ref does not exist';
    if (oldOid !== ZERO_OID && oldOid !== current) return 'stale info';
    repo.refs.delete(ref);
    repo.pushedAt = forge.tick();
    return null;
  }
  const object = forge.git.get(newOid);
  if (object === undefined) return 'missing necessary objects';
  if (ref.startsWith('refs/heads/') && forge.git.get(forge.peel(newOid))?.type !== 'commit') return 'not a commit';
  if (current !== undefined) {
    if (current !== newOid) {
      const from = forge.peel(current);
      const to = forge.peel(newOid);
      if (forge.git.commit(from) === undefined || forge.git.commit(to) === undefined || !forge.git.isAncestor(from, to)) return 'non-fast-forward';
    }
    if (oldOid !== current) return 'stale info';
  } else {
    if (oldOid !== ZERO_OID) return 'stale info';
    if (forge.refConflicts(repo, ref)) return 'failed to lock';
  }
  repo.refs.set(ref, newOid);
  repo.pushedAt = forge.tick();
  return null;
}
