import { defineConfig } from 'vite';
import { chiiPlugin } from './vite/chii.ts';
import { lanHttpsPlugin } from './vite/lan-https.ts';
import { remoteDebugPlugin } from './vite/remote-debug.ts';

/** Base de Vite. En Pages llega por VITE_BASE (p. ej. /quest-face-masks/) para que wasm y modelo resuelvan bajo ese prefijo. */
function resolveBase(): string {
  if (process.env.VITE_BASE !== undefined) return normalizeBase(process.env.VITE_BASE);
  if (process.env.GITHUB_ACTIONS === 'true') {
    const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
    if (repo) return normalizeBase(repo);
  }
  return '/';
}

function normalizeBase(raw: string): string {
  const value = raw.trim();
  if (!value || value === '/') return '/';
  const withSlash = value.startsWith('/') ? value : `/${value}`;
  return withSlash.endsWith('/') ? withSlash : `${withSlash}/`;
}

export default defineConfig(({ mode }) => {
  const lan = mode === 'lan';
  return {
    base: resolveBase(),
    plugins: [
      lan ? lanHttpsPlugin() : null,
      remoteDebugPlugin(),
      chiiPlugin(),
    ],
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      // Mismo origen que la página: el script de chii abre el WebSocket bajo /__chii/.
      proxy: {
        '/__chii': {
          target: 'http://127.0.0.1:8080',
          changeOrigin: true,
          ws: true,
        },
      },
    },
    preview: { host: true, port: 4173 },
    worker: { format: 'es' },
    build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
    optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  };
});
