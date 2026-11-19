import type { ResultMsg } from './vision/protocol';
import { POSE_CONNECTIONS, type PoseBody } from './vision/pose-protocol';

const MIN_VIS = 0.4;

/** Dibuja los landmarks normalizados sobre un canvas 2D del tamaño del vídeo. */
export function drawOverlay(
  canvas: HTMLCanvasElement,
  face: ResultMsg | null,
  bodies: PoseBody[] | null,
  mirrored = false,
  width = face?.width ?? 0,
  height = face?.height ?? 0,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = width || canvas.width;
  const h = height || canvas.height;
  if (w && h && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (face?.landmarks) drawFace(ctx, face.landmarks, canvas.width, canvas.height, mirrored);
  if (bodies?.length) {
    for (const body of bodies) drawBody(ctx, body, canvas.width, canvas.height);
  }
}

function drawFace(ctx: CanvasRenderingContext2D, lm: Float32Array, w: number, h: number, mirrored: boolean): void {
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
    ctx.save();
    ctx.scale(-1, 1);
    ctx.fillText(label, -maxX * w, ty);
    ctx.restore();
  } else {
    ctx.fillText(label, minX * w, ty);
  }
}

function drawBody(ctx: CanvasRenderingContext2D, body: PoseBody, w: number, h: number): void {
  const point = (index: number): { x: number; y: number; v: number } | null => {
    const o = index * 4;
    if (o + 3 >= body.norm.length) return null;
    return { x: body.norm[o] * w, y: body.norm[o + 1] * h, v: body.norm[o + 3] };
  };
  ctx.strokeStyle = 'rgba(120, 220, 255, 0.95)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (const [start, end] of POSE_CONNECTIONS) {
    const a = point(start);
    const b = point(end);
    if (!a || !b || a.v < MIN_VIS || b.v < MIN_VIS) continue;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 230, 80, 0.95)';
  for (let index = 0; index < body.norm.length / 4; index++) {
    const p = point(index);
    if (!p || p.v < MIN_VIS) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}
