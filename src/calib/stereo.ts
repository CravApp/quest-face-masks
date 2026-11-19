/**
 * Calibración estéreo que consumirá la fase 2.
 * Metros. Ejes OpenCV (x derecha, y abajo, z adelante).
 * stereo.R y stereo.T llevan un punto de la cámara izquierda a la derecha: X_r = R X_l + T.
 * La fase 1 carga el JSON y, si es válido, usa la K del ojo principal en lugar del recorte de fábrica.
 * La distorsión D se guarda pero no se aplica todavía.
 */
export type DistortionModel = 'radtan' | 'fisheye';

export interface CameraIntrinsicsJson {
  camera2_id: number;
  /** 3×3, fila a fila, o 9 números. */
  K: number[] | number[][];
  D: number[];
}

export interface RigidJson {
  R: number[] | number[][];
  t: number[];
}

export interface StereoCalibration {
  version: number;
  image_size: [number, number];
  distortion_model: DistortionModel;
  left: { camera2_id: number; K: number[][]; D: number[] };
  right: { camera2_id: number; K: number[][]; D: number[] };
  stereo: {
    R: number[][];
    T: number[];
    R1: number[][];
    R2: number[][];
    P1: number[][];
    P2: number[][];
    Q: number[][];
  };
  head_from_cam?: { left?: RigidJson; right?: RigidJson };
}

const KEY = 'quest-face-masks.stereo-calib.v1';

function matrix(value: unknown, rows: number, cols: number): number[][] | null {
  if (Array.isArray(value) && value.length === rows * cols && value.every((n) => typeof n === 'number')) {
    const flat = value as number[];
    const out: number[][] = [];
    for (let r = 0; r < rows; r++) out.push(flat.slice(r * cols, (r + 1) * cols));
    return out;
  }
  if (!Array.isArray(value) || value.length !== rows) return null;
  const out: number[][] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== cols || row.some((n) => typeof n !== 'number')) return null;
    out.push(row as number[]);
  }
  return out;
}

function vec(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length || value.some((n) => typeof n !== 'number')) return null;
  return value as number[];
}

function camera(value: unknown): StereoCalibration['left'] | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as CameraIntrinsicsJson;
  const K = matrix(raw.K, 3, 3);
  const D = Array.isArray(raw.D) && raw.D.every((n) => typeof n === 'number') ? raw.D : null;
  if (!K || !D || typeof raw.camera2_id !== 'number') return null;
  return { camera2_id: raw.camera2_id, K, D };
}

function rigid(value: unknown): RigidJson | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as RigidJson;
  const R = matrix(raw.R, 3, 3);
  const t = vec(raw.t, 3);
  if (!R || !t) return undefined;
  return { R, t };
}

/** Null si el JSON no cumple el formato. No lanza. */
export function parseStereoCalibration(input: unknown): StereoCalibration | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const size = raw.image_size;
  if (!Array.isArray(size) || size.length !== 2 || typeof size[0] !== 'number' || typeof size[1] !== 'number') return null;
  if (raw.distortion_model !== 'radtan' && raw.distortion_model !== 'fisheye') return null;
  if (typeof raw.version !== 'number') return null;
  const left = camera(raw.left);
  const right = camera(raw.right);
  const stereo = raw.stereo;
  if (!left || !right || !stereo || typeof stereo !== 'object') return null;
  const block = stereo as Record<string, unknown>;
  const R = matrix(block.R, 3, 3);
  const T = vec(block.T, 3);
  const R1 = matrix(block.R1, 3, 3);
  const R2 = matrix(block.R2, 3, 3);
  const P1 = matrix(block.P1, 3, 4);
  const P2 = matrix(block.P2, 3, 4);
  const Q = matrix(block.Q, 4, 4);
  if (!R || !T || !R1 || !R2 || !P1 || !P2 || !Q) return null;
  const head = raw.head_from_cam;
  let head_from_cam: StereoCalibration['head_from_cam'];
  if (head && typeof head === 'object') {
    const h = head as { left?: unknown; right?: unknown };
    head_from_cam = { left: rigid(h.left), right: rigid(h.right) };
  }
  return {
    version: raw.version,
    image_size: [size[0], size[1]],
    distortion_model: raw.distortion_model,
    left,
    right,
    stereo: { R, T, R1, R2, P1, P2, Q },
    head_from_cam,
  };
}

export function loadStoredCalibration(): StereoCalibration | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return parseStereoCalibration(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function storeCalibration(calib: StereoCalibration | null): void {
  if (!calib) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(calib));
}

/** K del ojo, escalada al fotograma actual. Traslación en el marco de la app (x derecha, y arriba, z atrás). */
export function intrinsicsFromCalibration(
  calib: StereoCalibration,
  eye: 'left' | 'right',
  outWidth: number,
  outHeight: number,
): { fx: number; fy: number; cx: number; cy: number; translationM: [number, number, number] | null } {
  const cam = eye === 'left' ? calib.left : calib.right;
  const [srcW, srcH] = calib.image_size;
  const sx = srcW > 0 ? outWidth / srcW : 1;
  const sy = srcH > 0 ? outHeight / srcH : 1;
  const head = calib.head_from_cam?.[eye];
  const translationM: [number, number, number] | null = head
    ? [head.t[0], -head.t[1], -head.t[2]]
    : null;
  return {
    fx: cam.K[0][0] * sx,
    fy: cam.K[1][1] * sy,
    cx: cam.K[0][2] * sx,
    cy: cam.K[1][2] * sy,
    translationM,
  };
}
