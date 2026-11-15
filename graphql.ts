// GraphQL v4 at POST /api/graphql: a small spec-shaped executor (parser, static validation, execution,
// introspection) over the same Forge the REST and git surfaces use. Global ids are render.ts's node_id
// values, so an object reads with the same id over REST and GraphQL.

import { ApiError, isoTime, type Comment, type Forge, type Issue, type Pull, type Repo } from './forge.ts';
import { nodeId } from './render.ts';

type Json = Record<string, unknown>;

// =========================================================================== parser

type Value =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int' | 'Float'; value: number }
  | { kind: 'String' | 'Enum'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'List'; values: Value[] }
  | { kind: 'Object'; fields: { name: string; value: Value }[] };

interface Field {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: { name: string; value: Value }[];
  directives: Directive[];
  selections: Selection[] | null;
  line: number;
  column: number;
}
interface Directive {
  name: string;
  args: { name: string; value: Value }[];
}
type Selection = Field | { kind: 'Spread'; name: string; directives: Directive[] } | { kind: 'Inline'; on: string | null; directives: Directive[]; selections: Selection[] };
interface Operation {
  kind: 'Operation';
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: { name: string; type: string; defaultValue: Value | null }[];
  selections: Selection[];
}
interface Fragment {
  kind: 'Fragment';
  name: string;
  on: string;
  selections: Selection[];
}

export class GraphQLError extends Error {
  readonly extra: Json;
  constructor(message: string, extra: Json = {}) {
    super(message);
    this.extra = extra;
  }
}

interface Token {
  kind: 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';
  value: string;
  line: number;
  column: number;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const push = (kind: Token['kind'], value: string, start: number): void => {
    tokens.push({ kind, value, line, column: start - lineStart + 1 });
  };
  while (i < source.length) {
    const c = source[i] as string;
    if (c === '\n') {
      i += 1;
      line += 1;
      lineStart = i;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      push('punct', '...', i);
      i += 3;
      continue;
    }
    if ('!$&()=:@[]{}|'.includes(c)) {
      push('punct', c, i);
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i] as string)) i += 1;
      push('name', source.slice(start, i), start);
      continue;
    }
    if (/[-0-9]/.test(c)) {
      const start = i;
      const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (match === null) throw new GraphQLError(`Syntax Error: Invalid number at ${line}:${i - lineStart + 1}`);
      i += match[0].length;
      push(match[2] !== undefined || match[3] !== undefined ? 'float' : 'int', match[0], start);
      continue;
    }
    if (source.startsWith('"""', i)) {
      const start = i;
      const end = source.indexOf('"""', i + 3);
      if (end < 0) throw new GraphQLError('Syntax Error: Unterminated string');
      const raw = source.slice(i + 3, end).replace(/\\"""/g, '"""');
      for (const ch of raw) if (ch === '\n') line += 1;
      i = end + 3;
      push('string', blockString(raw), start);
      continue;
    }
    if (c === '"') {
      const start = i;
      i += 1;
      let out = '';
      while (i < source.length && source[i] !== '"') {
        const ch = source[i] as string;
        if (ch === '\n') throw new GraphQLError('Syntax Error: Unterminated string');
        if (ch === '\\') {
          const next = source[i + 1] as string;
          if (next === 'u') {
            out += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
            continue;
          }
          out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' } as Record<string, string>)[next] ?? next;
          i += 2;
          continue;
        }
        out += ch;
        i += 1;
      }
      if (i >= source.length) throw new GraphQLError('Syntax Error: Unterminated string');
      i += 1;
      push('string', out, start);
      continue;
    }
    throw new GraphQLError(`Syntax Error: Unexpected character "${c}" at ${line}:${i - lineStart + 1}`);
  }
  tokens.push({ kind: 'eof', value: '', line, column: i - lineStart + 1 });
  return tokens;
}

function blockString(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let indent = Infinity;
  for (const text of lines.slice(1)) {
    const lead = /^[ \t]*/.exec(text)?.[0].length ?? 0;
    if (lead < text.length) indent = Math.min(indent, lead);
  }
  const out = lines.map((text, index) => (index === 0 || indent === Infinity ? text : text.slice(indent)));
  while (out.length > 0 && /^[ \t]*$/.test(out[0] as string)) out.shift();
  while (out.length > 0 && /^[ \t]*$/.test(out[out.length - 1] as string)) out.pop();
  return out.join('\n');
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    return this.tokens[this.pos++] as Token;
  }
  private is(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }
  private expect(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new GraphQLError(`Syntax Error: Expected "${value}", found ${token.kind === 'eof' ? '<EOF>' : `"${token.value}"`} at ${token.line}:${token.column}`);
  }
  private name(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLError(`Syntax Error: Expected Name, found ${token.kind === 'eof' ? '<EOF>' : `"${token.value}"`} at ${token.line}:${token.column}`);
    return token.value;
  }

  document(): (Operation | Fragment)[] {
    const definitions: (Operation | Fragment)[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.definition());
    if (definitions.length === 0) throw new GraphQLError('Syntax Error: Unexpected <EOF>');
    return definitions;
  }

  private definition(): Operation | Fragment {
    if (this.is('{')) return { kind: 'Operation', type: 'query', name: null, variables: [], selections: this.selectionSet() };
    const word = this.name();
    if (word === 'fragment') {
      const name = this.name();
      if (this.name() !== 'on') throw new GraphQLError('Syntax Error: Expected "on"');
      const on = this.name();
      this.directives();
      return { kind: 'Fragment', name, on, selections: this.selectionSet() };
    }
    if (word !== 'query' && word !== 'mutation' && word !== 'subscription') throw new GraphQLError(`Syntax Error: Unexpected Name "${word}"`);
    const name = this.peek().kind === 'name' ? this.name() : null;
    const variables: Operation['variables'] = [];
    if (this.is('(')) {
      this.next();
      while (!this.is(')')) {
        this.expect('$');
        const variable = this.name();
        this.expect(':');
        const type = this.typeRef();
        let defaultValue: Value | null = null;
        if (this.is('=')) {
          this.next();
          defaultValue = this.value(true);
        }
        this.directives();
        variables.push({ name: variable, type, defaultValue });
      }
      this.next();
    }
    this.directives();
    return { kind: 'Operation', type: word, name, variables, selections: this.selectionSet() };
  }

  private typeRef(): string {
    let out: string;
    if (this.is('[')) {
      this.next();
      out = `[${this.typeRef()}]`;
      this.expect(']');
    } else out = this.name();
    if (this.is('!')) {
      this.next();
      out += '!';
    }
    return out;
  }

  private directives(): Directive[] {
    const out: Directive[] = [];
    while (this.is('@')) {
      this.next();
      out.push({ name: this.name(), args: this.arguments() });
    }
    return out;
  }

  private arguments(): { name: string; value: Value }[] {
    const out: { name: string; value: Value }[] = [];
    if (!this.is('(')) return out;
    this.next();
    while (!this.is(')')) {
      const name = this.name();
      this.expect(':');
      out.push({ name, value: this.value(false) });
    }
    this.next();
    return out;
  }

  private selectionSet(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    while (!this.is('}')) {
      if (this.peek().kind === 'eof') throw new GraphQLError('Syntax Error: Expected Name, found <EOF>');
      out.push(this.selection());
    }
    this.next();
    if (out.length === 0) throw new GraphQLError('Syntax Error: Expected Name, found "}"');
    return out;
  }

  private selection(): Selection {
    if (this.is('...')) {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value !== 'on') {
        const name = this.name();
        return { kind: 'Spread', name, directives: this.directives() };
      }
      let on: string | null = null;
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        on = this.name();
      }
      const directives = this.directives();
      return { kind: 'Inline', on, directives, selections: this.selectionSet() };
    }
    const start = this.peek();
    let name = this.name();
    let alias: string | null = null;
    if (this.is(':')) {
      this.next();
      alias = name;
      name = this.name();
    }
    const args = this.arguments();
    const directives = this.directives();
    const selections = this.is('{') ? this.selectionSet() : null;
    return { kind: 'Field', alias, name, args, directives, selections, line: start.line, column: start.column };
  }

  private value(constant: boolean): Value {
    const token = this.next();
    if (token.kind === 'punct') {
      if (token.value === '$' && !constant) return { kind: 'Variable', name: this.name() };
      if (token.value === '[') {
        const values: Value[] = [];
        while (!this.is(']')) values.push(this.value(constant));
        this.next();
        return { kind: 'List', values };
      }
      if (token.value === '{') {
        const fields: { name: string; value: Value }[] = [];
        while (!this.is('}')) {
          const name = this.name();
          this.expect(':');
          fields.push({ name, value: this.value(constant) });
        }
        this.next();
        return { kind: 'Object', fields };
      }
    }
    if (token.kind === 'int') return { kind: 'Int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'Float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'String', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true' || token.value === 'false') return { kind: 'Boolean', value: token.value === 'true' };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    throw new GraphQLError(`Syntax Error: Unexpected ${token.kind === 'eof' ? '<EOF>' : `"${token.value}"`} at ${token.line}:${token.column}`);
  }
}

