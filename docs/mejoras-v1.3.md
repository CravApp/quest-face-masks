# Mejoras v1.3 — máscaras alineadas sin frenar el render

Versión de la app: **0.2.0**. Parte del SRS v1.2 y de lo medido con el spike de cámaras (PR #3, Quest 3, Horizon OS v209, Quest Browser 157.0.0.22.15, Chromium 157.0.8103.38).

## Qué midió el spike

| Paso | Resultado | Qué significa para la app |
| --- | --- | --- |
| a | Pasa. Tras el permiso hay 3 `videoinput`: `camera 1, facing back` (izquierda), `camera 2, facing back` (derecha) y la del avatar. Caps de ancho/alto 1…1728, `frameRate` máximo 30, `resizeMode` `none`\|`crop-and-scale`, foco manual, exposición y balance continuos. | La passthrough izquierda se elige por etiqueta, no por índice. No pedir más de 30 fps. |
| b | Pasa. Las dos abren a la vez a 1280×960@30. 60 exacto → `OverconstrainedError`. 60 ideal se aplica pero entrega 30. `requestVideoFrameCallback`: 29,8 fps por ojo y `captureTime` en el 100 % de los fotogramas. | Resolución de trabajo 1280×960 con tope de 30 fps. `captureTime` sirve para emparejar con la pose del visor. |
| c | Falla la sincronía fina. Con `captureTime` (y también `mediaTime`, `presentationTime`, `expectedDisplayTime` y `VideoFrame.timestamp`), mediana del Δ izquierda/derecha ~14 ms, p95 \|Δ\| ~28 ms, 0 % de pares bajo 1 ms, igual pidiendo 60 o 30. | El navegador no da un par estéreo a 60 Hz como Camera2. La profundidad por defecto es monocular. |
| d | No hay intrínsecos ni pose en `getSettings`. | Hay que usar las constantes de fábrica de `spike/cameras/intrinsics.ts`. |
| e | Pasa, con un pero. `immersive-ar` arranca (mezcla alpha). `enabledFeatures`: `local`, `viewer`, `hand-tracking`, `local-floor`. `camera-access` no está y `XRView.camera` no existe. Las cámaras siguen dentro de la sesión, pero todo iba a ~19 fps: XR 19,0 fps, cámara 18,9 fps (29,9 antes de entrar). PoseLandmarker lite en GPU, dentro del rAF de XR: media 20,8 ms, p95 25,3 ms, 19 Hz. | La inferencia no puede vivir en el `requestAnimationFrame` de la sesión: se come el render. |

En nativo (Camera2, fuera del navegador) las dos cámaras a 60 Hz comparten reloj y el 99,8 % de los pares cae por debajo de 1 ms. Eso el navegador no lo reproduce.

## Decisiones

1. **Cámara.** En auto se abre la passthrough izquierda. Si no está, cualquier `facing back`. Si no hay passthrough (escritorio), la webcam. Se pide `frameRate: { ideal: 30, max: 30 }` a 1280×960, con opción 640×480. Nunca 60 exacto.
2. **Inferencia fuera del frame de XR.** La cadencia es `requestVideoFrameCallback` con un tope (por defecto 20 Hz, para dejar margen al objetivo de ≥ 15 Hz sin ocupar cada frame). El worker, si puede, lee `VideoFrame` con `MediaStreamTrackProcessor`. Si no, recibe `ImageBitmap`. Si el worker no arranca, el hilo principal llama a `detectForVideo` desde un `setTimeout`, nunca desde el callback de la sesión. Un fotograma en vuelo: el más nuevo sustituye al que esperaba y el viejo se tira.
3. **Alineación.** El navegador no da fx/cx. Se escalan los intrínsecos de fábrica del sensor 1728×1728. Suposición, documentada en `src/scene/align-math.ts`: recorte **centrado** a 1728×1296 (se descartan 216 px arriba y 216 abajo) y escala `outWidth / 1728`. Para 1280×960 esa escala es 1280/1728 = 960/1296. La traslación de fábrica (izquierda ≈ [−0,032, −0,016, −0,062] m) pasa la cámara al centro de la cabeza. La rotación cámara–cabeza se toma como identidad; pitch/yaw del panel siguen siendo un ajuste fino. La pose del visor se guarda cada frame de XR y se interpola a `captureTime` para absorber la latencia.
4. **Profundidad monocular.** Distancia entre centros de iris (landmarks 468 y 473) ≈ 63 mm, o entre comisuras externas (33 y 263) ≈ 91 mm si no hay iris. `Z = fx · tamaño / distancia_en_píxeles`. El estéreo es opcional: solo triangula si `|Δ captureTime| < 5 ms`; si no, se queda en mono. En el spike ese umbral casi no se cumple, y es lo esperado.
5. **Suavizado.** Filtro One Euro sobre la posición y el cuaternión de la máscara. El slider de milisegundos fija el corte mínimo (80 ms → 1,5 Hz).
6. **HUD y log.** Una vez por segundo, y en el panel: fps de XR (o de render fuera de AR), fps de cámara, Hz de inferencia, media y p95 de ms, latencia `now − captureTime` y descartes del último segundo. Con `?log=` sale en el mismo logger que el spike (`kind: "perf"`).

Parámetros: `res=1280x960|640x480`, `infer=5…30`, `gpu=0`, `worker=0`, `stereo=1`, `overlay=1`, `cam=left|right|webcam`, más `glb` y `log`.

En escritorio la máscara sigue la matriz facial de MediaPipe (la webcam no tiene esos intrínsecos). El modo AR del Quest es el que usa la proyección nueva.

## Cómo probarlo en el Quest

1. Visor despierto, passthrough activo, sin el diálogo de Guardian. En el sistema, Browser tiene el permiso **Headset cameras**. Ninguna otra web está usando la cámara.
2. Abre la app (Pages o `npm run dev:lan`) y, si quieres el log, añade `?log=https://<ip-del-pc>:8443` después de aceptar ese certificado.
3. Deja resolución 1280×960, tope 20 Hz, worker y GPU marcados, estéreo sin marcar. Pulsa **Iniciar cámara + detector** y luego **Entrar en AR**.
4. En el HUD, dentro del visor: XR debería quedarse en la tasa del visor (objetivo **≥ 60 fps**) y la inferencia en **≥ 15 Hz**. La máscara tendría que seguir a otra persona (o a un rostro delante de la cámara izquierda) sin ir pegada al frame de render.
5. Prueba también `res=640x480` e `infer=15` si el GPU del visor no llega. El estéreo (`stereo=1`) es experimental: en el log solo verás «triangulado» cuando un par baje de 5 ms; el resto del tiempo es mono.

## Qué falta medir en el visor

Esta revisión pasa el build y, en Chrome de escritorio con webcam simulada, arranca sin excepciones. No sustituye la pasada en el Quest. Hay que confirmar allí:

- que el render de XR se mantiene ≥ 60 fps con la inferencia en el worker a ≥ 15 Hz;
- que la máscara cae sobre la cara con el recorte 1728×1296 (si queda alta o baja, el recorte no era centrado y hay que corregir `CROP_ORIGIN_Y_PX`);
- que la latencia `now − captureTime` es estable y el historial de pose la compensa;
- que 640×480 y el tope de Hz bajan la carga sin perder el tracking.
