// Detector unificado: Web Worker (preferido) con fallback a hilo principal.
import { createLandmarker, packResult, type LandmarkerHandle } from './landmarker';
import { REMOTE_MODEL_URL, type Delegate, type FromWorker, type ResultMsg } from './protocol';

export interface FaceDetector {
  readonly kind: 'worker' | 'main-thread';
  readonly delegate: Delegate;
  /** Procesa un fotograma; resuelve con el resultado (o null si se descartó). */
  detect(video: HTMLVideoElement, timestamp: number): Promise<ResultMsg | null>;
  dispose(): void;
}

function paths() {
  const base = new URL(import.meta.env.BASE_URL, location.href);
  return {
    wasmBase: new URL('wasm', base).href.replace(/\/$/, ''),
    modelUrl: new URL('models/face_landmarker.task', base).href,
    fallbackModelUrl: REMOTE_MODEL_URL,
  };
}

class WorkerDetector implements FaceDetector {
  readonly kind = 'worker' as const;
  private pending: ((r: ResultMsg | null) => void) | null = null;
  constructor(private worker: Worker, readonly delegate: Delegate, private log: (m: string) => void) {
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === 'result') this.resolve(m);
      else if (m.type === 'error') {
        this.log(`Worker: ${m.message}`);
        this.resolve(null);
      }
    };
  }
  private resolve(r: ResultMsg | null) {
    const p = this.pending;
    this.pending = null;
    p?.(r);
  }
  async detect(video: HTMLVideoElement, timestamp: number): Promise<ResultMsg | null> {
    if (this.pending) return null; // un fotograma en vuelo como máximo
    const bitmap = await createImageBitmap(video);
    return new Promise((resolve) => {
      this.pending = resolve;
      this.worker.postMessage({ type: 'frame', bitmap, timestamp }, [bitmap]);
    });
  }
  dispose() {
    this.worker.terminate();
    this.resolve(null);
  }
}

class MainThreadDetector implements FaceDetector {
  readonly kind = 'main-thread' as const;
  private lastTs = -1;
  constructor(private handle: LandmarkerHandle) {}
  get delegate() { return this.handle.delegate; }
  async detect(video: HTMLVideoElement, timestamp: number): Promise<ResultMsg | null> {
    const ts = Math.max(timestamp, this.lastTs + 1);
    this.lastTs = ts;
    const t0 = performance.now();
    const r = this.handle.landmarker.detectForVideo(video, ts);
    return packResult(r, timestamp, performance.now() - t0, video.videoWidth, video.videoHeight);
  }
  dispose() { this.handle.landmarker.close(); }
}

async function tryWorker(preferGPU: boolean, log: (m: string) => void, timeoutMs = 30000): Promise<FaceDetector> {
  const worker = new Worker(new URL('./face.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<FaceDetector>((resolve, reject) => {
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Timeout iniciando worker')); }, timeoutMs);
    worker.onerror = (e) => { clearTimeout(timer); worker.terminate(); reject(new Error(e.message || 'Error en worker')); };
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === 'ready') { clearTimeout(timer); worker.onerror = null; resolve(new WorkerDetector(worker, m.delegate, log)); }
      else if (m.type === 'error' && m.fatal) { clearTimeout(timer); worker.terminate(); reject(new Error(m.message)); }
    };
    worker.postMessage({ type: 'init', preferGPU, ...paths() });
  });
}

export async function createFaceDetector(opts: {
  preferWorker: boolean;
  preferGPU: boolean;
  log: (m: string) => void;
}): Promise<FaceDetector> {
  if (opts.preferWorker && typeof Worker !== 'undefined' && typeof createImageBitmap === 'function') {
    try {
      return await tryWorker(opts.preferGPU, opts.log);
    } catch (e) {
      opts.log(`Worker no disponible (${(e as Error).message}); usando hilo principal.`);
    }
  }
  const handle = await createLandmarker({ ...paths(), preferGPU: opts.preferGPU, inWorker: false, log: opts.log });
  return new MainThreadDetector(handle);
}