// =========================================================================== schema

interface Ctx {
  forge: Forge;
  base: string;
  variables: Json;
  fragments: Map<string, Fragment>;
  errors: Json[];
}

type Resolver = (parent: any, args: Json, ctx: Ctx) => unknown;
interface FieldDef {
  type: string;
  args?: Record<string, string>;
  description?: string;
  resolve?: Resolver;
}
type TypeDef =
  | { kind: 'SCALAR'; description?: string }
  | { kind: 'ENUM'; values: string[]; description?: string }
  | { kind: 'OBJECT'; fields: Record<string, FieldDef>; interfaces?: string[]; description?: string }
  | { kind: 'INTERFACE' | 'UNION'; fields: Record<string, FieldDef>; possibleTypes: string[]; description?: string }
  | { kind: 'INPUT_OBJECT'; inputFields: Record<string, string>; description?: string };

const enumOf = (...values: string[]): TypeDef => ({ kind: 'ENUM', values });
const CONNECTION_ARGS = { first: 'Int', after: 'String', last: 'Int', before: 'String' };

function repoOf(value: { repo: Repo }): Repo {
  return value.repo;
}

const wrapRepo = (repo: Repo): Json => ({ __typename: 'Repository', repo });
const wrapIssue = (repo: Repo, issue: Issue): Json => (issue.pull !== null ? wrapPull(repo, issue.pull) : { __typename: 'Issue', repo, issue });
const wrapPull = (repo: Repo, pull: Pull): Json => ({ __typename: 'PullRequest', repo, pull });
const wrapComment = (repo: Repo, comment: Comment): Json => ({ __typename: 'IssueComment', repo, comment });
const viewerOf = (forge: Forge): Json => ({ __typename: 'User', login: forge.login, id: nodeId('U', forge.viewerId), databaseId: forge.viewerId, name: forge.login, url: '', avatarUrl: '' });

function cursorOf(position: number): string {
  return Buffer.from(`cursor:v2:${position}`, 'utf8').toString('base64');
}

function positionOf(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const match = /^cursor:v2:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
  if (match === null) throw new GraphQLError(`\`${cursor}\` does not appear to be a valid cursor.`);
  return Number(match[1]);
}

/** A Relay connection over `items`, honouring first/after/last/before. */
function connection(typename: string, items: unknown[], args: Json): Json {
  let start = 0;
  let end = items.length;
  const after = positionOf(args.after);
  const before = positionOf(args.before);
  if (after !== null) start = Math.min(items.length, after);
  if (before !== null) end = Math.max(start, Math.min(end, before - 1));
  if (typeof args.first === 'number') {
    if (args.first < 0) throw new GraphQLError('`first` must be a non-negative integer');
    end = Math.min(end, start + Math.min(args.first, 100));
  }
  if (typeof args.last === 'number') start = Math.max(start, end - Math.min(args.last, 100));
  const slice = items.slice(start, end);
  return {
    __typename: typename,
    nodes: slice,
    edges: slice.map((node, index) => ({ __typename: `${typename.replace(/Connection$/, '')}Edge`, node, cursor: cursorOf(start + index + 1) })),
    totalCount: items.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorOf(start + 1) : null,
      endCursor: slice.length > 0 ? cursorOf(end) : null,
    },
  };
}

function enumArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  return (Array.isArray(value) ? value : [value]).map(String);
}

function issueList(repo: Repo, args: Json): Json[] {
  const states = enumArray(args.states);
  let issues = [...repo.issues.values()].filter((issue) => issue.pull === null);
  if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
  const labels = enumArray(args.labels);
  if (labels !== null) issues = issues.filter((issue) => labels.every((name) => issue.labels.some((label) => label.name === name)));
  const order = (args.orderBy ?? null) as Json | null;
  const field = typeof order?.field === 'string' ? order.field : 'CREATED_AT';
  const direction = typeof order?.direction === 'string' ? order.direction : 'ASC';
  const key = (issue: Issue): number => (field === 'UPDATED_AT' ? issue.updatedAt : field === 'COMMENTS' ? issue.comments.length : issue.createdAt);
  issues.sort((a, b) => key(a) - key(b) || a.number - b.number);
  if (direction === 'DESC') issues.reverse();
  return issues.map((issue) => wrapIssue(repo, issue));
}

