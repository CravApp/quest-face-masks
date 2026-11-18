import { debugReport, installRemoteDebug } from '../../src/debug/remote';
import { NATIVE_QUEST3_FACTORY, RESEARCH } from './intrinsics';
import {
  MEASURE_MS,
  OPEN_ATTEMPTS,
  clocksFromStamps,
  clockReport,
  collectProcessorTimestamps,
  errorInfo,
  fpsFromStamps,
  interestingNames,
  isConstraintError,
  listVideoInputs,
  measureWindow,
  pickEyes,
  plain,
  probeKeys,
  queryPermission,
  rateAttempts,
  sleep,
  trackDump,
  watchFrames,
  type ClockReport,
  type ConstraintAttempt,
  type ErrorInfo,
  type FrameStamp,
  type ListedDevice,
} from './measure';
import { quantile, type DeltaStats } from './stats';
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision';

installRemoteDebug();

type Verdict = 'pass' | 'fail' | 'partial' | 'info';

interface StepResult {
  verdict: Verdict;
  headline: string;
  detail: string;
  [key: string]: unknown;
}

const MODEL_CDN = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const AR_MS = 12_000;
const PERMISSION_NAMES = ['camera', 'headset-camera', 'xr-spatial-tracking'];

const live = el<HTMLElement>('live');
const env = el<HTMLElement>('env');
const videoLeft = el<HTMLVideoElement>('video-left');
const videoRight = el<HTMLVideoElement>('video-right');
const preview = el<HTMLCanvasElement>('preview');
const previewCtx = preview.getContext('2d');
const mpCanvas = el<HTMLCanvasElement>('mp');
const xrCanvas = el<HTMLCanvasElement>('xr');

const cameraEvents: unknown[] = [];
const report: Record<string, unknown> = {
  spike: 'quest-browser-passthrough-cameras',
  startedAt: new Date().toISOString(),
  href: location.href,
  secureContext: window.isSecureContext,
  remoteLog: new URLSearchParams(location.search).get('log'),
  nativeFactory: NATIVE_QUEST3_FACTORY,
  research: RESEARCH,
  cameraEvents,
  steps: {} as Record<string, StepResult>,
};

let leftStream: MediaStream | null = null;
let rightStream: MediaStream | null = null;
let leftDevice: ListedDevice | null = null;
let rightDevice: ListedDevice | null = null;
let openAttempt = '';
let busy = false;
let runAbort = new AbortController();
let xrSession: XRSession | null = null;
let pose: PoseLandmarker | null = null;
let poseConnections: { start: number; end: number }[] = [];
let lastLandmarks: NormalizedLandmark[] | null = null;
let lastEye: 'left' | 'right' = 'left';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Falta #${id}`);
  return node as T;
}

function n(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '–';
  return new Intl.NumberFormat('es', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function show(step: string, result: StepResult): void {
  const verdict = el<HTMLElement>(`verdict-${step}`);
  verdict.className = `verdict ${result.verdict}`;
  verdict.textContent = result.headline;
  el<HTMLElement>(`out-${step}`).textContent = result.detail;
  (report.steps as Record<string, StepResult>)[step] = result;
  publish(step, result.headline, result, result.verdict === 'fail' ? 'error' : 'info');
}

function publish(step: string, message: string, data: unknown, level: 'info' | 'warn' | 'error' = 'info'): void {
  debugReport({ kind: 'spike-cameras', level, message: `${step}: ${message}`, data });
}

function progress(text: string): void {
  live.textContent = text;
}

function mediaBlock(): ErrorInfo | null {
  if (!window.isSecureContext) return { name: 'SecurityError', message: 'Hace falta HTTPS o http://localhost.' };
  if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices.getUserMedia) {
    return { name: 'NotSupportedError', message: 'Este navegador no expone navigator.mediaDevices.' };
  }
  return null;
}

function asset(path: string): string {
  return new URL(path, new URL(import.meta.env.BASE_URL, location.href)).href;
}

function shortId(id: string): string {
  return id ? `${id.slice(0, 8)}…` : '(vacío)';
}

function deviceLine(device: ListedDevice, index: number): string {
  const label = device.label || '(sin etiqueta)';
  return `${index + 1}. «${label}» id ${shortId(device.deviceId)} grupo ${shortId(device.groupId)} → ${device.guess}`;
}

function rangeText(value: unknown): string {
  if (value == null) return '–';
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (typeof value === 'object' && 'min' in value && 'max' in value) {
    const range = value as { min: unknown; max: unknown };
    return `${String(range.min)}…${String(range.max)}`;
  }
  return JSON.stringify(value);
}

function settingsLine(dump: ReturnType<typeof trackDump>): string {
  const settings = dump.settings as { width?: number; height?: number; frameRate?: number; facingMode?: string };
  const caps = dump.capabilities as Record<string, unknown>;
  return [
    `${dump.label || '(sin etiqueta)'} ${settings.width ?? '–'}×${settings.height ?? '–'} @ ${settings.frameRate != null ? n(settings.frameRate, 1) : '–'} fps · facing ${settings.facingMode ?? '–'} · ${dump.readyState}`,
    `  caps ancho ${rangeText(caps.width)} alto ${rangeText(caps.height)} fps ${rangeText(caps.frameRate)} facing ${rangeText(caps.facingMode)} resize ${rangeText(caps.resizeMode)}`,
  ].join('\n');
}

function nativeText(): string {
  const lines = NATIVE_QUEST3_FACTORY.cameras.map((camera) => {
    const [x, y, z] = camera.translationM;
    const eye = camera.eye === 'left' ? 'Izquierda' : 'Derecha';
    return `${eye} (Camera2 ${camera.camera2Id}): fx=fy=${camera.fx} cx=${camera.cx} cy=${camera.cy} t=[${x}, ${y}, ${z}] m`;
  });
  return [
    'Respaldo nativo Camera2 (no es una medida de esta página, sensor 1728×1728):',
    ...lines,
    `Línea base ${NATIVE_QUEST3_FACTORY.baselineM} m, rotación relativa ${NATIVE_QUEST3_FACTORY.relativeRotationDeg}°, sin coeficientes de distorsión.`,
    'Si el stream no es 1728×1728, hay que conocer el recorte antes de triangular.',
  ].join('\n');
}

function formatDelta(clock: ClockReport | null): string {
  if (!clock || !clock.chosen.pairs) return 'Sin pares.';
  const stats = clock.chosen;
  const origin = clock.sharedOrigin ? 'reloj compartido' : 'relojes normalizados al primer fotograma';
  return `${clock.clock} (${origin}): ${stats.pairs} pares, mediana ${n(stats.medianMs, 2)} ms, p95 |Δ| ${n(stats.p95AbsMs, 2)} ms, p95 con signo ${n(stats.p95SignedMs, 2)} ms, |Δ|<1 ms ${n(stats.pctAbsUnder1Ms, 1)} %.`;
}

function chooseClock(clocks: ClockReport[]): ClockReport | null {
  const order = ['captureTime', 'mediaTime', 'presentationTime', 'expectedDisplayTime', 'processorTimestamp'];
  for (const name of order) {
    const clock = clocks.find((item) => item.clock === name && item.leftFrames > 0 && item.rightFrames > 0);
    if (clock) return clock;
  }
  return null;
}

function syncVerdict(stats: DeltaStats, requestedFps: number, sharedOrigin: boolean): Verdict {
  if (!stats.pairs) return 'fail';
  const pct = stats.pctAbsUnder1Ms ?? 0;
  const p95 = stats.p95AbsMs ?? Infinity;
  const median = stats.medianMs == null ? Infinity : Math.abs(stats.medianMs);
  let verdict: Verdict;
  if (requestedFps >= 45) {
    if (pct >= 95 && median < 1) verdict = 'pass';
    else if (pct >= 50 || p95 <= 2) verdict = 'partial';
    else verdict = 'fail';
  } else if (pct >= 95 || p95 <= 20) verdict = 'pass';
  else if (p95 <= 34) verdict = 'partial';
  else verdict = 'fail';
  if (!sharedOrigin && verdict === 'pass') return 'partial';
  return verdict;
}

function worst(a: Verdict, b: Verdict): Verdict {
  const rank: Record<Verdict, number> = { pass: 0, info: 1, partial: 2, fail: 3 };
  return rank[a] >= rank[b] ? a : b;
}

async function enumerateAll(): Promise<{ all: { kind: string; label: string; deviceId: string; groupId: string }[]; video: ListedDevice[] }> {
  const list = await navigator.mediaDevices.enumerateDevices();
  return {
    all: list.map((device) => ({ kind: device.kind, label: device.label, deviceId: device.deviceId, groupId: device.groupId })),
    video: listVideoInputs(list),
  };
}

async function probePermission(): Promise<{ attempts: { id: string; ok: boolean; error?: ErrorInfo }[]; granted: boolean }> {
  const probes: { id: string; video: boolean | MediaTrackConstraints }[] = [
    { id: 'ideal-environment', video: { facingMode: { ideal: 'environment' } } },
    { id: 'video-true', video: true },
  ];
  const attempts: { id: string; ok: boolean; error?: ErrorInfo }[] = [];
  for (const probe of probes) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: probe.video });
      stream.getTracks().forEach((track) => track.stop());
      attempts.push({ id: probe.id, ok: true });
      return { attempts, granted: true };
    } catch (error) {
      const info = errorInfo(error);
      attempts.push({ id: probe.id, ok: false, error: info });
      if (!isConstraintError(error) && info.name !== 'NotFoundError') return { attempts, granted: false };
    }
  }
  return { attempts, granted: false };
}

