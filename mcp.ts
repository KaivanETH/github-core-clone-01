// The Model Context Protocol endpoint, POST /mcp: JSON-RPC 2.0 over Streamable HTTP, answering
// application/json. It speaks revision 2026-07-28 (server/discover, a revision in every request's _meta,
// no session) and the handshake revisions through initialize + notifications/initialized. Tools act on
// the same Forge as REST and render with render.ts, so an object read over MCP is the REST object.

import { ApiError, type Forge, type Repo } from './forge.ts';
import { issueJson, pullJson, repoJson, commentJson } from './render.ts';

type Json = Record<string, unknown>;

export const MCP_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-mcp', title: 'Forge MCP server', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

interface Property {
  type: string;
  description: string;
  enum?: string[];
  items?: Json;
}

interface ToolSpec {
  name: string;
  title: string;
  description: string;
  properties: Record<string, Property>;
  required: string[];
  readOnly: boolean;
  run: (forge: Forge, args: Json, base: string) => unknown;
}

const OWNER: Property = { type: 'string', description: 'Repository owner (the login of the account that owns it)' };
const REPO: Property = { type: 'string', description: 'Repository name' };

function str(args: Json, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function num(args: Json, key: string): number {
  const value = args[key];
  const out = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(out) || out < 1) throw new ApiError(422, `${key} must be a positive integer`);
  return out;
}

/** The repository the owner/repo (or full_name) arguments name. */
function repoArg(forge: Forge, args: Json): Repo {
  let owner = str(args, 'owner');
  let name = str(args, 'repo');
  const full = str(args, 'full_name');
  if ((owner === '' || name === '') && full.includes('/')) [owner, name] = full.split('/', 2) as [string, string];
  return forge.repo(owner, name);
}

