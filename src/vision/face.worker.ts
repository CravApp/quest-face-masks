// Web Worker de inferencia. No corre en el requestAnimationFrame de WebXR.
// Acepta ImageBitmap o un ReadableStream de VideoFrame (MediaStreamTrackProcessor).
import { createLandmarker, packResult, type LandmarkerHandle } from './landmarker';
import type { FromWorker, ToWorker } from './protocol';

let handle: LandmarkerHandle | null = null;
let lastTs = -1;
let busy = false;
let capHz = 20;
let lastInferAt = 0;
let skipped = 0;
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;

function send(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

function captureFromFrame(frame: VideoFrame): number | null {
  const ms = frame.timestamp / 1000;
  return Math.abs(performance.now() - ms) < 5000 ? ms : null;
}

/** Devuelve false si el tope de Hz descartó el fotograma. El llamador cierra el frame. */
async function infer(source: TexImageSource, width: number, height: number, captureTime: number | null, eye: 'left' | 'right'): Promise<boolean> {
  if (!handle) throw new Error('Worker no inicializado');
  const now = performance.now();
  if (now - lastInferAt < 1000 / Math.max(1, capHz)) {
    skipped++;
    return false;
  }
  lastInferAt = now;
  const ts = Math.max(now, lastTs + 1);
  lastTs = ts;
  const t0 = performance.now();
  let detected;
  try {
    detected = handle.landmarker.detectForVideo(source, ts);
  } catch (error) {
    if (!(source instanceof VideoFrame)) throw error;
    const bitmap = await createImageBitmap(source);
    try {
      detected = handle.landmarker.detectForVideo(bitmap, ts);
      width = bitmap.width;
      height = bitmap.height;
    } finally {
      bitmap.close();
    }
  }
  const packed = packResult(detected, ts, performance.now() - t0, width, height, captureTime, eye, skipped);
  skipped = 0;
  send(packed, packed.landmarks ? [packed.landmarks.buffer] : []);
  return true;
}

async function readStream(readable: ReadableStream<VideoFrame>): Promise<void> {
  reader = readable.getReader();
  let queued: VideoFrame | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (busy) {
        queued?.close();
        queued = value;
        continue;
      }
      busy = true;
      let frame: VideoFrame | null = value;
      try {
        while (frame) {
          const current = frame;
          frame = queued;
          queued = null;
          try {
            await infer(current, current.displayWidth, current.displayHeight, captureFromFrame(current), 'left');
          } catch (error) {
            send({ type: 'error', message: `stream: ${(error as Error).message}`, fatal: false });
          } finally {
            current.close();
          }
        }
      } finally {
        busy = false;
      }
    }
  } catch (error) {
    send({ type: 'error', message: `stream: ${(error as Error).message}`, fatal: false });
  }
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    try {
      handle = await createLandmarker({ ...msg, inWorker: true });
      send({ type: 'ready', delegate: handle.delegate });
    } catch (error) {
      send({ type: 'error', message: (error as Error)?.message ?? String(error), fatal: true });
    }
    return;
  }
  if (msg.type === 'cap') {
    capHz = msg.capHz;
    return;
  }
  if (msg.type === 'stream') {
    capHz = msg.capHz;
    void readStream(msg.readable);
    return;
  }
  if (msg.type === 'frame') {
    const { bitmap } = msg;
    if (busy) {
      bitmap.close();
      send({ type: 'dropped' });
      return;
    }
    busy = true;
    try {
      await infer(bitmap, bitmap.width, bitmap.height, msg.captureTime, msg.eye);
    } catch (error) {
      send({ type: 'error', message: (error as Error)?.message ?? String(error), fatal: false });
    } finally {
      bitmap.close();
      busy = false;
    }
  }
};
