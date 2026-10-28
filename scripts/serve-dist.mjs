#!/usr/bin/env node
/**
 * Servidor estático mínimo para servir `dist/` (build de producción de Vite).
 * Pensado para el despliegue en el sandbox: HTTPS público vía el proxy del
 * entorno, por lo que getUserMedia() tiene contexto seguro.
 *
 * Uso: node scripts/serve-dist.mjs [puerto]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'dist');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const HOST = '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.map': 'application/json; charset=utf-8',
};

const LONG_CACHE = new Set(['.wasm', '.task', '.glb']);

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad Request', { 'content-type': 'text/plain' });
  }

  if (urlPath === '/healthz') {
    return send(res, 200, JSON.stringify({ ok: true }), {
      'content-type': 'application/json',
    });
  }

  // Normaliza y evita salir de ROOT (path traversal).
  let filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) {
    return send(res, 403, 'Forbidden', { 'content-type': 'text/plain' });
  }

  let stat = null;
  try {
    stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = fs.statSync(filePath);
    }
  } catch {
    // SPA: cualquier ruta desconocida sin extensión cae en index.html.
    if (path.extname(urlPath)) {
      return send(res, 404, 'Not Found', { 'content-type': 'text/plain' });
    }
    filePath = path.join(ROOT, 'index.html');
    try {
      stat = fs.statSync(filePath);
    } catch {
      return send(res, 500, 'build missing (run npm run build)', {
        'content-type': 'text/plain',
      });
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const headers = {
    'content-type': type,
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    'cache-control': LONG_CACHE.has(ext)
      ? 'public, max-age=31536000, immutable'
      : ext === '.html'
        ? 'no-cache'
        : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
  };

  // Soporte de Range para los .wasm / .task grandes.
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start <= end && end < stat.size) {
        res.writeHead(206, {
          ...headers,
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${stat.size}`,
        });
        return fs.createReadStream(filePath, { start, end }).pipe(res);
      }
    }
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`[serve-dist] http://${HOST}:${PORT} -> ${ROOT}`);
});
