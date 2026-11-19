import { STEREO_MAX_DELTA_MS } from '../scene/align-math';
import type { FaceDetector } from './detector';
import { isWorkerDetector } from './detector';
import type { ResultMsg } from './protocol';

export interface PumpOptions {
  detector: FaceDetector;
  video: HTMLVideoElement;
  right: HTMLVideoElement | null;
  capHz: () => number;
  stereo: () => boolean;
  onResult: (result: ResultMsg) => void;
  onCameraFrame: () => void;
  onDrop: (count: number) => void;
  log: (message: string) => void;
}

/** Cadencia de inferencia por requestVideoFrameCallback o por el stream del worker. Nunca desde el rAF de XR. */
export function startInferencePump(opts: PumpOptions): () => void {
  let stopped = false;
  let inflight = false;
  let lastStart = 0;
  let lastSentCap = opts.capHz();
  let lastRightCapture: number | null = null;
  let lastCapture: number | null = null;
  const track = opts.video.srcObject instanceof MediaStream ? opts.video.srcObject.getVideoTracks()[0] : null;
  let useBitmap = !(track && isWorkerDetector(opts.detector) && opts.detector.attachTrack(track, opts.capHz()));
  if (!useBitmap) opts.log('Inferencia por MediaStreamTrackProcessor en el worker.');
  else opts.log(opts.detector.kind === 'worker' ? 'Inferencia por ImageBitmap en el worker.' : 'Inferencia en el hilo principal, fuera del frame de XR.');

  if (isWorkerDetector(opts.detector)) {
    opts.detector.onPush = (result) => deliver(result);
    opts.detector.onStreamEnd = () => {
      if (useBitmap) return;
      useBitmap = true;
      opts.log('El stream del worker se cortó. Sigo con ImageBitmap.');
    };
    opts.detector.setCapHz(opts.capHz());
  }

  function deliver(result: ResultMsg): void {
    if (stopped || result.eye !== 'left') return;
    if (result.captureTime == null) result.captureTime = lastCapture;
    if (result.droppedBefore) opts.onDrop(result.droppedBefore);
    opts.onResult(result);
    maybeRight(result);
  }

  function maybeRight(left: ResultMsg): void {
    const right = opts.right;
    if (!opts.stereo() || !right || right.readyState < 2 || left.captureTime == null) return;
    const rightCapture = lastRightCapture;
    if (rightCapture == null || Math.abs(rightCapture - left.captureTime) >= STEREO_MAX_DELTA_MS) return;
    if (inflight) return;
    inflight = true;
    void opts.detector.detect(right, performance.now(), rightCapture, 'right').then((result) => {
      inflight = false;
      if (result) opts.onResult(result);
    }).catch(() => { inflight = false; });
  }

  const watch = (video: HTMLVideoElement, onFrame: (capture: number | null) => void) => {
    let handle = 0;
    const loop: VideoFrameRequestCallback = (_now, meta) => {
      if (stopped) return;
      onFrame(meta.captureTime ?? null);
      handle = video.requestVideoFrameCallback(loop);
    };
    handle = video.requestVideoFrameCallback(loop);
    return () => video.cancelVideoFrameCallback(handle);
  };

  const stopLeft = watch(opts.video, (capture) => {
    opts.onCameraFrame();
    if (capture != null) lastCapture = capture;
    if (isWorkerDetector(opts.detector)) {
      const cap = opts.capHz();
      if (cap !== lastSentCap) {
        opts.detector.setCapHz(cap);
        lastSentCap = cap;
      }
    }
    if (!useBitmap) return;
    const now = performance.now();
    const gap = 1000 / Math.max(1, opts.capHz());
    if (inflight || now - lastStart < gap) {
      opts.onDrop(1);
      return;
    }
    inflight = true;
    lastStart = now;
    // setTimeout cede el frame actual: detectForVideo del hilo principal no corre dentro del rAF de XR.
    setTimeout(() => {
      if (stopped) { inflight = false; return; }
      void opts.detector.detect(opts.video, performance.now(), capture, 'left').then((result) => {
        inflight = false;
        if (result) deliver(result);
      }).catch(() => { inflight = false; });
    }, 0);
  });

  const stopRight = opts.right ? watch(opts.right, (capture) => { lastRightCapture = capture; }) : () => {};

  return () => {
    stopped = true;
    stopLeft();
    stopRight();
    if (isWorkerDetector(opts.detector)) {
      opts.detector.onPush = null;
      opts.detector.onStreamEnd = null;
    }
  };
}