function pullState(pull: Pull): string {
  return pull.merged ? 'MERGED' : pull.issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullList(repo: Repo, args: Json): Json[] {
  const states = enumArray(args.states);
  let pulls = [...repo.pulls.values()];
  if (states !== null) pulls = pulls.filter((pull) => states.includes(pullState(pull)));
  if (typeof args.headRefName === 'string') pulls = pulls.filter((pull) => pull.head === args.headRefName);
  if (typeof args.baseRefName === 'string') pulls = pulls.filter((pull) => pull.base === args.baseRefName);
  const order = (args.orderBy ?? null) as Json | null;
  const key = (pull: Pull): number => (order?.field === 'UPDATED_AT' ? pull.issue.updatedAt : pull.issue.createdAt);
  pulls.sort((a, b) => key(a) - key(b) || a.number - b.number);
  if (order?.direction === 'DESC') pulls.reverse();
  return pulls.map((pull) => wrapPull(repo, pull));
}

/** The object a global id names, or null. */
function lookupNode(forge: Forge, id: unknown): Json | null {
  if (typeof id !== 'string') return null;
  const underscore = id.indexOf('_');
  if (underscore <= 0) return null;
  const kind = id.slice(0, underscore);
  const decoded = Buffer.from(id.slice(underscore + 1), 'base64url').toString('utf8');
  if (!decoded.startsWith(`${kind}:`)) return null;
  const key = decoded.slice(kind.length + 1);
  const number = Number(key);
  if (kind === 'U') return number === forge.viewerId ? viewerOf(forge) : null;
  for (const repo of forge.repos.values()) {
    if (kind === 'R' && repo.id === number) return wrapRepo(repo);
    if (kind === 'I' || kind === 'PRI') for (const issue of repo.issues.values()) if (issue.id === number) return wrapIssue(repo, issue);
    if (kind === 'PR') for (const pull of repo.pulls.values()) if (pull.id === number) return wrapPull(repo, pull);
    if (kind === 'IC') for (const issue of repo.issues.values()) for (const comment of issue.comments) if (comment.id === number) return wrapComment(repo, comment);
  }
  return null;
}

function requireNode(forge: Forge, id: unknown, typename: string, argument: string): Json {
  const node = lookupNode(forge, id);
  if (node === null || (typename !== '*' && node.__typename !== typename)) {
    throw new GraphQLError(`Could not resolve to a node with the global id of '${String(id)}'.`, { type: 'NOT_FOUND', argument });
  }
  return node;
}

function input(args: Json): Json {
  const value = args.input;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new GraphQLError("Argument 'input' on Field is required");
  return value as Json;
}

function apiCall<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof ApiError) {
      const errors = Array.isArray(err.body.errors) ? (err.body.errors as Json[]).map((entry) => entry.message ?? entry.code).filter(Boolean) : [];
      throw new GraphQLError(errors.length > 0 ? `${err.message}: ${errors.join(', ')}` : err.message, { type: err.status === 404 ? 'NOT_FOUND' : 'UNPROCESSABLE' });
    }
    throw err;
  }
}

const NODE_FIELDS = { id: { type: 'ID!' } };

