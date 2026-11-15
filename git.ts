// The git object layer: real git objects (blob, tree, commit) addressed by their SHA-1, held in
// process memory. Everything the REST API commits is a genuine git object, so the smart-HTTP
// service can later pack and serve exactly what REST wrote, and every sha is a 40-hex object id
// derived from content alone (no clock, no randomness).

import { createHash } from 'node:crypto';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface Person {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  time: number;
  /** Like "+0000". */
  tz: string;
}

export interface Commit {
  sha: string;
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

/** A path in a flattened tree, to its blob id and mode. */
export type FlatTree = Map<string, { sha: string; mode: string }>;

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

export class GitStore {
  readonly objects = new Map<string, GitObject>();
  private readonly treeCache = new Map<string, TreeEntry[]>();
  private readonly commitCache = new Map<string, Commit>();
  private readonly flatCache = new Map<string, FlatTree>();

  constructor() {
    this.write('tree', Buffer.alloc(0));
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  get(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  /** Store an object and return its id. */
  write(type: ObjectType, data: Buffer): string {
    const header = Buffer.from(`${type} ${data.length}\0`, 'latin1');
    const sha = createHash('sha1').update(header).update(data).digest('hex');
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  writeBlob(content: Buffer): string {
    return this.write('blob', content);
  }

  blob(sha: string): Buffer | undefined {
    const object = this.objects.get(sha);
    return object?.type === 'blob' ? object.data : undefined;
  }

  writeTree(entries: TreeEntry[]): string {
    const sorted = [...entries].sort((a, b) => compareTreeNames(a, b));
    const parts: Buffer[] = [];
    for (const entry of sorted) {
      parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.sha, 'hex'));
    }
    const sha = this.write('tree', Buffer.concat(parts));
    if (!this.treeCache.has(sha)) this.treeCache.set(sha, sorted);
    return sha;
  }

  tree(sha: string): TreeEntry[] | undefined {
    const cached = this.treeCache.get(sha);
    if (cached !== undefined) return cached;
    const object = this.objects.get(sha);
    if (object?.type !== 'tree') return undefined;
    const entries = parseTree(object.data);
    this.treeCache.set(sha, entries);
    return entries;
  }

  writeCommit(input: Omit<Commit, 'sha'>): string {
    const lines = [`tree ${input.tree}`];
    for (const parent of input.parents) lines.push(`parent ${parent}`);
    lines.push(`author ${formatPerson(input.author)}`, `committer ${formatPerson(input.committer)}`);
    const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
    const sha = this.write('commit', Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8'));
    return sha;
  }

  commit(sha: string): Commit | undefined {
    const cached = this.commitCache.get(sha);
    if (cached !== undefined) return cached;
    const object = this.objects.get(sha);
    if (object?.type !== 'commit') return undefined;
    const parsed = parseCommit(sha, object.data);
    this.commitCache.set(sha, parsed);
    return parsed;
  }

  /** Every file below a tree, by full path. */
  flatten(treeSha: string): FlatTree {
    const cached = this.flatCache.get(treeSha);
    if (cached !== undefined) return cached;
    const out: FlatTree = new Map();
    const walk = (sha: string, prefix: string): void => {
      for (const entry of this.tree(sha) ?? []) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.sha, path);
        else out.set(path, { sha: entry.sha, mode: entry.mode });
      }
    };
    walk(treeSha, '');
    this.flatCache.set(treeSha, out);
    return out;
  }

  /** Build (and store) the nested trees for a flat file map; returns the root tree id. */
  buildTree(files: FlatTree): string {
    interface Dir {
      files: TreeEntry[];
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: [], dirs: new Map() };
    for (const [path, { sha, mode }] of files) {
      const parts = path.split('/');
      let dir = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const name = parts[i] as string;
        let next = dir.dirs.get(name);
        if (next === undefined) {
          next = { files: [], dirs: new Map() };
          dir.dirs.set(name, next);
        }
        dir = next;
      }
      dir.files.push({ mode, name: parts[parts.length - 1] as string, sha });
    }
    const emit = (dir: Dir): string => {
      const entries = [...dir.files];
      for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, sha: emit(child) });
      return this.writeTree(entries);
    };
    const sha = emit(root);
    if (!this.flatCache.has(sha)) this.flatCache.set(sha, new Map(files));
    return sha;
  }

  /** The tree entry at `path` below a root tree (the root itself for ''). */
  lookup(rootTree: string, path: string): TreeEntry | undefined {
    if (path === '') return { mode: '40000', name: '', sha: rootTree };
    let current: TreeEntry = { mode: '40000', name: '', sha: rootTree };
    for (const part of path.split('/')) {
      if (current.mode !== '40000') return undefined;
      const found = this.tree(current.sha)?.find((entry) => entry.name === part);
      if (found === undefined) return undefined;
      current = found;
    }
    return current;
  }

  /** Every commit reachable from `tips`, newest committer time first, ties by discovery order. */
  history(tips: readonly string[], limit = Number.POSITIVE_INFINITY): Commit[] {
    const seen = new Set<string>();
    const out: Commit[] = [];
    const stack = [...tips];
    while (stack.length > 0) {
      const sha = stack.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = this.commit(sha);
      if (commit === undefined) continue;
      out.push(commit);
      for (const parent of commit.parents) if (!seen.has(parent)) stack.push(parent);
    }
    const order = new Map(out.map((commit, index) => [commit.sha, index]));
    out.sort((a, b) => b.committer.time - a.committer.time || (order.get(a.sha) as number) - (order.get(b.sha) as number));
    return out.length > limit ? out.slice(0, limit) : out;
  }

  /** Whether `ancestor` is reachable from `descendant` (a commit is its own ancestor). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = this.commit(sha);
      if (commit !== undefined) stack.push(...commit.parents);
    }
    return false;
  }

  /** A best common ancestor of two commits (breadth-first from `b`), or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestors = new Set<string>();
    const stack = [a];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (ancestors.has(sha)) continue;
      ancestors.add(sha);
      const commit = this.commit(sha);
      if (commit !== undefined) stack.push(...commit.parents);
    }
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (ancestors.has(sha)) return sha;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = this.commit(sha);
      if (commit !== undefined) queue.push(...commit.parents);
    }
    return null;
  }
}

/** Git orders tree entries by name, with a directory compared as if its name ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const bn = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(an, bn);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0, space);
    if (space < 0 || nul < 0) break;
    const mode = data.toString('latin1', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

function formatPerson(person: Person): string {
  return `${person.name} <${person.email}> ${person.time} ${person.tz}`;
}

function parsePerson(text: string): Person {
  const match = /^(.*?) <([^>]*)> (-?\d+) ([+-]\d{4})$/.exec(text);
  if (match === null) return { name: text, email: '', time: 0, tz: '+0000' };
  return { name: match[1] as string, email: match[2] as string, time: Number(match[3]), tz: match[4] as string };
}

export function parseCommit(sha: string, data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  let message = split < 0 ? '' : text.slice(split + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  const commit: Commit = { sha, tree: EMPTY_TREE, parents: [], author: parsePerson(''), committer: parsePerson(''), message };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') commit.tree = value;
    else if (key === 'parent') commit.parents.push(value);
    else if (key === 'author') commit.author = parsePerson(value);
    else if (key === 'committer') commit.committer = parsePerson(value);
  }
  return commit;
}
