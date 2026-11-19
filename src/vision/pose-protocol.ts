import type { Delegate } from './protocol';

export interface PoseInitMsg {
  type: 'init';
  wasmBase: string;
  modelUrl: string;
  fallbackModelUrl: string;
  preferGPU: boolean;
  numPoses: number;
}
export interface PoseFrameMsg {
  type: 'frame';
  bitmap: ImageBitmap;
  timestamp: number;
  captureTime: number | null;
  eye: 'left' | 'right';
}
export interface PoseStreamMsg {
  type: 'stream';
  readable: ReadableStream<VideoFrame>;
  capHz: number;
}
export interface PoseCapMsg { type: 'cap'; capHz: number }
export type ToPoseWorker = PoseInitMsg | PoseFrameMsg | PoseStreamMsg | PoseCapMsg;

export interface PoseReadyMsg { type: 'ready'; delegate: Delegate; model: string }
export interface PoseErrorMsg { type: 'error'; message: string; fatal: boolean }
export interface PoseBody {
  /** x, y, z, visibility por landmark, normalizado a la imagen. */
  norm: Float32Array;
  /** x, y, z, visibility en metros, origen en la cadera (eje MediaPipe). */
  world: Float32Array;
}
export interface PoseResultMsg {
  type: 'pose';
  timestamp: number;
  captureTime: number | null;
  eye: 'left' | 'right';
  inferMs: number;
  width: number;
  height: number;
  droppedBefore: number;
  bodies: PoseBody[];
}
export interface PoseDroppedMsg { type: 'dropped' }
export type FromPoseWorker = PoseReadyMsg | PoseErrorMsg | PoseResultMsg | PoseDroppedMsg;

export const POSE_LITE_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
export const POSE_FULL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

/** Conexiones de BlazePose (33 puntos), las de PoseLandmarker.POSE_CONNECTIONS. */
export const POSE_CONNECTIONS: readonly [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

export const LEFT_SHOULDER = 11;
export const RIGHT_SHOULDER = 12;
export const LEFT_HIP = 23;
export const RIGHT_HIP = 24;
/** Ancho de hombros supuesto para la profundidad monocular. */
export const SHOULDER_WIDTH_M = 0.4;
