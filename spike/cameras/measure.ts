import { matchRate, pairSeries, type DeltaStats, type SeriesPair } from './stats';

export const MEASURE_MS = 10_000;
export const PAIR_WINDOW_MS = 50;

export interface ErrorInfo {
  name: string;
  message: string;
}

export function errorInfo(error: unknown): ErrorInfo {
  if (error instanceof Error) return { name: error.name || 'Error', message: error.message };
  return { name: 'Error', message: String(error) };
}

export function isConstraintError(error: unknown): boolean {
  const name = errorInfo(error).name;
  return name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError';
}

export type EyeGuess = 'left' | 'right' | 'avatar' | 'back' | 'other';

export interface ListedDevice {
  label: string;
  deviceId: string;
  groupId: string;
  guess: EyeGuess;
  cameraNumber: number | null;
}

/** Número final de etiquetas "camera 1, facing back" o "camera 2 1, facing back". */
export function cameraNumber(label: string): number | null {
  const match = /camera\s+(?:\d+\s+)?(\d+)\s*,/i.exec(label);
  return match ? Number(match[1]) : null;
}

export function guessRole(label: string): EyeGuess {
  const text = label.toLowerCase();
  if (/facing front|\bavatar\b|selfie/.test(text)) return 'avatar';
  if (/facing back/.test(text)) {
    if (/\bleft\b|izquierda/.test(text)) return 'left';
    if (/\bright\b|derecha/.test(text)) return 'right';
    const number = cameraNumber(label);
    if (number === 1) return 'left';
    if (number === 2) return 'right';
    return 'back';
  }
  if (/\bleft\b|izquierda/.test(text)) return 'left';
  if (/\bright\b|derecha/.test(text)) return 'right';
  return 'other';
}

export function listVideoInputs(devices: MediaDeviceInfo[]): ListedDevice[] {
  return devices
    .filter((device) => device.kind === 'videoinput')
    .map((device) => ({
      label: device.label,
      deviceId: device.deviceId,
      groupId: device.groupId,
      guess: guessRole(device.label),
      cameraNumber: cameraNumber(device.label),
    }));
}

export function pickEyes(devices: ListedDevice[]): { left: ListedDevice | null; right: ListedDevice | null; note: string } {
  const left = devices.filter((device) => device.guess === 'left');
  const right = devices.filter((device) => device.guess === 'right');
  const unnamed = devices.filter((device) => device.guess === 'back');
  if (left.length === 1 && right.length === 1) {
    return { left: left[0], right: right[0], note: 'Izquierda = camera 1 / left. Derecha = camera 2 / right.' };
  }
  if (left.length === 1 && right.length === 0 && unnamed.length === 1) {
    return { left: left[0], right: unnamed[0], note: 'Una etiqueta era izquierda. La otra facing back se tomó como derecha.' };
  }
  if (right.length === 1 && left.length === 0 && unnamed.length === 1) {
    return { left: unnamed[0], right: right[0], note: 'Una etiqueta era derecha. La otra facing back se tomó como izquierda.' };
  }
  const backs = [...left, ...right, ...unnamed].sort(
    (a, b) => (a.cameraNumber ?? 999) - (b.cameraNumber ?? 999) || a.label.localeCompare(b.label),
  );
  if (backs.length >= 2) {
    return {
      left: backs[0],
      right: backs[backs.length - 1],
      note: 'Sin par left/right claro. El número de cámara menor es la izquierda y el mayor la derecha.',
    };
  }
  if (backs.length === 1) return { left: backs[0], right: null, note: 'Solo hay una cámara facing back.' };
  return { left: null, right: null, note: 'No hay cámaras facing back (passthrough). Si aparece una facing front, es la del avatar.' };
}

export interface ConstraintAttempt {
  id: string;
  video: MediaTrackConstraints;
}

export const OPEN_ATTEMPTS: ConstraintAttempt[] = [
  { id: '1280x960@60', video: { width: { exact: 1280 }, height: { exact: 960 }, frameRate: { exact: 60 } } },
  { id: '1280x960@30', video: { width: { exact: 1280 }, height: { exact: 960 }, frameRate: { exact: 30 } } },
  { id: '640x480', video: { width: { exact: 640 }, height: { exact: 480 } } },
  { id: 'max', video: {} },
];

