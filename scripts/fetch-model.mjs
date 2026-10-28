// Descarga el modelo face_landmarker.task a public/models si no existe.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const url = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const dst = 'public/models/face_landmarker.task';
if (existsSync(dst)) process.exit(0);
mkdirSync('public/models', { recursive: true });
const res = await fetch(url);
if (!res.ok) { console.warn('No se pudo descargar el modelo (' + res.status + '). La app intentará usar la URL remota.'); process.exit(0); }
writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
console.log('Modelo descargado en', dst);
