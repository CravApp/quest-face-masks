# Quest Face Masks — prototipo v0.1

Prototipo web (Vite + TypeScript + three.js + `@mediapipe/tasks-vision`) que detecta un rostro con **MediaPipe Face Landmarker** y le coloca una **máscara 3D**. Usa la cámara passthrough de **Meta Quest 3 / 3S** desde Quest Browser y, en escritorio, la webcam. Requisitos completos: [`docs/SRS-v1.2.md`](docs/SRS-v1.2.md).

## Funciones

- `getQuestPassthroughStream()` (`src/camera.ts`):
  - pide el permiso primero, filtra las cámaras `facing back` y elige izquierda o derecha;
  - pide 1280×960 a 30 fps como `ideal` y, si hay `OverconstrainedError`, reintenta con `facingMode`;
  - si no hay passthrough, usa la webcam.
- **FaceLandmarker en Web Worker** (`src/vision/`):
  - modo `VIDEO` con `outputFacialTransformationMatrixes`;
  - delegado GPU con fallback a CPU;
  - fotogramas enviados como `ImageBitmap` transferidos;
  - si el worker falla, la inferencia pasa al hilo principal.
- **Escena three.js**:
  - máscara procedural (sin GLB externo) o un GLB cargado por URL (campo en la UI o `?glb=https://…`);
  - pose obtenida de la matriz facial y suavizada (lerp/slerp exponencial).
- **Overlay 2D de depuración**: los 478 landmarks y su caja sobre el vídeo.
- **Entrar en AR** (`immersive-ar`):
  - la máscara se coloca en el mundo como pose de la cabeza en el instante de captura × offset de cámara calibrado × matriz facial;
  - un HUD 3D muestra los FPS dentro del visor.
- **Calibración** guardada en `localStorage`: FOV, offsets XYZ, pitch/yaw, escala de profundidad, escala de máscara, suavizado y espejo.
- **Contadores de FPS** de render y de inferencia, más los ms por inferencia.

## Instalación y uso en escritorio

Requisitos: Node.js 20 o superior.

```bash
npm install
npm run dev        # copia el WASM a public/wasm, descarga el modelo si falta y arranca Vite en :5173
```

Abre `http://localhost:5173` y pulsa **Iniciar cámara + detector**.

Otros comandos:
- `npm run build`: comprueba tipos con `tsc --noEmit` y genera `dist/`.
- `npm run preview`: sirve `dist/` en `:4173`.

El modelo `face_landmarker.task` (float16) va incluido en `public/models/`. Si falta, se descarga en `predev`/`prebuild`, y si tampoco se puede, la app usa la URL remota de Google.

## Pruebas en Meta Quest 3 / 3S

1. Activa el modo desarrollador en el visor y conéctalo por USB (`adb devices` debe listarlo).
2. En el PC: `npm run dev`.
3. Redirige el puerto: `adb reverse tcp:5173 tcp:5173`.
4. En Quest Browser abre **`http://localhost:5173`**. `localhost` es contexto seguro, así que no hace falta HTTPS. Si entras por la IP de la red local, necesitas HTTPS con un certificado válido.
5. Concede el permiso de cámara. Si solo aparece la cámara del avatar o falla la cámara trasera, revisa **Ajustes → Privacidad y seguridad → Permisos de apps → "Headset cameras"** para Browser.
6. Elige "Quest passthrough derecha" (o Auto), pulsa **Iniciar cámara + detector** y después **Entrar en AR**.
7. Calibra con los sliders (FOV, offsets, profundidad) mirando a otra persona. Los valores se guardan en el visor.

Requisitos de dispositivo: solo Quest 3 o 3S, con el passthrough activado. La API nativa existe desde Horizon OS v74; para el navegador se cita v77 o superior en fuentes de terceros (**por verificar en visor**).

## Limitaciones conocidas

- **Verificado solo en escritorio** (Chrome headless, cámara simulada, render por software): build, tipos, worker GPU/CPU, fallback al hilo principal y alineación de la máscara con webcam. **Nada probado aún en un Quest.**
- Quest Browser **no implementa WebXR Raw Camera Access** (`camera-access`). La imagen llega por `getUserMedia` y no está alineada con las vistas XR. Por eso la colocación en AR depende de la calibración manual (FOV y offset de la cámara respecto a la cabeza).
- No se usa WebXR Hit Test: no sirve para fijar la profundidad de una cara. La profundidad sale de la matriz de MediaPipe, que asume un FOV de unos 63°, más el slider de escala de profundidad.
- **Por verificar en visor**:
  - si los fotogramas de `getUserMedia` siguen llegando durante `immersive-ar` (la captura usa temporizador y no `requestAnimationFrame` para no depender de ello);
  - qué cámara es la izquierda y cuál la derecha según la etiqueta (`camera 1` / `camera 2`);
  - si se pueden abrir ambas cámaras a la vez (el prototipo usa una);
  - la tasa real de inferencia: el objetivo es 30 fps o más, y hay que medirlo con el contador.
- Solo un sitio puede usar la cámara del visor a la vez, y al minimizar la ventana dejan de llegar fotogramas (Meta Help).
- El GLB debe estar en metros, centrado en la cabeza y mirando a +Z. Se convierte a las unidades del modelo canónico de MediaPipe (cm).
- La máscara procedural se ajustó al modelo canónico de MediaPipe (`canonical_face_model.obj`).

## Estructura

```
src/camera.ts            captura Quest/webcam
src/vision/              protocolo, worker, FaceLandmarker, detector con fallback
src/scene/pose.ts        matriz facial → pose, corrección de FOV, suavizado
src/scene/mask.ts        máscara procedural y cargador GLB
src/calibration.ts       parámetros persistidos
src/overlay.ts           overlay 2D
src/main.ts              UI, render loop, WebXR
docs/SRS-v1.2.md|pdf     especificación
```
