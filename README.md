# Quest Face Masks — v0.2

Prototipo web (Vite + TypeScript + three.js + `@mediapipe/tasks-vision`) que detecta un rostro con **MediaPipe Face Landmarker** y le coloca una **máscara 3D**. En Quest Browser usa la cámara passthrough **izquierda** (`camera 1, facing back`) a 1280×960@30. En escritorio usa la webcam. Lo que cambió tras el spike de cámaras está en [`docs/mejoras-v1.3.md`](docs/mejoras-v1.3.md). Requisitos de partida: [`docs/SRS-v1.2.md`](docs/SRS-v1.2.md).

## Funciones

- `getBestCamera()` (`src/camera.ts`):
  - en auto elige la passthrough **izquierda** (`camera 1, facing back`); si no hay, cualquier `facing back`; si tampoco, la webcam;
  - pide 1280×960 o 640×480 con `frameRate` ideal 30 y máximo 30 (en el Quest, 60 exacto da `OverconstrainedError` y 60 ideal entrega 30);
  - el estéreo experimental abre la otra passthrough y solo triangula si `|Δ captureTime| < 5 ms`.
- **FaceLandmarker desacoplado del render XR** (`src/vision/`):
  - la cadencia la marca `requestVideoFrameCallback`, con tope de Hz;
  - si existe `MediaStreamTrackProcessor`, el worker lee `VideoFrame` y no toca el `requestAnimationFrame` de la sesión;
  - si no, manda `ImageBitmap` al worker; si el worker falla, el hilo principal infiere en un `setTimeout`, nunca dentro del frame de XR;
  - un fotograma en vuelo como máximo: el último gana y el resto se descarta.
- **Escena three.js**:
  - máscara procedural (sin GLB externo) o un GLB cargado por URL (campo en la UI o `?glb=https://…`);
  - en escritorio la pose sale de la matriz facial de MediaPipe;
  - en `immersive-ar` la posición sale de los intrínsecos de fábrica (recorte centrado 1728×1296) y de la profundidad monocular por la distancia entre iris, puesta en el mundo con la pose del visor más cercana a `captureTime`;
  - suavizado con filtro **One Euro** (el slider de ms cambia el corte mínimo).
- **Overlay 2D de depuración**: los 478 landmarks y su caja sobre el vídeo.
- **Entrar en AR** (`immersive-ar`, con `local-floor` y `hand-tracking` opcionales):
  - el HUD 3D muestra fps de XR, fps de cámara, Hz y ms de inferencia (media y p95), latencia `now − captureTime` y descartes.
- **Calibración** guardada en `localStorage`: FOV (escritorio), offsets XYZ, pitch/yaw, escala de profundidad (mono), escala de máscara, suavizado y espejo.
- **Parámetros de URL**: `res=640x480`, `infer=20`, `gpu=0`, `worker=0`, `stereo=1`, `overlay=1`, `cam=left|right|webcam`, y `?log=` / `?glb=` como antes.

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

## Pruebas en Meta Quest 3 / 3S por Wi-Fi (sin cable)

`getUserMedia` y WebXR necesitan un contexto seguro. `http://IP` no lo es. `npm run dev:lan` levanta el mismo Vite en HTTPS con un certificado autofirmado (la IP de la LAN va en el certificado) e imprime las URL. `npm run dev` no cambia: sigue siendo `http://localhost:5173` para el escritorio.

El PC y el visor tienen que estar en la misma red. En Windows hay que dejar entrar el puerto **5173** en el Firewall (el aviso de la primera vez, o una regla de entrada TCP 5173). Sin eso el visor no llega al PC.

1. En el PC (PowerShell o cmd, sin instalaciones de administrador):

   ```bash
   npm install
   npm run dev:lan
   ```

2. Anota la línea `https://192.168.x.x:5173/` (o la IP que imprima; por ejemplo `https://10.50.41.87:5173/`).
3. En Quest Browser abre esa URL. El certificado es autofirmado: en el aviso de conexión no privada elige la opción avanzada y continúa al sitio. La redacción exacta depende del idioma del visor.
4. Concede el permiso de cámara. Si el banner rojo dice que se denegó, o que no hay cámaras «facing back», abre **Ajustes → Privacidad y seguridad → Permisos de apps → Browser → «Headset cameras»**. La cámara «facing front» es la del avatar y no ve la sala. El mismo texto queda en el panel de la página y en el log del PC.
5. Deja Auto (passthrough izquierda) o elige la cámara, pulsa **Iniciar cámara + detector** y después **Entrar en AR**. El tope de inferencia por defecto es 20 Hz para no bajar el render. Cómo leer el HUD: [`docs/mejoras-v1.3.md`](docs/mejoras-v1.3.md).
6. Calibra con los sliders mirando a otra persona. Los valores se guardan en el visor.

### Ver la consola del visor desde el PC

Con `dev:lan` (y también con `npm run dev`) la página envía al propio servidor, por el mismo origen:

- `console.log` / `info` / `warn` / `error` / `debug`
- errores de `window` con archivo, línea, columna y stack
- promesas rechazadas sin `catch`
- `fetch` que falla
- un registro de arranque (userAgent, WebXR) y, tras el permiso, la lista de cámaras, la elegida y la resolución del vídeo
- inicio, fin y errores de la sesión `immersive-ar`
- FPS de render e inferencia cada 2 s

El servidor los añade a `debug-logs/device.jsonl` (no se versiona) y los imprime en la terminal con el prefijo `[quest-debug]`. No se envía ningún fotograma.

Para ejecutar JavaScript en la página que esté abierta en el visor, copia el token que imprime el servidor (también está en `debug-logs/token`) y, desde el PC:

```bash
curl.exe -k -X POST https://localhost:5173/__debug/eval -H "content-type: application/json" -H "x-debug-token: TOKEN" -d "{\"code\":\"navigator.userAgent\"}"
```

El resultado vuelve en la respuesta y queda en el jsonl. `https://localhost` evita el firewall; el visor tiene que tener la página abierta. Si hay varias, se usa la que hizo poll más reciente. Puedes fijar una con `"clientId"` (sale en el log al conectar). El estado de los clientes está en `https://localhost:5173/__debug/status`.

Ese canal solo existe en el servidor de desarrollo. Un build de producción no lo incluye salvo que exportes `VITE_REMOTE_DEBUG=1` al construir (y sirvas tú los endpoints).

### DevTools remoto con chii (opcional)

En otra terminal, sin instalación global:

```bash
npm run chii
```

Eso ejecuta `chii` en el puerto 8080 con la base `/__chii`. Vite hace de proxy de ese proceso bajo el mismo origen (`/__chii/target.js` y el WebSocket), así el visor no mezcla http con https. Al recargar la página, si chii responde, se inyecta el script. Abre `http://localhost:8080/__chii/` en el PC y elige el visor. Para forzar la inyección aunque el sondeo falle: `CHII=1` antes de `npm run dev:lan` (en PowerShell, `$env:CHII='1'`).

### Por USB, si adb sí conecta

1. Modo desarrollador y `adb devices`.
2. `npm run dev` (HTTP, sin certificado).
3. `adb reverse tcp:5173 tcp:5173`.
4. En el visor, `http://localhost:5173`. `localhost` ya es contexto seguro.

Requisitos de dispositivo: solo Quest 3 o 3S, con el passthrough activado. La API nativa existe desde Horizon OS v74; para el navegador se cita v77 o superior en fuentes de terceros (**por verificar en visor**).

## GitHub Pages

Cada push a `main`, y el disparo manual del workflow **Publicar en GitHub Pages**, construye con la base que reporta Pages (`/quest-face-masks/`) y publica en:

https://cravapp.github.io/quest-face-masks/

Esa base es la que usa el cliente para pedir el WASM de MediaPipe, `face_landmarker.task` y el worker (`import.meta.env.BASE_URL`). Un `npm run build` local, sin `VITE_BASE`, sigue generando `dist/` en la raíz `/`.

Pages no tiene servidor de logs. La página no envía nada salvo que la abras con `?log=` apuntando a un logger HTTPS (el del ejemplo acepta `POST /log` con un JSON y un WebSocket en `/rlog-ws`, con CORS `*`):

https://cravapp.github.io/quest-face-masks/?log=https://10.50.41.87:8443

Sustituye la IP por la del PC. Cada evento es un JSON (`t`, `level`, `kind`, `message`, `href`, `clientId` y, si aplica, `file` / `line` / `col` / `stack` / `data`). Si `/rlog-ws` está abierto se manda por ahí; si no, con `POST /log`. Antes, abre `https://10.50.41.87:8443` en el visor y acepta su certificado, o el navegador bloqueará el envío. Sin el parámetro `log` no hay ninguna petición de diagnóstico. Tampoco se envían fotogramas ni landmarks.

## Limitaciones conocidas

- El spike en Quest 3 (Browser 157, Horizon OS v209) ya midió cámaras, sincronía e inferencia. Esta versión **aún no se ha vuelto a medir en el visor** después de desacoplar el render. El objetivo a comprobar es XR ≥ 60 fps con inferencia ≥ 15 Hz. Detalle y tabla de resultados: [`docs/mejoras-v1.3.md`](docs/mejoras-v1.3.md).
- Quest Browser **no implementa WebXR Raw Camera Access** (`camera-access`). Los intrínsecos no vienen en `getSettings`; se usan los de fábrica del sensor 1728×1728, con el recorte 4:3 supuesto.
- El estéreo del navegador no está bien sincronizado (mediana ~14 ms). Por defecto la profundidad es monocular. El estéreo solo triangula si un par cae por debajo de 5 ms.
- No se usa WebXR Hit Test: no sirve para fijar la profundidad de una cara.
- En escritorio (webcam) la máscara sigue la matriz facial de MediaPipe, no los intrínsecos del Quest.
- Solo un sitio puede usar la cámara del visor a la vez, y al minimizar la ventana dejan de llegar fotogramas (Meta Help).
- El GLB debe estar en metros, centrado en la cabeza y mirando a +Z. Se convierte a las unidades del modelo canónico de MediaPipe (cm).
- La máscara procedural se ajustó al modelo canónico de MediaPipe (`canonical_face_model.obj`).

## Estructura

```
src/camera.ts            captura Quest (izquierda) / webcam / estéreo opcional
src/debug/remote.ts      log remoto (dev y ?log=)
src/vision/              worker, stream de VideoFrame, bomba por rVFC
src/scene/align-math.ts  intrínsecos escalados, profundidad mono y triangulación
src/scene/place.ts       pose de la máscara en el espacio de la cabeza
src/scene/one-euro.ts    suavizado One Euro
src/scene/pose-history.ts  historial de la pose del visor
src/scene/pose.ts        matriz facial → espacio de cámara (escritorio)
src/perf.ts              media y p95 del último segundo
vite/                    HTTPS de LAN, logger del dev server y proxy de chii
src/scene/mask.ts        máscara procedural y cargador GLB
src/main.ts              UI, render XR, HUD
docs/SRS-v1.2.md         especificación de partida
docs/mejoras-v1.3.md     decisiones tras el spike
```
