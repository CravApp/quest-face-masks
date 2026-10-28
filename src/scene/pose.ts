import * as THREE from 'three';
import type { Calibration } from '../calibration';

/** FOV vertical que asume el pipeline de geometría facial de MediaPipe (grados). */
export const MEDIAPIPE_ASSUMED_FOV_DEG = 63;

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();

/**
 * Convierte la facialTransformationMatrix (4x4 column-major, cm, cámara en el origen mirando a -Z)
 * en una matriz en metros dentro del espacio de la cámara física, corrigiendo el FOV asumido
 * por MediaPipe con el FOV real calibrado.
 */
export function faceMatrixToCameraSpace(data: number[], calib: Calibration, out = new THREE.Matrix4()): THREE.Matrix4 {
  out.fromArray(data);
  out.decompose(tmpPos, tmpQuat, tmpScale);
  const k = Math.tan(THREE.MathUtils.degToRad(calib.fovDeg) / 2) / Math.tan(THREE.MathUtils.degToRad(MEDIAPIPE_ASSUMED_FOV_DEG) / 2);
  tmpPos.multiplyScalar(0.01); // cm -> m
  tmpPos.x *= k;
  tmpPos.y *= k;
  tmpPos.z *= calib.depthScale;
  tmpScale.setScalar(0.01 * calib.maskScale * ((Math.abs(tmpScale.x) + Math.abs(tmpScale.y) + Math.abs(tmpScale.z)) / 3));
  return out.compose(tmpPos, tmpQuat, tmpScale);
}

/** Matriz cabeza→cámara física, a partir de offsets calibrados (modo AR). */
export function cameraOffsetMatrix(calib: Calibration, out = new THREE.Matrix4()): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(THREE.MathUtils.degToRad(calib.pitchDeg), THREE.MathUtils.degToRad(calib.yawDeg), 0, 'YXZ'),
  );
  return out.compose(new THREE.Vector3(calib.offsetX, calib.offsetY, calib.offsetZ), q, new THREE.Vector3(1, 1, 1));
}

/** Suavizado exponencial de pose independiente de la tasa de inferencia. */
export class PoseSmoother {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly scale = new THREE.Vector3(1, 1, 1);
  private target = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3(1, 1, 1) };
  private hasTarget = false;
  private initialized = false;
  lastUpdate = 0;

  setTarget(m: THREE.Matrix4, now = performance.now()): void {
    m.decompose(this.target.p, this.target.q, this.target.s);
    this.hasTarget = true;
    this.lastUpdate = now;
    if (!this.initialized) {
      this.position.copy(this.target.p);
      this.quaternion.copy(this.target.q);
      this.scale.copy(this.target.s);
      this.initialized = true;
    }
  }

  reset(): void { this.initialized = false; this.hasTarget = false; }

  /** Avanza dtMs hacia el objetivo con constante de tiempo tauMs. */
  step(dtMs: number, tauMs: number): void {
    if (!this.hasTarget) return;
    const a = tauMs <= 0 ? 1 : 1 - Math.exp(-dtMs / tauMs);
    this.position.lerp(this.target.p, a);
    this.quaternion.slerp(this.target.q, a);
    this.scale.lerp(this.target.s, a);
  }

  applyTo(obj: THREE.Object3D): void {
    obj.position.copy(this.position);
    obj.quaternion.copy(this.quaternion);
    obj.scale.copy(this.scale);
  }
}