async function capabilitiesFor(devices: ListedDevice[], signal: AbortSignal): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (const device of devices) {
    if (signal.aborted) break;
    if (!device.deviceId) {
      rows.push({ ...device, error: { name: 'NoDeviceId', message: 'Sin deviceId.' } });
      continue;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: device.deviceId } } });
      const track = stream.getVideoTracks()[0];
      const dump = track ? trackDump(track) : null;
      stream.getTracks().forEach((item) => item.stop());
      rows.push({ ...device, dump });
      await sleep(80, signal);
    } catch (error) {
      rows.push({ ...device, error: errorInfo(error) });
    }
  }
  return rows;
}

function bindTrack(stream: MediaStream, eye: string): void {
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  const note = (type: string) => {
    const event = { t: new Date().toISOString(), eye, type, readyState: track.readyState, muted: track.muted, label: track.label };
    cameraEvents.push(event);
    debugReport({ kind: 'spike-cameras', level: type === 'ended' ? 'warn' : 'info', message: `pista ${eye} ${type}`, data: event });
  };
  track.addEventListener('ended', () => note('ended'));
  track.addEventListener('mute', () => note('mute'));
  track.addEventListener('unmute', () => note('unmute'));
}

async function startVideo(video: HTMLVideoElement, stream: MediaStream): Promise<ErrorInfo | null> {
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    return null;
  } catch (error) {
    return errorInfo(error);
  }
}

function stopOpened(): void {
  leftStream?.getTracks().forEach((track) => track.stop());
  rightStream?.getTracks().forEach((track) => track.stop());
  leftStream = null;
  rightStream = null;
  videoLeft.srcObject = null;
  videoRight.srcObject = null;
}

async function adopt(left: MediaStream, right: MediaStream, attempt: string): Promise<ErrorInfo[]> {
  const previous = [leftStream, rightStream].filter((stream): stream is MediaStream => !!stream && stream !== left && stream !== right);
  leftStream = left;
  rightStream = right;
  openAttempt = attempt;
  previous.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  bindTrack(left, 'left');
  bindTrack(right, 'right');
  const errors = [await startVideo(videoLeft, left), await startVideo(videoRight, right)].filter((error): error is ErrorInfo => !!error);
  return errors;
}

async function openPair(leftId: string, rightId: string, attempts: ConstraintAttempt[], signal: AbortSignal) {
  const attemptsLog: { id: string; ok: boolean; error?: ErrorInfo }[] = [];
  for (const attempt of attempts) {
    if (signal.aborted) break;
    let left: MediaStream | null = null;
    let right: MediaStream | null = null;
    try {
      left = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...attempt.video, deviceId: { exact: leftId } } });
      right = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...attempt.video, deviceId: { exact: rightId } } });
      attemptsLog.push({ id: attempt.id, ok: true });
      publish('abrir', `par abierto con ${attempt.id}`, { attempt: attempt.id });
      return { left, right, attempt: attempt.id, attempts: attemptsLog, fatal: null as ErrorInfo | null };
    } catch (error) {
      left?.getTracks().forEach((track) => track.stop());
      right?.getTracks().forEach((track) => track.stop());
      const info = errorInfo(error);
      attemptsLog.push({ id: attempt.id, ok: false, error: info });
      publish('abrir', `${attempt.id} ${info.name}: ${info.message}`, { attempt: attempt.id, error: info }, 'warn');
      if (!isConstraintError(error)) {
        return { left: null, right: null, attempt: null as string | null, attempts: attemptsLog, fatal: info };
      }
    }
  }
  return { left: null, right: null, attempt: null as string | null, attempts: attemptsLog, fatal: null as ErrorInfo | null };
}

function liveTracks(): { eye: 'left' | 'right'; track: MediaStreamTrack }[] {
  const rows: { eye: 'left' | 'right'; track: MediaStreamTrack }[] = [];
  const left = leftStream?.getVideoTracks()[0];
  const right = rightStream?.getVideoTracks()[0];
  if (left?.readyState === 'live') rows.push({ eye: 'left', track: left });
  if (right?.readyState === 'live') rows.push({ eye: 'right', track: right });
  return rows;
}

