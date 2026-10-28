// Captura de cámara: passthrough de Meta Quest 3/3S vía getUserMedia, con fallback a webcam.
// Fuentes: Reactylon "Camera Passthrough", Meta Help "Headset cameras permission",
// Meta investigation 1557993751977106 (1280x960@30 en Quest Browser).

export type QuestEye = 'left' | 'right';
export type CameraSource = 'quest-passthrough' | 'webcam';

export interface CameraResult {
  stream: MediaStream;
  source: CameraSource;
  label: string;
  settings: MediaTrackSettings;
}

function assertMediaDevices(): MediaDevices {
  const md = navigator.mediaDevices;
  if (!window.isSecureContext || !md?.getUserMedia || !md.enumerateDevices) {
    throw new Error('Requiere contexto seguro (HTTPS o http://localhost) y MediaDevices');
  }
  return md;
}

/** Número de cámara en etiquetas tipo "camera 1, facing back" o "camera 2 1, facing back". */
function cameraNumber(label: string): number {
  const m = /camera\s+(?:\d+\s+)?(\d+),/i.exec(label);
  return m ? Number(m[1]) : Number.NaN;
}

export async function getQuestPassthroughStream(eye: QuestEye = 'right'): Promise<MediaStream> {
  const md = assertMediaDevices();

  // 1) Pedir permiso primero: sin él, label/deviceId de enumerateDevices llegan vacíos.
  const probe = await md.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  probe.getTracks().forEach((t) => t.stop());

  // 2) Filtrar por "facing back" (nunca por índice ni por un dígito suelto en la etiqueta).
  const cams = (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const back = cams.filter((d) => /facing back/i.test(d.label));
  if (back.length === 0) {
    throw new Error('No hay cámaras passthrough ("facing back"): revisa el permiso "Headset cameras" y que sea Quest 3/3S');
  }
  // camera 1 = izquierda, camera 2 = derecha (según Reactylon; por verificar en visor).
  back.sort((a, b) => cameraNumber(a.label) - cameraNumber(b.label));
  const chosen = eye === 'left' ? back[0] : back[back.length - 1];

  // 3) Pedir 4:3 nativo (1280x960) con "ideal" para evitar OverconstrainedError.
  const video: MediaTrackConstraints = {
    deviceId: { exact: chosen.deviceId },
    width: { ideal: 1280 },
    height: { ideal: 960 },
    frameRate: { ideal: 30 },
  };
  try {
    return await md.getUserMedia({ video, audio: false });
  } catch (e) {
    if ((e as DOMException).name !== 'OverconstrainedError') throw e;
    return md.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  }
}

export async function getWebcamStream(): Promise<MediaStream> {
  const md = assertMediaDevices();
  return md.getUserMedia({
    video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
}

function describe(stream: MediaStream, source: CameraSource): CameraResult {
  const track = stream.getVideoTracks()[0];
  return { stream, source, label: track?.label ?? '(sin etiqueta)', settings: track?.getSettings() ?? {} };
}

/** Intenta el passthrough de Quest; si no existe (escritorio, permiso denegado), usa la webcam. */
export async function getBestCamera(
  mode: 'auto' | 'quest-left' | 'quest-right' | 'webcam',
  log: (m: string) => void,
): Promise<CameraResult> {
  if (mode !== 'webcam') {
    try {
      const eye: QuestEye = mode === 'quest-left' ? 'left' : 'right';
      return describe(await getQuestPassthroughStream(eye), 'quest-passthrough');
    } catch (e) {
      if (mode !== 'auto') throw e;
      log(`Passthrough no disponible (${(e as Error).message}). Usando webcam.`);
    }
  }
  return describe(await getWebcamStream(), 'webcam');
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}
