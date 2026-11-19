import { isWorkerPose, type PoseDetector } from './pose-detector';
import type { PoseResultMsg } from './pose-protocol';

export interface PosePumpOptions {
  detector: PoseDetector;
  video: HTMLVideoElement;
  capHz: () => number;
  onResult: (result: PoseResultMsg) => void;
  onCameraFrame?: () => void;
  onDrop: (count: number) => void;
  log: (message: string) => void;
}

/** Misma cadencia que la cara, en su propio worker. No toca el rAF de XR. */
export function startPosePump(opts: PosePumpOptions): () => void {
  let stopped = false;
  let inflight = false;
  let lastStart = 0;
  let lastSentCap = opts.capHz();
  let lastCapture: number | null = null;
  const track = opts.video.srcObject instanceof MediaStream ? opts.video.srcObject.getVideoTracks()[0] : null;
  let useBitmap = !(track && isWorkerPose(opts.detector) && opts.detector.attachTrack(track, opts.capHz()));
  opts.log(useBitmap
    ? `Pose por ${opts.detector.kind === 'worker' ? 'ImageBitmap' : 'hilo principal'}, fuera del frame de XR.`
    : 'Pose por MediaStreamTrackProcessor en su worker.');

  if (isWorkerPose(opts.detector)) {
    opts.detector.onPush = (result) => deliver(result);
    opts.detector.onStreamEnd = () => {
      if (useBitmap) return;
      useBitmap = true;
      opts.log('El stream de pose se cortó. Sigo con ImageBitmap.');
    };
    opts.detector.setCapHz(opts.capHz());
  }

  function deliver(result: PoseResultMsg): void {
    if (stopped || result.eye !== 'left') return;
    if (result.captureTime == null) result.captureTime = lastCapture;
    if (result.droppedBefore) opts.onDrop(result.droppedBefore);
    opts.onResult(result);
  }

  let handle = 0;
  const loop: VideoFrameRequestCallback = (_now, meta) => {
    if (stopped) return;
    opts.onCameraFrame?.();
    if (meta.captureTime != null) lastCapture = meta.captureTime;
    if (isWorkerPose(opts.detector)) {
      const cap = opts.capHz();
      if (cap !== lastSentCap) {
        opts.detector.setCapHz(cap);
        lastSentCap = cap;
      }
    }
    if (!useBitmap) {
      handle = opts.video.requestVideoFrameCallback(loop);
      return;
    }
    const now = performance.now();
    const gap = 1000 / Math.max(1, opts.capHz());
    if (inflight || now - lastStart < gap) {
      opts.onDrop(1);
      handle = opts.video.requestVideoFrameCallback(loop);
      return;
    }
    inflight = true;
    lastStart = now;
    const capture = meta.captureTime ?? null;
    setTimeout(() => {
      if (stopped) { inflight = false; return; }
      void opts.detector.detect(opts.video, performance.now(), capture, 'left').then((result) => {
        inflight = false;
        if (result) deliver(result);
      }).catch(() => { inflight = false; });
    }, 0);
    handle = opts.video.requestVideoFrameCallback(loop);
  };
  handle = opts.video.requestVideoFrameCallback(loop);

  return () => {
    stopped = true;
    opts.video.cancelVideoFrameCallback(handle);
    if (isWorkerPose(opts.detector)) {
      opts.detector.onPush = null;
      opts.detector.onStreamEnd = null;
    }
  };
}