async function ensureEyes(signal: AbortSignal): Promise<{ ok: boolean; note: string; openAttempts: unknown[] }> {
  if (liveTracks().length === 2) return { ok: true, note: 'Se reutilizan las dos cámaras ya abiertas.', openAttempts: [] };
  stopOpened();
  let listed = await enumerateAll();
  if (listed.video.every((device) => !device.label)) {
    const probe = await probePermission();
    if (!probe.granted) {
      return { ok: false, note: probe.attempts.map((item) => item.error ? `${item.id} ${item.error.name}` : item.id).join(' · ') || 'Sin permiso.', openAttempts: probe.attempts };
    }
    await sleep(100, signal);
    listed = await enumerateAll();
  }
  const picked = pickEyes(listed.video);
  leftDevice = picked.left;
  rightDevice = picked.right;
  if (!picked.left?.deviceId || !picked.right?.deviceId) return { ok: false, note: picked.note, openAttempts: [] };
  const opened = await openPair(picked.left.deviceId, picked.right.deviceId, OPEN_ATTEMPTS, signal);
  if (!opened.left || !opened.right || !opened.attempt) {
    return { ok: false, note: opened.fatal ? `${opened.fatal.name}: ${opened.fatal.message}` : 'Ningún modo abrió las dos cámaras.', openAttempts: opened.attempts };
  }
  const playErrors = await adopt(opened.left, opened.right, opened.attempt);
  return { ok: true, note: `${picked.note} Modo ${opened.attempt}.`, openAttempts: opened.attempts.concat(playErrors.map((error) => ({ id: 'play', ok: false, error }))) };
}

async function stepA(signal: AbortSignal): Promise<void> {
  const blocked = mediaBlock();
  const permissions = await Promise.all(PERMISSION_NAMES.map((name) => queryPermission(name)));
  const agent = report.userAgent as { oculusBrowser?: string | null; chromium?: string | null; userAgent?: string } | null;
  if (blocked) {
    show('a', { verdict: 'fail', headline: `${blocked.name}: ${blocked.message}`, detail: `${blocked.message}\n${agent?.userAgent ?? ''}`, permissions, error: blocked });
    return;
  }
  progress('Enumerando antes del permiso…');
  const before = await enumerateAll();
  progress('Pidiendo permiso de cámara…');
  const probe = await probePermission();
  if (signal.aborted) return;
  await sleep(120, signal);
  const after = await enumerateAll();
  progress('Leyendo capacidades de cada cámara…');
  const capabilities = await capabilitiesFor(after.video, signal);
  const supported = plain(navigator.mediaDevices.getSupportedConstraints());
  const backs = after.video.filter((device) => device.guess === 'left' || device.guess === 'right' || device.guess === 'back');
  const denied = probe.attempts.some((item) => item.error?.name === 'NotAllowedError' || item.error?.name === 'PermissionDeniedError');
  let verdict: Verdict = 'pass';
  if (denied || !probe.granted) verdict = 'fail';
  else if (backs.length < 2) verdict = after.video.length ? 'partial' : 'fail';
  const headline = denied
    ? 'PERMISO DENEGADO. Sin listas útiles.'
    : `${after.video.length} videoinput tras el permiso, ${backs.length} facing back.`;
  const detail = [
    `Navegador: OculusBrowser ${agent?.oculusBrowser ?? '–'} · Chromium ${agent?.chromium ?? '–'}`,
    agent?.userAgent ?? '',
    `Permisos consultados: ${permissions.map((item) => `${item.name}=${item.state ?? item.error?.name}`).join(' · ')}`,
    '',
    `Antes del permiso (${before.video.length}):`,
    ...before.video.map(deviceLine),
    '',
    `Sondeo: ${probe.attempts.map((item) => `${item.id} ${item.ok ? 'ok' : item.error?.name}`).join(' · ')}`,
    '',
    `Después del permiso (${after.video.length}):`,
    ...after.video.map(deviceLine),
    '',
    'getCapabilities / getSettings (una cámara cada vez, luego se cierra):',
    ...capabilities.map((row) => {
      const item = row as { label?: string; guess?: string; dump?: ReturnType<typeof trackDump>; error?: ErrorInfo };
      if (item.error) return `«${item.label || '(sin etiqueta)'}» ${item.error.name}: ${item.error.message}`;
      return item.dump ? settingsLine(item.dump) : 'sin pista';
    }),
  ].join('\n');
  show('a', {
    verdict,
    headline,
    detail,
    permissions,
    before,
    probe,
    after,
    capabilities,
    supportedConstraints: supported,
    userAgent: agent,
  });
}

async function stepB(signal: AbortSignal): Promise<void> {
  const blocked = mediaBlock();
  if (blocked) {
    show('b', { verdict: 'fail', headline: `${blocked.name}: ${blocked.message}`, detail: blocked.message, error: blocked });
    return;
  }
  progress('Abriendo las dos cámaras…');
  const opened = await ensureEyes(signal);
  if (!opened.ok) {
    show('b', { verdict: 'fail', headline: opened.note, detail: `${opened.note}\n${nativeOpenHint()}`, open: opened });
    return;
  }
  progress('Midiendo fps durante 10 s…');
  const windowResult = await measureWindow(videoLeft, videoRight, MEASURE_MS, signal, (elapsed) => {
    progress(`Midiendo fps… ${n(elapsed / 1000, 0)} s de 10`);
  });
  const leftFps = fpsFromStamps(windowResult.left, windowResult.wallMs);
  const rightFps = fpsFromStamps(windowResult.right, windowResult.wallMs);
  const dumps = liveTracks().map((row) => ({ eye: row.eye, ...trackDump(row.track) }));
  const clocks = clocksFromStamps(windowResult.left, windowResult.right);
  const chosen = chooseClock(clocks);
  const minFps = Math.min(leftFps.fps, rightFps.fps);
  const fullRes = openAttempt.startsWith('1280x960');
  let verdict: Verdict = 'pass';
  if (minFps < 20) verdict = 'partial';
  if (!fullRes) verdict = worst(verdict, 'partial');
  if (leftFps.frames === 0 || rightFps.frames === 0) verdict = 'fail';
  const headline = `ABIERTAS con ${openAttempt}. Izq ${n(leftFps.fps)} fps, der ${n(rightFps.fps)} fps.`;
  const detail = [
    opened.note,
    ...dumps.map((dump) => `${dump.eye}: ${settingsLine(dump)}`),
    `Ventana ${n(windowResult.wallMs / 1000, 1)} s. fps por requestVideoFrameCallback: izq ${n(leftFps.fps)} (${leftFps.frames} fotogramas), der ${n(rightFps.fps)} (${rightFps.frames}).`,
    `fps por presentedFrames: izq ${n(leftFps.presentedFps)} der ${n(rightFps.presentedFps)}. captureTime en ${n(leftFps.captureTimeCoverage * 100, 0)} % / ${n(rightFps.captureTimeCoverage * 100, 0)} % de los fotogramas.`,
    `Vista previa de sincronía en esta tasa: ${formatDelta(chosen)}`,
    'El paso c repite la medida forzando 60 y 30.',
  ].join('\n');
  show('b', {
    verdict,
    headline,
    detail,
    open: opened,
    attempt: openAttempt,
    fps: { left: leftFps, right: rightFps },
    settings: dumps,
    syncPreview: clocks.map(publicClock),
    timestamps: { left: seriesOf(windowResult.left), right: seriesOf(windowResult.right) },
  });
}

function nativeOpenHint(): string {
  return 'Si solo aparece la cámara del avatar: Ajustes → Privacidad y seguridad → Permisos de apps → Browser → Headset cameras. Passthrough encendido y ninguna otra web usando la cámara.';
}

