import { createPoseLandmarker, packPoseResult, type PoseHandle } from './pose-landmarker';
import { POSE_FULL_URL, POSE_LITE_URL, type FromPoseWorker, type PoseResultMsg } from './pose-protocol';
import type { Delegate } from './protocol';

export interface PoseDetector {
  readonly kind: 'worker' | 'main-thread';
  readonly delegate: Delegate;
  detect(video: HTMLVideoElement, timestamp: number, captureTime: number | null, eye?: 'left' | 'right'): Promise<PoseResultMsg | null>;
  attachTrack(track: MediaStreamTrack, capHz: number): boolean;
  setCapHz(hz: number): void;
  dispose(): void;
}

function paths(variant: 'lite' | 'full') {
  const base = new URL(import.meta.env.BASE_URL, location.href);
  const file = variant === 'full' ? 'models/pose_landmarker_full.task' : 'models/pose_landmarker_lite.task';
  return {
    wasmBase: new URL('wasm', base).href.replace(/\/$/, ''),
    modelUrl: new URL(file, base).href,
    fallbackModelUrl: variant === 'full' ? POSE_FULL_URL : POSE_LITE_URL,
  };
}

interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> };
}

function processorCtor(): TrackProcessorCtor | null {
  const host = globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor };
  return typeof host.MediaStreamTrackProcessor === 'function' ? host.MediaStreamTrackProcessor : null;
}

class WorkerPoseDetector implements PoseDetector {
  readonly kind = 'worker' as const;
  private pending: ((result: PoseResultMsg | null) => void) | null = null;
  private pendingEye: 'left' | 'right' | null = null;
  private clone: MediaStreamTrack | null = null;
  onPush: ((result: PoseResultMsg) => void) | null = null;
  onStreamEnd: (() => void) | null = null;
  constructor(private worker: Worker, readonly delegate: Delegate, private log: (m: string) => void) {
    worker.onmessage = (ev: MessageEvent<FromPoseWorker>) => {
      const message = ev.data;
      if (message.type === 'pose') {
        if (this.pending && this.pendingEye === message.eye) this.resolve(message);
        else this.onPush?.(message);
      } else if (message.type === 'dropped') this.resolve(null);
      else if (message.type === 'error') {
        this.log(`Pose: ${message.message}`);
        if (message.message.startsWith('stream:')) {
          this.onStreamEnd?.();
          this.onStreamEnd = null;
        }
        this.resolve(null);
      }
    };
  }
  private resolve(result: PoseResultMsg | null) {
    const pending = this.pending;
    this.pending = null;
    this.pendingEye = null;
    pending?.(result);
  }
  async detect(video: HTMLVideoElement, timestamp: number, captureTime: number | null, eye: 'left' | 'right' = 'left'): Promise<PoseResultMsg | null> {
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
      return true;
    } catch (error) {
      this.log(`Pose: MediaStreamTrackProcessor no usable: ${(error as Error).message}`);
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

class MainPoseDetector implements PoseDetector {
  readonly kind = 'main-thread' as const;
  private lastTs = -1;
  private busy = false;
  constructor(private handle: PoseHandle) {}
  get delegate() { return this.handle.delegate; }
  async detect(video: HTMLVideoElement, timestamp: number, captureTime: number | null, eye: 'left' | 'right' = 'left'): Promise<PoseResultMsg | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const ts = Math.max(timestamp, this.lastTs + 1);
      this.lastTs = ts;
      const t0 = performance.now();
      const detected = this.handle.landmarker.detectForVideo(video, ts);
      return {
        type: 'pose',
        timestamp,
        captureTime,
        eye,
        inferMs: performance.now() - t0,
        width: video.videoWidth,
        height: video.videoHeight,
        droppedBefore: 0,
        bodies: packPoseResult(detected),
      };
    } finally {
      this.busy = false;
    }
  }
  attachTrack(): boolean { return false; }
  setCapHz(): void { /* el bucle aplica el tope */ }
  dispose() { this.handle.landmarker.close(); }
}

export function isWorkerPose(detector: PoseDetector): detector is WorkerPoseDetector {
  return detector.kind === 'worker';
}

export async function createPoseDetector(opts: {
  preferWorker: boolean;
  preferGPU: boolean;
  variant: 'lite' | 'full';
  numPoses: number;
  log: (m: string) => void;
}): Promise<PoseDetector> {
  const init = { ...paths(opts.variant), preferGPU: opts.preferGPU, numPoses: opts.numPoses };
  if (opts.preferWorker && typeof Worker !== 'undefined' && typeof createImageBitmap === 'function') {
    try {
      const worker = new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' });
      const detector = await new Promise<PoseDetector>((resolve, reject) => {
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('Timeout del worker de pose')); }, 30000);
        worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message || 'Error en el worker de pose')); };
        worker.onmessage = (ev: MessageEvent<FromPoseWorker>) => {
          const message = ev.data;
          if (message.type === 'ready') {
            clearTimeout(timer);
            worker.onerror = null;
            resolve(new WorkerPoseDetector(worker, message.delegate, opts.log));
          } else if (message.type === 'error' && message.fatal) {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error(message.message));
          }
        };
        worker.postMessage({ type: 'init', ...init });
      });
      return detector;
    } catch (error) {
      opts.log(`Worker de pose no disponible (${(error as Error).message}); uso el hilo principal.`);
    }
  }
  const handle = await createPoseLandmarker({ ...init, inWorker: false, log: opts.log });
  return new MainPoseDetector(handle);
}
