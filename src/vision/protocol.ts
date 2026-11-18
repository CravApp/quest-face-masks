// Mensajes entre hilo principal y Web Worker de inferencia.
export type Delegate = 'GPU' | 'CPU';

export interface InitMsg {
  type: 'init';
  wasmBase: string;
  modelUrl: string;
  fallbackModelUrl: string;
  preferGPU: boolean;
}
export interface FrameMsg {
  type: 'frame';
  bitmap: ImageBitmap;
  timestamp: number;
  captureTime: number | null;
  eye: 'left' | 'right';
}
export interface StreamMsg {
  type: 'stream';
  readable: ReadableStream<VideoFrame>;
  capHz: number;
}
export interface CapMsg { type: 'cap'; capHz: number }
export type ToWorker = InitMsg | FrameMsg | StreamMsg | CapMsg;

export interface ReadyMsg { type: 'ready'; delegate: Delegate }
export interface ErrorMsg { type: 'error'; message: string; fatal: boolean }
export interface ResultMsg {
  type: 'result';
  timestamp: number;
  /** Reloj de captura (captureTime o VideoFrame.timestamp en ms), o null. */
  captureTime: number | null;
  eye: 'left' | 'right';
  inferMs: number;
  /** 478 landmarks * (x,y,z) normalizados del primer rostro, o null si no hay rostro. */
  landmarks: Float32Array | null;
  /** Matriz 4x4 (column-major, unidades cm) del primer rostro, o null. */
  matrix: number[] | null;
  width: number;
  height: number;
  /** Fotogramas descartados por tope o por estar ocupado, desde el resultado anterior. */
  droppedBefore: number;
}
export interface DroppedMsg { type: 'dropped' }
export type FromWorker = ReadyMsg | ErrorMsg | ResultMsg | DroppedMsg;

export const REMOTE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
