import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import type { Delegate, ResultMsg } from './protocol';

export interface LandmarkerHandle {
  landmarker: FaceLandmarker;
  delegate: Delegate;
}

/** Crea FaceLandmarker en modo VIDEO; intenta GPU y cae a CPU. */
export async function createLandmarker(opts: {
  wasmBase: string;
  modelUrl: string;
  fallbackModelUrl: string;
  preferGPU: boolean;
  inWorker: boolean;
  log?: (m: string) => void;
}): Promise<LandmarkerHandle> {
  // En un worker de tipo module no hay importScripts: usar la variante ES module del WASM.
  const fileset = await FilesetResolver.forVisionTasks(opts.wasmBase, opts.inWorker);
  const delegates: Delegate[] = opts.preferGPU ? ['GPU', 'CPU'] : ['CPU'];
  const models = [opts.modelUrl, opts.fallbackModelUrl];
  let lastErr: unknown;
  for (const delegate of delegates) {
    for (const modelAssetPath of models) {
      try {
        const canvas = delegate === 'GPU' && opts.inWorker ? new OffscreenCanvas(1, 1) : undefined;
        const landmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: true,
          ...(canvas ? { canvas } : {}),
        });
        return { landmarker, delegate };
      } catch (e) {
        lastErr = e;
        opts.log?.(`FaceLandmarker ${delegate} con ${modelAssetPath} falló: ${(e as Error)?.message ?? e}`);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function packResult(
  r: FaceLandmarkerResult,
  timestamp: number,
  inferMs: number,
  width: number,
  height: number,
): ResultMsg {
  const face = r.faceLandmarks?.[0];
  let landmarks: Float32Array | null = null;
  if (face) {
    landmarks = new Float32Array(face.length * 3);
    face.forEach((p, i) => {
      landmarks![i * 3] = p.x;
      landmarks![i * 3 + 1] = p.y;
      landmarks![i * 3 + 2] = p.z;
    });
  }
  const m = r.facialTransformationMatrixes?.[0];
  return { type: 'result', timestamp, inferMs, landmarks, matrix: m ? Array.from(m.data) : null, width, height };
}
