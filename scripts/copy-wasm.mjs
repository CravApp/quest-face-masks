// Copia los binarios WASM de @mediapipe/tasks-vision a public/wasm (se ejecuta antes de dev/build).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
const src = 'node_modules/@mediapipe/tasks-vision/wasm';
const dst = 'public/wasm';
if (!existsSync(src)) { console.error('No se encontró', src, '— ejecuta npm install'); process.exit(1); }
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log('WASM de MediaPipe copiado a', dst);