const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
      autoInit: { type: 'boolean', description: 'Initialize the repository with a README' },
    },
    required: ['name'],
    readOnly: false,
    run: (forge, args, base) =>
      repoJson(forge, forge.createRepo({ name: args.name, description: args.description, private: args.private, auto_init: args.autoInit }), base),
  },
  {
    name: 'get_repo',
    title: 'Get repository',
    description: 'Get a repository by owner and name.',
    properties: { owner: OWNER, repo: REPO },
    required: ['owner', 'repo'],
    readOnly: true,
    run: (forge, args, base) => repoJson(forge, repoArg(forge, args), base),
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Create a new issue in a repository.',
    properties: {
      owner: OWNER,
      repo: REPO,
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body (Markdown)' },
      labels: { type: 'array', description: 'Names of existing labels to apply', items: { type: 'string' } },
    },
    required: ['owner', 'repo', 'title'],
    readOnly: false,
    run: (forge, args, base) => {
      const repo = repoArg(forge, args);
      return issueJson(forge, repo, forge.createIssue(repo, { title: args.title, body: args.body, labels: args.labels }), base);
    },
  },
  {
    name: 'get_issue',
    title: 'Get issue',
    description: 'Get one issue of a repository by its number.',
    properties: { owner: OWNER, repo: REPO, issue_number: { type: 'number', description: 'Issue number' } },
    required: ['owner', 'repo', 'issue_number'],
    readOnly: true,
    run: (forge, args, base) => {
      const repo = repoArg(forge, args);
      return issueJson(forge, repo, forge.issue(repo, num(args, 'issue_number')), base);
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List the issues of a repository, newest first, filtered by state.',
    properties: {
      owner: OWNER,
      repo: REPO,
      state: { type: 'string', description: 'Issue state filter', enum: ['open', 'closed', 'all'] },
      perPage: { type: 'number', description: 'Results per page (1-100, default 30)' },
      page: { type: 'number', description: 'Page number (default 1)' },
    },
    required: ['owner', 'repo'],
    readOnly: true,
    run: (forge, args, base) => {
      const repo = repoArg(forge, args);
      const state = str(args, 'state').toLowerCase();
      const query = new URLSearchParams({ state: state === 'closed' || state === 'all' ? state : 'open' });
      const perPage = typeof args.perPage === 'number' && args.perPage > 0 ? Math.min(100, Math.floor(args.perPage)) : 30;
      const page = typeof args.page === 'number' && args.page > 0 ? Math.floor(args.page) : 1;
      return forge.listIssues(repo, query).slice((page - 1) * perPage, page * perPage).map((issue) => issueJson(forge, repo, issue, base));
    },
  },
  {
    name: 'update_issue',
    title: 'Update issue',
    description: 'Update the title, body or state of an issue.',
    properties: {
      owner: OWNER,
      repo: REPO,
      issue_number: { type: 'number', description: 'Issue number' },
      title: { type: 'string', description: 'New title' },
      body: { type: 'string', description: 'New body' },
      state: { type: 'string', description: 'New state', enum: ['open', 'closed'] },
    },
    required: ['owner', 'repo', 'issue_number'],
    readOnly: false,
    run: (forge, args, base) => {
      const repo = repoArg(forge, args);
      const issue = forge.issue(repo, num(args, 'issue_number'));
      return issueJson(forge, repo, forge.updateIssue(repo, issue, { title: args.title, body: args.body, state: args.state }), base);
    },
  },
  {
    name: 'add_issue_comment',
    title: 'Add issue comment',
    description: 'Add a comment to an issue or pull request.',
    properties: { owner: OWNER, repo: REPO, issue_number: { type: 'number', description: 'Issue or pull request number' }, body: { type: 'string', description: 'Comment text' } },
    required: ['owner', 'repo', 'issue_number', 'body'],
    readOnly: false,
    run: (forge, args, base) => {
      const repo = repoArg(forge, args);
      const issue = forge.issue(repo, num(args, 'issue_number'));
      return commentJson(forge, repo, forge.addComment(repo, issue, { body: args.body }), base);
    },
  },
  {
    name: 'create_pull_request',
    title: 'Create pull request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: OWNER,
      repo: REPO,
      title: { type: 'string', description: 'Pull request title' },
      head: { type: 'string', description: 'The branch holding the changes' },
      base: { type: 'string', description: 'The branch to merge into' },
      body: { type: 'string', description: 'Pull request description' },
      draft: { type: 'boolean', description: 'Open as a draft' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    readOnly: false,
    run: (forge, args, base) => {
      const repo = repoArg(forge, args);
      return pullJson(forge, repo, forge.createPull(repo, { title: args.title, head: args.head, base: args.base, body: args.body, draft: args.draft }), base);
    },
  },
  {
    name: 'get_pull_request',
    title: 'Get pull request',
    description: 'Get one pull request of a repository by its number.',
    properties: { owner: OWNER, repo: REPO, pull_number: { type: 'number', description: 'Pull request number' } },
    required: ['owner', 'repo', 'pull_number'],
    readOnly: true,
    run: (forge, args, base) => {
      const repo = repoArg(forge, args);
      return pullJson(forge, repo, forge.pull(repo, num(args, 'pull_number')), base);
    },
  },
  {
    name: 'list_pull_requests',
    title: 'List pull requests',
    description: 'List the pull requests of a repository, newest first, filtered by state.',
    properties: { owner: OWNER, repo: REPO, state: { type: 'string', description: 'Pull request state filter', enum: ['open', 'closed', 'all'] } },
    required: ['owner', 'repo'],
    readOnly: true,
    run: (forge, args, base) => {
      const repo = repoArg(forge, args);
      const state = str(args, 'state').toLowerCase() || 'open';
      const pulls = [...repo.pulls.values()].filter((pull) => state === 'all' || pull.issue.state === state).reverse();
      return pulls.map((pull) => pullJson(forge, repo, pull, base, false));
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge a pull request into its base branch (squash by default).',
    properties: {
      owner: OWNER,
      repo: REPO,
      pull_number: { type: 'number', description: 'Pull request number' },
      merge_method: { type: 'string', description: 'Merge method', enum: ['merge', 'squash', 'rebase'] },
      commit_title: { type: 'string', description: 'Title of the merge commit' },
      commit_message: { type: 'string', description: 'Extra detail for the merge commit' },
    },
    required: ['owner', 'repo', 'pull_number'],
    readOnly: false,
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      const pull = forge.pull(repo, num(args, 'pull_number'));
      const result = forge.merge(repo, pull, {
        merge_method: typeof args.merge_method === 'string' ? args.merge_method : 'squash',
        commit_title: args.commit_title,
        commit_message: args.commit_message,
      });
      return { sha: result.sha, merged: true, message: result.message };
    },
  },
];

/** tools/list's array, built once: the same bytes on every call. */
const TOOL_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  annotations: { title: tool.title, readOnlyHint: tool.readOnly },
}));
const TOOL_LIST_TEXT = JSON.stringify(TOOL_LIST);