async function stepC(signal: AbortSignal): Promise<void> {
  const blocked = mediaBlock();
  if (blocked) {
    show('c', { verdict: 'fail', headline: `${blocked.name}: ${blocked.message}`, detail: blocked.message, error: blocked });
    return;
  }
  progress('Preparando las dos cámaras…');
  const opened = await ensureEyes(signal);
  if (!opened.ok) {
    show('c', { verdict: 'fail', headline: opened.note, detail: opened.note, open: opened });
    return;
  }
  const rates: Record<string, unknown>[] = [];
  let verdict: Verdict = 'pass';
  const headlines: string[] = [];
  for (const fps of [60, 30]) {
    if (signal.aborted) break;
    progress(`Fijando ${fps} fps…`);
    const applied = await applyRate(fps, signal);
    await sleep(400, signal);
    const dumps = liveTracks().map((row) => ({ eye: row.eye, ...trackDump(row.track) }));
    if (liveTracks().length < 2) {
      verdict = 'fail';
      headlines.push(`${fps}: no se pudo fijar`);
      rates.push({ requestedFps: fps, applied, settings: dumps, error: 'sin las dos pistas' });
      continue;
    }
    const tracks = liveTracks();
    progress(`Midiendo marcas a ${fps} fps… 0 s de 10`);
    const [windowResult, procLeft, procRight] = await Promise.all([
      measureWindow(videoLeft, videoRight, MEASURE_MS, signal, (elapsed) => progress(`Midiendo ${fps} fps… ${n(elapsed / 1000, 0)} s de 10`)),
      collectProcessorTimestamps(tracks[0].track, MEASURE_MS, signal),
      collectProcessorTimestamps(tracks[1].track, MEASURE_MS, signal),
    ]);
    const clocks = clocksFromStamps(windowResult.left, windowResult.right);
    clocks.push(clockReport('processorTimestamp', procLeft.timestampsMs, procRight.timestampsMs));
    const chosen = chooseClock(clocks);
    const leftFps = fpsFromStamps(windowResult.left, windowResult.wallMs);
    const rightFps = fpsFromStamps(windowResult.right, windowResult.wallMs);
    let rateVerdict: Verdict = chosen ? syncVerdict(chosen.chosen, fps, chosen.sharedOrigin) : 'fail';
    if (Math.min(leftFps.fps, rightFps.fps) + 10 < fps) rateVerdict = worst(rateVerdict, 'partial');
    verdict = worst(verdict, rateVerdict);
    headlines.push(`${fps}: ${n(leftFps.fps)}/${n(rightFps.fps)} fps, ${formatDelta(chosen)}`);
    rates.push({
      requestedFps: fps,
      verdict: rateVerdict,
      applied,
      settings: dumps,
      fps: { left: leftFps, right: rightFps },
      processor: { left: { available: procLeft.available, error: procLeft.error, frames: procLeft.timestampsMs.length }, right: { available: procRight.available, error: procRight.error, frames: procRight.timestampsMs.length } },
      clocks: clocks.map(publicClock),
      timestamps: {
        left: seriesOf(windowResult.left),
        right: seriesOf(windowResult.right),
        processorLeftMs: procLeft.timestampsMs,
        processorRightMs: procRight.timestampsMs,
      },
    });
  }
  const detail = [
    'Δ = marca derecha − marca izquierda. p95 |Δ| es el percentil 95 del valor absoluto. La ventana de emparejado es 50 ms.',
    'A 60 fps el nativo cae por debajo de 1 ms. A 30 fps el nativo está en 0 o ±16,7 ms (p95 |Δ| ≤ 20 ms cuenta como pasa).',
    'Si el reloj no es compartido, la mediana sale de series puestas a cero en su primer fotograma y el veredicto baja a parcial.',
    ...rates.map((rate) => {
      const clocks = (rate.clocks as ReturnType<typeof publicClock>[]) ?? [];
      return [`Pedido ${String(rate.requestedFps)} fps → ${String(rate.verdict)}`, ...clocks.map((clock) => `  ${clock.clock}: pares ${String((clock.chosen as DeltaStats).pairs)} mediana ${n((clock.chosen as DeltaStats).medianMs, 2)} p95|Δ| ${n((clock.chosen as DeltaStats).p95AbsMs, 2)} <1 ms ${n((clock.chosen as DeltaStats).pctAbsUnder1Ms, 1)} %`)].join('\n');
    }),
  ].join('\n');
  show('c', { verdict, headline: headlines.join(' '), detail, open: opened, rates });
}

async function applyRate(fps: number, signal: AbortSignal) {
  const attempts = rateAttempts(fps);
  const attemptsLog: { id: string; via: string; ok: boolean; error?: ErrorInfo }[] = [];
  const left = leftStream?.getVideoTracks()[0];
  const right = rightStream?.getVideoTracks()[0];
  if (left?.readyState === 'live' && right?.readyState === 'live') {
    for (const attempt of attempts) {
      try {
        await left.applyConstraints(attempt.video);
        await right.applyConstraints(attempt.video);
        attemptsLog.push({ id: attempt.id, via: 'applyConstraints', ok: true });
        return { ok: true, mode: attempt.id, via: 'applyConstraints', attempts: attemptsLog };
      } catch (error) {
        const info = errorInfo(error);
        attemptsLog.push({ id: attempt.id, via: 'applyConstraints', ok: false, error: info });
        publish('tasa', `${attempt.id} ${info.name}`, { fps, error: info }, 'warn');
        if (!isConstraintError(error)) break;
      }
    }
  }
  if (!leftDevice?.deviceId || !rightDevice?.deviceId) {
    return { ok: false, mode: null, via: 'reopen', attempts: attemptsLog, fatal: { name: 'NoDevice', message: 'No hay deviceId para reabrir.' } };
  }
  stopOpened();
  const opened = await openPair(leftDevice.deviceId, rightDevice.deviceId, attempts, signal);
  if (opened.left && opened.right && opened.attempt) {
    await adopt(opened.left, opened.right, opened.attempt);
    return { ok: true, mode: opened.attempt, via: 'reopen', attempts: attemptsLog.concat(opened.attempts.map((item) => ({ ...item, via: 'reopen' }))) };
  }
  return { ok: false, mode: null, via: 'reopen', attempts: attemptsLog.concat(opened.attempts.map((item) => ({ ...item, via: 'reopen' }))), fatal: opened.fatal };
}

function seriesOf(stamps: FrameStamp[]) {
  return {
    captureTime: stamps.map((stamp) => stamp.captureTime),
    mediaTimeMs: stamps.map((stamp) => stamp.mediaTimeMs),
    presentationTime: stamps.map((stamp) => stamp.presentationTime),
    expectedDisplayTime: stamps.map((stamp) => stamp.expectedDisplayTime),
  };
}

function publicClock(clock: ClockReport) {
  return {
    clock: clock.clock,
    leftFrames: clock.leftFrames,
    rightFrames: clock.rightFrames,
    sharedOrigin: clock.sharedOrigin,
    used: clock.used,
    chosen: clock.chosen,
    nearest: clock.pair.nearest,
    relativeToFirstFrame: clock.pair.relativeToFirstFrame,
  };
}

