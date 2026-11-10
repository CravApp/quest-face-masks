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
  /** Aviso cuando no hubo passthrough y se cayó a la webcam. */
  notice?: string;
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

export async function getQuestPassthroughStream(eye: QuestEye = 'right'): Promise<MediaStream> {
  const md = assertMediaDevices();

  // 1) Pedir permiso primero: sin él, label/deviceId de enumerateDevices llegan vacíos.
  let probe: MediaStream | null = null;
  try {
    probe = await md.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (error) {
    throw await failure(error, 'No se pudo pedir el permiso de cámara');
  } finally {
    probe?.getTracks().forEach((track) => track.stop());
  }

  // 2) Filtrar por "facing back" (nunca por índice ni por un dígito suelto en la etiqueta).
  const devices = await videoInputs();
  const back = devices.filter((device) => device.facingBack);
  if (back.length === 0) throw new CameraError('no-facing-back', noBackMessage(devices), devices);
  // camera 1 = izquierda, camera 2 = derecha (según Reactylon; por verificar en visor).
  back.sort((a, b) => cameraNumber(a.label) - cameraNumber(b.label));
  const chosen = eye === 'left' ? back[0] : back[back.length - 1];
  if (!chosen?.deviceId) throw new CameraError('failed', 'La cámara passthrough no tiene deviceId.', devices);

  // 3) Pedir 4:3 nativo (1280x960) con "ideal" para evitar OverconstrainedError.
  const video: MediaTrackConstraints = {
    deviceId: { exact: chosen.deviceId },
    width: { ideal: 1280 },
    height: { ideal: 960 },
    frameRate: { ideal: 30 },
  };
  try {
    return await md.getUserMedia({ video, audio: false });
  } catch (error) {
    if (errorName(error) !== 'OverconstrainedError') throw await failure(error, `No se pudo abrir «${chosen.label}»`);
    try {
      return await md.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (retry) {
      throw await failure(retry, `«${chosen.label}» rechazó 1280×960 y el reintento con facingMode también falló`);
    }
  }
}

export async function getWebcamStream(): Promise<MediaStream> {
  const md = assertMediaDevices();
  try {
    return await md.getUserMedia({
      video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (error) {
    throw await failure(error, 'No se pudo abrir la webcam');
  }
}

async function describe(stream: MediaStream, source: CameraSource): Promise<CameraResult> {
  const track = stream.getVideoTracks()[0];
  return {
    stream,
    source,
    label: track?.label ?? '(sin etiqueta)',
    settings: track?.getSettings() ?? {},
    devices: await videoInputs(),
  };
}

/** Intenta el passthrough de Quest; si no existe (escritorio), usa la webcam. Un permiso denegado no se disimula. */
export async function getBestCamera(
  mode: 'auto' | 'quest-left' | 'quest-right' | 'webcam',
  log: (message: string) => void,
): Promise<CameraResult> {
  if (mode !== 'webcam') {
    try {
      const eye: QuestEye = mode === 'quest-left' ? 'left' : 'right';
      return await describe(await getQuestPassthroughStream(eye), 'quest-passthrough');
    } catch (error) {
      const cameraError = error instanceof CameraError ? error : await failure(error, 'Passthrough no disponible');
      if (mode !== 'auto' || cameraError.code === 'denied' || cameraError.code === 'insecure') throw cameraError;
      log(`${cameraError.message} Usando webcam.`);
      const webcam = await describe(await getWebcamStream(), 'webcam');
      webcam.notice = cameraError.message;
      return webcam;
    }
  }
  return describe(await getWebcamStream(), 'webcam');
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}
