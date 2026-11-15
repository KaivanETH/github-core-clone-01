// The GitHub REST v3 routes under /api/v3. A handler gets the decoded path segments after the
// prefix and returns a Reply, or throws an ApiError (forge.ts) that app.ts renders as JSON.

import { ApiError, notFound, normalisePath, type Forge, type Repo } from './forge.ts';
import {
  branchJson,
  commentJson,
  commitJson,
  contentEntryJson,
  fileJson,
  gitCommitJson,
  issueJson,
  labelJson,
  pullJson,
  refJson,
  repoJson,
  userJson,
} from './render.ts';

export interface Ctx {
  method: string;
  /** Decoded path segments after /api/v3. */
  segs: string[];
  query: URLSearchParams;
  /** The parsed JSON body (undefined when the request had none). */
  body: unknown;
  /** The origin the client dialled, e.g. http://10.0.0.5:41234. */
  base: string;
  /** The request's raw pathname, for pagination links. */
  path: string;
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export const INSTALLED_VERSION = '3.14.0';

const ok = (body: unknown, headers?: Record<string, string>): Reply => ({ status: 200, body, headers });
const created = (body: unknown, headers?: Record<string, string>): Reply => ({ status: 201, body, headers });
const noContent = (): Reply => ({ status: 204 });

function input(ctx: Ctx): Record<string, unknown> {
  if (ctx.body === undefined || ctx.body === null) return {};
  if (typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new ApiError(400, 'Body should be a JSON object');
  return ctx.body as Record<string, unknown>;
}

function intSeg(value: string | undefined): number {
  if (value === undefined || !/^\d{1,15}$/.test(value)) throw notFound();
  return Number(value);
}

/** One page of `items` and GitHub's Link header (next, last, first, prev) for the rest. */
function paginate<T>(ctx: Ctx, items: readonly T[]): { items: T[]; headers: Record<string, string> } {
  const perRaw = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isInteger(perRaw) && perRaw > 0 ? Math.min(perRaw, 100) : 30;
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const link = (target: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `<${ctx.base}${ctx.path}?${params.toString()}>`;
  };
  const rels: string[] = [];
  if (page > 1) rels.push(`${link(page - 1)}; rel="prev"`);
  if (page < lastPage) rels.push(`${link(page + 1)}; rel="next"`, `${link(lastPage)}; rel="last"`);
  if (page > 1) rels.push(`${link(1)}; rel="first"`);
  return { items: slice, headers: rels.length === 0 ? {} : { link: rels.join(', ') } };
}

function list<T>(ctx: Ctx, items: readonly T[], render: (item: T) => unknown): Reply {
  const { items: pageItems, headers } = paginate(ctx, items);
  return ok(pageItems.map(render), headers);
}

export function handleRest(forge: Forge, ctx: Ctx): Reply {
  const { segs, method } = ctx;
  const head = segs[0];

  if (segs.length === 0) {
    if (method !== 'GET') throw notFound();
    return ok(apiRoot(ctx.base));
  }

  if (head === 'meta' && segs.length === 1 && method === 'GET') {
    return ok({ verifiable_password_authentication: false, installed_version: INSTALLED_VERSION, hooks: [], web: [], api: [], git: [], packages: [], pages: [], importer: [], actions: [], dependabot: [] });
  }

  if (head === 'rate_limit' && segs.length === 1 && method === 'GET') {
    const core = { limit: 5000, used: 0, remaining: 5000, reset: forge.now() + 3600 };
    return ok({ resources: { core, search: core, graphql: core }, rate: core });
  }

  if (head === 'user') {
    if (segs.length === 1 && method === 'GET') return ok({ ...userJson(forge, ctx.base), name: forge.login, public_repos: forge.repos.size });
    if (segs.length === 2 && segs[1] === 'repos') {
      if (method === 'GET') return listRepos(forge, ctx);
      if (method === 'POST') {
        const repo = forge.createRepo(input(ctx));
        return created(repoJson(forge, repo, ctx.base), { location: `${ctx.base}/api/v3/repos/${forge.login}/${repo.name}` });
      }
    }
    throw notFound();
  }

  if (head === 'users' && segs.length >= 2) {
    const login = segs[1] as string;
    if (login.toLowerCase() !== forge.login.toLowerCase()) throw notFound();
    if (segs.length === 2 && method === 'GET') return ok(userJson(forge, ctx.base));
    if (segs.length === 3 && segs[2] === 'repos' && method === 'GET') return listRepos(forge, ctx);
    throw notFound();
  }

  if (head === 'repos' && segs.length >= 3) {
    const repo = forge.repo(segs[1] as string, segs[2] as string);
    return repoRoutes(forge, repo, ctx, segs.slice(3));
  }

  throw notFound();
}

function apiRoot(base: string): Record<string, string> {
  const api = `${base}/api/v3`;
  return {
    current_user_url: `${api}/user`,
    current_user_repositories_url: `${api}/user/repos{?type,page,per_page,sort}`,
    repository_url: `${api}/repos/{owner}/{repo}`,
    user_url: `${api}/users/{user}`,
    user_repositories_url: `${api}/users/{user}/repos{?type,page,per_page,sort}`,
    issues_url: `${api}/issues`,
    rate_limit_url: `${api}/rate_limit`,
    meta_url: `${api}/meta`,
    graphql_url: `${base}/api/graphql`,
  };
}

function listRepos(forge: Forge, ctx: Ctx): Reply {
  const sort = ctx.query.get('sort') ?? 'full_name';
  const repos = forge.listRepos();
  const key = (repo: Repo): number | string => (sort === 'created' ? repo.createdAt : sort === 'updated' ? repo.updatedAt : sort === 'pushed' ? repo.pushedAt : repo.name.toLowerCase());
  repos.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : a.id - b.id;
  });
  const direction = ctx.query.get('direction') ?? (sort === 'full_name' ? 'asc' : 'desc');
  if (direction === 'desc') repos.reverse();
  const visibility = ctx.query.get('visibility');
  const filtered = visibility === 'private' || visibility === 'public' ? repos.filter((repo) => repo.private === (visibility === 'private')) : repos;
  return list(ctx, filtered, (repo) => repoJson(forge, repo, ctx.base));
}

