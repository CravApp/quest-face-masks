import { NATIVE_QUEST3_FACTORY, type FactoryCamera } from '../../spike/cameras/intrinsics';

/**
 * Recorte supuesto del sensor 1728×1728 al stream 4:3 del navegador.
 * El spike midió 1280×960 con resizeMode crop-and-scale y el sensor llega a 1728.
 * Suposición: recorte centrado 1728×1296 (se quitan 216 px arriba y abajo) y
 * después escala uniforme outW/1728. 1280/1728 = 960/1296. No hay coeficientes
 * de distorsión. La rotación de la cámara respecto a la cabeza se toma como
 * identidad (la relativa entre ojos es ~1,38° y no trae eje).
 */
export const SENSOR_PX = 1728;
export const CROP_WIDTH_PX = 1728;
export const CROP_HEIGHT_PX = 1296;
export const CROP_ORIGIN_Y_PX = (SENSOR_PX - CROP_HEIGHT_PX) / 2;

/** Distancia entre centros de iris (landmarks 468 y 473), metros. */
export const IRIS_IPD_M = 0.063;
/** Distancia entre comisuras externas (33 y 263) si el modelo no trae iris. */
export const OUTER_CANTHUS_M = 0.091;

export interface ScaledIntrinsics {
  eye: 'left' | 'right';
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** Metros, x a la derecha, y arriba, z hacia atrás (la cámara está delante del centro). */
  translationM: [number, number, number];
}

export function factoryCamera(eye: 'left' | 'right'): FactoryCamera {
  const camera = NATIVE_QUEST3_FACTORY.cameras.find((item) => item.eye === eye);
  if (!camera) throw new Error(`Sin intrínsecos de fábrica para ${eye}`);
  return camera;
}

export function scaleFactoryIntrinsics(eye: 'left' | 'right', outWidth: number, outHeight: number): ScaledIntrinsics {
  const camera = factoryCamera(eye);
  const sx = outWidth / CROP_WIDTH_PX;
  const sy = outHeight / CROP_HEIGHT_PX;
  return {
    eye,
    fx: camera.fx * sx,
    fy: camera.fy * sy,
    cx: camera.cx * sx,
    cy: (camera.cy - CROP_ORIGIN_Y_PX) * sy,
    width: outWidth,
    height: outHeight,
    translationM: [camera.translationM[0], camera.translationM[1], camera.translationM[2]],
  };
}

export interface EyePair {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  realM: number;
}

/** Ojos en píxeles del fotograma. Iris si hay 478 puntos; si no, comisuras. */
export function eyePair(landmarks: Float32Array, width: number, height: number): EyePair | null {
  const count = landmarks.length / 3;
  const iris = count >= 474;
  const i0 = iris ? 468 : 33;
  const i1 = iris ? 473 : 263;
  if (count <= i1) return null;
  return {
    u0: landmarks[i0 * 3] * width,
    v0: landmarks[i0 * 3 + 1] * height,
    u1: landmarks[i1 * 3] * width,
    v1: landmarks[i1 * 3 + 1] * height,
    realM: iris ? IRIS_IPD_M : OUTER_CANTHUS_M,
  };
}

export interface Vec3 { x: number; y: number; z: number }

/**
 * Centro de la cara en el sistema de la cámara three.js / WebXR
 * (x derecha, y arriba, z hacia el visor; la cara queda en z negativo).
 */
export function monoFaceGl(pair: EyePair, k: ScaledIntrinsics, depthScale = 1): Vec3 | null {
  const dist = Math.hypot(pair.u1 - pair.u0, pair.v1 - pair.v0);
  if (dist < 2 || k.fx <= 0) return null;
  const zForward = (k.fx * pair.realM / dist) * depthScale;
  const u = (pair.u0 + pair.u1) / 2;
  const v = (pair.v0 + pair.v1) / 2;
  const x = ((u - k.cx) / k.fx) * zForward;
  const y = ((v - k.cy) / k.fy) * zForward;
  return { x, y: -y, z: -zForward };
}

export interface Ray { o: Vec3; d: Vec3 }

/** Rayo en el espacio de la cabeza. El origen es la traslación de fábrica. */
export function pixelRay(u: number, v: number, k: ScaledIntrinsics): Ray {
  const x = (u - k.cx) / k.fx;
  const y = -((v - k.cy) / k.fy);
  const z = -1;
  const len = Math.hypot(x, y, z) || 1;
  return {
    o: { x: k.translationM[0], y: k.translationM[1], z: k.translationM[2] },
    d: { x: x / len, y: y / len, z: z / len },
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function addScaled(o: Vec3, d: Vec3, s: number): Vec3 {
  return { x: o.x + d.x * s, y: o.y + d.y * s, z: o.z + d.z * s };
}

/** Punto medio de los dos rayos. Null si son casi paralelos o el cruce queda detrás de una cámara. */
export function triangulateRays(a: Ray, b: Ray): Vec3 | null {
  const w0 = { x: a.o.x - b.o.x, y: a.o.y - b.o.y, z: a.o.z - b.o.z };
  const bDot = dot(a.d, b.d);
  const d = dot(a.d, w0);
  const e = dot(b.d, w0);
  const denom = 1 - bDot * bDot;
  if (denom < 1e-6) return null;
  const sc = (bDot * e - d) / denom;
  const tc = (e - bDot * d) / denom;
  if (sc < 0 || tc < 0) return null;
  const p1 = addScaled(a.o, a.d, sc);
  const p2 = addScaled(b.o, b.d, tc);
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, z: (p1.z + p2.z) / 2 };
}

export function triangulateEyes(left: EyePair, kL: ScaledIntrinsics, right: EyePair, kR: ScaledIntrinsics): Vec3 | null {
  const uL = (left.u0 + left.u1) / 2;
  const vL = (left.v0 + left.v1) / 2;
  const uR = (right.u0 + right.u1) / 2;
  const vR = (right.v0 + right.v1) / 2;
  return triangulateRays(pixelRay(uL, vL, kL), pixelRay(uR, vR, kR));
}

/** |Δ| de captureTime por debajo del cual el estéreo del spike merece triangulación. */
export const STEREO_MAX_DELTA_MS = 5;
