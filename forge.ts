// The forge's in-process store and its rules: repositories, refs, contents commits, labels,
// issues, comments and pull requests (with squash merges). REST, GraphQL and MCP all act on the
// one Forge instance, so an object created on one surface reads back unchanged on another.
//
// Determinism: ids are counters, shas are git object ids, and time is a logical clock that starts
// at MAKEFUN_TRIAL_NOW (or a fixed epoch) and advances one second per write. Nothing reads the
// wall clock or Math.random.

import { GitStore, EMPTY_TREE, type Commit, type FlatTree, type Person } from './git.ts';

/** An API failure: the status and the GitHub-shaped body ({message, ...}). */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = { message, ...extra, documentation_url: 'https://docs.github.com/rest' };
  }
}

export const notFound = (): ApiError => new ApiError(404, 'Not Found');

export function validationFailed(resource: string, field: string, code: string, extraMessage?: string): ApiError {
  const error: Record<string, unknown> = { resource, field, code };
  if (extraMessage !== undefined) error.message = extraMessage;
  return new ApiError(422, 'Validation Failed', { errors: [error] });
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  issueNumber: number;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: Label[];
  comments: Comment[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  /** Set when this number is a pull request. */
  pull: Pull | null;
}

export interface Pull {
  id: number;
  number: number;
  issue: Issue;
  head: string;
  base: string;
  draft: boolean;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  /** Frozen once the pull request is merged or closed. */
  frozenHeadSha: string | null;
  frozenBaseSha: string | null;
  /** The base tip when the pull request was opened (GitHub's base.sha until the base moves on merge). */
  baseShaAtOpen: string;
}

export interface Repo {
  id: number;
  name: string;
  description: string | null;
  homepage: string | null;
  private: boolean;
  defaultBranch: string;
  hasIssues: boolean;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  createdAt: number;
  updatedAt: number;
  pushedAt: number;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  sha: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
}

const DEFAULT_LOGIN = 'octocat';
const DEFAULT_EPOCH = Date.UTC(2026, 0, 1) / 1000;
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

function startTime(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw !== '') {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return DEFAULT_EPOCH;
}

export function isoTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class Forge {
  readonly git = new GitStore();
  readonly repos = new Map<string, Repo>();
  readonly viewerId = 1;
  private bound: string | null = null;
  private clock = startTime();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;

  /** The login the token names: learned from the first request that names it, else a default. */
  get login(): string {
    return this.bound ?? DEFAULT_LOGIN;
  }

  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  now(): number {
    return this.clock;
  }

  person(time: number, override?: { name?: unknown; email?: unknown }): Person {
    const name = typeof override?.name === 'string' && override.name !== '' ? override.name : this.login;
    const email = typeof override?.email === 'string' && override.email !== '' ? override.email : `${this.login}@users.noreply.localhost`;
    return { name, email, time, tz: '+0000' };
  }

  /**
   * Whether `owner` is the token's login. The forge is never told the login up front, so the
   * first request that names an owner for a repository this token created binds that owner; from
   * then on only that login (case-insensitively) owns anything, and every other owner reads 404.
   */
  ownsAs(owner: string, repoName?: string): boolean {
    if (this.bound !== null) return owner.toLowerCase() === this.bound.toLowerCase();
    if (repoName !== undefined && this.repos.has(repoName.toLowerCase()) && /^[A-Za-z0-9-]{1,39}$/.test(owner)) {
      this.bound = owner;
      return true;
    }
    return false;
  }

  /** The viewer's repository at owner/name, or a 404. */
  repo(owner: string, name: string): Repo {
    const repo = this.repos.get(name.toLowerCase());
    if (repo === undefined || !this.ownsAs(owner, name)) throw notFound();
    return repo;
  }

  findRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name.toLowerCase());
    if (repo === undefined || !this.ownsAs(owner, name)) return null;
    return repo;
  }

  // ------------------------------------------------------------------ repositories

  createRepo(input: Record<string, unknown>): Repo {
    const name = input.name;
    if (typeof name !== 'string' || name === '') throw validationFailed('Repository', 'name', 'missing_field');
    if (!NAME_PATTERN.test(name) || name === '.' || name === '..') throw validationFailed('Repository', 'name', 'custom', 'name is invalid');
    if (this.repos.has(name.toLowerCase())) throw validationFailed('Repository', 'name', 'custom', 'name already exists on this account');
    const time = this.tick();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      description: typeof input.description === 'string' ? input.description : null,
      homepage: typeof input.homepage === 'string' ? input.homepage : null,
      private: input.private === true || input.visibility === 'private',
      defaultBranch: typeof input.default_branch === 'string' && input.default_branch !== '' ? input.default_branch : 'main',
      hasIssues: input.has_issues !== false,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: time,
      updatedAt: time,
      pushedAt: time,
    };
    this.repos.set(name.toLowerCase(), repo);
    if (input.auto_init === true) {
      const blob = this.git.writeBlob(Buffer.from(`# ${name}\n${repo.description === null ? '' : `\n${repo.description}\n`}`, 'utf8'));
      const tree = this.git.buildTree(new Map([['README.md', { sha: blob, mode: '100644' }]]));
      const sha = this.git.writeCommit({ tree, parents: [], author: this.person(time), committer: this.person(time), message: 'Initial commit' });
      repo.refs.set(`refs/heads/${repo.defaultBranch}`, sha);
    }
    return repo;
  }

  updateRepo(repo: Repo, input: Record<string, unknown>): Repo {
    if (typeof input.name === 'string' && input.name !== repo.name) {
      if (!NAME_PATTERN.test(input.name)) throw validationFailed('Repository', 'name', 'custom', 'name is invalid');
      const existing = this.repos.get(input.name.toLowerCase());
      if (existing !== undefined && existing !== repo) throw validationFailed('Repository', 'name', 'custom', 'name already exists on this account');
      this.repos.delete(repo.name.toLowerCase());
      repo.name = input.name;
      this.repos.set(repo.name.toLowerCase(), repo);
    }
    if (input.description === null || typeof input.description === 'string') repo.description = input.description as string | null;
    if (input.homepage === null || typeof input.homepage === 'string') repo.homepage = input.homepage as string | null;
    if (typeof input.private === 'boolean') repo.private = input.private;
    if (input.visibility === 'private' || input.visibility === 'public') repo.private = input.visibility === 'private';
    if (typeof input.has_issues === 'boolean') repo.hasIssues = input.has_issues;
    if (typeof input.default_branch === 'string' && input.default_branch !== '') {
      if (repo.refs.size > 0 && !repo.refs.has(`refs/heads/${input.default_branch}`)) {
        throw validationFailed('Repository', 'default_branch', 'invalid', `The branch ${input.default_branch} was not found`);
      }
      repo.defaultBranch = input.default_branch;
    }
    repo.updatedAt = this.tick();
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name.toLowerCase());
  }

  /** Repositories the viewer owns, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  // ------------------------------------------------------------------ refs and commits

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** A ref name, a full ref or a commit sha (full or abbreviated) to a commit sha; null when unknown. */
  resolve(repo: Repo, ref: string): string | null {
    if (ref === '' || ref === 'HEAD') return this.branchTip(repo, repo.defaultBranch) ?? null;
    const direct = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
    if (direct !== undefined) return this.peel(direct);
    if (/^[0-9a-f]{40}$/i.test(ref)) {
      const sha = ref.toLowerCase();
      return this.git.commit(sha) !== undefined ? sha : null;
    }
    if (/^[0-9a-f]{4,39}$/i.test(ref)) {
      const prefix = ref.toLowerCase();
      for (const commit of this.git.history([...repo.refs.values()])) if (commit.sha.startsWith(prefix)) return commit.sha;
    }
    return null;
  }

  /** Follow an annotated tag to its commit. */
  peel(sha: string): string {
    let current = sha;
    for (let i = 0; i < 8; i += 1) {
      const object = this.git.get(current);
      if (object?.type !== 'tag') return current;
      const match = /^object ([0-9a-f]{40})/.exec(object.data.toString('utf8'));
      if (match === null) return current;
      current = match[1] as string;
    }
    return current;
  }

  /** The tree of a commit as a flat path map (empty for null). */
  files(commitSha: string | null | undefined): FlatTree {
    if (commitSha === null || commitSha === undefined) return new Map();
    const commit = this.git.commit(commitSha);
    return commit === undefined ? new Map() : this.git.flatten(commit.tree);
  }

  createRef(repo: Repo, ref: unknown, sha: unknown): string {
    if (typeof ref !== 'string' || !/^refs\/[^/]+\/.+/.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) {
      throw new ApiError(422, 'Reference name is invalid');
    }
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha) || !this.git.has(sha.toLowerCase())) throw new ApiError(422, 'Object does not exist');
    if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
    if (this.refConflicts(repo, ref)) throw new ApiError(422, 'Reference name is invalid');
    repo.refs.set(ref, sha.toLowerCase());
    repo.pushedAt = this.tick();
    return ref;
  }

  /** Whether a new ref collides with an existing one as a directory/file (refs/heads/a vs refs/heads/a/b). */
  refConflicts(repo: Repo, ref: string): boolean {
    for (const existing of repo.refs.keys()) {
      if (existing.startsWith(`${ref}/`) || ref.startsWith(`${existing}/`)) return true;
    }
    return false;
  }

  updateRef(repo: Repo, ref: string, sha: unknown, force: boolean): void {
    const current = repo.refs.get(ref);
    if (current === undefined) throw new ApiError(422, 'Reference does not exist');
    if (typeof sha !== 'string' || !this.git.has(sha.toLowerCase())) throw new ApiError(422, 'Object does not exist');
    const next = sha.toLowerCase();
    if (!force && !this.git.isAncestor(current, next)) throw new ApiError(422, 'Update is not a fast forward');
    repo.refs.set(ref, next);
    repo.pushedAt = this.tick();
  }

  deleteRef(repo: Repo, ref: string): void {
    if (!repo.refs.delete(ref)) throw new ApiError(422, 'Reference does not exist');
    repo.pushedAt = this.tick();
  }

  /** Commit a new flat tree on a branch (creating the branch when the repository is empty). */
  commitFiles(repo: Repo, branch: string, files: FlatTree, message: string, people: { author?: unknown; committer?: unknown } = {}): Commit {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    const time = this.tick();
    const author = this.person(time, asRecord(people.author));
    const committer = people.committer === undefined ? author : this.person(time, asRecord(people.committer));
    const tree = files.size === 0 ? EMPTY_TREE : this.git.buildTree(files);
    const sha = this.git.writeCommit({ tree, parents: parent === undefined ? [] : [parent], author, committer, message });
    repo.refs.set(ref, sha);
    repo.pushedAt = time;
    repo.updatedAt = time;
    return this.git.commit(sha) as Commit;
  }

  /** The branch a contents write targets, and its tip; 404 for an unknown branch of a non-empty repository. */
  private writeTarget(repo: Repo, branchInput: unknown): { branch: string; tip: string | undefined } {
    const branch = typeof branchInput === 'string' && branchInput !== '' ? branchInput.replace(/^refs\/heads\//, '') : repo.defaultBranch;
    const tip = this.branchTip(repo, branch);
    if (tip === undefined && repo.refs.size > 0) throw new ApiError(404, `Branch ${branch} not found`);
    return { branch, tip };
  }

  putContents(repo: Repo, path: string, input: Record<string, unknown>): { created: boolean; blobSha: string; commit: Commit; path: string } {
    const clean = normalisePath(path);
    if (clean === '') throw new ApiError(422, 'path cannot be blank');
    if (typeof input.message !== 'string' || input.message === '') throw validationFailed('Commit', 'message', 'missing_field');
    if (typeof input.content !== 'string') throw validationFailed('Commit', 'content', 'missing_field');
    if (!/^[A-Za-z0-9+/=\s_-]*$/.test(input.content)) throw new ApiError(422, 'content is not valid Base64');
    const { branch, tip } = this.writeTarget(repo, input.branch);
    const files = new Map(this.files(tip));
    const current = files.get(clean);
    if (current !== undefined) {
      if (typeof input.sha !== 'string' || input.sha === '') throw new ApiError(422, `Invalid request.\n\n"sha" wasn't supplied.`);
      if (input.sha.toLowerCase() !== current.sha) throw new ApiError(409, `${clean} does not match ${input.sha}`);
    } else {
      const parts = clean.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        if (files.has(parts.slice(0, i).join('/'))) throw new ApiError(422, `A file exists at ${parts.slice(0, i).join('/')}`);
      }
      const prefix = `${clean}/`;
      for (const key of files.keys()) if (key.startsWith(prefix)) throw new ApiError(422, `${clean} is a directory`);
    }
    const blobSha = this.git.writeBlob(Buffer.from(input.content, 'base64'));
    files.set(clean, { sha: blobSha, mode: current?.mode ?? '100644' });
    const commit = this.commitFiles(repo, branch, files, input.message, { author: input.author, committer: input.committer });
    return { created: current === undefined, blobSha, commit, path: clean };
  }

  deleteContents(repo: Repo, path: string, input: Record<string, unknown>): Commit {
    const clean = normalisePath(path);
    if (typeof input.message !== 'string' || input.message === '') throw validationFailed('Commit', 'message', 'missing_field');
    const { branch, tip } = this.writeTarget(repo, input.branch);
    const files = new Map(this.files(tip));
    const current = files.get(clean);
    if (current === undefined) throw notFound();
    if (typeof input.sha !== 'string' || input.sha === '') throw new ApiError(422, `Invalid request.\n\n"sha" wasn't supplied.`);
    if (input.sha.toLowerCase() !== current.sha) throw new ApiError(409, `${clean} does not match ${input.sha}`);
    files.delete(clean);
    return this.commitFiles(repo, branch, files, input.message, { author: input.author, committer: input.committer });
  }

  // ------------------------------------------------------------------ labels

  createLabel(repo: Repo, input: Record<string, unknown>): Label {
    const name = input.name;
    if (typeof name !== 'string' || name.trim() === '') throw validationFailed('Label', 'name', 'missing_field');
    if (repo.labels.has(name.toLowerCase())) throw validationFailed('Label', 'name', 'already_exists');
    const color = typeof input.color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(input.color) ? input.color.replace(/^#/, '').toLowerCase() : 'ededed';
    const label: Label = { id: this.nextLabelId++, name, color, description: typeof input.description === 'string' ? input.description : null };
    repo.labels.set(name.toLowerCase(), label);
    return label;
  }

  label(repo: Repo, name: string): Label {
    const label = repo.labels.get(name.toLowerCase());
    if (label === undefined) throw notFound();
    return label;
  }

  updateLabel(repo: Repo, name: string, input: Record<string, unknown>): Label {
    const label = this.label(repo, name);
    const newName = typeof input.new_name === 'string' && input.new_name !== '' ? input.new_name : typeof input.name === 'string' && input.name !== '' ? input.name : label.name;
    if (newName.toLowerCase() !== label.name.toLowerCase() && repo.labels.has(newName.toLowerCase())) throw validationFailed('Label', 'name', 'already_exists');
    repo.labels.delete(label.name.toLowerCase());
    label.name = newName;
    repo.labels.set(newName.toLowerCase(), label);
    if (typeof input.color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(input.color)) label.color = input.color.replace(/^#/, '').toLowerCase();
    if (input.description === null || typeof input.description === 'string') label.description = input.description as string | null;
    return label;
  }

  deleteLabel(repo: Repo, name: string): void {
    const label = this.label(repo, name);
    repo.labels.delete(label.name.toLowerCase());
    for (const issue of repo.issues.values()) issue.labels = issue.labels.filter((entry) => entry !== label);
  }

  /** Label names (or {name} objects) to the repository's labels; 422 when one does not exist. */
  resolveLabels(repo: Repo, input: unknown): Label[] {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input)) throw validationFailed('Issue', 'labels', 'invalid');
    const out: Label[] = [];
    for (const item of input) {
      const name = typeof item === 'string' ? item : typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).name === 'string' ? ((item as Record<string, unknown>).name as string) : null;
      if (name === null) throw validationFailed('Issue', 'labels', 'invalid');
      const label = repo.labels.get(name.toLowerCase());
      if (label === undefined) throw new ApiError(422, 'Validation Failed', { errors: [{ value: name, resource: 'Label', field: 'name', code: 'invalid' }] });
      if (!out.includes(label)) out.push(label);
    }
    return out;
  }

  // ------------------------------------------------------------------ issues and comments

  createIssue(repo: Repo, input: Record<string, unknown>): Issue {
    if (!repo.hasIssues) throw new ApiError(410, 'Issues are disabled for this repo');
    const title = input.title;
    if ((typeof title !== 'string' && typeof title !== 'number') || String(title).trim() === '') throw validationFailed('Issue', 'title', 'missing_field');
    const labels = this.resolveLabels(repo, input.labels);
    return this.newIssue(repo, String(title), typeof input.body === 'string' ? input.body : '', labels);
  }

  private newIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const time = this.tick();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      stateReason: null,
      labels,
      comments: [],
      createdAt: time,
      updatedAt: time,
      closedAt: null,
      pull: null,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  issue(repo: Repo, number: number): Issue {
    const issue = repo.issues.get(number);
    if (issue === undefined) throw notFound();
    return issue;
  }

  updateIssue(repo: Repo, issue: Issue, input: Record<string, unknown>): Issue {
    if (input.title !== undefined) {
      if (typeof input.title !== 'string' || input.title.trim() === '') throw validationFailed('Issue', 'title', 'missing_field');
      issue.title = input.title;
    }
    if (input.body === null) issue.body = '';
    else if (typeof input.body === 'string') issue.body = input.body;
    if (input.labels !== undefined) issue.labels = this.resolveLabels(repo, input.labels);
    if (input.state !== undefined) {
      if (input.state !== 'open' && input.state !== 'closed') throw validationFailed('Issue', 'state', 'invalid');
      if (input.state === 'closed' && issue.state === 'open') {
        issue.state = 'closed';
        issue.closedAt = this.tick();
        issue.stateReason = typeof input.state_reason === 'string' ? input.state_reason : 'completed';
        if (issue.pull !== null) this.freeze(repo, issue.pull);
      } else if (input.state === 'open' && issue.state === 'closed') {
        if (issue.pull?.merged === true) throw validationFailed('PullRequest', 'state', 'invalid', 'cannot reopen a merged pull request');
        issue.state = 'open';
        issue.closedAt = null;
        issue.stateReason = 'reopened';
        if (issue.pull !== null) {
          issue.pull.frozenHeadSha = null;
          issue.pull.frozenBaseSha = null;
        }
      }
    }
    issue.updatedAt = this.tick();
    return issue;
  }

  /** Issues (and pull requests, as GitHub lists them) filtered and sorted as GET /issues takes them. */
  listIssues(repo: Repo, query: URLSearchParams): Issue[] {
    const state = query.get('state') ?? 'open';
    const sort = query.get('sort') ?? 'created';
    const direction = query.get('direction') ?? 'desc';
    const labelFilter = (query.get('labels') ?? '').split(',').map((name) => name.trim().toLowerCase()).filter((name) => name !== '');
    let issues = [...repo.issues.values()];
    if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
    if (labelFilter.length > 0) issues = issues.filter((issue) => labelFilter.every((name) => issue.labels.some((label) => label.name.toLowerCase() === name)));
    const key = (issue: Issue): number => (sort === 'updated' ? issue.updatedAt : sort === 'comments' ? issue.comments.length : issue.createdAt);
    issues.sort((a, b) => key(a) - key(b) || a.number - b.number);
    if (direction !== 'asc') issues.reverse();
    return issues;
  }

  addComment(repo: Repo, issue: Issue, input: Record<string, unknown>): Comment {
    if (typeof input.body !== 'string' || input.body === '') throw validationFailed('IssueComment', 'body', 'missing_field');
    const time = this.tick();
    const comment: Comment = { id: this.nextCommentId++, issueNumber: issue.number, body: input.body, createdAt: time, updatedAt: time };
    issue.comments.push(comment);
    issue.updatedAt = time;
    void repo;
    return comment;
  }

  comment(repo: Repo, id: number): Comment {
    for (const issue of repo.issues.values()) {
      const found = issue.comments.find((comment) => comment.id === id);
      if (found !== undefined) return found;
    }
    throw notFound();
  }

  deleteComment(repo: Repo, id: number): void {
    const comment = this.comment(repo, id);
    const issue = repo.issues.get(comment.issueNumber);
    if (issue !== undefined) issue.comments = issue.comments.filter((entry) => entry !== comment);
  }

  // ------------------------------------------------------------------ pull requests

  createPull(repo: Repo, input: Record<string, unknown>): Pull {
    const title = input.title;
    if (typeof title !== 'string' || title.trim() === '') throw validationFailed('PullRequest', 'title', 'missing_field');
    if (typeof input.head !== 'string' || input.head === '') throw validationFailed('PullRequest', 'head', 'missing_field');
    if (typeof input.base !== 'string' || input.base === '') throw validationFailed('PullRequest', 'base', 'missing_field');
    const head = stripOwner(input.head);
    const base = input.base.replace(/^refs\/heads\//, '');
    const headTip = this.branchTip(repo, head);
    const baseTip = this.branchTip(repo, base);
    if (headTip === undefined) throw validationFailed('PullRequest', 'head', 'invalid');
    if (baseTip === undefined) throw validationFailed('PullRequest', 'base', 'invalid');
    if (head === base) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'custom', message: `No commits between ${base} and ${head}` }] });
    for (const pull of repo.pulls.values()) {
      if (pull.issue.state === 'open' && pull.head === head && pull.base === base) {
        throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${this.login}:${head}.` }] });
      }
    }
    const issue = this.newIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
    const pull: Pull = {
      id: this.nextPullId++,
      number: issue.number,
      issue,
      head,
      base,
      draft: input.draft === true,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      frozenHeadSha: null,
      frozenBaseSha: null,
      baseShaAtOpen: baseTip,
    };
    issue.pull = pull;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  pull(repo: Repo, number: number): Pull {
    const pull = repo.pulls.get(number);
    if (pull === undefined) throw notFound();
    return pull;
  }

  headSha(repo: Repo, pull: Pull): string {
    return pull.frozenHeadSha ?? this.branchTip(repo, pull.head) ?? pull.baseShaAtOpen;
  }

  baseSha(repo: Repo, pull: Pull): string {
    return pull.frozenBaseSha ?? this.branchTip(repo, pull.base) ?? pull.baseShaAtOpen;
  }

  private freeze(repo: Repo, pull: Pull): void {
    pull.frozenHeadSha = this.headSha(repo, pull);
    pull.frozenBaseSha = this.baseSha(repo, pull);
  }

  updatePull(repo: Repo, pull: Pull, input: Record<string, unknown>): Pull {
    if (typeof input.base === 'string' && input.base !== '') {
      if (this.branchTip(repo, input.base) === undefined) throw validationFailed('PullRequest', 'base', 'invalid');
      pull.base = input.base;
    }
    this.updateIssue(repo, pull.issue, { title: input.title, body: input.body, state: input.state });
    return pull;
  }

  /**
   * The squash (or merge) result of a pull request, without writing anything: the new flat tree,
   * or the conflicting paths when the head and the base both changed a path since their merge base.
   */
  mergePreview(repo: Repo, pull: Pull): { files: FlatTree; conflicts: string[]; mergeBase: string | null } {
    const headTip = this.headSha(repo, pull);
    const baseTip = this.baseSha(repo, pull);
    const mergeBase = this.git.mergeBase(headTip, baseTip);
    const ancestor = this.files(mergeBase);
    const head = this.files(headTip);
    const base = this.files(baseTip);
    const files = new Map(base);
    const conflicts: string[] = [];
    const paths = new Set<string>([...ancestor.keys(), ...head.keys()]);
    for (const path of paths) {
      const a = ancestor.get(path)?.sha;
      const h = head.get(path)?.sha;
      if (h === a) continue;
      const b = base.get(path)?.sha;
      if (b !== a && b !== h) {
        conflicts.push(path);
        continue;
      }
      const entry = head.get(path);
      if (entry === undefined) files.delete(path);
      else files.set(path, entry);
    }
    return { files, conflicts, mergeBase };
  }

  mergeable(repo: Repo, pull: Pull): boolean {
    if (pull.merged || pull.issue.state !== 'open') return false;
    if (this.branchTip(repo, pull.head) === undefined || this.branchTip(repo, pull.base) === undefined) return false;
    return this.mergePreview(repo, pull).conflicts.length === 0;
  }

  merge(repo: Repo, pull: Pull, input: Record<string, unknown>): { sha: string; message: string } {
    if (pull.merged || pull.issue.state !== 'open') throw new ApiError(405, 'Pull Request is not mergeable');
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined || pull.head === pull.base) throw new ApiError(405, 'Pull Request is not mergeable');
    if (typeof input.sha === 'string' && input.sha !== '' && input.sha.toLowerCase() !== headTip) {
      throw new ApiError(409, 'Head branch was modified. Review and try the merge again.');
    }
    const method = input.merge_method === 'merge' || input.merge_method === 'rebase' ? input.merge_method : 'squash';
    const preview = this.mergePreview(repo, pull);
    if (preview.conflicts.length > 0) throw new ApiError(405, 'Pull Request is not mergeable');
    const commits = this.pullCommits(repo, pull);
    const title = typeof input.commit_title === 'string' && input.commit_title !== ''
      ? input.commit_title
      : method === 'merge' ? `Merge pull request #${pull.number} from ${this.login}/${pull.head}` : `${pull.issue.title} (#${pull.number})`;
    const detail = typeof input.commit_message === 'string'
      ? input.commit_message
      : method === 'merge' ? pull.issue.title : commits.map((commit) => `* ${commit.message}`).join('\n\n');
    const message = detail === '' ? title : `${title}\n\n${detail}`;
    const time = this.tick();
    const tree = preview.files.size === 0 ? EMPTY_TREE : this.git.buildTree(preview.files);
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const sha = this.git.writeCommit({ tree, parents, author: this.person(time), committer: this.person(time), message });
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    repo.pushedAt = time;
    pull.frozenHeadSha = headTip;
    pull.frozenBaseSha = baseTip;
    pull.merged = true;
    pull.mergedAt = time;
    pull.mergeCommitSha = sha;
    pull.issue.state = 'closed';
    pull.issue.stateReason = 'completed';
    pull.issue.closedAt = time;
    pull.issue.updatedAt = time;
    return { sha, message: 'Pull Request successfully merged' };
  }

  /** The commits on the head that the base does not have, oldest first. */
  pullCommits(repo: Repo, pull: Pull): Commit[] {
    const headTip = this.headSha(repo, pull);
    const baseTip = this.baseSha(repo, pull);
    const excluded = new Set(this.git.history([baseTip]).map((commit) => commit.sha));
    return this.git.history([headTip]).filter((commit) => !excluded.has(commit.sha)).reverse();
  }

  /** The files a pull request changes: its head against the merge base (GitHub's three-dot diff). */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const headTip = this.headSha(repo, pull);
    const baseTip = this.baseSha(repo, pull);
    const mergeBase = this.git.mergeBase(headTip, baseTip);
    return this.diff(this.files(mergeBase), this.files(headTip));
  }

  diff(before: FlatTree, after: FlatTree): FileChange[] {
    const paths = [...new Set<string>([...before.keys(), ...after.keys()])].sort();
    const out: FileChange[] = [];
    for (const path of paths) {
      const a = before.get(path);
      const b = after.get(path);
      if (a?.sha === b?.sha) continue;
      const oldText = a === undefined ? '' : (this.git.blob(a.sha) ?? Buffer.alloc(0)).toString('utf8');
      const newText = b === undefined ? '' : (this.git.blob(b.sha) ?? Buffer.alloc(0)).toString('utf8');
      const { additions, deletions, patch } = lineDiff(oldText, newText);
      out.push({
        filename: path,
        status: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified',
        sha: (b ?? a)?.sha ?? '',
        additions,
        deletions,
        changes: additions + deletions,
        patch,
      });
    }
    return out;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stripOwner(head: string): string {
  const colon = head.indexOf(':');
  return (colon >= 0 ? head.slice(colon + 1) : head).replace(/^refs\/heads\//, '');
}

export function normalisePath(path: string): string {
  return path.split('/').filter((part) => part !== '' && part !== '.').join('/');
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line counts and a single-hunk unified patch; the counts match a multiset line diff. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number; patch: string } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  const removed = oldLines.slice(start, endOld);
  const added = newLines.slice(start, endNew);
  const header = `@@ -${removed.length === 0 ? start : start + 1},${removed.length} +${added.length === 0 ? start : start + 1},${added.length} @@`;
  const body = [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)];
  return { additions: added.length, deletions: removed.length, patch: body.length === 0 ? '' : [header, ...body].join('\n') };
}
