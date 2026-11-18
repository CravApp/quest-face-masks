// Detector unificado: Web Worker (preferido) con fallback a hilo principal.
// El worker puede leer un ReadableStream de VideoFrame para no bloquear el hilo de XR.
import { createLandmarker, packResult, type LandmarkerHandle } from './landmarker';
import { REMOTE_MODEL_URL, type Delegate, type FromWorker, type ResultMsg } from './protocol';

export interface FaceDetector {
  readonly kind: 'worker' | 'main-thread';
  readonly delegate: Delegate;
  /** Procesa un fotograma. Null si había otro en vuelo (se descarta). */
  detect(video: HTMLVideoElement, timestamp: number, captureTime: number | null, eye?: 'left' | 'right'): Promise<ResultMsg | null>;
  /** Pasa el track al worker vía MediaStreamTrackProcessor. False si no se pudo. */
  attachTrack(track: MediaStreamTrack, capHz: number): boolean;
  setCapHz(hz: number): void;
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

interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> };
}

function processorCtor(): TrackProcessorCtor | null {
  const host = globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor };
  return typeof host.MediaStreamTrackProcessor === 'function' ? host.MediaStreamTrackProcessor : null;
}

class WorkerDetector implements FaceDetector {
  readonly kind = 'worker' as const;
  private pending: ((r: ResultMsg | null) => void) | null = null;
  private pendingEye: 'left' | 'right' | null = null;
  private clone: MediaStreamTrack | null = null;
  streaming = false;
  /** Resultados que no responden a un detect() (el stream del worker). */
  onPush: ((result: ResultMsg) => void) | null = null;
  onStreamEnd: (() => void) | null = null;
  constructor(private worker: Worker, readonly delegate: Delegate, private log: (m: string) => void) {
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const message = ev.data;
      if (message.type === 'result') {
        if (this.pending && this.pendingEye === message.eye) this.resolve(message);
        else this.onPush?.(message);
      } else if (message.type === 'dropped') this.resolve(null);
      else if (message.type === 'error') {
        this.log(`Worker: ${message.message}`);
        if (message.message.startsWith('stream:')) {
          this.streaming = false;
          this.onStreamEnd?.();
          this.onStreamEnd = null;
        }
        this.resolve(null);
      }
    };
  }
  private resolve(result: ResultMsg | null) {
    const pending = this.pending;
    this.pending = null;
    this.pendingEye = null;
    pending?.(result);
  }
  async detect(video: HTMLVideoElement, timestamp: number, captureTime: number | null, eye: 'left' | 'right' = 'left'): Promise<ResultMsg | null> {
    if (this.pending) return null;
    const bitmap = await createImageBitmap(video);
    return new Promise((resolve) => {
      this.pending = resolve;
      this.pendingEye = eye;
      this.worker.postMessage({ type: 'frame', bitmap, timestamp, captureTime, eye }, [bitmap]);
    });
  }
  attachTrack(track: MediaStreamTrack, capHz: number): boolean {
    const Ctor = processorCtor();
    if (!Ctor) return false;
    try {
      this.clone?.stop();
      const clone = track.clone();
      const readable = new Ctor({ track: clone }).readable;
      this.worker.postMessage({ type: 'stream', readable, capHz }, [readable]);
      this.clone = clone;
      this.streaming = true;
      return true;
    } catch (error) {
      this.log(`MediaStreamTrackProcessor no usable: ${(error as Error).message}`);
      return false;
    }
  }
  setCapHz(hz: number): void {
    this.worker.postMessage({ type: 'cap', capHz: hz });
  }
  dispose() {
    this.clone?.stop();
    this.worker.terminate();
    this.resolve(null);
  }
}

class MainThreadDetector implements FaceDetector {
  readonly kind = 'main-thread' as const;
  private lastTs = -1;
  private busy = false;
  constructor(private handle: LandmarkerHandle) {}
  get delegate() { return this.handle.delegate; }
  async detect(video: HTMLVideoElement, timestamp: number, captureTime: number | null, eye: 'left' | 'right' = 'left'): Promise<ResultMsg | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const ts = Math.max(timestamp, this.lastTs + 1);
      this.lastTs = ts;
      const t0 = performance.now();
      const result = this.handle.landmarker.detectForVideo(video, ts);
      return packResult(result, timestamp, performance.now() - t0, video.videoWidth, video.videoHeight, captureTime, eye);
    } finally {
      this.busy = false;
    }
  }
  attachTrack(): boolean { return false; }
  setCapHz(): void { /* el bucle principal aplica el tope */ }
  dispose() { this.handle.landmarker.close(); }
}

async function tryWorker(preferGPU: boolean, log: (m: string) => void, timeoutMs = 30000): Promise<FaceDetector> {
  const worker = new Worker(new URL('./face.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<FaceDetector>((resolve, reject) => {
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Timeout iniciando worker')); }, timeoutMs);
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message || 'Error en worker')); };
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const message = ev.data;
      if (message.type === 'ready') { clearTimeout(timer); worker.onerror = null; resolve(new WorkerDetector(worker, message.delegate, log)); }
      else if (message.type === 'error' && message.fatal) { clearTimeout(timer); worker.terminate(); reject(new Error(message.message)); }
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
    } catch (error) {
      opts.log(`Worker no disponible (${(error as Error).message}); usando hilo principal.`);
    }
  }
  const handle = await createLandmarker({ ...paths(), preferGPU: opts.preferGPU, inWorker: false, log: opts.log });
  return new MainThreadDetector(handle);
}

export function isWorkerDetector(detector: FaceDetector): detector is WorkerDetector {
  return detector.kind === 'worker';
}