export function rateAttempts(fps: number): ConstraintAttempt[] {
  return [
    { id: `${fps}-exact-1280x960`, video: { width: { exact: 1280 }, height: { exact: 960 }, frameRate: { exact: fps } } },
    { id: `${fps}-ideal-1280x960`, video: { width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: fps } } },
    { id: `${fps}-solo-fps`, video: { frameRate: { ideal: fps } } },
  ];
}

export interface FrameStamp {
  receivedAt: number;
  captureTime: number | null;
  mediaTimeMs: number | null;
  presentationTime: number;
  expectedDisplayTime: number;
  presentedFrames: number;
  width: number;
  height: number;
}

export function watchFrames(video: HTMLVideoElement): { stamps: FrameStamp[]; stop: () => void } {
  const stamps: FrameStamp[] = [];
  let stopped = false;
  let handle = 0;
  const onFrame: VideoFrameRequestCallback = (_now, meta) => {
    if (stopped) return;
    stamps.push({
      receivedAt: performance.now(),
      captureTime: meta.captureTime ?? null,
      mediaTimeMs: Number.isFinite(meta.mediaTime) ? meta.mediaTime * 1000 : null,
      presentationTime: meta.presentationTime,
      expectedDisplayTime: meta.expectedDisplayTime,
      presentedFrames: meta.presentedFrames,
      width: meta.width,
      height: meta.height,
    });
    handle = video.requestVideoFrameCallback(onFrame);
  };
  handle = video.requestVideoFrameCallback(onFrame);
  return {
    stamps,
    stop() {
      stopped = true;
      video.cancelVideoFrameCallback(handle);
    },
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function measureWindow(
  left: HTMLVideoElement,
  right: HTMLVideoElement,
  ms: number,
  signal: AbortSignal,
  onProgress?: (elapsed: number) => void,
): Promise<{ left: FrameStamp[]; right: FrameStamp[]; wallMs: number }> {
  const leftWatch = watchFrames(left);
  const rightWatch = watchFrames(right);
  const start = performance.now();
  try {
    while (performance.now() - start < ms && !signal.aborted) {
      await sleep(250, signal);
      onProgress?.(performance.now() - start);
    }
  } finally {
    leftWatch.stop();
    rightWatch.stop();
  }
  return { left: leftWatch.stamps, right: rightWatch.stamps, wallMs: performance.now() - start };
}

export interface FpsSummary {
  frames: number;
  wallMs: number;
  fps: number;
  presentedFps: number | null;
  captureTimeCoverage: number;
  size: { width: number; height: number } | null;
}

export function fpsFromStamps(stamps: FrameStamp[], wallMs: number): FpsSummary {
  const fps = wallMs > 0 ? (stamps.length * 1000) / wallMs : 0;
  let presentedFps: number | null = null;
  if (stamps.length >= 2) {
    const first = stamps[0];
    const last = stamps[stamps.length - 1];
    const dt = last.presentationTime - first.presentationTime;
    if (dt > 0) presentedFps = ((last.presentedFrames - first.presentedFrames) * 1000) / dt;
  }
  const withCapture = stamps.filter((stamp) => stamp.captureTime != null).length;
  const last = stamps[stamps.length - 1];
  return {
    frames: stamps.length,
    wallMs,
    fps,
    presentedFps,
    captureTimeCoverage: stamps.length ? withCapture / stamps.length : 0,
    size: last ? { width: last.width, height: last.height } : null,
  };
}

interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}

interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): TrackProcessor;
}

export function trackProcessorCtor(): TrackProcessorCtor | null {
  const host = globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor };
  return typeof host.MediaStreamTrackProcessor === 'function' ? host.MediaStreamTrackProcessor : null;
}

export async function collectProcessorTimestamps(
  track: MediaStreamTrack,
  ms: number,
  signal: AbortSignal,
): Promise<{ available: boolean; error: ErrorInfo | null; timestampsMs: number[] }> {
  const Ctor = trackProcessorCtor();
  if (!Ctor) return { available: false, error: null, timestampsMs: [] };
  const clone = track.clone();
  const timestampsMs: number[] = [];
  let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  let timer = 0;
  try {
    reader = new Ctor({ track: clone }).readable.getReader();
    const deadline = performance.now() + ms;
    timer = window.setTimeout(() => {
      void reader?.cancel().catch(() => {});
    }, ms);
    while (!signal.aborted && performance.now() < deadline) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      timestampsMs.push(value.timestamp / 1000);
      value.close();
    }
    return { available: true, error: null, timestampsMs };
  } catch (error) {
    const info = errorInfo(error);
    if (info.name === 'AbortError') return { available: true, error: null, timestampsMs };
    return { available: true, error: info, timestampsMs };
  } finally {
    clearTimeout(timer);
    try { await reader?.cancel(); } catch { /* el reader ya se cerró */ }
    clone.stop();
  }
}

