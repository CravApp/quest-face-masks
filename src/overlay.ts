import type { ResultMsg } from './vision/protocol';

/** Dibuja los landmarks normalizados sobre un canvas 2D del tamaño del vídeo. */
export function drawOverlay(canvas: HTMLCanvasElement, r: ResultMsg | null, mirrored = false): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (r && (canvas.width !== r.width || canvas.height !== r.height)) {
    canvas.width = r.width;
    canvas.height = r.height;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!r?.landmarks) return;
  const lm = r.landmarks;
  const w = canvas.width, h = canvas.height;
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  ctx.fillStyle = 'rgba(0,255,170,0.85)';
  for (let i = 0; i < lm.length; i += 3) {
    const x = lm[i], y = lm[i + 1];
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    ctx.fillRect(x * w - 1, y * h - 1, 2, 2);
  }
  ctx.strokeStyle = 'rgba(255,200,0,0.9)';
  ctx.lineWidth = 2;
  ctx.strokeRect(minX * w, minY * h, (maxX - minX) * w, (maxY - minY) * h);
  ctx.fillStyle = 'rgba(255,200,0,0.95)';
  ctx.font = `${Math.round(h / 30)}px sans-serif`;
  const label = `${lm.length / 3} landmarks`;
  const ty = Math.max(12, minY * h - 6);
  if (mirrored) {
    // El stage se espeja por CSS: des-espejar solo el texto para que sea legible.
    ctx.save();
    ctx.scale(-1, 1);
    ctx.fillText(label, -maxX * w, ty);
    ctx.restore();
  } else {
    ctx.fillText(label, minX * w, ty);
  }
}