async function stepD(signal: AbortSignal): Promise<void> {
  const blocked = mediaBlock();
  const permissions = await Promise.all(PERMISSION_NAMES.map((name) => queryPermission(name)));
  const supported = mediaBlock() ? null : plain(navigator.mediaDevices.getSupportedConstraints());
  let xrSupported: Record<string, boolean | ErrorInfo> = {};
  if (!navigator.xr) xrSupported = { xr: false };
  else {
    for (const mode of ['immersive-ar', 'immersive-vr', 'inline'] as const) {
      try { xrSupported[mode] = await navigator.xr.isSessionSupported(mode); }
      catch (error) { xrSupported[mode] = errorInfo(error); }
    }
  }
  if (blocked) {
    show('d', { verdict: 'fail', headline: `${blocked.name}: ${blocked.message}`, detail: `${blocked.message}\n\n${nativeText()}`, error: blocked, nativeFactory: NATIVE_QUEST3_FACTORY });
    return;
  }
  const hadLive = liveTracks().length > 0;
  let ensureNote = '';
  const dumps: {
    eye: string;
    dump: ReturnType<typeof trackDump>;
    probe: Record<string, unknown>;
    interestingOnTrack: string[];
    interestingOnSettings: string[];
    interestingOnCapabilities: string[];
    error?: ErrorInfo;
  }[] = [];
  if (hadLive) {
    ensureNote = 'Se leen las pistas que ya estaban abiertas.';
    for (const row of liveTracks()) {
      const dump = trackDump(row.track);
      dumps.push({
        eye: row.eye,
        dump,
        probe: probeKeys(row.track.getSettings()),
        interestingOnTrack: interestingNames(row.track),
        interestingOnSettings: interestingNames(row.track.getSettings()),
        interestingOnCapabilities: interestingNames(row.track.getCapabilities()),
      });
    }
  } else {
    progress('Abriendo cada cámara para leer settings…');
    let listed = await enumerateAll();
    if (listed.video.every((device) => !device.label)) {
      const probe = await probePermission();
      ensureNote = probe.granted ? 'Permiso concedido para leer settings.' : probe.attempts.map((item) => item.error ? `${item.id} ${item.error.name}` : item.id).join(' · ');
      if (probe.granted) listed = await enumerateAll();
    } else ensureNote = 'Había etiquetas: se abre cada cámara por separado.';
    const caps = await capabilitiesFor(listed.video, signal);
    for (const row of caps) {
      const item = row as ListedDevice & { dump?: ReturnType<typeof trackDump>; error?: ErrorInfo };
      if (!item.dump) {
        dumps.push({
          eye: item.guess,
          dump: { label: item.label, readyState: 'ended', muted: false, settings: {}, capabilities: {}, constraints: {}, settingKeys: [] },
          probe: {},
          interestingOnTrack: [],
          interestingOnSettings: [],
          interestingOnCapabilities: [],
          error: item.error,
        });
        continue;
      }
      const settings = (item.dump.settings ?? {}) as object;
      const capabilities = (item.dump.capabilities ?? {}) as object;
      dumps.push({
        eye: `${item.guess} ${item.label}`,
        dump: item.dump,
        probe: probeKeys(settings),
        interestingOnTrack: [],
        interestingOnSettings: interestingNames(settings),
        interestingOnCapabilities: interestingNames(capabilities),
        error: item.error,
      });
    }
  }
  const exposed = dumps.some((row) => Object.entries(row.probe).some(([, value]) => value != null) || row.interestingOnSettings.length > 0 || row.interestingOnCapabilities.length > 0);
  const supportedKeys = supported && typeof supported === 'object' ? Object.keys(supported as object).filter((key) => /focal|principal|lens|pose|intrinsic/i.test(key)) : [];
  const readAny = dumps.some((row) => !row.error);
  const verdict: Verdict = exposed || supportedKeys.length ? 'pass' : readAny ? 'info' : 'partial';
  const headline = exposed || supportedKeys.length ? 'EXPUESTO: hay metadatos de lente en la API web.' : 'NO EXPUESTO: getSettings no trae focal, punto principal ni pose.';
  const detail = [
    headline,
    ensureNote,
    dumps.length ? dumps.map((row) => `${row.eye}: ${row.error ? row.error.name + ' ' + row.error.message : 'claves ' + (row.dump.settingKeys.join(', ') || '(ninguna)')}\n  sonda ${JSON.stringify(row.probe)}\n  nombres ${[...row.interestingOnTrack, ...row.interestingOnSettings, ...row.interestingOnCapabilities].join(', ') || '(ninguno)'}`).join('\n') : 'No había pistas de vídeo que leer.',
    `Restricciones soportadas con nombre de lente: ${supportedKeys.join(', ') || '(ninguna)'}`,
    `WebXR isSessionSupported: ${JSON.stringify(xrSupported)}`,
    `Permissions API: ${permissions.map((item) => `${item.name}=${item.state ?? item.error?.name}`).join(' · ')}`,
    'XRView.camera se prueba en el paso e. La pose del visor no es la pose de la cámara de passthrough.',
    '',
    nativeText(),
  ].join('\n');
  show('d', { verdict, headline, detail, dumps, supportedConstraints: supported, supportedKeys, xrSupported, permissions, nativeFactory: NATIVE_QUEST3_FACTORY });
}

