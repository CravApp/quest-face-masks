// Registro remoto. En dev habla con el middleware del propio Vite (/__debug).
// En cualquier build, ?log=https://host:puerto envía lo mismo a un logger externo
// (POST /log y, si conecta, WebSocket /rlog-ws). Sin el parámetro no hace nada.

export interface DebugFields {
  kind: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  message?: string;
  file?: string;
  line?: number;
  col?: number;
  stack?: string;
  data?: unknown;
}

interface DebugEntry extends DebugFields {
  t: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  href: string;
  clientId: string;
}

type Transport = (entries: DebugEntry[]) => void;

const devServer = import.meta.env.DEV || import.meta.env.VITE_REMOTE_DEBUG === '1';

let active = false;
let clientId = '';
const queue: DebugEntry[] = [];
const transports: Transport[] = [];
let flushTimer = 0;
let reporting = false;

function externalOrigin(): string | null {
  const raw = new URLSearchParams(location.search).get('log');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isDebugUrl(url: string): boolean {
  return url.includes('/__debug/') || url.includes('/__debug?') || /\/log(?:\?|$)/.test(url) || url.includes('/rlog-ws');
}

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function serialize(value: unknown): string {
  if (value === undefined) return 'undefined';
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return item.toString();
      if (typeof item === 'function') return `[Function ${(item as { name?: string }).name || 'anonymous'}]`;
      if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
      if (typeof Element !== 'undefined' && item instanceof Element) return `<${item.tagName.toLowerCase()}>`;
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
    if (json === undefined) return String(value);
    return json.length > 20_000 ? `${json.slice(0, 20_000)}…` : json;
  } catch {
    return String(value);
  }
}

function enqueue(fields: DebugFields): void {
  if (!active || reporting) return;
  queue.push({
    t: new Date().toISOString(),
    level: fields.level ?? 'info',
    message: fields.message ?? '',
    href: location.href,
    clientId,
    ...fields,
  });
  if (queue.length >= 20) void flush();
  else if (!flushTimer) flushTimer = window.setTimeout(() => void flush(), 250);
}

async function flush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = 0;
  }
  if (!queue.length) return;
  const batch = queue.splice(0, 40);
  reporting = true;
  try {
    for (const send of transports) {
      try { send(batch); } catch { /* el transporte ya ignora sus propios fallos */ }
    }
  } finally {
    reporting = false;
  }
}

function patchConsole(): void {
  const levels = ['debug', 'info', 'log', 'warn', 'error'] as const;
  for (const method of levels) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      if (reporting) return;
      const error = args.find((arg) => arg instanceof Error);
      enqueue({
        kind: 'console',
        level: method === 'log' ? 'info' : method,
        message: args.map(formatArg).join(' '),
        stack: error?.stack,
        data: { method },
      });
    };
  }
}

function patchFetch(): void {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    try {
      const res = await original(input, init);
      if (!res.ok && !isDebugUrl(url)) {
        enqueue({ kind: 'fetch', level: 'error', message: `fetch ${res.status} ${url}`, data: { url, status: res.status } });
      }
      return res;
    } catch (err) {
      if (!isDebugUrl(url)) {
        const error = err instanceof Error ? err : new Error(String(err));
        enqueue({ kind: 'fetch', level: 'error', message: `fetch falló ${url}: ${error.message}`, stack: error.stack, data: { url } });
      }
      throw err;
    }
  };
}

function installGuards(): void {
  window.addEventListener('error', (event) => {
    const error = event.error instanceof Error ? event.error : undefined;
    enqueue({
      kind: 'error',
      level: 'error',
      message: event.message || error?.message || 'error',
      file: event.filename || undefined,
      line: event.lineno || undefined,
      col: event.colno || undefined,
      stack: error?.stack,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const error = reason instanceof Error ? reason : undefined;
    enqueue({
      kind: 'unhandledrejection',
      level: 'error',
      message: error?.message ?? String(reason),
      stack: error?.stack,
    });
  });
  window.addEventListener('pagehide', () => { void flush(); });
}

function startDevChannel(): void {
  transports.push((entries) => {
    void fetch('/__debug/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debug-client': clientId },
      body: JSON.stringify({ entries }),
    }).catch(() => {});
  });
  void pollEvals();
}

async function pollEvals(): Promise<void> {
  while (active) {
    try {
      const res = await fetch('/__debug/poll', { headers: { 'x-debug-client': clientId } });
      if (res.status === 404) return;
      if (!res.ok) {
        await delay(1000);
        continue;
      }
      const body = await res.json() as { evals?: { id: string; code: string }[] };
      for (const job of body.evals ?? []) {
        const outcome = await runEval(job.code);
        await fetch('/__debug/result', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-debug-client': clientId },
          body: JSON.stringify({ id: job.id, ...outcome }),
        });
      }
    } catch {
      await delay(1500);
    }
  }
}

async function runEval(code: string): Promise<{ ok: boolean; result: string }> {
  const AsyncFunction = Object.getPrototypeOf(async function () { /* plantilla */ }).constructor as new (body: string) => () => Promise<unknown>;
  try {
    let value: unknown;
    try {
      value = await new AsyncFunction(`"use strict"; return (\n${code}\n);`)();
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      value = await new AsyncFunction(`"use strict";\n${code}`)();
    }
    return { ok: true, result: serialize(value) };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { ok: false, result: error.stack || error.message };
  }
}

function startExternal(origin: string): void {
  const postUrl = new URL('/log', origin).href;
  const wsUrl = new URL('/rlog-ws', origin);
  wsUrl.protocol = origin.startsWith('https:') ? 'wss:' : 'ws:';
  let socket: WebSocket | null = null;
  let open = false;
  let retryMs = 500;
  const connect = () => {
    if (!active) return;
    try {
      socket = new WebSocket(wsUrl.href);
    } catch {
      window.setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 8000);
      return;
    }
    socket.addEventListener('open', () => { open = true; retryMs = 500; });
    socket.addEventListener('close', () => {
      open = false;
      window.setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 8000);
    });
    socket.addEventListener('error', () => socket?.close());
  };
  connect();
  transports.push((entries) => {
    if (open && socket?.readyState === WebSocket.OPEN) {
      for (const entry of entries) socket.send(JSON.stringify(entry));
      return;
    }
    for (const entry of entries) {
      void fetch(postUrl, {
        method: 'POST',
        mode: 'cors',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry),
      }).catch(() => {});
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rememberClient(): string {
  const key = 'quest-debug-client';
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/** Activa la captura. En producción no hace nada salvo que la URL lleve ?log=. */
export function installRemoteDebug(): void {
  if (active) return;
  const external = externalOrigin();
  if (!devServer && !external) return;
  active = true;
  clientId = rememberClient();
  patchConsole();
  patchFetch();
  installGuards();
  if (devServer) startDevChannel();
  if (external) startExternal(external);
}

/** Evento estructurado (cámara, WebXR, FPS, arranque). No-op si el logger no está activo. */
export function debugReport(fields: DebugFields): void {
  enqueue(fields);
}