function repoRoutes(forge: Forge, repo: Repo, ctx: Ctx, rest: string[]): Reply {
  const { method, base } = ctx;
  const section = rest[0];

  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(forge, repo, base));
    if (method === 'PATCH') return ok(repoJson(forge, forge.updateRepo(repo, input(ctx)), base));
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return noContent();
    }
    throw notFound();
  }

  switch (section) {
    case 'branches':
      return branchRoutes(forge, repo, ctx, rest.slice(1));
    case 'commits':
      return commitRoutes(forge, repo, ctx, rest.slice(1));
    case 'contents':
      return contentRoutes(forge, repo, ctx, rest.slice(1).join('/'));
    case 'git':
      return gitRoutes(forge, repo, ctx, rest.slice(1));
    case 'labels':
      return labelRoutes(forge, repo, ctx, rest.slice(1));
    case 'issues':
      return issueRoutes(forge, repo, ctx, rest.slice(1));
    case 'pulls':
      return pullRoutes(forge, repo, ctx, rest.slice(1));
    default:
      throw notFound();
  }
}

// ---------------------------------------------------------------------- branches, commits, refs

function branchRoutes(forge: Forge, repo: Repo, ctx: Ctx, rest: string[]): Reply {
  if (ctx.method !== 'GET') throw notFound();
  if (rest.length === 0) {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), sha }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return list(ctx, branches, (branch) => branchJson(forge, repo, branch.name, branch.sha, ctx.base));
  }
  const name = rest.join('/');
  const sha = forge.branchTip(repo, name);
  if (sha === undefined) throw new ApiError(404, 'Branch not found');
  const commit = forge.git.commit(sha);
  const api = `${ctx.base}/api/v3/repos/${forge.login}/${repo.name}`;
  return ok({
    name,
    commit: commit === undefined ? { sha } : commitJson(forge, repo, commit, ctx.base),
    _links: { self: `${api}/branches/${name}`, html: `${ctx.base}/${forge.login}/${repo.name}/tree/${name}` },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
    protection_url: `${api}/branches/${name}/protection`,
  });
}

