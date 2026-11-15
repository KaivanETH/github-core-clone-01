// The forge's HTTP server. main.ts owns the lifecycle (bind, register, wait for done); this file
// owns every reply: the health probe, the REST v3 API under /api/v3, and a JSON 404 for the rest.
//
// HTTP discipline, for every reply: a JSON body (never HTML), a non-empty X-GitHub-Request-Id, an
// error body of {"message": string}; 401 without the trial's bearer token (except /healthz), 404
// for an unknown route and 400 for a malformed JSON body. Request ids are a counter: nothing here
// reads the clock or draws a random number.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, Forge } from './forge.ts';
import { handleRest, type Ctx, type Reply } from './rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const API_PREFIX = '/api/v3';
const OAUTH_SCOPES = 'repo, read:org';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `F0C5:${requestCounter.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (res.headersSent) return;
  const base: Record<string, string | number> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    'x-github-media-type': 'github.v3; format=json',
  };
  if (status === 204 || body === undefined) {
    res.writeHead(status, { ...base, 'content-length': 0, ...headers });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { ...base, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendError(res: ServerResponse, error: ApiError, headers: Readonly<Record<string, string>> = {}): void {
  sendJson(res, error.status, error.body, headers);
}

/** The bearer (or `token`) credential of a request, or null. */
function credentialOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^(?:bearer|token)\s+(\S+)\s*$/i.exec(header.trim());
  return match === null ? null : (match[1] as string);
}

/** null when the request carries the trial's token, else the 401 to answer. */
function authFailure(req: IncomingMessage): ApiError | null {
  const presented = credentialOf(req);
  if (presented === null) return new ApiError(401, 'Requires authentication');
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '' && presented !== expected) return new ApiError(401, 'Bad credentials');
  return null;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The decoded path segments of `path`, or null when one does not decode. */
function segmentsOf(path: string): string[] | null {
  const out: string[] = [];
  for (const raw of path.split('/')) {
    if (raw === '') continue;
    try {
      out.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return out;
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  if (typeof host === 'string' && host !== '') return `http://${host}`;
  const address = req.socket.localAddress ?? '127.0.0.1';
  return `http://${address.includes(':') ? `[${address}]` : address}:${req.socket.localPort ?? 80}`;
}

async function handleApi(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const scopes = { 'x-oauth-scopes': OAUTH_SCOPES, 'x-accepted-oauth-scopes': '' };
  const denied = authFailure(req);
  if (denied !== null) {
    req.resume();
    sendError(res, denied);
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  let body: unknown;
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await readBody(req);
    const text = raw.toString('utf8');
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        sendError(res, new ApiError(400, 'Problems parsing JSON'), scopes);
        return;
      }
    }
  } else {
    req.resume();
  }
  const segs = segmentsOf(url.pathname.slice(API_PREFIX.length));
  if (segs === null) {
    sendError(res, new ApiError(404, 'Not Found'), scopes);
    return;
  }
  const ctx: Ctx = { method, segs, query: url.searchParams, body, base: originOf(req), path: url.pathname };
  const reply: Reply = handleRest(forge, ctx);
  sendJson(res, reply.status, reply.body, { ...scopes, ...(reply.headers ?? {}) });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      url = new URL('http://entry/');
    }
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (path === '/healthz' && (method === 'GET' || method === 'HEAD')) {
      req.resume();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
      handleApi(forge, req, res, url).catch((err: unknown) => {
        if (err instanceof ApiError) sendError(res, err, { 'x-oauth-scopes': OAUTH_SCOPES });
        else {
          process.stderr.write(`[entry] ${req.method} ${req.url}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
          sendJson(res, 500, { message: 'Internal Server Error' });
        }
      });
      return;
    }

    // Everything else, every method: GitHub's 404 body.
    req.resume();
    sendJson(res, 404, { message: 'Not Found' });
  });
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 0;
  return server;
}
