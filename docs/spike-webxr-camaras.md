# Spike: cámaras de passthrough en Quest Browser

Página de prueba, no es una función de la app de máscaras. Mide si **Quest Browser** puede dar a una web las **dos** cámaras de passthrough del Quest 3 a la vez, y con qué calidad: resolución, fps, sincronía de marcas de tiempo, intrínsecos y si el vídeo sigue vivo dentro de una sesión `immersive-ar`.

URL prevista en GitHub Pages:

https://cravapp.github.io/quest-face-masks/spike/cameras/

En local, con `npm run dev`: http://localhost:5173/spike/cameras/

## Qué mide cada botón

El texto grande de cada paso es el resultado, pensado para leerse dentro del visor. El detalle queda debajo. **Copiar/Exportar resultados** descarga un JSON con todo (listas, `getSettings`, marcas de tiempo, muestras de `XRFrame`) y lo copia al portapapeles. Con `?log=https://<host>:8443` cada resultado sale además como línea JSON al logger del PR #2 (`POST /log` y, si conecta, WebSocket `/rlog-ws`). No se envían fotogramas.

| Botón | Qué hace |
| --- | --- |
| a | `enumerateDevices()` antes y después de un `getUserMedia` que pide permiso. Lista cada `videoinput` (`label`, `deviceId`, `groupId`) y, ya con permiso, abre cada cámara **por separado** para leer `getCapabilities()` / `getSettings()` (ancho, alto, fps, `facingMode`, etc.). Anota el user agent. |
| b | Abre izquierda y derecha **a la vez** con `deviceId` exacto. Prueba `1280×960@60`, luego `1280×960@30`, luego `640×480`, luego sin tamaño (`max`). Informa el `getSettings()` real y los fps medidos durante 10 s con `requestVideoFrameCallback`. |
| c | Vuelve a fijar 60 fps y después 30 fps. Durante 10 s en cada tasa guarda `mediaTime`, `captureTime`, `presentationTime` y `expectedDisplayTime` de `requestVideoFrameCallback`, y `VideoFrame.timestamp` de `MediaStreamTrackProcessor` si existe. Empareja cada fotograma izquierdo con el derecho más cercano (ventana de 50 ms) y da mediana, p95 y el porcentaje de pares con \|Δ\| < 1 ms. |
| d | Busca intrínsecos o pose de la cámara en `getSettings`, `getCapabilities`, `getSupportedConstraints` y en los nombres del track. Si no están, lo dice y deja por escrito los valores de fábrica de Camera2 (abajo), para triangular más adelante. |
| e | Pide `immersive-ar` con `camera-access`, `local-floor` y `hand-tracking` como **opcionales** (si el navegador rechaza el conjunto, reintenta con menos). Las dos cámaras siguen abiertas. Cuenta si siguen llegando fotogramas dentro de la sesión y guarda el tiempo de `XRFrame` junto a la pose del visor y las marcas de la cámara. Corre **PoseLandmarker lite** (GPU y, si falla, CPU) sobre la cámara izquierda —o alternando, si se marca la casilla— y anota Hz y ms por inferencia. Los landmarks se dibujan en el canvas y en un quad delante del visor. A los 12 s sale de AR solo. |

**Detener cámaras** corta el paso en curso y suelta las pistas.

Un `NotAllowedError`, un `OverconstrainedError` o «no hay cámaras facing back» no rompe la página: queda escrito con `name` y `message`. Eso ya es un resultado del spike.

## Cómo ejecutarlo en el Quest

1. El visor tiene que estar **despierto**, con passthrough y **sin** el diálogo de Guardian. Solo una web puede usar las cámaras; si minimizas el navegador, Meta deja de entregar fotogramas.
2. En el sistema: **Ajustes → Privacidad y seguridad → Permisos de apps → Browser → Headset cameras**, concedido. Ese permiso es de la app Browser (`horizonos.permission.HEADSET_CAMERA` a nivel de sistema). La web no declara un permiso `headset-camera`: el aviso del sitio es el de `getUserMedia`.
3. Abre la URL de Pages en **Quest Browser**. Si quieres el log en el PC, antes abre `https://<ip-del-pc>:8443` en el visor, acepta el certificado, y entra a la spike con `?log=https://<ip-del-pc>:8443`.
4. Pulsa **a**, acepta la cámara, lee el resultado. Sigue con **b**, **c**, **d** y **e**. El paso c tarda unos 20 s (10 s a 60 fps y 10 s a 30). El paso e entra en AR unos 12 s y vuelve solo; el quad muestra fps de AR e inferencia mientras tanto.
5. Pulsa **Copiar/Exportar resultados**.

