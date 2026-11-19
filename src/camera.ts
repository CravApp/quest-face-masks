// Captura de cámara: passthrough de Meta Quest 3/3S vía getUserMedia, con fallback a webcam.
// Fuentes: Reactylon "Camera Passthrough", Meta Help "Headset cameras permission",
// Meta investigation 1557993751977106 (1280x960@30 en Quest Browser).

export type QuestEye = 'left' | 'right';
export type CameraSource = 'quest-passthrough' | 'webcam';
export type CameraErrorCode = 'insecure' | 'denied' | 'no-facing-back' | 'failed';

export interface VideoInputSummary {
  label: string;
  deviceId: string;
  facingBack: boolean;
  facingFront: boolean;
}

export interface CameraResult {
  stream: MediaStream;
  source: CameraSource;
  label: string;
  settings: MediaTrackSettings;
  devices: VideoInputSummary[];
  /** Ojo elegido. En Quest, auto es la passthrough izquierda. */
  eye: QuestEye | 'webcam';
  /** La otra passthrough. La fase 2 la usará junto con StereoCalibration (src/calib/stereo.ts). */
  rightStream: MediaStream | null;
  rightLabel: string | null;
  rightSettings: MediaTrackSettings | null;
  /** Ojo de rightStream. Si el principal es la derecha, este es el izquierdo. */
  otherEye: QuestEye | null;
  /** Aviso cuando no hubo passthrough y se cayó a la webcam, o el estéreo no abrió. */
  notice?: string;
}

export interface CaptureRequest {
  mode: 'auto' | 'quest-left' | 'quest-right' | 'webcam';
  width: number;
  height: number;
  stereo: boolean;
}

export class CameraError extends Error {
  readonly code: CameraErrorCode;
  readonly devices: VideoInputSummary[];
  constructor(code: CameraErrorCode, message: string, devices: VideoInputSummary[] = []) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
    this.devices = devices;
  }
}

function errorName(error: unknown): string {
  if (error instanceof DOMException) return error.name;
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string') return error.name;
  return 'Error';
}

function isDenied(error: unknown): boolean {
  const name = errorName(error);
  return name === 'NotAllowedError' || name === 'PermissionDeniedError';
}

export function describeDevices(devices: VideoInputSummary[]): string {
  if (devices.length === 0) return 'ninguna cámara de vídeo';
  return devices.map((device) => (device.label ? `«${device.label}»` : '(sin etiqueta)')).join(', ');
}

function deniedMessage(devices: VideoInputSummary[]): string {
  return `Permiso de cámara denegado. En Quest 3/3S abre Ajustes → Privacidad y seguridad → Permisos de apps → Browser → «Headset cameras» y concédelo. Activa el passthrough y cierra cualquier otra página que esté usando la cámara. Cámaras visibles ahora: ${describeDevices(devices)}.`;
}

function noBackMessage(devices: VideoInputSummary[]): string {
  const avatar = devices.some((device) => device.facingFront)
    ? ' La cámara «facing front» es la virtual del avatar y no ve el entorno.'
    : '';
  return `No hay cámaras «facing back» (passthrough). Cámaras de vídeo: ${describeDevices(devices)}.${avatar} En el Quest esto suele indicar que falta el permiso «Headset cameras», que el passthrough está apagado o que el visor no es un Quest 3/3S.`;
}

function assertMediaDevices(): MediaDevices {
  const md = navigator.mediaDevices;
  if (!window.isSecureContext || !md?.getUserMedia || !md.enumerateDevices) {
    throw new CameraError('insecure', 'Se necesita un contexto seguro (https:// o http://localhost) y MediaDevices. Por la IP de la red usa npm run dev:lan y abre la URL https que imprime el servidor.');
  }
  return md;
}

async function videoInputs(): Promise<VideoInputSummary[]> {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.filter((device) => device.kind === 'videoinput').map((device) => ({
      label: device.label,
      deviceId: device.deviceId,
      facingBack: /facing back/i.test(device.label),
      facingFront: /facing front/i.test(device.label),
    }));
  } catch {
    return [];
  }
}

/** Número de cámara en etiquetas tipo "camera 1, facing back" o "camera 2 1, facing back". */
function cameraNumber(label: string): number {
  const match = /camera\s+(?:\d+\s+)?(\d+),/i.exec(label);
  return match ? Number(match[1]) : Number.NaN;
}

async function failure(error: unknown, fallback: string): Promise<CameraError> {
  const devices = await videoInputs();
  if (isDenied(error)) return new CameraError('denied', deniedMessage(devices), devices);
  return new CameraError('failed', `${fallback} (${errorName(error)}: ${(error as Error).message}). Cámaras: ${describeDevices(devices)}.`, devices);
}

