// Inyecta chii (DevTools remoto) por el mismo origen HTTPS cuando el proceso
// está escuchando en el puerto 8080 con --base-path /__chii.
import type { Plugin } from 'vite';

const PROBE = 'http://127.0.0.1:8080/__chii/target.js';

async function chiiUp(): Promise<boolean> {
  if (process.env.CHII === '0') return false;
  if (process.env.CHII === '1') return true;
  try {
    const res = await fetch(PROBE, { signal: AbortSignal.timeout(400) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Añade `<script src="/__chii/target.js">` si chii responde, o si CHII=1. */
export function chiiPlugin(): Plugin {
  let cached: { at: number; on: boolean } | null = null;
  return {
    name: 'quest-chii',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      async handler() {
        if (process.env.CHII !== '1') {
          const now = Date.now();
          if (!cached || now - cached.at > 3000) cached = { at: now, on: await chiiUp() };
          if (!cached.on) return;
        }
        return [{ tag: 'script', attrs: { src: '/__chii/target.js' }, injectTo: 'head' }];
      },
    },
  };
}