async function stepE(signal: AbortSignal): Promise<void> {
  const blocked = mediaBlock();
  if (blocked) {
    show('e', { verdict: 'fail', headline: `${blocked.name}: ${blocked.message}`, detail: blocked.message, error: blocked });
    return;
  }
  if (!navigator.xr) {
    show('e', { verdict: 'fail', headline: 'No hay navigator.xr.', detail: 'Este navegador no expone WebXR.', error: { name: 'NotSupportedError', message: 'navigator.xr ausente' } });
    return;
  }
  progress('Abriendo cámaras antes de AR…');
  const opened = await ensureEyes(signal);
  if (!opened.ok) {
    show('e', { verdict: 'fail', headline: `Sin cámaras: ${opened.note}`, detail: opened.note, open: opened });
    return;
  }
  progress('Cargando PoseLandmarker lite…');
  let model: Awaited<ReturnType<typeof loadPose>>;
  try {
    model = await loadPose();
  } catch (error) {
    const info = errorInfo(error);
    model = { landmarker: null, delegate: 'ninguno', modelUrl: null, errors: [{ delegate: 'load', ...info }], connections: [] };
    publish('e', 'no se pudo cargar PoseLandmarker', { error: info }, 'error');
  }
  pose = model.landmarker;
  poseConnections = model.connections;
  progress('Midiendo fps justo antes de entrar en AR…');
  const before = await measureWindow(videoLeft, videoRight, 1500, signal);
  const beforeFps = { left: fpsFromStamps(before.left, before.wallMs), right: fpsFromStamps(before.right, before.wallMs) };
  progress('Pidiendo sesión immersive-ar…');
  const sessionTry = await requestArSession();
  if (!sessionTry.session) {
    show('e', {
      verdict: 'fail',
      headline: `Sesión AR rechazada: ${sessionTry.attempts.at(-1)?.error?.name ?? 'sin sesión'}`,
      detail: [
        sessionTry.attempts.map((item) => `${item.features.join('+') || '(sin extras)'} ${item.ok ? 'ok' : item.error?.name + ': ' + item.error?.message}`).join('\n'),
        `PoseLandmarker ${model.delegate}${model.modelUrl ? ' · ' + model.modelUrl : ''}. ${model.errors.length ? model.errors.map((item) => `${item.delegate} ${item.name}: ${item.message}`).join(' · ') : 'El modelo cargó.'}`,
        `Justo antes de pedir AR: izq ${n(beforeFps.left.fps)} fps, der ${n(beforeFps.right.fps)} fps.`,
      ].join('\n'),
      attempts: sessionTry.attempts,
      model,
      beforeFps,
    });
    model.landmarker?.close();
    pose = null;
    return;
  }
  const session = sessionTry.session;
  xrSession = session;
  const features = [...(session.enabledFeatures ?? [])];
  let sessionOver = false;
  const visibility: { t: string; state: XRVisibilityState }[] = [];
  session.addEventListener('end', () => { sessionOver = true; });
  session.addEventListener('visibilitychange', () => visibility.push({ t: new Date().toISOString(), state: session.visibilityState }));
  const THREE = await import('three');
  const renderer = new THREE.WebGLRenderer({ canvas: xrCanvas, alpha: true, antialias: false });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(1);
  renderer.xr.enabled = true;
  const spaceType: XRReferenceSpaceType = features.includes('local-floor') ? 'local-floor' : 'local';
  renderer.xr.setReferenceSpaceType(spaceType);
  let activeSpace: XRReferenceSpaceType = spaceType;
  let setSessionError: ErrorInfo | null = null;
  try {
    await renderer.xr.setSession(session);
  } catch (error) {
    const info = errorInfo(error);
    if (spaceType === 'local') setSessionError = info;
    else {
      activeSpace = 'local';
      renderer.xr.setReferenceSpaceType('local');
      try {
        await renderer.xr.setSession(session);
        publish('e', 'local-floor no sirvió para el reference space', { error: info }, 'warn');
      } catch (retry) {
        setSessionError = errorInfo(retry);
      }
    }
  }
  if (setSessionError) {
    await session.end().catch(() => {});
    model.landmarker?.close();
    pose = null;
    xrSession = null;
    show('e', {
      verdict: 'fail',
      headline: `La sesión no arrancó: ${setSessionError.name}`,
      detail: `${setSessionError.name}: ${setSessionError.message}`,
      error: setSessionError,
      attempts: sessionTry.attempts,
      beforeFps,
    });
    return;
  }
  const refSpace = await session.requestReferenceSpace(activeSpace);
  const gl = renderer.getContext();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.01, 20);
  const texture = new THREE.CanvasTexture(preview);
  texture.colorSpace = THREE.SRGBColorSpace;
  const holder = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.54), new THREE.MeshBasicMaterial({ map: texture, depthTest: false }));
  mesh.position.set(0, -0.02, -1.05);
  holder.add(mesh);
  scene.add(holder);

  const leftWatch = watchFrames(videoLeft);
  const rightWatch = watchFrames(videoRight);
  const decodedStart = { left: decodedCount(videoLeft), right: decodedCount(videoRight) };
  let leftTimeChanges = 0;
  let rightTimeChanges = 0;
  let prevLeftTime = videoLeft.currentTime;
  let prevRightTime = videoRight.currentTime;
  const inferMs: number[] = [];
  let posesFound = 0;
  let inferEye: 'left' | 'right' = 'left';
  let lastTs = 0;
  let cameraProbe: unknown = null;
  const samples: unknown[] = [];
  const started = performance.now();
  let xrFrames = 0;
  const alternate = el<HTMLInputElement>('alternate').checked;

  const paintStats = (line: string) => {
    paintPreview(line);
    texture.needsUpdate = true;
  };

  renderer.setAnimationLoop((time, frame) => {
    if (!frame || sessionOver) return;
    xrFrames++;
    const elapsed = performance.now() - started;
    if (videoLeft.currentTime !== prevLeftTime) { leftTimeChanges++; prevLeftTime = videoLeft.currentTime; }
    if (videoRight.currentTime !== prevRightTime) { rightTimeChanges++; prevRightTime = videoRight.currentTime; }
    let viewer: XRViewerPose | null = null;
    try { viewer = frame.getViewerPose(refSpace) ?? null; } catch (error) {
      if (xrFrames === 1) publish('e', 'getViewerPose falló', { error: errorInfo(error) }, 'warn');
    }
    if (!cameraProbe && viewer && xrFrames <= 45) {
      const probed = probeCameras(session, gl, viewer);
      if (probed.some((view) => view.hasCamera || view.textureError) || xrFrames === 45) cameraProbe = probed;
    }
    if (viewer) {
      const position = viewer.transform.position;
      const orientation = viewer.transform.orientation;
      holder.position.set(position.x, position.y, position.z);
      holder.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
      if (samples.length < 4000) {
        const leftStamp = leftWatch.stamps[leftWatch.stamps.length - 1];
        const rightStamp = rightWatch.stamps[rightWatch.stamps.length - 1];
        samples.push({
          t: performance.now(),
          xrTime: time,
          pose: { position: [position.x, position.y, position.z], orientation: [orientation.x, orientation.y, orientation.z, orientation.w] },
          leftCapture: leftStamp?.captureTime ?? null,
          rightCapture: rightStamp?.captureTime ?? null,
          leftMediaMs: leftStamp?.mediaTimeMs ?? null,
          rightMediaMs: rightStamp?.mediaTimeMs ?? null,
        });
      }
    }
    if (model.landmarker && elapsed <= AR_MS) {
      const ran = runInference(model.landmarker, alternate, inferMs, () => { posesFound++; }, (eye) => { inferEye = eye; }, lastTs);
      lastTs = ran.ts;
    }
    const mean = inferMs.length ? inferMs.reduce((sum, value) => sum + value, 0) / inferMs.length : 0;
    const hz = elapsed > 0 ? (inferMs.length * 1000) / elapsed : 0;
    paintStats(`AR ${n((xrFrames * 1000) / Math.max(elapsed, 1))} fps · infer ${n(hz)} Hz · ${n(mean)} ms\n${model.delegate} · poses ${posesFound} · ojo ${inferEye}`);
    renderer.render(scene, camera);
  });

  await new Promise<void>((resolve) => {
    if (signal.aborted || sessionOver) {
      resolve();
      return;
    }
    let timer = 0;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = window.setTimeout(finish, AR_MS);
    signal.addEventListener('abort', finish, { once: true });
    session.addEventListener('end', finish, { once: true });
  });
  if (!sessionOver) await session.end().catch(() => {});
  leftWatch.stop();
  rightWatch.stop();
  renderer.setAnimationLoop(null);
  const wallMs = performance.now() - started;
  const during = { left: fpsFromStamps(leftWatch.stamps, wallMs), right: fpsFromStamps(rightWatch.stamps, wallMs) };
  const mean = inferMs.length ? inferMs.reduce((sum, value) => sum + value, 0) / inferMs.length : null;
  const sortedInfer = [...inferMs].sort((a, b) => a - b);
  const flowing = during.left.fps >= 5 || leftTimeChanges >= 8;
  const flowingRight = during.right.fps >= 5 || rightTimeChanges >= 8;
  let verdict: Verdict = 'pass';
  if (!flowing || !flowingRight) verdict = 'fail';
  else if (!model.landmarker || !inferMs.length) verdict = 'partial';
  const cameraAccess = features.includes('camera-access');
  const headline = verdict === 'fail'
    ? 'AR sin fotogramas de las cámaras dentro de la sesión.'
    : `AR ${n((xrFrames * 1000) / wallMs)} fps. Cámaras dentro: ${n(during.left.fps)}/${n(during.right.fps)} fps. Infer ${n(mean == null ? null : (inferMs.length * 1000) / wallMs)} Hz, ${n(mean)} ms. camera-access ${cameraAccess ? 'sí' : 'no'}.`;
  const detail = [
    `Features pedidas y resultado:\n${sessionTry.attempts.map((item) => `${item.features.join('+') || '(sin extras)'} ${item.ok ? 'ok' : item.error?.name}`).join('\n')}`,
    `enabledFeatures: ${features.join(', ') || '(ninguna)'}`,
    `camera-access: ${cameraAccess ? 'activo' : 'no está en enabledFeatures'}`,
    `Sonda XRView.camera: ${JSON.stringify(cameraProbe)}`,
    `Fotogramas RVFC dentro de la sesión (${n(wallMs / 1000, 1)} s): izq ${during.left.frames} (${n(during.left.fps)} fps), der ${during.right.frames} (${n(during.right.fps)} fps).`,
    `currentTime avanzó ${leftTimeChanges} / ${rightTimeChanges} veces. webkitDecodedFrameCount Δ ${deltaDecoded(decodedStart.left, decodedCount(videoLeft))} / ${deltaDecoded(decodedStart.right, decodedCount(videoRight))}.`,
    `Antes de entrar: izq ${n(beforeFps.left.fps)} fps, der ${n(beforeFps.right.fps)} fps.`,
    `XR frames ${xrFrames} (${n((xrFrames * 1000) / wallMs)} fps). Muestras de pose ${samples.length}. Visibilidad: ${visibility.map((item) => item.state).join(' → ') || session.visibilityState}.`,
    `PoseLandmarker ${model.delegate} modelo ${model.modelUrl}. Inferencias ${inferMs.length}, media ${n(mean)} ms, p95 ${n(quantile(sortedInfer, 0.95))} ms, poses con landmarks ${posesFound}. Alternar: ${alternate ? 'sí' : 'no'}.`,
    model.errors.length ? `Fallos de delegado: ${model.errors.map((item) => `${item.delegate} ${item.name}: ${item.message}`).join(' · ')}` : 'GPU aceptó el modelo.',
    'La pose del visor no sustituye la extrínseca de la cámara. Intrínsecos de fábrica en el paso d.',
  ].join('\n');
  model.landmarker?.close();
  pose = null;
  xrSession = null;
  show('e', {
    verdict,
    headline,
    detail,
    open: opened,
    beforeFps,
    during,
    leftTimeChanges,
    rightTimeChanges,
    xrFrames,
    wallMs,
    features,
    attempts: sessionTry.attempts,
    environmentBlendMode: session.environmentBlendMode,
    visibility,
    cameraProbe,
    samples,
    inference: { delegate: model.delegate, modelUrl: model.modelUrl, errors: model.errors, count: inferMs.length, meanMs: mean, p95Ms: quantile(sortedInfer, 0.95), hz: wallMs > 0 ? (inferMs.length * 1000) / wallMs : 0, posesFound, inferMs, alternate },
  });
}