function commitRoutes(forge: Forge, repo: Repo, ctx: Ctx, rest: string[]): Reply {
  if (ctx.method !== 'GET') throw notFound();
  if (repo.refs.size === 0) throw new ApiError(409, 'Git Repository is empty.');
  if (rest.length === 0) {
    const ref = ctx.query.get('sha') ?? '';
    const tip = forge.resolve(repo, ref);
    if (tip === null) throw new ApiError(404, `No commit found for SHA: ${ref}`);
    let commits = forge.git.history([tip]);
    const path = normalisePath(ctx.query.get('path') ?? '');
    if (path !== '') {
      commits = commits.filter((commit) => {
        const mine = forge.files(commit.sha);
        const parent = forge.files(commit.parents[0] ?? null);
        const touched = (files: typeof mine): string => [...files].filter(([key]) => key === path || key.startsWith(`${path}/`)).map(([key, value]) => `${key}:${value.sha}`).join(',');
        return touched(mine) !== touched(parent);
      });
    }
    return list(ctx, commits, (commit) => commitJson(forge, repo, commit, ctx.base));
  }
  const ref = rest.join('/');
  const sha = forge.resolve(repo, ref);
  const commit = sha === null ? undefined : forge.git.commit(sha);
  if (commit === undefined) throw new ApiError(422, `No commit found for SHA: ${ref}`);
  const files = forge.diff(forge.files(commit.parents[0] ?? null), forge.files(commit.sha));
  return ok(commitJson(forge, repo, commit, ctx.base, files));
}

function gitRoutes(forge: Forge, repo: Repo, ctx: Ctx, rest: string[]): Reply {
  const { method, base } = ctx;
  const kind = rest[0];
  if (kind === 'refs' || kind === 'ref') {
    const name = rest.slice(1).join('/');
    if (kind === 'refs' && name === '' && method === 'POST') {
      const body = input(ctx);
      const ref = forge.createRef(repo, body.ref, body.sha);
      return created(refJson(forge, repo, ref, repo.refs.get(ref) as string, base));
    }
    const full = name.startsWith('refs/') ? name : `refs/${name}`;
    if (method === 'GET') {
      const exact = repo.refs.get(full);
      if (exact !== undefined) return ok(refJson(forge, repo, full, exact, base));
      if (kind === 'ref') throw notFound();
      const prefix = name === '' ? 'refs/' : `${full}/`;
      const matches = [...repo.refs.entries()].filter(([ref]) => ref.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1));
      if (matches.length === 0) throw notFound();
      return ok(matches.map(([ref, sha]) => refJson(forge, repo, ref, sha, base)));
    }
    if (kind === 'refs' && name !== '' && method === 'PATCH') {
      const body = input(ctx);
      forge.updateRef(repo, full, body.sha, body.force === true);
      return ok(refJson(forge, repo, full, repo.refs.get(full) as string, base));
    }
    if (kind === 'refs' && name !== '' && method === 'DELETE') {
      forge.deleteRef(repo, full);
      return noContent();
    }
    throw notFound();
  }
  if (method !== 'GET' || rest.length !== 2) throw notFound();
  const sha = (rest[1] as string).toLowerCase();
  const object = forge.git.get(sha);
  const api = `${base}/api/v3/repos/${forge.login}/${repo.name}`;
  if (kind === 'commits' && object?.type === 'commit') return ok(gitCommitJson(forge, repo, forge.git.commit(sha)!, base));
  if (kind === 'blobs' && object?.type === 'blob') {
    return ok({ sha, node_id: `B_${sha}`, size: object.data.length, url: `${api}/git/blobs/${sha}`, content: object.data.toString('base64'), encoding: 'base64' });
  }
  if (kind === 'trees') {
    const treeSha = object?.type === 'commit' ? forge.git.commit(sha)!.tree : object?.type === 'tree' ? sha : null;
    if (treeSha === null) throw notFound();
    const recursive = ctx.query.has('recursive');
    const entries: Record<string, unknown>[] = [];
    const walk = (tree: string, prefix: string): void => {
      for (const entry of forge.git.tree(tree) ?? []) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const isTree = entry.mode === '40000';
        const item: Record<string, unknown> = { path, mode: isTree ? '040000' : entry.mode, type: isTree ? 'tree' : 'blob', sha: entry.sha, url: `${api}/git/${isTree ? 'trees' : 'blobs'}/${entry.sha}` };
        if (!isTree) item.size = forge.git.get(entry.sha)?.data.length ?? 0;
        entries.push(item);
        if (isTree && recursive) walk(entry.sha, path);
      }
    };
    walk(treeSha, '');
    return ok({ sha: treeSha, url: `${api}/git/trees/${treeSha}`, tree: entries, truncated: false });
  }
  throw notFound();
}

// ---------------------------------------------------------------------- contents

