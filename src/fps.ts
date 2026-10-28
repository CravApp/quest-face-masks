/** Contador de FPS con ventana deslizante de 1 s. */
export class FpsCounter {
  private stamps: number[] = [];
  tick(now = performance.now()): void {
    this.stamps.push(now);
    while (this.stamps.length && now - this.stamps[0] > 1000) this.stamps.shift();
  }
  get fps(): number {
    const now = performance.now();
    while (this.stamps.length && now - this.stamps[0] > 1000) this.stamps.shift();
    return this.stamps.length;
  }
}
