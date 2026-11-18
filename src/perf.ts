/** Muestras del último segundo: media, p95 y cuántas cayeron en la ventana. */
export class Series {
  private rows: { t: number; v: number }[] = [];

  push(value: number, now = performance.now()): void {
    this.rows.push({ t: now, v: value });
    this.trim(now);
  }

  private trim(now: number): void {
    while (this.rows.length && now - this.rows[0].t > 1000) this.rows.shift();
  }

  count(now = performance.now()): number {
    this.trim(now);
    return this.rows.length;
  }

  mean(now = performance.now()): number {
    this.trim(now);
    if (!this.rows.length) return 0;
    let sum = 0;
    for (const row of this.rows) sum += row.v;
    return sum / this.rows.length;
  }

  p95(now = performance.now()): number {
    this.trim(now);
    if (!this.rows.length) return 0;
    const values = this.rows.map((row) => row.v).sort((a, b) => a - b);
    const index = Math.min(values.length - 1, Math.max(0, Math.ceil(0.95 * values.length) - 1));
    return values[index];
  }
}
