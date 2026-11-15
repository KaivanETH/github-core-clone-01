// GitHub-shaped JSON for the forge's objects. `base` is the origin the client dialled
// (http://host:port), so every url a body carries points back at this forge.

import type { FileChange, Forge, Issue, Label, Pull, Repo, Comment } from './forge.ts';
import { isoTime } from './forge.ts';
import type { Commit } from './git.ts';

type Json = Record<string, unknown>;

export function nodeId(kind: string, id: number | string): string {
  return `${kind}_${Buffer.from(`${kind}:${id}`, 'utf8').toString('base64url')}`;
}

export function userJson(forge: Forge, base: string): Json {
  const login = forge.login;
  return {
    login,
    id: forge.viewerId,
    node_id: nodeId('U', forge.viewerId),
    avatar_url: `${base}/avatars/${login}`,
    gravatar_id: '',
    url: `${base}/api/v3/users/${login}`,
    html_url: `${base}/${login}`,
    repos_url: `${base}/api/v3/users/${login}/repos`,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(forge: Forge, repo: Repo, base: string): Json {
  const full = `${forge.login}/${repo.name}`;
  const api = `${base}/api/v3/repos/${full}`;
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: nodeId('R', repo.id),
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userJson(forge, base),
    html_url: `${base}/${full}`,
    description: repo.description,
    fork: false,
    url: api,
    branches_url: `${api}/branches{/branch}`,
    issues_url: `${api}/issues{/number}`,
    pulls_url: `${api}/pulls{/number}`,
    contents_url: `${api}/contents/{+path}`,
    commits_url: `${api}/commits{/sha}`,
    labels_url: `${api}/labels{/name}`,
    git_refs_url: `${api}/git/refs{/sha}`,
    clone_url: `${base}/${full}.git`,
    git_url: `${base.replace(/^https?:/, 'git:')}/${full}.git`,
    ssh_url: `git@localhost:${full}.git`,
    svn_url: `${base}/${full}`,
    homepage: repo.homepage,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: repo.hasIssues,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    delete_branch_on_merge: false,
    created_at: isoTime(repo.createdAt),
    updated_at: isoTime(repo.updatedAt),
    pushed_at: isoTime(repo.pushedAt),
  };
}

function personJson(person: Commit['author']): Json {
  return { name: person.name, email: person.email, date: isoTime(person.time) };
}

export function commitJson(forge: Forge, repo: Repo, commit: Commit, base: string, files?: FileChange[]): Json {
  const api = `${base}/api/v3/repos/${forge.login}/${repo.name}`;
  const out: Json = {
    sha: commit.sha,
    node_id: nodeId('C', commit.sha),
    commit: {
      author: personJson(commit.author),
      committer: personJson(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree, url: `${api}/git/trees/${commit.tree}` },
      url: `${api}/git/commits/${commit.sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${api}/commits/${commit.sha}`,
    html_url: `${base}/${forge.login}/${repo.name}/commit/${commit.sha}`,
    comments_url: `${api}/commits/${commit.sha}/comments`,
    author: userJson(forge, base),
    committer: userJson(forge, base),
    parents: commit.parents.map((sha) => ({ sha, url: `${api}/commits/${sha}`, html_url: `${base}/${forge.login}/${repo.name}/commit/${sha}` })),
  };
  if (files !== undefined) {
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    out.stats = { total: additions + deletions, additions, deletions };
    out.files = files.map((file) => fileJson(forge, repo, file, base, commit.sha));
  }
  return out;
}

/** The `commit` member of a contents write reply (git-commit shaped, as GitHub answers it). */
export function gitCommitJson(forge: Forge, repo: Repo, commit: Commit, base: string): Json {
  const api = `${base}/api/v3/repos/${forge.login}/${repo.name}`;
  return {
    sha: commit.sha,
    node_id: nodeId('C', commit.sha),
    url: `${api}/git/commits/${commit.sha}`,
    html_url: `${base}/${forge.login}/${repo.name}/commit/${commit.sha}`,
    author: personJson(commit.author),
    committer: personJson(commit.committer),
    message: commit.message,
    tree: { sha: commit.tree, url: `${api}/git/trees/${commit.tree}` },
    parents: commit.parents.map((sha) => ({ sha, url: `${api}/git/commits/${sha}`, html_url: `${base}/${forge.login}/${repo.name}/commit/${sha}` })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
  };
}

export function contentEntryJson(forge: Forge, repo: Repo, path: string, type: 'file' | 'dir' | 'symlink' | 'submodule', sha: string, size: number, base: string, ref: string): Json {
  const api = `${base}/api/v3/repos/${forge.login}/${repo.name}`;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const self = `${api}/contents/${encoded}?ref=${encodeURIComponent(ref)}`;
  const html = `${base}/${forge.login}/${repo.name}/${type === 'dir' ? 'tree' : 'blob'}/${ref}/${encoded}`;
  const git = `${api}/git/${type === 'dir' ? 'trees' : 'blobs'}/${sha}`;
  return {
    type,
    size,
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    sha,
    url: self,
    git_url: git,
    html_url: html,
    download_url: type === 'file' ? `${base}/${forge.login}/${repo.name}/raw/${ref}/${encoded}` : null,
    _links: { self, git, html },
  };
}

export function labelJson(forge: Forge, repo: Repo, label: Label, base: string): Json {
  return {
    id: label.id,
    node_id: nodeId('LA', label.id),
    url: `${base}/api/v3/repos/${forge.login}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue, base: string): Json {
  const api = `${base}/api/v3/repos/${forge.login}/${repo.name}`;
  const out: Json = {
    id: issue.id,
    node_id: nodeId(issue.pull === null ? 'I' : 'PRI', issue.id),
    url: `${api}/issues/${issue.number}`,
    repository_url: api,
    labels_url: `${api}/issues/${issue.number}/labels{/name}`,
    comments_url: `${api}/issues/${issue.number}/comments`,
    events_url: `${api}/issues/${issue.number}/events`,
    html_url: `${base}/${forge.login}/${repo.name}/${issue.pull === null ? 'issues' : 'pull'}/${issue.number}`,
    number: issue.number,
    state: issue.state,
    state_reason: issue.stateReason,
    title: issue.title,
    body: issue.body,
    user: userJson(forge, base),
    labels: issue.labels.map((label) => labelJson(forge, repo, label, base)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    closed_at: issue.closedAt === null ? null : isoTime(issue.closedAt),
    created_at: isoTime(issue.createdAt),
    updated_at: isoTime(issue.updatedAt),
    closed_by: issue.closedAt === null ? null : userJson(forge, base),
    author_association: 'OWNER',
    reactions: { url: `${api}/issues/${issue.number}/reactions`, total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
  };
  if (issue.pull !== null) {
    out.pull_request = {
      url: `${api}/pulls/${issue.number}`,
      html_url: `${base}/${forge.login}/${repo.name}/pull/${issue.number}`,
      diff_url: `${base}/${forge.login}/${repo.name}/pull/${issue.number}.diff`,
      patch_url: `${base}/${forge.login}/${repo.name}/pull/${issue.number}.patch`,
      merged_at: issue.pull.mergedAt === null ? null : isoTime(issue.pull.mergedAt),
    };
  }
  return out;
}

export function commentJson(forge: Forge, repo: Repo, comment: Comment, base: string): Json {
  const api = `${base}/api/v3/repos/${forge.login}/${repo.name}`;
  return {
    id: comment.id,
    node_id: nodeId('IC', comment.id),
    url: `${api}/issues/comments/${comment.id}`,
    html_url: `${base}/${forge.login}/${repo.name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
    issue_url: `${api}/issues/${comment.issueNumber}`,
    body: comment.body,
    user: userJson(forge, base),
    created_at: isoTime(comment.createdAt),
    updated_at: isoTime(comment.updatedAt),
    author_association: 'OWNER',
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull, base: string, detailed = true): Json {
  const api = `${base}/api/v3/repos/${forge.login}/${repo.name}`;
  const issue = pull.issue;
  const headSha = forge.headSha(repo, pull);
  const baseSha = forge.baseSha(repo, pull);
  const repoBody = repoJson(forge, repo, base);
  const out: Json = {
    url: `${api}/pulls/${pull.number}`,
    id: pull.id,
    node_id: nodeId('PR', pull.id),
    html_url: `${base}/${forge.login}/${repo.name}/pull/${pull.number}`,
    diff_url: `${base}/${forge.login}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `${base}/${forge.login}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `${api}/issues/${pull.number}`,
    commits_url: `${api}/pulls/${pull.number}/commits`,
    comments_url: `${api}/issues/${pull.number}/comments`,
    number: pull.number,
    state: issue.state,
    locked: false,
    title: issue.title,
    user: userJson(forge, base),
    body: issue.body,
    labels: issue.labels.map((label) => labelJson(forge, repo, label, base)),
    milestone: null,
    created_at: isoTime(issue.createdAt),
    updated_at: isoTime(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : isoTime(issue.closedAt),
    merged_at: pull.mergedAt === null ? null : isoTime(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: { label: `${forge.login}:${pull.head}`, ref: pull.head, sha: headSha, user: userJson(forge, base), repo: repoBody },
    base: { label: `${forge.login}:${pull.base}`, ref: pull.base, sha: baseSha, user: userJson(forge, base), repo: repoBody },
    author_association: 'OWNER',
    draft: pull.draft,
    merged: pull.merged,
  };
  if (detailed) {
    const mergeable = pull.merged ? null : issue.state === 'open' ? forge.mergeable(repo, pull) : null;
    const commits = forge.pullCommits(repo, pull);
    const files = forge.pullFiles(repo, pull);
    out.mergeable = mergeable;
    out.mergeable_state = pull.merged ? 'unknown' : mergeable === true ? 'clean' : mergeable === false ? 'dirty' : 'unknown';
    out.merged_by = pull.merged ? userJson(forge, base) : null;
    out.comments = issue.comments.length;
    out.review_comments = 0;
    out.maintainer_can_modify = false;
    out.commits = commits.length;
    out.additions = files.reduce((sum, file) => sum + file.additions, 0);
    out.deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    out.changed_files = files.length;
  }
  return out;
}

export function fileJson(forge: Forge, repo: Repo, file: FileChange, base: string, ref: string): Json {
  const encoded = file.filename.split('/').map(encodeURIComponent).join('/');
  return {
    sha: file.sha,
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: `${base}/${forge.login}/${repo.name}/blob/${ref}/${encoded}`,
    raw_url: `${base}/${forge.login}/${repo.name}/raw/${ref}/${encoded}`,
    contents_url: `${base}/api/v3/repos/${forge.login}/${repo.name}/contents/${encoded}?ref=${ref}`,
    patch: file.patch,
  };
}

export function refJson(forge: Forge, repo: Repo, ref: string, sha: string, base: string): Json {
  const api = `${base}/api/v3/repos/${forge.login}/${repo.name}`;
  const type = forge.git.get(sha)?.type ?? 'commit';
  return {
    ref,
    node_id: nodeId('REF', `${repo.id}:${ref}`),
    url: `${api}/git/${ref}`,
    object: { sha, type, url: `${api}/git/${type}s/${sha}` },
  };
}

export function branchJson(forge: Forge, repo: Repo, name: string, sha: string, base: string): Json {
  return {
    name,
    commit: { sha, url: `${base}/api/v3/repos/${forge.login}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}