/** Resolve a listed name, allowing a server prefix (github__create_issue) and any case. */
function findTool(name: string): ToolSpec | undefined {
  const wanted = name.toLowerCase();
  return TOOLS.find((tool) => tool.name === wanted) ?? TOOLS.find((tool) => wanted.endsWith(`__${tool.name}`) || wanted.endsWith(`.${tool.name}`) || wanted.endsWith(`/${tool.name}`));
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Json {
  const error: Json = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id, result };
}

function toolResult(value: unknown, isError = false): Json {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const out: Json = { content: [{ type: 'text', text }], isError };
  if (!isError && typeof value === 'object' && value !== null && !Array.isArray(value)) out.structuredContent = value;
  return out;
}

function callTool(forge: Forge, base: string, id: unknown, params: Json): Json {
  const name = params.name;
  if (typeof name !== 'string' || name === '') return rpcError(id, INVALID_PARAMS, 'Invalid params: tools/call needs a tool name');
  const tool = findTool(name);
  if (tool === undefined) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
  const rawArgs = params.arguments;
  if (rawArgs !== undefined && rawArgs !== null && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) return rpcError(id, INVALID_PARAMS, 'Invalid params: arguments must be an object');
  const args = (rawArgs ?? {}) as Json;
  const missing = tool.required.filter((key) => {
    if (key === 'owner' || key === 'repo') {
      if (typeof args.full_name === 'string' && args.full_name.includes('/')) return false;
    }
    const value = args[key];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) return rpcResult(id, toolResult(`missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`, true));
  try {
    return rpcResult(id, toolResult(tool.run(forge, args, base)));
  } catch (err) {
    if (err instanceof ApiError) {
      const details = Array.isArray(err.body.errors) ? ` ${JSON.stringify(err.body.errors)}` : '';
      return rpcResult(id, toolResult(`${err.status} ${err.message}${details}`, true));
    }
    throw err;
  }
}

let sessionCounter = 0;

export interface McpReply {
  status: number;
  /** undefined: no body (a notification's 202). */
  body?: unknown;
  headers?: Record<string, string>;
}

/** One JSON-RPC message to its response (null for a notification). */
function handleMessage(forge: Forge, base: string, message: unknown, headers: Record<string, string>): Json | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return rpcError(null, INVALID_REQUEST, 'Invalid Request');
  const request = message as Json;
  const id = request.id;
  const method = request.method;
  if (typeof method !== 'string') {
    if ('result' in request || 'error' in request) return null;
    return rpcError(id, INVALID_REQUEST, 'Invalid Request: no method');
  }
  const isNotification = id === undefined;
  if (isNotification) return null;
  const params = typeof request.params === 'object' && request.params !== null && !Array.isArray(request.params) ? (request.params as Json) : {};
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const legacy = SUPPORTED_VERSIONS.slice(1);
      const chosen = legacy.includes(asked) ? asked : (legacy[0] as string);
      sessionCounter += 1;
      headers['mcp-session-id'] = `forge-session-${sessionCounter}`;
      return rpcResult(id, { protocolVersion: chosen, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.' });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: JSON.parse(TOOL_LIST_TEXT) });
    case 'tools/call':
      return callTool(forge, base, id, params);
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    case 'logging/setLevel':
      return rpcResult(id, {});
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** The body of POST /mcp (raw text) to the HTTP reply. */
export function handleMcp(forge: Forge, base: string, text: string): McpReply {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return { status: 400, body: rpcError(null, PARSE_ERROR, 'Parse error') };
  }
  const headers: Record<string, string> = {};
  if (Array.isArray(message)) {
    if (message.length === 0) return { status: 400, body: rpcError(null, INVALID_REQUEST, 'Invalid Request: empty batch') };
    const answers = message.map((entry) => handleMessage(forge, base, entry, headers)).filter((entry): entry is Json => entry !== null);
    return answers.length === 0 ? { status: 202, headers } : { status: 200, body: answers, headers };
  }
  const answer = handleMessage(forge, base, message, headers);
  if (answer === null) return { status: 202, headers };
  return { status: 200, body: answer, headers };
}