function contentRoutes(forge: Forge, repo: Repo, ctx: Ctx, rawPath: string): Reply {
  const path = normalisePath(rawPath);
  const { method, base } = ctx;
  if (method === 'PUT') {
    if (path === '') throw notFound();
    const result = forge.putContents(repo, path, input(ctx));
    const blob = forge.git.blob(result.blobSha) as Buffer;
    const ref = branchOf(input(ctx), repo);
    return {
      status: result.created ? 201 : 200,
      body: {
        content: contentEntryJson(forge, repo, result.path, 'file', result.blobSha, blob.length, base, ref),
        commit: gitCommitJson(forge, repo, result.commit, base),
      },
    };
  }
  if (method === 'DELETE') {
    if (path === '') throw notFound();
    const commit = forge.deleteContents(repo, path, input(ctx));
    return ok({ content: null, commit: gitCommitJson(forge, repo, commit, base) });
  }
  if (method !== 'GET') throw notFound();
  if (repo.refs.size === 0) throw new ApiError(404, 'This repository is empty.');
  const refName = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = forge.resolve(repo, refName);
  if (tip === null) throw new ApiError(404, `No commit found for the ref ${refName}`);
  const commit = forge.git.commit(tip);
  if (commit === undefined) throw notFound();
  const entry = forge.git.lookup(commit.tree, path);
  if (entry === undefined) throw notFound();
  if (entry.mode === '40000') {
    const children = forge.git.tree(entry.sha) ?? [];
    return ok(
      children.map((child) => {
        const childPath = path === '' ? child.name : `${path}/${child.name}`;
        const isDir = child.mode === '40000';
        const size = isDir ? 0 : forge.git.get(child.sha)?.data.length ?? 0;
        return contentEntryJson(forge, repo, childPath, isDir ? 'dir' : child.mode === '120000' ? 'symlink' : child.mode === '160000' ? 'submodule' : 'file', child.sha, size, base, refName);
      }),
    );
  }
  const data = forge.git.blob(entry.sha) ?? Buffer.alloc(0);
  const body = contentEntryJson(forge, repo, path, entry.mode === '120000' ? 'symlink' : 'file', entry.sha, data.length, base, refName);
  body.content = wrapBase64(data.toString('base64'));
  body.encoding = 'base64';
  return ok(body);
}

function branchOf(body: Record<string, unknown>, repo: Repo): string {
  return typeof body.branch === 'string' && body.branch !== '' ? body.branch.replace(/^refs\/heads\//, '') : repo.defaultBranch;
}

/** Base64 wrapped at 60 characters per line, as GitHub's contents API sends it. */
function wrapBase64(text: string): string {
  if (text === '') return '';
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += 60) lines.push(text.slice(i, i + 60));
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------- labels, issues, comments

function labelRoutes(forge: Forge, repo: Repo, ctx: Ctx, rest: string[]): Reply {
  const { method, base } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') return list(ctx, [...repo.labels.values()], (label) => labelJson(forge, repo, label, base));
    if (method === 'POST') return created(labelJson(forge, repo, forge.createLabel(repo, input(ctx)), base));
    throw notFound();
  }
  const name = rest.join('/');
  if (method === 'GET') return ok(labelJson(forge, repo, forge.label(repo, name), base));
  if (method === 'PATCH') return ok(labelJson(forge, repo, forge.updateLabel(repo, name, input(ctx)), base));
  if (method === 'DELETE') {
    forge.deleteLabel(repo, name);
    return noContent();
  }
  throw notFound();
}