export interface ClockReport {
  clock: string;
  leftFrames: number;
  rightFrames: number;
  sharedOrigin: boolean;
  used: 'nearest' | 'relativeToFirstFrame';
  pair: SeriesPair;
  chosen: DeltaStats;
}

export function clockReport(clock: string, left: number[], right: number[]): ClockReport {
  const pair = pairSeries(left, right, PAIR_WINDOW_MS);
  const nearestRate = matchRate(pair.nearest, left.length, right.length);
  const used = nearestRate >= 0.5 || left.length === 0 || right.length === 0 ? 'nearest' : 'relativeToFirstFrame';
  return {
    clock,
    leftFrames: left.length,
    rightFrames: right.length,
    sharedOrigin: nearestRate >= 0.5,
    used,
    pair,
    chosen: used === 'nearest' ? pair.nearest : pair.relativeToFirstFrame,
  };
}

function finite(stamps: FrameStamp[], pick: (stamp: FrameStamp) => number | null): number[] {
  return stamps
    .map(pick)
    .filter((value): value is number => value != null && Number.isFinite(value));
}

export function clocksFromStamps(left: FrameStamp[], right: FrameStamp[]): ClockReport[] {
  return [
    clockReport('captureTime', finite(left, (stamp) => stamp.captureTime), finite(right, (stamp) => stamp.captureTime)),
    clockReport('mediaTime', finite(left, (stamp) => stamp.mediaTimeMs), finite(right, (stamp) => stamp.mediaTimeMs)),
    clockReport('presentationTime', finite(left, (stamp) => stamp.presentationTime), finite(right, (stamp) => stamp.presentationTime)),
    clockReport('expectedDisplayTime', finite(left, (stamp) => stamp.expectedDisplayTime), finite(right, (stamp) => stamp.expectedDisplayTime)),
  ];
}

export function preferredClock(clocks: ClockReport[]): ClockReport | null {
  const capture = clocks.find((clock) => clock.clock === 'captureTime' && clock.leftFrames > 0 && clock.rightFrames > 0);
  if (capture) return capture;
  return clocks.find((clock) => clock.leftFrames > 0 && clock.rightFrames > 0) ?? clocks[0] ?? null;
}

export async function queryPermission(name: string): Promise<{ name: string; state?: PermissionState; error?: ErrorInfo }> {
  try {
    const status = await navigator.permissions.query({ name: name as PermissionName });
    return { name, state: status.state };
  } catch (error) {
    return { name, error: errorInfo(error) };
  }
}

export function plain(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export function trackDump(track: MediaStreamTrack): {
  label: string;
  readyState: MediaStreamTrackState;
  muted: boolean;
  settings: unknown;
  capabilities: unknown;
  constraints: unknown;
  settingKeys: string[];
} {
  const settings = track.getSettings();
  return {
    label: track.label,
    readyState: track.readyState,
    muted: track.muted,
    settings: plain(settings),
    capabilities: plain(track.getCapabilities()),
    constraints: plain(track.getConstraints()),
    settingKeys: Object.keys(settings),
  };
}

const INTEREST = /focal|principal|intrinsic|extrinsic|lens|pose|distort|baseline|fov|projection/i;

export function interestingNames(value: object | null | undefined): string[] {
  if (!value) return [];
  const found: string[] = [];
  const seen = new Set<object>();
  let current: object | null = value;
  while (current && current !== Object.prototype && !seen.has(current)) {
    seen.add(current);
    for (const name of Object.getOwnPropertyNames(current)) {
      if (INTEREST.test(name)) found.push(name);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return found;
}

export const PROBE_KEYS = [
  'focalLength',
  'focalLengthX',
  'focalLengthY',
  'principalPoint',
  'principalPointX',
  'principalPointY',
  'lensPoseTranslation',
  'lensPoseRotation',
  'cameraPosition',
  'intrinsicMatrix',
  'distortionCoefficients',
] as const;

export function probeKeys(value: object): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PROBE_KEYS) out[key] = key in record ? plain(record[key]) : null;
  return out;
}