/** El spike (Quest Browser 157) rechaza frameRate exact 60 y, con ideal 60, entrega 30. Se pide ideal 30 con tope 30. */
async function openDevice(deviceId: string, width: number, height: number): Promise<MediaStream> {
  const md = assertMediaDevices();
  const attempts: MediaTrackConstraints[] = [
    { deviceId: { exact: deviceId }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30, max: 30 } },
    { deviceId: { exact: deviceId }, width: { ideal: width }, height: { ideal: height } },
    { deviceId: { exact: deviceId } },
  ];
  let last: unknown;
  for (const video of attempts) {
    try {
      return await md.getUserMedia({ video, audio: false });
    } catch (error) {
      last = error;
      if (errorName(error) !== 'OverconstrainedError') break;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function sortedBack(devices: VideoInputSummary[]): VideoInputSummary[] {
  return devices.filter((device) => device.facingBack).sort((a, b) => cameraNumber(a.label) - cameraNumber(b.label));
}

async function grantAndList(): Promise<VideoInputSummary[]> {
  const md = assertMediaDevices();
  let probe: MediaStream | null = null;
  try {
    probe = await md.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (error) {
    throw await failure(error, 'No se pudo pedir el permiso de cámara');
  } finally {
    probe?.getTracks().forEach((track) => track.stop());
  }
  return videoInputs();
}

export async function getQuestPassthroughStream(eye: QuestEye = 'left', width = 1280, height = 960): Promise<MediaStream> {
  const devices = await grantAndList();
  const back = sortedBack(devices);
  if (back.length === 0) throw new CameraError('no-facing-back', noBackMessage(devices), devices);
  // Spike en Quest Browser 157: «camera 1, facing back» = izquierda, «camera 2, facing back» = derecha.
  const chosen = eye === 'left' ? back[0] : back[back.length - 1];
  if (!chosen?.deviceId) throw new CameraError('failed', 'La cámara passthrough no tiene deviceId.', devices);
  try {
    return await openDevice(chosen.deviceId, width, height);
  } catch (error) {
    if (errorName(error) !== 'OverconstrainedError') throw await failure(error, `No se pudo abrir «${chosen.label}»`);
    try {
      return await assertMediaDevices().getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (retry) {
      throw await failure(retry, `«${chosen.label}» rechazó ${width}×${height} y el reintento con facingMode también falló`);
    }
  }
}

export async function getWebcamStream(width = 1280, height = 720): Promise<MediaStream> {
  const md = assertMediaDevices();
  try {
    return await md.getUserMedia({
      video: { facingMode: { ideal: 'user' }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (error) {
    throw await failure(error, 'No se pudo abrir la webcam');
  }
}

function trackSettings(stream: MediaStream): { label: string; settings: MediaTrackSettings } {
  const track = stream.getVideoTracks()[0];
  return { label: track?.label ?? '(sin etiqueta)', settings: track?.getSettings() ?? {} };
}

async function withMeta(stream: MediaStream, source: CameraSource, eye: CameraResult['eye']): Promise<CameraResult> {
  const main = trackSettings(stream);
  return {
    stream,
    source,
    label: main.label,
    settings: main.settings,
    devices: await videoInputs(),
    eye,
    rightStream: null,
    rightLabel: null,
    rightSettings: null,
    otherEye: null,
  };
}

async function attachRight(result: CameraResult, width: number, height: number, log: (message: string) => void): Promise<void> {
  const back = sortedBack(result.devices);
  const other = back.filter((device) => device.label !== result.label);
  const right = other[other.length - 1];
  if (!right?.deviceId) {
    result.notice = result.notice ? `${result.notice} Estéreo no disponible: no hay segunda cámara facing back.` : 'Estéreo no disponible: no hay segunda cámara facing back.';
    return;
  }
  try {
    const stream = await openDevice(right.deviceId, width, height);
    const meta = trackSettings(stream);
    result.rightStream = stream;
    result.rightLabel = meta.label;
    result.rightSettings = meta.settings;
    result.otherEye = result.eye === 'right' ? 'left' : 'right';
    log(`Estéreo: también «${meta.label}» ${meta.settings.width}×${meta.settings.height}@${meta.settings.frameRate ?? '–'}`);
  } catch (error) {
    const info = error instanceof Error ? error.message : String(error);
    result.notice = `La cámara derecha no abrió (${info}). Se sigue en mono.`;
    log(result.notice);
  }
}

/**
 * Auto en Quest: passthrough izquierda, luego cualquier facing back, y si no hay
 * (escritorio) la webcam. Un permiso denegado no se disimula.
 */
export async function getBestCamera(request: CaptureRequest, log: (message: string) => void): Promise<CameraResult> {
  const { mode, width, height, stereo } = request;
  if (mode === 'webcam') return withMeta(await getWebcamStream(width, height), 'webcam', 'webcam');
  try {
    const eye: QuestEye = mode === 'quest-right' ? 'right' : 'left';
    const result = await withMeta(await getQuestPassthroughStream(eye, width, height), 'quest-passthrough', eye);
    if (stereo) await attachRight(result, width, height, log);
    return result;
  } catch (error) {
    const cameraError = error instanceof CameraError ? error : await failure(error, 'Passthrough no disponible');
    if (mode !== 'auto' || cameraError.code === 'denied' || cameraError.code === 'insecure') throw cameraError;
    log(`${cameraError.message} Usando webcam.`);
    const webcam = await withMeta(await getWebcamStream(width, height), 'webcam', 'webcam');
    webcam.notice = cameraError.message;
    return webcam;
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}