function decodedCount(video: HTMLVideoElement): number | null {
  const value = (video as HTMLVideoElement & { webkitDecodedFrameCount?: number }).webkitDecodedFrameCount;
  return typeof value === 'number' ? value : null;
}

function deltaDecoded(start: number | null, end: number | null): string {
  if (start == null || end == null) return '–';
  return String(end - start);
}

function probeCameras(session: XRSession, gl: WebGLRenderingContext, viewer: XRViewerPose) {
  return viewer.views.map((view) => {
    const camera = (view as XRView & { camera?: { width: number; height: number } | null }).camera ?? null;
    let texture: boolean | null = null;
    let textureError: ErrorInfo | null = null;
    if (camera && typeof XRWebGLBinding !== 'undefined') {
      try {
        const binding = new XRWebGLBinding(session, gl) as XRWebGLBinding & { getCameraImage?: (cam: { width: number; height: number }) => WebGLTexture | null };
        texture = typeof binding.getCameraImage === 'function' ? binding.getCameraImage(camera) != null : null;
      } catch (error) {
        textureError = errorInfo(error);
      }
    }
    return { eye: view.eye, hasCamera: camera != null, width: camera?.width ?? null, height: camera?.height ?? null, texture, textureError };
  });
}

function runInference(
  landmarker: PoseLandmarker,
  alternate: boolean,
  inferMs: number[],
  onPose: () => void,
  onEye: (eye: 'left' | 'right') => void,
  lastTs: number,
): { ts: number } {
  const eye: 'left' | 'right' = alternate && inferMs.length % 2 === 1 ? 'right' : 'left';
  onEye(eye);
  const video = eye === 'right' ? videoRight : videoLeft;
  if (video.readyState < 2) return { ts: lastTs };
  let ts = performance.now();
  if (ts <= lastTs) ts = lastTs + 0.001;
  const t0 = performance.now();
  try {
    const result = landmarker.detectForVideo(video, ts);
    inferMs.push(performance.now() - t0);
    const landmarks = result.landmarks?.[0] ?? null;
    lastLandmarks = landmarks;
    lastEye = eye;
    if (landmarks?.length) onPose();
  } catch (error) {
    inferMs.push(performance.now() - t0);
    publish('e', 'detectForVideo falló', { error: errorInfo(error) }, 'warn');
  }
  return { ts };
}

function paintPreview(statsLine: string): void {
  if (!previewCtx) return;
  const ctx = previewCtx;
  const width = preview.width;
  const height = preview.height;
  const band = 100;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  paintVideo(ctx, videoLeft, 0, 0, width / 2, height - band);
  paintVideo(ctx, videoRight, width / 2, 0, width / 2, height - band);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText('IZQ', 16, 42);
  ctx.fillText('DER', width / 2 + 16, 42);
  if (lastLandmarks?.length) paintPose(ctx, lastLandmarks, lastEye === 'right' ? width / 2 : 0, 0, width / 2, height - band);
  ctx.fillStyle = '#081018';
  ctx.fillRect(0, height - band, width, band);
  ctx.fillStyle = '#d6ffe8';
  ctx.font = 'bold 28px sans-serif';
  statsLine.split('\n').slice(0, 2).forEach((line, index) => ctx.fillText(line, 16, height - band + 38 + index * 34));
}