La cámara `facing front` es la del avatar (Camera2 id 1). No cuenta como passthrough. En las etiquetas que se han visto en Quest Browser, `camera 1, facing back` es la izquierda y `camera 2, facing back` la derecha (a veces `camera 2 1` / `camera 2 2`). La página usa esa regla y la escribe en el resultado.

## Qué es pasa, parcial y falla

| Paso | Pasa | Parcial | Falla |
| --- | --- | --- | --- |
| a | Tras el permiso hay al menos dos `videoinput` facing back. | Hay vídeo, pero solo el avatar o una sola facing back. | `NotAllowedError`, cero cámaras, o sin `mediaDevices` / sin HTTPS. Las etiquetas vacías *antes* del permiso son lo normal. |
| b | Las dos quedan abiertas y cada una entrega ≥ 20 fps en 1280×960 (a 60 o a 30). | Las dos abren, pero en 640×480 o en `max`, o por debajo de 20 fps. | La segunda no abre (`NotReadableError`, `NotAllowedError`, etc.) o no llega ningún fotograma. |
| c | A 60 fps, con reloj compartido, ≥ 95 % de los pares tienen \|Δ\| < 1 ms y la mediana absoluta es < 1 ms. A 30 fps, ≥ 95 % bajo 1 ms **o** p95 de \|Δ\| ≤ 20 ms (el nativo a 30 fps cae en 0 o ±16,7 ms). | Hay pares, pero la sincronía es peor, o los relojes no compartían origen y hubo que restar el primer fotograma. | No hay pares, o no se pudo fijar la tasa y no llegaron fotogramas. |
| d | Algún campo de settings, capabilities o constraints trae focal, punto principal o pose. | No hay pistas que leer. | El acceso a medios está bloqueado. **«NO EXPUESTO» es un resultado válido del spike**, no un fallo de la página: la API web no entrega intrínsecos y hay que usar el respaldo nativo. |
| e | `immersive-ar` arranca, las dos cámaras siguen por encima de 5 fps (RVFC o `currentTime` que avanza) y PoseLandmarker produce una tasa finita. | La sesión y los fotogramas van, pero el modelo no carga o no llega a inferir. Que `camera-access` no esté en `enabledFeatures` **no** tira el paso: es el resultado esperado hoy. | La sesión no arranca, o dentro de AR las cámaras dejan de entregar fotogramas. |

Referencia nativa, ya medida fuera del navegador en este Quest 3 (Horizon OS v209, Android 14): Camera2 id 50 izquierda y 51 derecha; hace falta `CAMERA` y `horizonos.permission.HEADSET_CAMERA`; YUV de 320×240 a 1728×1728, resolución de trabajo 1280×960; a 60 fps las dos comparten reloj y el 99,8 % de los pares cae en microsegundos; a 30 fps derivan 0 o ±16,7 ms. La página no repite esa medida: la usa para comparar.

## Hallazgos de la investigación

**Sí: Quest Browser expone las cámaras de passthrough a la web.** No es el módulo WebXR Raw Camera Access. Son cámaras normales de `getUserMedia` / `enumerateDevices`.