const TYPES: Record<string, TypeDef> = {
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  GitObjectID: { kind: 'SCALAR' },
  HTML: { kind: 'SCALAR' },

  IssueState: enumOf('OPEN', 'CLOSED'),
  IssueClosedStateReason: enumOf('COMPLETED', 'NOT_PLANNED', 'DUPLICATE'),
  PullRequestState: enumOf('OPEN', 'CLOSED', 'MERGED'),
  MergeableState: enumOf('MERGEABLE', 'CONFLICTING', 'UNKNOWN'),
  PullRequestMergeMethod: enumOf('MERGE', 'SQUASH', 'REBASE'),
  RepositoryPermission: enumOf('ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'),
  RepositoryVisibility: enumOf('PRIVATE', 'PUBLIC', 'INTERNAL'),
  SearchType: enumOf('ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'),
  IssueOrderField: enumOf('CREATED_AT', 'UPDATED_AT', 'COMMENTS'),
  PullRequestOrderField: enumOf('CREATED_AT', 'UPDATED_AT'),
  OrderDirection: enumOf('ASC', 'DESC'),
  PatchStatus: enumOf('ADDED', 'DELETED', 'RENAMED', 'COPIED', 'MODIFIED', 'CHANGED'),

  Node: { kind: 'INTERFACE', fields: NODE_FIELDS, possibleTypes: ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment', 'Label'] },
  RepositoryOwner: { kind: 'INTERFACE', fields: { ...NODE_FIELDS, login: { type: 'String!' } }, possibleTypes: ['User'] },
  Actor: { kind: 'INTERFACE', fields: { login: { type: 'String!' } }, possibleTypes: ['User'] },
  IssueOrPullRequest: { kind: 'UNION', fields: {}, possibleTypes: ['Issue', 'PullRequest'] },

  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User!', resolve: (_p, _a, ctx) => viewerOf(ctx.forge) },
      repository: {
        type: 'Repository',
        args: { owner: 'String!', name: 'String!', followRenames: 'Boolean' },
        resolve: (_p, args, ctx) => {
          if (typeof args.owner !== 'string' || typeof args.name !== 'string') return null;
          const repo = ctx.forge.findRepo(args.owner, args.name);
          return repo === null ? null : wrapRepo(repo);
        },
      },
      user: { type: 'User', args: { login: 'String!' }, resolve: (_p, args, ctx) => (String(args.login).toLowerCase() === ctx.forge.login.toLowerCase() ? viewerOf(ctx.forge) : null) },
      repositoryOwner: { type: 'RepositoryOwner', args: { login: 'String!' }, resolve: (_p, args, ctx) => (String(args.login).toLowerCase() === ctx.forge.login.toLowerCase() ? viewerOf(ctx.forge) : null) },
      node: { type: 'Node', args: { id: 'ID!' }, resolve: (_p, args, ctx) => lookupNode(ctx.forge, args.id) },
      nodes: { type: '[Node]!', args: { ids: '[ID!]!' }, resolve: (_p, args, ctx) => (Array.isArray(args.ids) ? args.ids.map((id) => lookupNode(ctx.forge, id)) : []) },
      __type: { type: '__Type', args: { name: 'String!' }, resolve: (_p, args) => (typeof args.name === 'string' && TYPES[args.name] !== undefined ? typeRef(args.name) : null) },
      __schema: { type: '__Schema!', resolve: () => ({ __typename: '__Schema' }) },
    },
  },

  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: {
        type: 'CreateIssuePayload',
        args: { input: 'CreateIssueInput!' },
        resolve: (_p, args, ctx) => {
          const data = input(args);
          const { repo } = requireNode(ctx.forge, data.repositoryId, 'Repository', 'repositoryId') as { repo: Repo };
          const labels: string[] = [];
          if (Array.isArray(data.labelIds)) {
            for (const id of data.labelIds) {
              const label = [...repo.labels.values()].find((entry) => nodeId('LA', entry.id) === id);
              if (label === undefined) throw new GraphQLError(`Could not resolve to a node with the global id of '${String(id)}'.`, { type: 'NOT_FOUND' });
              labels.push(label.name);
            }
          }
          const issue = apiCall(() => ctx.forge.createIssue(repo, { title: data.title, body: data.body, labels }));
          return { __typename: 'CreateIssuePayload', clientMutationId: data.clientMutationId ?? null, issue: wrapIssue(repo, issue) };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        args: { input: 'CloseIssueInput!' },
        resolve: (_p, args, ctx) => {
          const data = input(args);
          const node = requireNode(ctx.forge, data.issueId, 'Issue', 'issueId') as { repo: Repo; issue: Issue };
          const reason = typeof data.stateReason === 'string' ? data.stateReason.toLowerCase() : undefined;
          apiCall(() => ctx.forge.updateIssue(node.repo, node.issue, { state: 'closed', state_reason: reason }));
          return { __typename: 'CloseIssuePayload', clientMutationId: data.clientMutationId ?? null, issue: wrapIssue(node.repo, node.issue) };
        },
      },
      reopenIssue: {
        type: 'ReopenIssuePayload',
        args: { input: 'ReopenIssueInput!' },
        resolve: (_p, args, ctx) => {
          const data = input(args);
          const node = requireNode(ctx.forge, data.issueId, 'Issue', 'issueId') as { repo: Repo; issue: Issue };
          apiCall(() => ctx.forge.updateIssue(node.repo, node.issue, { state: 'open' }));
          return { __typename: 'ReopenIssuePayload', clientMutationId: data.clientMutationId ?? null, issue: wrapIssue(node.repo, node.issue) };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        args: { input: 'CreatePullRequestInput!' },
        resolve: (_p, args, ctx) => {
          const data = input(args);
          const { repo } = requireNode(ctx.forge, data.repositoryId, 'Repository', 'repositoryId') as { repo: Repo };
          const pull = apiCall(() => ctx.forge.createPull(repo, { title: data.title, body: data.body, head: data.headRefName, base: data.baseRefName, draft: data.draft }));
          return { __typename: 'CreatePullRequestPayload', clientMutationId: data.clientMutationId ?? null, pullRequest: wrapPull(repo, pull) };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        args: { input: 'MergePullRequestInput!' },
        resolve: (_p, args, ctx) => {
          const data = input(args);
          const node = requireNode(ctx.forge, data.pullRequestId, 'PullRequest', 'pullRequestId') as { repo: Repo; pull: Pull };
          const method = typeof data.mergeMethod === 'string' ? data.mergeMethod.toLowerCase() : 'merge';
          apiCall(() =>
            ctx.forge.merge(node.repo, node.pull, { merge_method: method, commit_title: data.commitHeadline, commit_message: data.commitBody, sha: data.expectedHeadOid }),
          );
          return { __typename: 'MergePullRequestPayload', clientMutationId: data.clientMutationId ?? null, pullRequest: wrapPull(node.repo, node.pull) };
        },
      },
      closePullRequest: {
        type: 'ClosePullRequestPayload',
        args: { input: 'ClosePullRequestInput!' },
        resolve: (_p, args, ctx) => {
          const data = input(args);
          const node = requireNode(ctx.forge, data.pullRequestId, 'PullRequest', 'pullRequestId') as { repo: Repo; pull: Pull };
          apiCall(() => ctx.forge.updateIssue(node.repo, node.pull.issue, { state: 'closed' }));
          return { __typename: 'ClosePullRequestPayload', clientMutationId: data.clientMutationId ?? null, pullRequest: wrapPull(node.repo, node.pull) };
        },
      },
      addComment: {
        type: 'AddCommentPayload',
        args: { input: 'AddCommentInput!' },
        resolve: (_p, args, ctx) => {
          const data = input(args);
          const node = requireNode(ctx.forge, data.subjectId, '*', 'subjectId') as { __typename: string; repo: Repo; issue?: Issue; pull?: Pull };
          const issue = node.issue ?? node.pull?.issue;
          if (issue === undefined) throw new GraphQLError(`Could not resolve to a node with the global id of '${String(data.subjectId)}'.`, { type: 'NOT_FOUND' });
          const comment = apiCall(() => ctx.forge.addComment(node.repo, issue, { body: data.body }));
          const wrapped = wrapComment(node.repo, comment);
          return {
            __typename: 'AddCommentPayload',
            clientMutationId: data.clientMutationId ?? null,
            commentEdge: { __typename: 'IssueCommentEdge', node: wrapped, cursor: cursorOf(issue.comments.length) },
            subject: node,
            timelineEdge: { __typename: 'IssueTimelineItemEdge', node: wrapped, cursor: cursorOf(issue.comments.length) },
          };
        },
      },
    },
  },

  User: {
    kind: 'OBJECT',
    interfaces: ['Node', 'Actor', 'RepositoryOwner'],
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int' },
      login: { type: 'String!' },
      name: { type: 'String' },
      url: { type: 'URI!' },
      avatarUrl: { type: 'URI!', args: { size: 'Int' } },
    },
  },

  Repository: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (p) => nodeId('R', repoOf(p).id) },
      databaseId: { type: 'Int', resolve: (p) => repoOf(p).id },
      name: { type: 'String!', resolve: (p) => repoOf(p).name },
      nameWithOwner: { type: 'String!', resolve: (p, _a, ctx) => `${ctx.forge.login}/${repoOf(p).name}` },
      owner: { type: 'RepositoryOwner!', resolve: (_p, _a, ctx) => viewerOf(ctx.forge) },
      description: { type: 'String', resolve: (p) => repoOf(p).description },
      homepageUrl: { type: 'URI', resolve: (p) => repoOf(p).homepage },
      url: { type: 'URI!', resolve: (p, _a, ctx) => `${ctx.base}/${ctx.forge.login}/${repoOf(p).name}` },
      sshUrl: { type: 'String!', resolve: (p, _a, ctx) => `git@localhost:${ctx.forge.login}/${repoOf(p).name}.git` },
      isPrivate: { type: 'Boolean!', resolve: (p) => repoOf(p).private },
      isFork: { type: 'Boolean!', resolve: () => false },
      isArchived: { type: 'Boolean!', resolve: () => false },
      isEmpty: { type: 'Boolean!', resolve: (p) => repoOf(p).refs.size === 0 },
      visibility: { type: 'RepositoryVisibility!', resolve: (p) => (repoOf(p).private ? 'PRIVATE' : 'PUBLIC') },
      createdAt: { type: 'DateTime!', resolve: (p) => isoTime(repoOf(p).createdAt) },
      updatedAt: { type: 'DateTime!', resolve: (p) => isoTime(repoOf(p).updatedAt) },
      pushedAt: { type: 'DateTime', resolve: (p) => isoTime(repoOf(p).pushedAt) },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (p, _a, ctx) => {
          const repo = repoOf(p);
          const sha = ctx.forge.branchTip(repo, repo.defaultBranch);
          return sha === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', sha, repo };
        },
      },
      viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
      viewerCanAdminister: { type: 'Boolean!', resolve: () => true },
      hasIssuesEnabled: { type: 'Boolean!', resolve: (p) => repoOf(p).hasIssues },
      hasWikiEnabled: { type: 'Boolean!', resolve: () => false },
      mergeCommitAllowed: { type: 'Boolean!', resolve: () => true },
      squashMergeAllowed: { type: 'Boolean!', resolve: () => true },
      rebaseMergeAllowed: { type: 'Boolean!', resolve: () => true },
      issue: {
        type: 'Issue',
        args: { number: 'Int!' },
        resolve: (p, args) => {
          const issue = repoOf(p).issues.get(Number(args.number));
          return issue === undefined || issue.pull !== null ? null : wrapIssue(repoOf(p), issue);
        },
      },
      issueOrPullRequest: {
        type: 'IssueOrPullRequest',
        args: { number: 'Int!' },
        resolve: (p, args) => {
          const issue = repoOf(p).issues.get(Number(args.number));
          return issue === undefined ? null : wrapIssue(repoOf(p), issue);
        },
      },
      issues: {
        type: 'IssueConnection!',
        args: { ...CONNECTION_ARGS, states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]', filterBy: 'IssueFilters' },
        resolve: (p, args) => connection('IssueConnection', issueList(repoOf(p), args), args),
      },
      pullRequest: {
        type: 'PullRequest',
        args: { number: 'Int!' },
        resolve: (p, args) => {
          const pull = repoOf(p).pulls.get(Number(args.number));
          return pull === undefined ? null : wrapPull(repoOf(p), pull);
        },
      },
      pullRequests: {
        type: 'PullRequestConnection!',
        args: { ...CONNECTION_ARGS, states: '[PullRequestState!]', orderBy: 'IssueOrder', headRefName: 'String', baseRefName: 'String', labels: '[String!]' },
        resolve: (p, args) => connection('PullRequestConnection', pullList(repoOf(p), args), args),
      },
      labels: {
        type: 'LabelConnection',
        args: { ...CONNECTION_ARGS, query: 'String' },
        resolve: (p, args) => connection('LabelConnection', [...repoOf(p).labels.values()].map((label) => ({ __typename: 'Label', repo: repoOf(p), label })), args),
      },
    },
  },

  Ref: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (p) => nodeId('REF', `${p.repo.id}:${p.prefix}${p.name}`) },
      name: { type: 'String!' },
      prefix: { type: 'String!' },
      target: { type: 'Commit', resolve: (p) => ({ __typename: 'Commit', sha: p.sha }) },
    },
  },

  Commit: {
    kind: 'OBJECT',
    fields: {
      oid: { type: 'GitObjectID!', resolve: (p) => p.sha },
      abbreviatedOid: { type: 'String!', resolve: (p) => String(p.sha).slice(0, 7) },
      message: { type: 'String!', resolve: (p, _a, ctx) => ctx.forge.git.commit(p.sha)?.message ?? '' },
      messageHeadline: { type: 'String!', resolve: (p, _a, ctx) => (ctx.forge.git.commit(p.sha)?.message ?? '').split('\n')[0] },
      committedDate: { type: 'DateTime!', resolve: (p, _a, ctx) => isoTime(ctx.forge.git.commit(p.sha)?.committer.time ?? 0) },
    },
  },

  Issue: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (p) => nodeId('I', p.issue.id) },
      databaseId: { type: 'Int', resolve: (p) => p.issue.id },
      number: { type: 'Int!', resolve: (p) => p.issue.number },
      title: { type: 'String!', resolve: (p) => p.issue.title },
      body: { type: 'String!', resolve: (p) => p.issue.body },
      bodyText: { type: 'String!', resolve: (p) => p.issue.body },
      state: { type: 'IssueState!', resolve: (p) => p.issue.state.toUpperCase() },
      stateReason: { type: 'IssueClosedStateReason', resolve: (p) => (p.issue.state === 'closed' ? String(p.issue.stateReason ?? 'completed').toUpperCase() : null) },
      closed: { type: 'Boolean!', resolve: (p) => p.issue.state === 'closed' },
      closedAt: { type: 'DateTime', resolve: (p) => (p.issue.closedAt === null ? null : isoTime(p.issue.closedAt)) },
      createdAt: { type: 'DateTime!', resolve: (p) => isoTime(p.issue.createdAt) },
      updatedAt: { type: 'DateTime!', resolve: (p) => isoTime(p.issue.updatedAt) },
      url: { type: 'URI!', resolve: (p, _a, ctx) => `${ctx.base}/${ctx.forge.login}/${p.repo.name}/issues/${p.issue.number}` },
      author: { type: 'Actor', resolve: (_p, _a, ctx) => viewerOf(ctx.forge) },
      repository: { type: 'Repository!', resolve: (p) => wrapRepo(p.repo) },
      labels: { type: 'LabelConnection', args: CONNECTION_ARGS, resolve: (p, args) => connection('LabelConnection', p.issue.labels.map((label: unknown) => ({ __typename: 'Label', repo: p.repo, label })), args) },
      comments: { type: 'IssueCommentConnection!', args: CONNECTION_ARGS, resolve: (p, args) => connection('IssueCommentConnection', p.issue.comments.map((comment: Comment) => wrapComment(p.repo, comment)), args) },
      assignees: { type: 'UserConnection!', args: CONNECTION_ARGS, resolve: (_p, args) => connection('UserConnection', [], args) },
    },
  },

  PullRequest: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (p) => nodeId('PR', p.pull.id) },
      databaseId: { type: 'Int', resolve: (p) => p.pull.id },
      number: { type: 'Int!', resolve: (p) => p.pull.number },
      title: { type: 'String!', resolve: (p) => p.pull.issue.title },
      body: { type: 'String!', resolve: (p) => p.pull.issue.body },
      state: { type: 'PullRequestState!', resolve: (p) => pullState(p.pull) },
      closed: { type: 'Boolean!', resolve: (p) => p.pull.issue.state === 'closed' },
      merged: { type: 'Boolean!', resolve: (p) => p.pull.merged },
      mergedAt: { type: 'DateTime', resolve: (p) => (p.pull.mergedAt === null ? null : isoTime(p.pull.mergedAt)) },
      isDraft: { type: 'Boolean!', resolve: (p) => p.pull.draft },
      headRefName: { type: 'String!', resolve: (p) => p.pull.head },
      baseRefName: { type: 'String!', resolve: (p) => p.pull.base },
      headRefOid: { type: 'GitObjectID!', resolve: (p, _a, ctx) => ctx.forge.headSha(p.repo, p.pull) },
      baseRefOid: { type: 'GitObjectID!', resolve: (p, _a, ctx) => ctx.forge.baseSha(p.repo, p.pull) },
      mergeable: {
        type: 'MergeableState!',
        resolve: (p, _a, ctx) => (p.pull.issue.state !== 'open' ? 'UNKNOWN' : ctx.forge.mergeable(p.repo, p.pull) ? 'MERGEABLE' : 'CONFLICTING'),
      },
      mergeCommit: { type: 'Commit', resolve: (p) => (p.pull.mergeCommitSha === null ? null : { __typename: 'Commit', sha: p.pull.mergeCommitSha }) },
      createdAt: { type: 'DateTime!', resolve: (p) => isoTime(p.pull.issue.createdAt) },
      updatedAt: { type: 'DateTime!', resolve: (p) => isoTime(p.pull.issue.updatedAt) },
      url: { type: 'URI!', resolve: (p, _a, ctx) => `${ctx.base}/${ctx.forge.login}/${p.repo.name}/pull/${p.pull.number}` },
      author: { type: 'Actor', resolve: (_p, _a, ctx) => viewerOf(ctx.forge) },
      repository: { type: 'Repository!', resolve: (p) => wrapRepo(p.repo) },
      additions: { type: 'Int!', resolve: (p, _a, ctx) => ctx.forge.pullFiles(p.repo, p.pull).reduce((sum, file) => sum + file.additions, 0) },
      deletions: { type: 'Int!', resolve: (p, _a, ctx) => ctx.forge.pullFiles(p.repo, p.pull).reduce((sum, file) => sum + file.deletions, 0) },
      changedFiles: { type: 'Int!', resolve: (p, _a, ctx) => ctx.forge.pullFiles(p.repo, p.pull).length },
      files: {
        type: 'PullRequestChangedFileConnection',
        args: CONNECTION_ARGS,
        resolve: (p, args, ctx) =>
          connection(
            'PullRequestChangedFileConnection',
            ctx.forge.pullFiles(p.repo, p.pull).map((file) => ({
              __typename: 'PullRequestChangedFile',
              path: file.filename,
              additions: file.additions,
              deletions: file.deletions,
              changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
            })),
            args,
          ),
      },
      labels: { type: 'LabelConnection', args: CONNECTION_ARGS, resolve: (p, args) => connection('LabelConnection', p.pull.issue.labels.map((label: unknown) => ({ __typename: 'Label', repo: p.repo, label })), args) },
      comments: { type: 'IssueCommentConnection!', args: CONNECTION_ARGS, resolve: (p, args) => connection('IssueCommentConnection', p.pull.issue.comments.map((comment: Comment) => wrapComment(p.repo, comment)), args) },
    },
  },

  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: { path: { type: 'String!' }, additions: { type: 'Int!' }, deletions: { type: 'Int!' }, changeType: { type: 'PatchStatus!' } },
  },

  IssueComment: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (p) => nodeId('IC', p.comment.id) },
      databaseId: { type: 'Int', resolve: (p) => p.comment.id },
      body: { type: 'String!', resolve: (p) => p.comment.body },
      createdAt: { type: 'DateTime!', resolve: (p) => isoTime(p.comment.createdAt) },
      url: { type: 'URI!', resolve: (p, _a, ctx) => `${ctx.base}/${ctx.forge.login}/${p.repo.name}/issues/${p.comment.issueNumber}#issuecomment-${p.comment.id}` },
      author: { type: 'Actor', resolve: (_p, _a, ctx) => viewerOf(ctx.forge) },
    },
  },

  Label: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (p) => nodeId('LA', p.label.id) },
      name: { type: 'String!', resolve: (p) => p.label.name },
      color: { type: 'String!', resolve: (p) => p.label.color },
      description: { type: 'String', resolve: (p) => p.label.description },
    },
  },

  PageInfo: {
    kind: 'OBJECT',
    fields: { hasNextPage: { type: 'Boolean!' }, hasPreviousPage: { type: 'Boolean!' }, startCursor: { type: 'String' }, endCursor: { type: 'String' } },
  },

  CreateIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  ReopenIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  ClosePullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: { clientMutationId: { type: 'String' }, commentEdge: { type: 'IssueCommentEdge' }, subject: { type: 'Node' }, timelineEdge: { type: 'IssueTimelineItemEdge' } },
  },
  IssueTimelineItemEdge: { kind: 'OBJECT', fields: { cursor: { type: 'String!' }, node: { type: 'IssueComment' } } },

  CreateIssueInput: { kind: 'INPUT_OBJECT', inputFields: { repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]', assigneeIds: '[ID!]', clientMutationId: 'String' } },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: 'ID!', stateReason: 'IssueClosedStateReason', clientMutationId: 'String' } },
  ReopenIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: 'ID!', clientMutationId: 'String' } },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean', maintainerCanModify: 'Boolean', clientMutationId: 'String' },
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', commitHeadline: 'String', commitBody: 'String', expectedHeadOid: 'GitObjectID', clientMutationId: 'String' },
  },
  ClosePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: { pullRequestId: 'ID!', clientMutationId: 'String' } },
  AddCommentInput: { kind: 'INPUT_OBJECT', inputFields: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' } },
  IssueOrder: { kind: 'INPUT_OBJECT', inputFields: { field: 'IssueOrderField!', direction: 'OrderDirection!' } },
  IssueFilters: { kind: 'INPUT_OBJECT', inputFields: { states: '[IssueState!]', labels: '[String!]', assignee: 'String', createdBy: 'String' } },

  __Schema: {
    kind: 'OBJECT',
    fields: {
      description: { type: 'String', resolve: () => null },
      queryType: { type: '__Type!', resolve: () => typeRef('Query') },
      mutationType: { type: '__Type', resolve: () => typeRef('Mutation') },
      subscriptionType: { type: '__Type', resolve: () => null },
      types: { type: '[__Type!]!', resolve: () => Object.keys(TYPES).map((name) => typeRef(name)) },
      directives: { type: '[__Directive!]!', resolve: () => [] },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      kind: { type: '__TypeKind!', resolve: (p) => (p.ref.endsWith('!') ? 'NON_NULL' : p.ref.startsWith('[') ? 'LIST' : (TYPES[p.ref] as TypeDef).kind) },
      name: { type: 'String', resolve: (p) => (p.ref.endsWith('!') || p.ref.startsWith('[') ? null : p.ref) },
      description: { type: 'String', resolve: (p) => (TYPES[p.ref] as { description?: string } | undefined)?.description ?? null },
      specifiedByURL: { type: 'String', resolve: () => null },
      fields: {
        type: '[__Field!]',
        args: { includeDeprecated: 'Boolean' },
        resolve: (p) => {
          const def = TYPES[p.ref];
          if (def === undefined || (def.kind !== 'OBJECT' && def.kind !== 'INTERFACE')) return null;
          return Object.entries(def.fields)
            .filter(([name]) => !name.startsWith('__'))
            .map(([name, field]) => ({ __typename: '__Field', name, field }));
        },
      },
      interfaces: { type: '[__Type!]', resolve: (p) => { const def = TYPES[p.ref]; return def?.kind === 'OBJECT' ? (def.interfaces ?? []).map((name) => typeRef(name)) : def?.kind === 'INTERFACE' ? [] : null; } },
      possibleTypes: { type: '[__Type!]', resolve: (p) => { const def = TYPES[p.ref]; return def?.kind === 'INTERFACE' || def?.kind === 'UNION' ? def.possibleTypes.map((name) => typeRef(name)) : null; } },
      enumValues: {
        type: '[__EnumValue!]',
        args: { includeDeprecated: 'Boolean' },
        resolve: (p) => { const def = TYPES[p.ref]; return def?.kind === 'ENUM' ? def.values.map((name) => ({ __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null })) : null; },
      },
      inputFields: {
        type: '[__InputValue!]',
        args: { includeDeprecated: 'Boolean' },
        resolve: (p) => { const def = TYPES[p.ref]; return def?.kind === 'INPUT_OBJECT' ? Object.entries(def.inputFields).map(([name, type]) => inputValue(name, type)) : null; },
      },
      ofType: { type: '__Type', resolve: (p) => (p.ref.endsWith('!') ? typeRef(p.ref.slice(0, -1)) : p.ref.startsWith('[') ? typeRef(p.ref.slice(1, -1)) : null) },
      isOneOf: { type: 'Boolean', resolve: () => false },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String', resolve: (p) => p.field.description ?? null },
      args: { type: '[__InputValue!]!', args: { includeDeprecated: 'Boolean' }, resolve: (p) => Object.entries((p.field as FieldDef).args ?? {}).map(([name, type]) => inputValue(name, type)) },
      type: { type: '__Type!', resolve: (p) => typeRef(p.field.type) },
      isDeprecated: { type: 'Boolean!', resolve: () => false },
      deprecationReason: { type: 'String', resolve: () => null },
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      type: { type: '__Type!', resolve: (p) => typeRef(p.type) },
      defaultValue: { type: 'String' },
      isDeprecated: { type: 'Boolean!', resolve: () => false },
      deprecationReason: { type: 'String', resolve: () => null },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: { name: { type: 'String!' }, description: { type: 'String' }, isDeprecated: { type: 'Boolean!' }, deprecationReason: { type: 'String' } },
  },
  __Directive: { kind: 'OBJECT', fields: { name: { type: 'String!' }, description: { type: 'String' }, locations: { type: '[String!]!' }, args: { type: '[__InputValue!]!' } } },
  __TypeKind: enumOf('SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'),
};

// Connections and edges, generated.
for (const [connectionName, nodeType] of [
  ['IssueConnection', 'Issue'],
  ['PullRequestConnection', 'PullRequest'],
  ['IssueCommentConnection', 'IssueComment'],
  ['LabelConnection', 'Label'],
  ['UserConnection', 'User'],
  ['PullRequestChangedFileConnection', 'PullRequestChangedFile'],
] as const) {
  const edge = `${connectionName.replace(/Connection$/, '')}Edge`;
  TYPES[edge] = { kind: 'OBJECT', fields: { cursor: { type: 'String!' }, node: { type: nodeType } } };
  TYPES[connectionName] = {
    kind: 'OBJECT',
    fields: { nodes: { type: `[${nodeType}]` }, edges: { type: `[${edge}]` }, pageInfo: { type: 'PageInfo!' }, totalCount: { type: 'Int!' } },
  };
}

function typeRef(ref: string): Json {
  return { __typename: '__Type', ref };
}

function inputValue(name: string, type: string): Json {
  return { __typename: '__InputValue', name, description: null, type, defaultValue: null };
}

function namedType(ref: string): string {
  return ref.replace(/[[\]!]/g, '');
}

function fieldsOf(typeName: string): Record<string, FieldDef> | null {
  const def = TYPES[typeName];
  if (def === undefined) return null;
  if (def.kind === 'OBJECT' || def.kind === 'INTERFACE' || def.kind === 'UNION') return def.fields;
  return null;
}

function implementsType(runtime: string, condition: string): boolean {
  if (runtime === condition) return true;
  const def = TYPES[condition];
  if (def !== undefined && (def.kind === 'INTERFACE' || def.kind === 'UNION')) return def.possibleTypes.includes(runtime);
  return false;
}

// =========================================================================== validation

function validate(selections: Selection[], typeName: string, ctx: Ctx, seen: Set<string> = new Set()): void {
  const fields = fieldsOf(typeName);
  for (const selection of selections) {
    if (selection.kind === 'Spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Fragment ${selection.name} was used, but not defined` });
        continue;
      }
      if (seen.has(fragment.name)) continue;
      validate(fragment.selections, fragment.on, ctx, new Set([...seen, fragment.name]));
      continue;
    }
    if (selection.kind === 'Inline') {
      validate(selection.selections, selection.on ?? typeName, ctx, seen);
      continue;
    }
    if (selection.name === '__typename') continue;
    const field = fields?.[selection.name];
    if (field === undefined) {
      ctx.errors.push({
        message: `Field '${selection.name}' doesn't exist on type '${typeName}'`,
        locations: [{ line: selection.line, column: selection.column }],
        extensions: { code: 'undefinedField', typeName, fieldName: selection.name },
      });
      continue;
    }
    const target = namedType(field.type);
    const leaf = TYPES[target]?.kind === 'SCALAR' || TYPES[target]?.kind === 'ENUM';
    if (leaf && selection.selections !== null) {
      ctx.errors.push({ message: `Selections can't be made on ${TYPES[target]?.kind === 'ENUM' ? 'enums' : 'scalars'} (field '${selection.name}' returns ${target} but has selections [...])`, locations: [{ line: selection.line, column: selection.column }] });
    } else if (!leaf && selection.selections === null) {
      ctx.errors.push({ message: `Field must have selections (field '${selection.name}' returns ${target} but has no selections. Did you mean '${selection.name} { ... }'?)`, locations: [{ line: selection.line, column: selection.column }] });
    } else if (selection.selections !== null) validate(selection.selections, target, ctx, seen);
  }
}

