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
5. Elige «Quest passthrough derecha» (o Auto), pulsa **Iniciar cámara + detector** y después **Entrar en AR**.
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
src/debug/remote.ts      log remoto (dev y ?log=)
src/vision/              protocolo, worker, FaceLandmarker, detector con fallback
vite/                    HTTPS de LAN, logger del dev server y proxy de chii
src/scene/pose.ts        matriz facial → pose, corrección de FOV, suavizado
src/scene/mask.ts        máscara procedural y cargador GLB
src/calibration.ts       parámetros persistidos
src/overlay.ts           overlay 2D
src/main.ts              UI, render loop, WebXR
docs/SRS-v1.2.md|pdf     especificación
```