- **Experimental:** Quest Browser **38.3**, «Passthrough Camera: Added initial support for passthrough camera», no para todos los usuarios. En ese periodo hacía falta el flag *Experimental web platform features*. [Notas de Browser](https://developers.meta.com/horizon/release-notes/web/), hilo [Babylon.js](https://forum.babylonjs.com/t/webxr-camera-passthrough-support/58274).
- **Disponibilidad general:** Quest Browser **40.1**, «Support for passthrough camera», ya como función normal (paquete con fecha 12 ago 2025). [Notas 40.1](https://developers.meta.com/vr/downloads/package/browser/40.1/). El 40.0 había subido a Chromium 138; 40.1 sigue esa base.
- **Sistema:** el anuncio de la Passthrough Camera API nativa (Horizon OS **v76**, abril 2025) dice que la parte web / WebXR llegaría con **v77**. [Blog de Meta](https://developers.meta.com/vr/blog/new-era-mixed-reality-passthrough-camera-api-machine-learning-computer-vision/). Horizon OS v77 empezó la semana del 19 may 2025 ([notas del sistema](https://www.meta.com/help/quest/172903867975450/)), pero esas notas no describen la API del navegador. La versión del navegador y la del sistema no son el mismo número. Un informe de terceros vio las tres cámaras en Browser 39.0 sobre Horizon OS v78, o sea en builds anteriores al 40.1 general: [GMO Tech Blog](https://tech.gmogshd.com/webxr-camera-api/).
- **Una o las dos:** las notas oficiales dicen «passthrough camera», en singular, y no prometen abrirlas a la vez. Rik Cabanier (Meta), citado en el hilo de Babylon, describió **dos cámaras extra, izquierda y derecha**, expuestas como cámaras normales junto a la del avatar. La ayuda de Meta habla de «headset cameras» en plural. [Ayuda de permisos](https://www.meta.com/help/quest/1406582186767703/). Si al Browser le falta el permiso de sistema, `enumerateDevices` solo enseña el avatar y `facingMode: { exact: 'environment' }` falla con `OverconstrainedError`. [Investigación 1557993751977106](https://developers.meta.com/vr/support/investigations/1557993751977106/). Abrir las dos a la vez, y lo bien que coinciden sus relojes, es lo que mide esta página: no está cerrado por la documentación.
- **Permisos:** el sitio pide el permiso de cámara de `getUserMedia`. «Headset cameras» es el permiso de la app Browser en el sistema, no un nombre de `navigator.permissions` (`headset-camera` se consulta en el paso a por si existiera; lo esperable es que esa consulta falle). Solo una web a la vez. Minimizar o cerrar la ventana corta el feed. [Ayuda de Meta](https://www.meta.com/help/quest/1406582186767703/).
- **WebXR `camera-access` / `XRCamera`:** el [módulo Raw Camera Access](https://immersive-web.github.io/raw-camera-access/) es un borrador pensado para móviles (`XRView.camera`, `XRWebGLBinding.getCameraImage`). Quest Browser no lo implementa: pedirlo como feature **requerida** rechaza la sesión. En este repo ya se vio en Horizon OS v85 (`docs/SRS-v1.2.md`). [xrblocks #227](https://github.com/google/xrblocks/pull/227) también lo da por no disponible en Quest 3. El paso e lo pide solo como opcional, para registrar si algún día aparece en `enabledFeatures`. El [IWSDK de Meta](https://developers.meta.com/vr/documentation/web/iwsdk-guide-camera-access/) usa MediaDevices, no la textura cruda de WebXR.
- **Intrínsecos:** la ayuda de Meta dice que, con el permiso, el sitio recibe focal, punto principal, dimensiones y posición respecto al centro del visor. A la vez, el issue [w3c/mediacapture-main#1060](https://github.com/w3c/mediacapture-main/issues/1060) (Rik Cabanier, 4 nov 2025, sigue abierto; última actividad registrada el 15 oct 2026) dice que el navegador expone la cámara pero **faltan** los intrínsecos y la pose del objetivo, y propone `LENS_POSE_TRANSLATION` / `LENS_POSE_ROTATION` en `MediaTrackSettings`. El paso d vuelca las claves reales. Si no están, el JSON y la pantalla llevan las constantes de fábrica.

Esas constantes están en `spike/cameras/intrinsics.ts` (`NATIVE_QUEST3_FACTORY`), sensor completo 1728×1728, sin distorsión:

- Izquierda, Camera2 50: fx = fy = 1180.68, cx = 870.74, cy = 869.25, t = [-0.0322, -0.0164, -0.0622] m.
- Derecha, Camera2 51: fx = fy = 1178.99, cx = 862.69, cy = 866.26, t = [0.0315, -0.0171, -0.0621] m.
- Línea base ~6,37 cm, rotación relativa ~1,38°.

Un stream de 1280×960 no es ese sensor entero. No hay que aplicar fx/cx tal cual hasta saber el recorte.

## Respuesta corta

Quest Browser **sí** expone el passthrough a la web, por `getUserMedia`, desde la **40.1** en general (experimental en **38.3**). Meta describió **las dos** cámaras, izquierda y derecha, como `videoinput` normales, además de la del avatar. No hay soporte oficial de WebXR `camera-access` / `XRCamera`. La documentación no garantiza abrirlas a la vez ni entrega hoy intrínsecos en `MediaTrackSettings`; esta página es la medida de eso en el visor.
