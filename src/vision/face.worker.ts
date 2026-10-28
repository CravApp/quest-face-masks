// Web Worker de inferencia: recibe ImageBitmap transferidos y devuelve landmarks + matriz.
import { createLandmarker, packResult, type LandmarkerHandle } from './landmarker';
import type { FromWorker, ToWorker } from './protocol';

let handle: LandmarkerHandle | null = null;
let lastTs = -1;

function send(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    try {
      handle = await createLandmarker({ ...msg, inWorker: true });
      send({ type: 'ready', delegate: handle.delegate });
    } catch (e) {
      send({ type: 'error', message: (e as Error)?.message ?? String(e), fatal: true });
    }
    return;
  }
  if (msg.type === 'frame') {
    const { bitmap } = msg;
    try {
      if (!handle) throw new Error('Worker no inicializado');
      // detectForVideo exige timestamps estrictamente crecientes.
      const ts = Math.max(msg.timestamp, lastTs + 1);
      lastTs = ts;
      const t0 = performance.now();
      const r = handle.landmarker.detectForVideo(bitmap, ts);
      const res = packResult(r, msg.timestamp, performance.now() - t0, bitmap.width, bitmap.height);
      send(res, res.landmarks ? [res.landmarks.buffer] : []);
    } catch (e) {
      send({ type: 'error', message: (e as Error)?.message ?? String(e), fatal: false });
    } finally {
      bitmap.close();
    }
  }
};
