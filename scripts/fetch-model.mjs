// Descarga los modelos de MediaPipe a public/models si no existen.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const models = [
  {
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    dst: 'public/models/face_landmarker.task',
  },
  {
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    dst: 'public/models/pose_landmarker_lite.task',
  },
];

mkdirSync('public/models', { recursive: true });
for (const model of models) {
  if (existsSync(model.dst)) continue;
  const res = await fetch(model.url);
  if (!res.ok) {
    console.warn(`No se pudo descargar ${model.dst} (${res.status}). Se usará la URL remota si hace falta.`);
    continue;
  }
  writeFileSync(model.dst, Buffer.from(await res.arrayBuffer()));
  console.log('Modelo descargado en', model.dst);
}
