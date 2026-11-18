/**
 * Intrínsecos de fábrica del Quest 3 medidos por Camera2 (app nativa, no el navegador).
 * Sensor completo 1728×1728. Un stream web de otra resolución es un recorte o un escalado:
 * no aplicar fx/cx sin conocer esa ventana.
 * Sin coeficientes de distorsión. Traslación en metros respecto al centro del visor.
 */
export interface FactoryCamera {
  eye: 'left' | 'right';
  /** ID Camera2. El 1 es la cámara del avatar y no entra aquí. */
  camera2Id: number;
  sensorWidth: 1728;
  sensorHeight: 1728;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  translationM: [number, number, number];
  distortionCoefficients: null;
}

export const NATIVE_QUEST3_FACTORY = {
  source: 'factory-camera2-not-web',
  device: 'Quest 3',
  horizonOs: 'v209',
  android: 14,
  ignoredCamera2Id: { id: 1, role: 'avatar' },
  permissions: ['android.permission.CAMERA', 'horizonos.permission.HEADSET_CAMERA'],
  yuvSizePx: { min: [320, 240] as [number, number], max: [1728, 1728] as [number, number] },
  workingResolutionPx: { width: 1280, height: 960 },
  baselineM: 0.0637,
  relativeRotationDeg: 1.38,
  syncNative: {
    fps60: 'Reloj compartido. El 99,8 % de los pares cae en microsegundos.',
    fps30: 'Deriva de 0 o ±16,7 ms.',
  },
  conditions: 'Visor despierto y sin diálogo de Guardian.',
  cameras: [
    {
      eye: 'left',
      camera2Id: 50,
      sensorWidth: 1728,
      sensorHeight: 1728,
      fx: 1180.68,
      fy: 1180.68,
      cx: 870.74,
      cy: 869.25,
      translationM: [-0.0322, -0.0164, -0.0622],
      distortionCoefficients: null,
    },
    {
      eye: 'right',
      camera2Id: 51,
      sensorWidth: 1728,
      sensorHeight: 1728,
      fx: 1178.99,
      fy: 1178.99,
      cx: 862.69,
      cy: 866.26,
      translationM: [0.0315, -0.0171, -0.0621],
      distortionCoefficients: null,
    },
  ] satisfies FactoryCamera[],
} as const;

export const RESEARCH = {
  summary:
    'Quest Browser expone el passthrough como cámaras videoinput de getUserMedia, no como WebXR camera-access. ' +
    'Soporte experimental en Quest Browser 38.3 y disponibilidad general en 40.1. ' +
    'Las notas oficiales no prometen abrir las dos a la vez ni entregan intrínsecos en la API web: esta página lo mide.',
  bothCameras:
    'Rik Cabanier (Meta) describió dos cámaras extra, izquierda y derecha, como cámaras normales junto a la del avatar. La apertura simultánea no está especificada.',
  intrinsics:
    'La ayuda de Meta dice que el sitio recibe focal, punto principal y posición. El issue w3c/mediacapture-main#1060 (abierto, Meta, nov 2025) dice que esos datos aún no están en MediaTrackSettings.',
  urls: [
    'https://developers.meta.com/horizon/release-notes/web/',
    'https://developers.meta.com/vr/downloads/package/browser/40.1/',
    'https://developers.meta.com/vr/blog/new-era-mixed-reality-passthrough-camera-api-machine-learning-computer-vision/',
    'https://www.meta.com/help/quest/1406582186767703/',
    'https://developers.meta.com/vr/support/investigations/1557993751977106/',
    'https://immersive-web.github.io/raw-camera-access/',
    'https://github.com/w3c/mediacapture-main/issues/1060',
    'https://forum.babylonjs.com/t/webxr-camera-passthrough-support/58274',
    'https://tech.gmogshd.com/webxr-camera-api/',
    'https://developers.meta.com/vr/documentation/web/iwsdk-guide-camera-access/',
    'https://www.meta.com/help/quest/172903867975450/',
  ],
} as const;
