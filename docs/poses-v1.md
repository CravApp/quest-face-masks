# Poses corporales — fase 1 (una cámara)

Versión de la app: **0.3.0**. Sigue la tubería de v0.2: passthrough izquierda, `getUserMedia` 1280×960@30, inferencia fuera del frame de XR.

## Qué hace esta fase

Una sola cámara (la izquierda en el Quest, la webcam en escritorio).

- **PoseLandmarker** de `@mediapipe/tasks-vision`. Modelo **lite** por defecto; **full** con `?pose=full`. GPU y, si falla, CPU. `numPoses` 1 por defecto, 2 con `?poses=2`.
- **Modo** `face` | `pose` | `both` (UI o `?mode=`). En `both`, cara y pose van en **workers separados**, cada uno con el mismo tope de Hz. Ninguno corre dentro del `requestAnimationFrame` de la sesión. Si el visor no aguanta los dos, baja `infer` o usa solo `pose`.
- **Escritorio:** overlay 2D del esqueleto (33 puntos, conexiones de BlazePose) sobre el vídeo.
- **immersive-ar:** esqueleto 3D. La profundidad del ancla (cadera) sale del ancho de hombros, **supuesto 0,40 m**, y de los intrínsecos. Los `worldLandmarks` de MediaPipe (metros, origen en la cadera, x a la derecha, y hacia abajo, z hacia la cámara) se suman como `(x, −y, z)` en el espacio de la cámara. La pose del visor es la interpolada a `captureTime`. Cada articulación pasa por un filtro One Euro.
- **Intrínsecos.** Si no hay JSON, el recorte de fábrica de `align-math.ts`: sensor 1728×1728, recorte centrado 1728×1296, escala `ancho/1728`. Si hay calibración estéreo válida, se usa su `K` (escalada al tamaño del fotograma) y, si viene, `head_from_cam.t` convertido de OpenCV `(x, y, z)` a `(x, −y, −z)`.
- **HUD y `?log=`.** Línea de pose: Hz, media y p95 de ms, número de personas y latencia `now − captureTime`. El JSON de perf lleva `poseHz`, `poseMeanMs`, `poseP95Ms`, `poseLatencyMs` y `people`.

Objetivo en el visor: **XR ≥ 60 fps** y **pose ≥ 15 Hz**.

## Parámetros para el Quest

Abre, con el visor despierto y el permiso Headset cameras del Browser:

```
https://cravapp.github.io/quest-face-masks/?mode=pose&infer=20
```

| Parámetro | Valores | Efecto |
| --- | --- | --- |
| `mode` | `face` (defecto), `pose`, `both` | Qué detectores arrancan |
| `pose` | `lite` (defecto), `full` | Modelo de pose |
| `poses` | `1` (defecto), `2` | `numPoses` |
| `infer` | 5…30, defecto 20 | Tope de Hz de cada detector |
| `res` | `1280x960` (defecto), `640x480` | Resolución pedida |
| `gpu` | `0` | Fuerza CPU |
| `worker` | `0` | Hilo principal |
| `calib` | URL `https://…/calib.json` | Calibración estéreo; también hay selector de archivo |
| `log` | `https://<host>:8443` | Log remoto, una línea por segundo |
| `overlay` | `1` | Landmarks de la cara además del esqueleto |

Ejemplos:

- Solo pose, lite, 20 Hz: `?mode=pose&infer=20`
- Cara y pose, por si el visor aguanta: `?mode=both&infer=15`
- Modelo full, una persona: `?mode=pose&pose=full&infer=15`
- Dos personas: `?mode=pose&poses=2&infer=15`

Entra en AR después de iniciar. El esqueleto 3D solo se dibuja en la sesión. En el panel 2D del navegador, antes de entrar, se ve el overlay.

## Formato de calibración

Metros. Ejes **OpenCV**. `stereo.R` y `stereo.T` llevan un punto de la izquierda a la derecha: `X_r = R X_l + T`.

```json
{
  "version": 1,
  "image_size": [1280, 960],
  "distortion_model": "radtan",
  "left": { "camera2_id": 50, "K": [[0, 0, 0], [0, 0, 0], [0, 0, 1]], "D": [0, 0, 0, 0, 0] },
  "right": { "camera2_id": 51, "K": [[0, 0, 0], [0, 0, 0], [0, 0, 1]], "D": [0, 0, 0, 0, 0] },
  "stereo": {
    "R": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    "T": [0.0637, 0, 0],
    "R1": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    "R2": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    "P1": [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 1, 0]],
    "P2": [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 1, 0]],
    "Q": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
  },
  "head_from_cam": {
    "left": { "R": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "t": [-0.032, 0.016, 0.062] }
  }
}
```

`distortion_model` es `radtan` o `fisheye`. `K` puede ir 3×3 o en 9 números. `D` se persiste en `localStorage` y **no se usa** en esta fase. Sin JSON, o si el JSON no valida, se usan los intrínsecos de fábrica.

## Fase 2 (no está en este PR)

Estéreo de verdad, con las dos cámaras a la vez:

- Izquierda: `camera 1, facing back`. Derecha: `camera 2, facing back`. La app ya sabe abrir la segunda si se marca el estéreo experimental; la fase 2 la usará siempre en modo pose.
- PoseLandmarker en las dos imágenes (dos ojos, no solo el izquierdo).
- Triangulación por articulación con `stereo.R` y `stereo.T` **solo si** `|Δ captureTime| < 5 ms`. El spike midió mediana ~14 ms y p95 ~28 ms, así que la mayoría de los pares no llegarán y hay que caer a la profundidad monocular de esta fase (ancho de hombros 0,40 m).
- Aplicar `D` (`radtan` o `fisheye`) antes de lanzar los rayos.
- `head_from_cam` deja de ser opcional para el ancla: la extrínseca medida sustituye a la traslación de fábrica.
- El HUD añade el porcentaje de articulaciones que sí triangularon frente a las que fueron mono.

La interfaz ya está: `CameraResult.rightStream` / `otherEye`, y `StereoCalibration` en `src/calib/stereo.ts`.
