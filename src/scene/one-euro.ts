/**
 * Filtro One Euro (Casiez et al.) para una pose 3D.
 * minCutoff alto = menos suavizado. beta sube el corte cuando hay velocidad.
 */

function smoothingAlpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * Math.max(cutoffHz, 1e-3));
  return 1 / (1 + tau / Math.max(dtSec, 1e-4));
}

class LowPass {
  private y = 0;
  primed = false;
  filter(value: number, alpha: number): number {
    this.y = this.primed ? alpha * value + (1 - alpha) * this.y : value;
    this.primed = true;
    return this.y;
  }
  reset(): void { this.primed = false; }
  get value(): number { return this.y; }
}

export class OneEuroScalar {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private x = new LowPass();
  private dx = new LowPass();
  private lastT = 0;
  constructor(minCutoff = 1.2, beta = 0.04, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.lastT = 0;
  }

  setTuning(minCutoff: number, beta: number): void {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }

  filter(value: number, tSec: number): number {
    const dt = this.lastT > 0 ? Math.max(tSec - this.lastT, 1e-3) : 1 / 30;
    this.lastT = tSec;
    const derivative = this.x.primed ? (value - this.x.value) / dt : 0;
    const speed = this.dx.filter(derivative, smoothingAlpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(speed);
    return this.x.filter(value, smoothingAlpha(cutoff, dt));
  }
}

export interface PoseSample {
  p: [number, number, number];
  q: [number, number, number, number];
}

/** Suaviza posición y cuaternión. El cuaternión se filtra componente a componente y se renormaliza. */
export class OneEuroPose {
  private px = new OneEuroScalar();
  private py = new OneEuroScalar();
  private pz = new OneEuroScalar();
  private qx = new OneEuroScalar();
  private qy = new OneEuroScalar();
  private qz = new OneEuroScalar();
  private qw = new OneEuroScalar();
  private prev: PoseSample | null = null;
  readonly current: PoseSample = { p: [0, 0, 0], q: [0, 0, 0, 1] };
  hasValue = false;

  constructor(minCutoff = 1.2, beta = 0.04) {
    this.setGains(minCutoff, beta);
  }

  setGains(minCutoff: number, beta = 0.04): void {
    const cutoff = Math.max(0.05, minCutoff);
    for (const f of [this.px, this.py, this.pz, this.qx, this.qy, this.qz, this.qw]) f.setTuning(cutoff, beta);
  }

  reset(): void {
    for (const f of [this.px, this.py, this.pz, this.qx, this.qy, this.qz, this.qw]) f.reset();
    this.prev = null;
    this.hasValue = false;
  }

  /** minCutoff derivado del slider de suavizado: 80 ms → ~1,5 Hz. */
  static cutoffFromMs(smoothingMs: number): number {
    if (smoothingMs <= 0) return 30;
    return Math.min(30, 120 / smoothingMs);
  }

  filter(sample: PoseSample, tSec: number): PoseSample {
    let [x, y, z, w] = sample.q;
    if (this.prev) {
      const dot = this.prev.q[0] * x + this.prev.q[1] * y + this.prev.q[2] * z + this.prev.q[3] * w;
      if (dot < 0) { x = -x; y = -y; z = -z; w = -w; }
    }
    const p: [number, number, number] = [
      this.px.filter(sample.p[0], tSec),
      this.py.filter(sample.p[1], tSec),
      this.pz.filter(sample.p[2], tSec),
    ];
    const qf: [number, number, number, number] = [
      this.qx.filter(x, tSec),
      this.qy.filter(y, tSec),
      this.qz.filter(z, tSec),
      this.qw.filter(w, tSec),
    ];
    const len = Math.hypot(qf[0], qf[1], qf[2], qf[3]) || 1;
    const q: [number, number, number, number] = [qf[0] / len, qf[1] / len, qf[2] / len, qf[3] / len];
    this.prev = { p, q };
    this.current.p = p;
    this.current.q = q;
    this.hasValue = true;
    return this.current;
  }
}
