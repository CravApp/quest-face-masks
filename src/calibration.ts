// Parámetros de calibración persistidos en localStorage.
export interface Calibration {
  /** FOV vertical real de la cámara (grados). MediaPipe asume ~63°. */
  fovDeg: number;
  /** Offset de la cámara física respecto al centro de la cabeza (m), solo modo AR. */
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  pitchDeg: number;
  yawDeg: number;
  depthScale: number;
  maskScale: number;
  smoothingMs: number;
  mirror: boolean;
}

export const DEFAULT_CALIBRATION: Calibration = {
  fovDeg: 63,
  offsetX: 0,
  offsetY: 0,
  offsetZ: 0,
  pitchDeg: 0,
  yawDeg: 0,
  depthScale: 1,
  maskScale: 1,
  smoothingMs: 80,
  mirror: true,
};

const KEY = 'quest-face-masks.calibration.v1';

export function loadCalibration(): Calibration {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_CALIBRATION, ...(JSON.parse(raw) as Partial<Calibration>) };
  } catch { /* ignorar */ }
  return { ...DEFAULT_CALIBRATION };
}

export function saveCalibration(c: Calibration): void {
  localStorage.setItem(KEY, JSON.stringify(c));
}

export interface SliderSpec { key: keyof Calibration; label: string; min: number; max: number; step: number }

export const SLIDERS: SliderSpec[] = [
  { key: 'fovDeg', label: 'FOV vertical cámara (°)', min: 30, max: 120, step: 0.5 },
  { key: 'offsetX', label: 'Offset X (m)', min: -0.3, max: 0.3, step: 0.005 },
  { key: 'offsetY', label: 'Offset Y (m)', min: -0.3, max: 0.3, step: 0.005 },
  { key: 'offsetZ', label: 'Offset Z (m)', min: -0.3, max: 0.3, step: 0.005 },
  { key: 'pitchDeg', label: 'Pitch cámara (°)', min: -45, max: 45, step: 0.5 },
  { key: 'yawDeg', label: 'Yaw cámara (°)', min: -45, max: 45, step: 0.5 },
  { key: 'depthScale', label: 'Escala profundidad', min: 0.3, max: 3, step: 0.01 },
  { key: 'maskScale', label: 'Escala máscara', min: 0.3, max: 3, step: 0.01 },
  { key: 'smoothingMs', label: 'Suavizado (ms)', min: 0, max: 400, step: 5 },
];