function issueRoutes(forge: Forge, repo: Repo, ctx: Ctx, rest: string[]): Reply {
  const { method, base } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') return list(ctx, forge.listIssues(repo, ctx.query), (issue) => issueJson(forge, repo, issue, base));
    if (method === 'POST') {
      const issue = forge.createIssue(repo, input(ctx));
      return created(issueJson(forge, repo, issue, base), { location: `${base}/api/v3/repos/${forge.login}/${repo.name}/issues/${issue.number}` });
    }
    throw notFound();
  }
  if (rest[0] === 'comments') {
    if (rest.length === 1 && method === 'GET') {
      const all = [...repo.issues.values()].flatMap((issue) => issue.comments).sort((a, b) => a.id - b.id);
      return list(ctx, all, (comment) => commentJson(forge, repo, comment, base));
    }
    if (rest.length !== 2) throw notFound();
    const id = intSeg(rest[1]);
    if (method === 'GET') return ok(commentJson(forge, repo, forge.comment(repo, id), base));
    if (method === 'PATCH') {
      const comment = forge.comment(repo, id);
      const body = input(ctx);
      if (typeof body.body !== 'string' || body.body === '') throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }] });
      comment.body = body.body;
      comment.updatedAt = forge.tick();
      return ok(commentJson(forge, repo, comment, base));
    }
    if (method === 'DELETE') {
      forge.deleteComment(repo, id);
      return noContent();
    }
    throw notFound();
  }
  const issue = forge.issue(repo, intSeg(rest[0]));
  if (rest.length === 1) {
    if (method === 'GET') return ok(issueJson(forge, repo, issue, base));
    if (method === 'PATCH') return ok(issueJson(forge, repo, forge.updateIssue(repo, issue, input(ctx)), base));
    throw notFound();
  }
  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'GET') return list(ctx, issue.comments, (comment) => commentJson(forge, repo, comment, base));
    if (method === 'POST') return created(commentJson(forge, repo, forge.addComment(repo, issue, input(ctx)), base));
    throw notFound();
  }
  if (rest[1] === 'labels') {
    if (rest.length === 2) {
      if (method === 'GET') return list(ctx, issue.labels, (label) => labelJson(forge, repo, label, base));
      if (method === 'POST' || method === 'PUT') {
        const body = Array.isArray(ctx.body) ? ctx.body : input(ctx).labels;
        const labels = forge.resolveLabels(repo, body);
        issue.labels = method === 'PUT' ? labels : [...issue.labels, ...labels.filter((label) => !issue.labels.includes(label))];
        issue.updatedAt = forge.tick();
        return ok(issue.labels.map((label) => labelJson(forge, repo, label, base)));
      }
      if (method === 'DELETE') {
        issue.labels = [];
        issue.updatedAt = forge.tick();
        return noContent();
      }
    }
    if (rest.length === 3 && method === 'DELETE') {
      const name = (rest[2] as string).toLowerCase();
      const before = issue.labels.length;
      issue.labels = issue.labels.filter((label) => label.name.toLowerCase() !== name);
      if (issue.labels.length === before) throw new ApiError(404, 'Label does not exist');
      issue.updatedAt = forge.tick();
      return ok(issue.labels.map((label) => labelJson(forge, repo, label, base)));
    }
  }
  throw notFound();
}

// ---------------------------------------------------------------------- pull requests

function pullRoutes(forge: Forge, repo: Repo, ctx: Ctx, rest: string[]): Reply {
  const { method, base } = ctx;
  if (rest.length === 0) {
    if (method === 'POST') {
      const pull = forge.createPull(repo, input(ctx));
      return created(pullJson(forge, repo, pull, base), { location: `${base}/api/v3/repos/${forge.login}/${repo.name}/pulls/${pull.number}` });
    }
    if (method !== 'GET') throw notFound();
    const state = ctx.query.get('state') ?? 'open';
    const headFilter = ctx.query.get('head');
    const baseFilter = ctx.query.get('base');
    let pulls = [...repo.pulls.values()];
    if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.issue.state === state);
    if (headFilter !== null && headFilter !== '') {
      const branch = headFilter.includes(':') ? headFilter.slice(headFilter.indexOf(':') + 1) : headFilter;
      pulls = pulls.filter((pull) => pull.head === branch);
    }
    if (baseFilter !== null && baseFilter !== '') pulls = pulls.filter((pull) => pull.base === baseFilter);
    const sort = ctx.query.get('sort') ?? 'created';
    const key = (pull: (typeof pulls)[number]): number => (sort === 'updated' ? pull.issue.updatedAt : pull.issue.createdAt);
    pulls.sort((a, b) => key(a) - key(b) || a.number - b.number);
    if ((ctx.query.get('direction') ?? 'desc') !== 'asc') pulls.reverse();
    return list(ctx, pulls, (pull) => pullJson(forge, repo, pull, base, false));
  }
  const pull = forge.pull(repo, intSeg(rest[0]));
  if (rest.length === 1) {
    if (method === 'GET') return ok(pullJson(forge, repo, pull, base));
    if (method === 'PATCH') return ok(pullJson(forge, repo, forge.updatePull(repo, pull, input(ctx)), base));
    throw notFound();
  }
  if (rest.length !== 2) throw notFound();
  switch (rest[1]) {
    case 'files':
      if (method !== 'GET') throw notFound();
      return list(ctx, forge.pullFiles(repo, pull), (file) => fileJson(forge, repo, file, base, forge.headSha(repo, pull)));
    case 'commits':
      if (method !== 'GET') throw notFound();
      return list(ctx, forge.pullCommits(repo, pull), (commit) => commitJson(forge, repo, commit, base));
    case 'merge':
      if (method === 'GET') {
        if (!pull.merged) throw notFound();
        return noContent();
      }
      if (method === 'PUT') {
        const result = forge.merge(repo, pull, input(ctx));
        return ok({ sha: result.sha, merged: true, message: result.message });
      }
      throw notFound();
    default:
      throw notFound();
  }
}