function paintVideo(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, x: number, y: number, width: number, height: number): void {
  if (video.readyState < 2 || !video.videoWidth) {
    ctx.fillStyle = '#201818';
    ctx.fillRect(x, y, width, height);
    return;
  }
  try { ctx.drawImage(video, x, y, width, height); } catch { /* el fotograma todavía no se puede dibujar */ }
}

function paintPose(ctx: CanvasRenderingContext2D, landmarks: NormalizedLandmark[], x: number, y: number, width: number, height: number): void {
  ctx.strokeStyle = '#7cf0ff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (const connection of poseConnections) {
    const start = landmarks[connection.start];
    const end = landmarks[connection.end];
    if (!start || !end) continue;
    ctx.moveTo(x + start.x * width, y + start.y * height);
    ctx.lineTo(x + end.x * width, y + end.y * height);
  }
  ctx.stroke();
  ctx.fillStyle = '#ffe66b';
  for (const point of landmarks) {
    ctx.beginPath();
    ctx.arc(x + point.x * width, y + point.y * height, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function loadPose(): Promise<{ landmarker: PoseLandmarker | null; delegate: string; modelUrl: string | null; errors: (ErrorInfo & { delegate: string })[]; connections: { start: number; end: number }[] }> {
  const { FilesetResolver, PoseLandmarker: PoseCtor } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(asset('wasm').replace(/\/$/, ''));
  const urls = [asset('models/pose_landmarker_lite.task'), MODEL_CDN];
  const errors: (ErrorInfo & { delegate: string })[] = [];
  for (const modelUrl of urls) {
    for (const delegate of ['GPU', 'CPU'] as const) {
      try {
        const landmarker = await PoseCtor.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: modelUrl, delegate },
          runningMode: 'VIDEO',
          numPoses: 1,
          ...(delegate === 'GPU' ? { canvas: mpCanvas } : {}),
        });
        const connections = PoseCtor.POSE_CONNECTIONS ?? [];
        return { landmarker, delegate, modelUrl, errors, connections };
      } catch (error) {
        const info = errorInfo(error);
        errors.push({ delegate: `${delegate} ${modelUrl}`, ...info });
        publish('e', `PoseLandmarker ${delegate} falló`, { modelUrl, error: info }, 'warn');
      }
    }
  }
  return { landmarker: null, delegate: 'ninguno', modelUrl: null, errors, connections: [] };
}

async function requestArSession(): Promise<{ session: XRSession | null; attempts: { features: string[]; ok: boolean; error?: ErrorInfo }[] }> {
  const sets = [
    ['camera-access', 'local-floor', 'hand-tracking'],
    ['local-floor', 'hand-tracking'],
    ['local-floor'],
    [] as string[],
  ];
  const xr = navigator.xr;
  const attempts: { features: string[]; ok: boolean; error?: ErrorInfo }[] = [];
  if (!xr) return { session: null, attempts: [{ features: [], ok: false, error: { name: 'NotSupportedError', message: 'navigator.xr ausente' } }] };
  for (const features of sets) {
    try {
      const session = await xr.requestSession('immersive-ar', features.length ? { optionalFeatures: features } : {});
      attempts.push({ features, ok: true });
      return { session, attempts };
    } catch (error) {
      const info = errorInfo(error);
      attempts.push({ features, ok: false, error: info });
      publish('e', `requestSession falló (${features.join('+') || 'vacío'})`, { error: info }, 'warn');
      if (info.name === 'NotAllowedError' || info.name === 'SecurityError') break;
    }
  }
  return { session: null, attempts };
}

function exportResults(): void {
  const payload = { ...report, exportedAt: new Date().toISOString() };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `spike-camaras-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  const verdict = el<HTMLElement>('verdict-export');
  const done = (text: string, kind: Verdict) => {
    verdict.className = `verdict ${kind}`;
    verdict.textContent = text;
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(json).then(
      () => done('JSON descargado y copiado.', 'pass'),
      () => done('JSON descargado. El portapapeles no aceptó la copia.', 'partial'),
    );
  } else done('JSON descargado.', 'pass');
  publish('export', 'resultados exportados', { bytes: json.length });
}

function stopAll(): void {
  runAbort.abort();
  runAbort = new AbortController();
  xrSession?.end().catch(() => {});
  xrSession = null;
  pose?.close();
  pose = null;
  stopOpened();
  progress('Cámaras detenidas.');
}

async function run(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  for (const id of ['btn-a', 'btn-b', 'btn-c', 'btn-d', 'btn-e']) el<HTMLButtonElement>(id).disabled = true;
  const signal = runAbort.signal;
  try {
    await task(signal);
  } catch (error) {
    const info = errorInfo(error);
    progress(`${info.name}: ${info.message}`);
    publish('error', `${info.name}: ${info.message}`, { error: info }, 'error');
  } finally {
    busy = false;
    for (const id of ['btn-a', 'btn-b', 'btn-c', 'btn-d', 'btn-e']) el<HTMLButtonElement>(id).disabled = false;
    if (signal.aborted) progress('Paso interrumpido.');
  }
}

async function boot(): Promise<void> {
  const ua = navigator.userAgent;
  const uaData = (navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[]; mobile?: boolean; platform?: string; getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>> } }).userAgentData;
  let high: unknown = null;
  if (uaData?.getHighEntropyValues) {
    try { high = await uaData.getHighEntropyValues(['fullVersionList', 'platform', 'platformVersion', 'model', 'uaFullVersion']); }
    catch (error) { high = errorInfo(error); }
  }
  const agent = {
    userAgent: ua,
    oculusBrowser: /OculusBrowser\/([\d.]+)/.exec(ua)?.[1] ?? null,
    chromium: /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? null,
    userAgentData: uaData ? { brands: uaData.brands ?? null, mobile: uaData.mobile ?? null, platform: uaData.platform ?? null, high } : null,
  };
  report.userAgent = agent;
  const log = report.remoteLog ? String(report.remoteLog) : 'inactivo (añade ?log=https://<host>:8443)';
  env.textContent = `OculusBrowser ${agent.oculusBrowser ?? '–'} · Chromium ${agent.chromium ?? '–'} · contexto seguro: ${window.isSecureContext ? 'sí' : 'no'} · log: ${log}`;
  el<HTMLElement>('blurb').textContent = RESEARCH.summary;
  publish('arranque', 'spike listo', { userAgent: agent, secureContext: window.isSecureContext, href: location.href, remoteLog: report.remoteLog });
  el<HTMLButtonElement>('btn-a').addEventListener('click', () => void run(stepA));
  el<HTMLButtonElement>('btn-b').addEventListener('click', () => void run(stepB));
  el<HTMLButtonElement>('btn-c').addEventListener('click', () => void run(stepC));
  el<HTMLButtonElement>('btn-d').addEventListener('click', () => void run(stepD));
  el<HTMLButtonElement>('btn-e').addEventListener('click', () => void run(stepE));
  el<HTMLButtonElement>('btn-export').addEventListener('click', exportResults);
  el<HTMLButtonElement>('btn-stop').addEventListener('click', stopAll);
}

void boot();
