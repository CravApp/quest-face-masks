// Logger de desarrollo en el mismo origen: JSONL en disco, eco en la terminal
// y POST /__debug/eval para ejecutar JS en la página conectada.
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Connect, Plugin, ViteDevServer } from 'vite';

const LOG_DIR = path.resolve('debug-logs');
const LOG_FILE = path.join(LOG_DIR, 'device.jsonl');
const TOKEN_FILE = path.join(LOG_DIR, 'token');

interface EvalJob {
  id: string;
  code: string;
}

interface ClientInfo {
  id: string;
  ua: string;
  ip: string;
  lastSeen: number;
  held?: {
    finish: (jobs: EvalJob[]) => void;
    timer: ReturnType<typeof setTimeout>;
  };
}

interface EvalWaiter {
  resolve: (result: { ok: boolean; result: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

function clientIp(req: IncomingMessage): string {
  const xf = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xf) ? xf[0] : xf;
  if (raw) return raw.split(',')[0]?.trim() || '';
  return req.socket.remoteAddress ?? '';
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function summarize(row: Record<string, unknown>): string {
  const level = String(row.level ?? 'info');
  const kind = String(row.kind ?? 'log');
  const message = String(row.message ?? '').replace(/\s+/g, ' ');
  const loc = row.file ? ` (${row.file}:${row.line ?? '?'}:${row.col ?? '?'})` : '';
  return `[quest-debug] ${level} ${kind} ${message}${loc}`.slice(0, 420);
}

function attach(middlewares: Connect.Server, httpServer: ViteDevServer['httpServer'], logger: Logger, secure: boolean): void {
  const token = randomBytes(16).toString('hex');
  const clients = new Map<string, ClientInfo>();
  const inbox = new Map<string, EvalJob[]>();
  const waiters = new Map<string, EvalWaiter>();
  const ready = mkdir(LOG_DIR, { recursive: true }).then(() => writeFile(TOKEN_FILE, `${token}\n`));
  let chain: Promise<void> = ready;

  function record(row: Record<string, unknown>): void {
    logger.info(summarize(row));
    const line = `${JSON.stringify(row)}\n`;
    chain = chain.then(() => appendFile(LOG_FILE, line)).catch((err: unknown) => {
      logger.warn(`[quest-debug] no se pudo escribir ${LOG_FILE}: ${err instanceof Error ? err.message : err}`);
    });
  }

  function touch(req: IncomingMessage): ClientInfo {
    const id = header(req, 'x-debug-client') || 'anon';
    const prev = clients.get(id);
    const info: ClientInfo = prev ?? { id, ua: '', ip: '', lastSeen: 0 };
    info.ua = header(req, 'user-agent');
    info.ip = clientIp(req);
    info.lastSeen = Date.now();
    if (!prev) {
      clients.set(id, info);
      record({
        t: new Date().toISOString(),
        level: 'info',
        kind: 'client',
        message: `cliente conectado ${id}`,
        data: { userAgent: info.ua, ip: info.ip },
      });
    }
    return info;
  }

  function freshest(preferred?: string): ClientInfo | undefined {
    if (preferred) {
      const chosen = clients.get(preferred);
      if (chosen && Date.now() - chosen.lastSeen < 30_000) return chosen;
    }
    let best: ClientInfo | undefined;
    for (const client of clients.values()) {
      if (Date.now() - client.lastSeen > 30_000) continue;
      if (!best || client.lastSeen > best.lastSeen) best = client;
    }
    return best;
  }

  function deliver(client: ClientInfo, job: EvalJob): void {
    if (client.held) {
      const held = client.held;
      client.held = undefined;
      clearTimeout(held.timer);
      held.finish([job]);
      return;
    }
    const queued = inbox.get(client.id) ?? [];
    queued.push(job);
    inbox.set(client.id, queued);
  }

  async function onEval(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown> = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'JSON inválido' });
      return;
    }
    const presented = header(req, 'x-debug-token') || String(body.token ?? '');
    if (presented !== token) {
      sendJson(res, 401, { ok: false, error: 'token inválido (está en la terminal y en debug-logs/token)' });
      return;
    }
    const code = String(body.code ?? body.expr ?? '');
    if (!code.trim()) {
      sendJson(res, 400, { ok: false, error: 'falta "code"' });
      return;
    }
    const timeoutMs = Math.min(60_000, Math.max(1000, Number(body.timeoutMs) || 15_000));
    const preferred = typeof body.clientId === 'string' ? body.clientId : undefined;
    const deadline = Date.now() + timeoutMs;
    let target = freshest(preferred);
    while (!target && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      target = freshest(preferred);
    }
    if (!target) {
      const message = 'no hay ninguna página conectada';
      record({ t: new Date().toISOString(), level: 'error', kind: 'eval', message, data: { code } });
      sendJson(res, 504, { ok: false, error: message });
      return;
    }
    const id = randomBytes(8).toString('hex');
    const result = new Promise<{ ok: boolean; result: string }>((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        resolve({ ok: false, result: 'tiempo de espera agotado' });
      }, Math.max(500, deadline - Date.now()));
      waiters.set(id, { resolve, timer });
    });
    deliver(target, { id, code });
    const outcome = await result;
    record({
      t: new Date().toISOString(),
      level: outcome.ok ? 'info' : 'error',
      kind: 'eval',
      message: outcome.result,
      data: { id, ok: outcome.ok, code, clientId: target.id },
    });
    sendJson(res, outcome.ok ? 200 : 500, { ok: outcome.ok, result: outcome.result, clientId: target.id, id });
  }

  middlewares.use((req, res, next) => {
    const pathname = (req.url ?? '').split('?')[0] ?? '';
    if (!pathname.startsWith('/__debug')) {
      next();
      return;
    }
    void (async () => {
      await ready;
      if (req.method === 'GET' && (pathname === '/__debug' || pathname === '/__debug/status')) {
        sendJson(res, 200, {
          logFile: 'debug-logs/device.jsonl',
          clients: [...clients.values()].map((c) => ({ id: c.id, userAgent: c.ua, ip: c.ip, lastSeen: c.lastSeen })),
        });
        return;
      }
      if (req.method === 'POST' && pathname === '/__debug/log') {
        touch(req);
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) as { entries?: unknown } : {};
        const entries = Array.isArray(body) ? body : Array.isArray(body.entries) ? body.entries : [body];
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object') continue;
          const row = { ...(entry as Record<string, unknown>) };
          if (typeof row.t !== 'string') row.t = new Date().toISOString();
          const ip = clientIp(req);
          if (ip) row.ip = ip;
          record(row);
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && pathname === '/__debug/poll') {
        const client = touch(req);
        const queued = inbox.get(client.id) ?? [];
        inbox.set(client.id, []);
        if (queued.length) {
          sendJson(res, 200, { evals: queued });
          return;
        }
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (jobs: EvalJob[]) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (client.held?.finish === finish) client.held = undefined;
            sendJson(res, 200, { evals: jobs });
            resolve();
          };
          const timer = setTimeout(() => finish([]), 15_000);
          client.held = { finish, timer };
          req.on('close', () => { if (!res.writableEnded) finish([]); });
        });
        return;
      }
      if (req.method === 'POST' && pathname === '/__debug/result') {
        touch(req);
        const raw = await readBody(req);
        const body = JSON.parse(raw) as { id?: string; ok?: boolean; result?: string };
        const waiter = body.id ? waiters.get(body.id) : undefined;
        if (!waiter || !body.id) {
          record({
            t: new Date().toISOString(),
            level: 'warn',
            kind: 'eval',
            message: String(body.result ?? ''),
            data: { id: body.id, ok: !!body.ok, late: true },
          });
          sendJson(res, 200, { ok: true, late: true });
          return;
        }
        clearTimeout(waiter.timer);
        waiters.delete(body.id);
        waiter.resolve({ ok: !!body.ok, result: String(body.result ?? '') });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && pathname === '/__debug/eval') {
        await onEval(req, res);
        return;
      }
      sendJson(res, 404, { ok: false, error: 'ruta desconocida' });
    })().catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });

  httpServer?.once('listening', () => {
    setTimeout(() => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 5173;
      const proto = secure ? 'https' : 'http';
      const curlFlags = secure ? ' -k' : '';
      logger.info([
        '',
        '  Depuración remota (solo este dev server)',
        '  archivo: debug-logs/device.jsonl',
        `  token:   ${token}`,
        `  estado:  ${proto}://localhost:${port}/__debug/status`,
        `  eval:    curl${curlFlags} -X POST ${proto}://localhost:${port}/__debug/eval -H "content-type: application/json" -H "x-debug-token: ${token}" -d "{\\"code\\":\\"navigator.userAgent\\"}"`,
        '',
      ].join('\n'));
    }, 40);
  });
}

/** Middleware de logs. En `vite preview` solo si REMOTE_DEBUG=1. */
export function remoteDebugPlugin(): Plugin {
  return {
    name: 'quest-remote-debug',
    apply: 'serve',
    configureServer(server) {
      attach(server.middlewares, server.httpServer, server.config.logger, Boolean(server.config.server.https));
    },
    configurePreviewServer(server) {
      if (process.env.REMOTE_DEBUG === '1') {
        attach(server.middlewares, server.httpServer, server.config.logger, Boolean(server.config.preview.https));
      }
    },
  };
}
