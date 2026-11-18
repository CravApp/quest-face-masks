import * as THREE from 'three';
import type { Calibration } from '../calibration';
import type { ResultMsg } from '../vision/protocol';
import {
  eyePair,
  monoFaceGl,
  scaleFactoryIntrinsics,
  triangulateEyes,
  type ScaledIntrinsics,
  type Vec3,
} from './align-math';

const tmpMat = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const faceQuat = new THREE.Quaternion();
const camQuat = new THREE.Quaternion();
const camPos = new THREE.Vector3();
const faceLocal = new THREE.Matrix4();
const extrinsic = new THREE.Matrix4();

export function scaledFor(eye: 'left' | 'right', width: number, height: number): ScaledIntrinsics {
  return scaleFactoryIntrinsics(eye, width, height);
}

function readFaceQuat(matrix: number[] | null): boolean {
  if (!matrix) return false;
  tmpMat.fromArray(matrix);
  tmpMat.decompose(tmpPos, faceQuat, tmpScale);
  return true;
}

function calibQuat(calib: Calibration): THREE.Quaternion {
  return camQuat.setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(calib.pitchDeg),
    THREE.MathUtils.degToRad(calib.yawDeg),
    0,
    'YXZ',
  ));
}

function vec(v: Vec3, out = tmpPos): THREE.Vector3 {
  return out.set(v.x, v.y, v.z);
}

/**
 * Pose de la máscara en el espacio de la cabeza (todavía sin la pose del visor).
 * Mono: intrínsecos + traslación de fábrica. Estéreo: triangulación, si vino un punto.
 */
export function maskInHead(
  result: ResultMsg,
  k: ScaledIntrinsics,
  calib: Calibration,
  stereoHead: Vec3 | null,
  out = new THREE.Matrix4(),
): THREE.Matrix4 | null {
  if (!result.landmarks || !readFaceQuat(result.matrix)) return null;
  const pair = eyePair(result.landmarks, result.width, result.height);
  if (!pair) return null;
  const s = 0.01 * calib.maskScale;
  tmpScale.set(s, s, s);
  calibQuat(calib);
  if (stereoHead) {
    vec(stereoHead, tmpPos);
    tmpQuat.copy(camQuat).multiply(faceQuat);
    return out.compose(tmpPos, tmpQuat, tmpScale);
  }
  const mono = monoFaceGl(pair, k, calib.depthScale);
  if (!mono) return null;
  vec(mono, tmpPos);
  faceLocal.compose(tmpPos, faceQuat, tmpScale);
  camPos.set(
    k.translationM[0] + calib.offsetX,
    k.translationM[1] + calib.offsetY,
    k.translationM[2] + calib.offsetZ,
  );
  extrinsic.compose(camPos, camQuat, new THREE.Vector3(1, 1, 1));
  return out.copy(extrinsic).multiply(faceLocal);
}

export function stereoHeadPoint(left: ResultMsg, right: ResultMsg, kL: ScaledIntrinsics, kR: ScaledIntrinsics): Vec3 | null {
  if (!left.landmarks || !right.landmarks) return null;
  const a = eyePair(left.landmarks, left.width, left.height);
  const b = eyePair(right.landmarks, right.width, right.height);
  if (!a || !b) return null;
  return triangulateEyes(a, kL, b, kR);
}