// =========================================================================== execution

function valueOf(value: Value, ctx: Ctx): unknown {
  switch (value.kind) {
    case 'Variable':
      return ctx.variables[value.name] ?? null;
    case 'Int':
    case 'Float':
    case 'String':
    case 'Enum':
    case 'Boolean':
      return value.value;
    case 'Null':
      return null;
    case 'List':
      return value.values.map((item) => valueOf(item, ctx));
    case 'Object': {
      const out: Json = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: Field, ctx: Ctx): Json {
  const out: Json = {};
  for (const arg of field.args) {
    if (arg.value.kind === 'Variable' && !(arg.value.name in ctx.variables)) continue;
    out[arg.name] = valueOf(arg.value, ctx);
  }
  return out;
}

function included(directives: Directive[], ctx: Ctx): boolean {
  for (const directive of directives) {
    const ifArg = directive.args.find((arg) => arg.name === 'if');
    const condition = ifArg === undefined ? true : valueOf(ifArg.value, ctx) === true;
    if (directive.name === 'skip' && condition) return false;
    if (directive.name === 'include' && !condition) return false;
  }
  return true;
}

/** Collect the fields of a selection set for a runtime type, merging by response key. */
function collect(selections: Selection[], runtime: string, ctx: Ctx, out: Map<string, Field[]> = new Map()): Map<string, Field[]> {
  for (const selection of selections) {
    if (!included(selection.directives, ctx)) continue;
    if (selection.kind === 'Field') {
      const key = selection.alias ?? selection.name;
      const list = out.get(key);
      if (list === undefined) out.set(key, [selection]);
      else list.push(selection);
    } else if (selection.kind === 'Inline') {
      if (selection.on === null || implementsType(runtime, selection.on)) collect(selection.selections, runtime, ctx, out);
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && implementsType(runtime, fragment.on)) collect(fragment.selections, runtime, ctx, out);
    }
  }
  return out;
}

function executeObject(typeName: string, parent: any, selections: Selection[], ctx: Ctx, path: (string | number)[]): Json {
  const runtime = typeof parent?.__typename === 'string' ? (parent.__typename as string) : typeName;
  const fields = fieldsOf(runtime) ?? {};
  const out: Json = {};
  for (const [key, group] of collect(selections, runtime, ctx)) {
    const field = group[0] as Field;
    if (field.name === '__typename') {
      out[key] = runtime;
      continue;
    }
    const def = fields[field.name];
    if (def === undefined) {
      out[key] = null;
      continue;
    }
    const subSelections = group.flatMap((entry) => entry.selections ?? []);
    try {
      const resolved = def.resolve !== undefined ? def.resolve(parent, argsOf(field, ctx), ctx) : parent?.[field.name];
      out[key] = complete(def.type, resolved ?? null, subSelections, ctx, [...path, key]);
    } catch (err) {
      const message = err instanceof GraphQLError ? err.message : err instanceof Error ? err.message : String(err);
      const extra = err instanceof GraphQLError ? err.extra : {};
      ctx.errors.push({ ...extra, message, path: [...path, key], locations: [{ line: field.line, column: field.column }] });
      out[key] = null;
    }
  }
  return out;
}

function complete(ref: string, value: unknown, selections: Selection[], ctx: Ctx, path: (string | number)[]): unknown {
  if (ref.endsWith('!')) return complete(ref.slice(0, -1), value, selections, ctx, path);
  if (value === null || value === undefined) return null;
  if (ref.startsWith('[')) {
    const inner = ref.slice(1, -1);
    return (value as unknown[]).map((item, index) => complete(inner, item ?? null, selections, ctx, [...path, index]));
  }
  const def = TYPES[ref];
  if (def === undefined || def.kind === 'SCALAR' || def.kind === 'ENUM') return value;
  return executeObject(ref, value, selections, ctx, path);
}

/** Coerce the operation's variables: declared defaults, and a missing required variable is an error. */
function coerceVariables(operation: Operation, provided: Json): { variables: Json; errors: Json[] } {
  const variables: Json = {};
  const errors: Json[] = [];
  for (const definition of operation.variables) {
    if (definition.name in provided) variables[definition.name] = provided[definition.name];
    else if (definition.defaultValue !== null) variables[definition.name] = valueOf(definition.defaultValue, { variables: {} } as unknown as Ctx);
    else if (definition.type.endsWith('!')) errors.push({ message: `Variable $${definition.name} of type ${definition.type} was provided invalid value`, extensions: { value: null, problems: [{ path: [], explanation: 'Expected value to not be null' }] } });
    if (variables[definition.name] === null && definition.type.endsWith('!') && definition.name in provided) {
      errors.push({ message: `Variable $${definition.name} of type ${definition.type} was provided invalid value`, extensions: { value: null, problems: [{ path: [], explanation: 'Expected value to not be null' }] } });
    }
  }
  return { variables, errors };
}

/** Run one {query, variables, operationName} request against the forge. */
export function executeRequest(forge: Forge, base: string, request: unknown): Json {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  const body = request as Json;
  if (typeof body.query !== 'string' || body.query.trim() === '') return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  let definitions: (Operation | Fragment)[];
  try {
    definitions = new Parser(tokenize(body.query)).document();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err), locations: [] }] };
  }
  const operations = definitions.filter((definition): definition is Operation => definition.kind === 'Operation');
  const fragments = new Map(definitions.filter((definition): definition is Fragment => definition.kind === 'Fragment').map((fragment) => [fragment.name, fragment]));
  const operationName = typeof body.operationName === 'string' && body.operationName !== '' ? body.operationName : null;
  let operation: Operation | undefined;
  if (operationName !== null) operation = operations.find((entry) => entry.name === operationName);
  else if (operations.length === 1) operation = operations[0];
  if (operation === undefined) {
    return { errors: [{ message: operationName !== null ? `Unknown operation named "${operationName}".` : 'An operation name is required when the document holds more than one operation.' }] };
  }
  if (operation.type === 'subscription') return { errors: [{ message: 'Subscriptions are not supported' }] };
  const rawVariables = typeof body.variables === 'object' && body.variables !== null && !Array.isArray(body.variables) ? (body.variables as Json) : {};
  const { variables, errors: variableErrors } = coerceVariables(operation, rawVariables);
  const ctx: Ctx = { forge, base, variables, fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  validate(operation.selections, rootType, ctx);
  if (ctx.errors.length > 0 || variableErrors.length > 0) return { errors: [...variableErrors, ...ctx.errors] };
  const data = executeObject(rootType, { __typename: rootType }, operation.selections, ctx, []);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

/** The body of POST /api/graphql: one request object, or an array of them (operation batching). */
export function handleGraphQL(forge: Forge, base: string, body: unknown): unknown {
  if (Array.isArray(body)) return body.map((entry) => executeRequest(forge, base, entry));
  return executeRequest(forge, base, body);
}
