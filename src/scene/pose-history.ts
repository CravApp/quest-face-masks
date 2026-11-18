import type { PoseSample } from './one-euro';

interface Sample extends PoseSample { t: number }

function slerp(a: PoseSample['q'], b: PoseSample['q'], u: number): PoseSample['q'] {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  if (dot > 0.9995) {
    const x = a[0] + u * (bx - a[0]);
    const y = a[1] + u * (by - a[1]);
    const z = a[2] + u * (bz - a[2]);
    const w = a[3] + u * (bw - a[3]);
    const len = Math.hypot(x, y, z, w) || 1;
    return [x / len, y / len, z / len, w / len];
  }
  const theta = Math.acos(Math.min(1, dot));
  const s = Math.sin(theta);
  const wa = Math.sin((1 - u) * theta) / s;
  const wb = Math.sin(u * theta) / s;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

/** Historial corto de la pose del visor, indexado por el reloj de XR (el mismo que captureTime). */
export class PoseHistory {
  private samples: Sample[] = [];
  private horizonMs: number;
  constructor(horizonMs = 2000) { this.horizonMs = horizonMs; }

  clear(): void { this.samples.length = 0; }

  push(t: number, pose: PoseSample): void {
    const last = this.samples[this.samples.length - 1];
    if (last && t < last.t) return;
    this.samples.push({ t, p: pose.p, q: pose.q });
    const cutoff = t - this.horizonMs;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
  }

  /** Interpola la muestra que rodea t. Si t es posterior a la última, devuelve la última. */
  at(t: number): PoseSample | null {
    const n = this.samples.length;
    if (!n) return null;
    if (t <= this.samples[0].t) return this.samples[0];
    const last = this.samples[n - 1];
    if (t >= last.t) return last;
    let hi = 1;
    while (hi < n && this.samples[hi].t < t) hi++;
    const b = this.samples[hi];
    const a = this.samples[hi - 1];
    const span = b.t - a.t || 1;
    const u = (t - a.t) / span;
    return {
      p: [
        a.p[0] + (b.p[0] - a.p[0]) * u,
        a.p[1] + (b.p[1] - a.p[1]) * u,
        a.p[2] + (b.p[2] - a.p[2]) * u,
      ],
      q: slerp(a.q, b.q, u),
    };
  }
}
