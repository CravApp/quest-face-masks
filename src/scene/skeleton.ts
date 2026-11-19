import * as THREE from 'three';
import type { Calibration } from '../calibration';
import type { ScaledIntrinsics, Vec3 } from './align-math';
import { OneEuroScalar } from './one-euro';
import {
  LEFT_HIP,
  LEFT_SHOULDER,
  POSE_CONNECTIONS,
  RIGHT_HIP,
  RIGHT_SHOULDER,
  SHOULDER_WIDTH_M,
  type PoseBody,
} from '../vision/pose-protocol';

const MIN_VIS = 0.4;

function at(data: Float32Array, index: number): { x: number; y: number; z: number; v: number } | null {
  const o = index * 4;
  if (o + 3 >= data.length) return null;
  return { x: data[o], y: data[o + 1], z: data[o + 2], v: data[o + 3] };
}

/** Profundidad del ancla (cadera) a partir del ancho de hombros. Hip en espacio GL de la cámara. */
export function hipAnchor(body: PoseBody, k: ScaledIntrinsics, depthScale: number): Vec3 | null {
  const a = at(body.norm, LEFT_SHOULDER);
  const b = at(body.norm, RIGHT_SHOULDER);
  if (!a || !b || a.v < MIN_VIS || b.v < MIN_VIS) return null;
  const u0 = a.x * k.width;
  const v0 = a.y * k.height;
  const u1 = b.x * k.width;
  const v1 = b.y * k.height;
  const dist = Math.hypot(u1 - u0, v1 - v0);
  if (dist < 4 || k.fx <= 0) return null;
  const z = (k.fx * SHOULDER_WIDTH_M / dist) * depthScale;
  const hipL = at(body.norm, LEFT_HIP);
  const hipR = at(body.norm, RIGHT_HIP);
  const u = hipL && hipR ? ((hipL.x + hipR.x) / 2) * k.width : (u0 + u1) / 2;
  const v = hipL && hipR ? ((hipL.y + hipR.y) / 2) * k.height : (v0 + v1) / 2;
  const x = ((u - k.cx) / k.fx) * z;
  const y = ((v - k.cy) / k.fy) * z;
  return { x, y: -y, z: -z };
}

/**
 * Articulación en el espacio GL de la cámara.
 * worldLandmarks: origen en la cadera, x a la derecha, y hacia abajo, z hacia la cámara
 * (más pequeño = más cerca). Se suma al ancla como (x, -y, z).
 */
export function jointInCamera(body: PoseBody, index: number, hip: Vec3): Vec3 | null {
  const world = at(body.world, index);
  const norm = at(body.norm, index);
  if (!world || (norm && norm.v < MIN_VIS)) return null;
  return { x: hip.x + world.x, y: hip.y - world.y, z: hip.z + world.z };
}

const tmp = new THREE.Vector3();
const camPos = new THREE.Vector3();
const camQuat = new THREE.Quaternion();
const extrinsic = new THREE.Matrix4();

export class BodyView {
  readonly group = new THREE.Group();
  private positions = new Float32Array(35 * 2 * 2 * 3);
  private geometry = new THREE.BufferGeometry();
  private filters: OneEuroScalar[] = [];
  private seenAt = 0;
  people = 0;

  constructor() {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const line = new THREE.LineSegments(this.geometry, new THREE.LineBasicMaterial({ color: 0x7cf0ff }));
    const dots = new THREE.Points(this.geometry, new THREE.PointsMaterial({ color: 0xffe66b, size: 0.015 }));
    this.group.add(line, dots);
    this.group.visible = false;
    this.group.matrixAutoUpdate = false;
  }

  reset(): void {
    this.filters.forEach((filter) => filter.reset());
    this.group.visible = false;
    this.people = 0;
    this.seenAt = 0;
  }

  get fresh(): boolean {
    return this.group.visible && performance.now() - this.seenAt < 500;
  }

  hideIfStale(): void {
    if (this.group.visible && performance.now() - this.seenAt >= 500) {
      this.group.visible = false;
      this.filters.forEach((filter) => filter.reset());
    }
  }

  /**
   * Coloca hasta dos cuerpos. En AR, cada punto pasa por extrínseca y por la pose del visor
   * en captureTime. En escritorio el grupo se oculta: el esqueleto va al overlay 2D.
   */
  update(opts: {
    bodies: PoseBody[];
    width: number;
    height: number;
    k: ScaledIntrinsics | null;
    calib: Calibration;
    head: THREE.Matrix4 | null;
    presenting: boolean;
    captureTime: number | null;
  }): void {
    if (!opts.presenting || !opts.k || !opts.head) {
      this.group.visible = false;
      return;
    }
    const count = Math.min(2, opts.bodies.length);
    this.people = opts.bodies.length;
    camQuat.setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(opts.calib.pitchDeg),
      THREE.MathUtils.degToRad(opts.calib.yawDeg),
      0,
      'YXZ',
    ));
    camPos.set(
      opts.k.translationM[0] + opts.calib.offsetX,
      opts.k.translationM[1] + opts.calib.offsetY,
      opts.k.translationM[2] + opts.calib.offsetZ,
    );
    extrinsic.compose(camPos, camQuat, new THREE.Vector3(1, 1, 1));
    extrinsic.premultiply(opts.head);
    const tSec = (opts.captureTime ?? performance.now()) / 1000;
    let written = 0;
    this.positions.fill(0);
    for (let bodyIndex = 0; bodyIndex < count; bodyIndex++) {
      const body = opts.bodies[bodyIndex];
      const hip = hipAnchor(body, opts.k, opts.calib.depthScale);
      if (!hip) continue;
      const placed = new Map<number, Vec3>();
      const place = (index: number): Vec3 | null => {
        const cached = placed.get(index);
        if (cached) return cached;
        const raw = jointInCamera(body, index, hip);
        if (!raw) return null;
        const point = this.filterJoint(bodyIndex, index, raw, tSec);
        placed.set(index, point);
        return point;
      };
      for (const [start, end] of POSE_CONNECTIONS) {
        const a = place(start);
        const b = place(end);
        if (!a || !b) continue;
        this.put(written++, a);
        this.put(written++, b);
      }
    }
    this.geometry.setDrawRange(0, written);
    this.geometry.attributes.position.needsUpdate = true;
    if (written > 0) this.geometry.computeBoundingSphere();
    this.group.visible = written > 0;
    this.seenAt = performance.now();
  }

  private filterJoint(bodyIndex: number, joint: number, point: Vec3, tSec: number): Vec3 {
    tmp.set(point.x, point.y, point.z).applyMatrix4(extrinsic);
    const key = bodyIndex * 33 + joint;
    while (this.filters.length < (key + 1) * 3) this.filters.push(new OneEuroScalar(1.5, 0.04));
    const base = key * 3;
    return {
      x: this.filters[base].filter(tmp.x, tSec),
      y: this.filters[base + 1].filter(tmp.y, tSec),
      z: this.filters[base + 2].filter(tmp.z, tSec),
    };
  }

  private put(slot: number, point: Vec3): void {
    const base = slot * 3;
    this.positions[base] = point.x;
    this.positions[base + 1] = point.y;
    this.positions[base + 2] = point.z;
  }
}
