import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import type { Delegate } from './protocol';
import type { PoseBody } from './pose-protocol';

export interface PoseHandle {
  landmarker: PoseLandmarker;
  delegate: Delegate;
}

export async function createPoseLandmarker(opts: {
  wasmBase: string;
  modelUrl: string;
  fallbackModelUrl: string;
  preferGPU: boolean;
  inWorker: boolean;
  numPoses: number;
  log?: (m: string) => void;
}): Promise<PoseHandle> {
  const fileset = await FilesetResolver.forVisionTasks(opts.wasmBase, opts.inWorker);
  const delegates: Delegate[] = opts.preferGPU ? ['GPU', 'CPU'] : ['CPU'];
  const models = [opts.modelUrl, opts.fallbackModelUrl];
  let last: unknown;
  for (const delegate of delegates) {
    for (const modelAssetPath of models) {
      try {
        const canvas = delegate === 'GPU' && opts.inWorker ? new OffscreenCanvas(1, 1) : undefined;
        const landmarker = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: 'VIDEO',
          numPoses: opts.numPoses,
          ...(canvas ? { canvas } : {}),
        });
        return { landmarker, delegate };
      } catch (error) {
        last = error;
        opts.log?.(`PoseLandmarker ${delegate} con ${modelAssetPath} falló: ${(error as Error)?.message ?? error}`);
      }
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function packLandmarks(points: { x: number; y: number; z: number; visibility?: number }[] | undefined): Float32Array {
  const out = new Float32Array((points?.length ?? 0) * 4);
  points?.forEach((point, index) => {
    out[index * 4] = point.x;
    out[index * 4 + 1] = point.y;
    out[index * 4 + 2] = point.z;
    out[index * 4 + 3] = point.visibility ?? 1;
  });
  return out;
}

export function packPoseResult(result: PoseLandmarkerResult): PoseBody[] {
  const count = Math.max(result.landmarks?.length ?? 0, result.worldLandmarks?.length ?? 0);
  const bodies: PoseBody[] = [];
  for (let i = 0; i < count; i++) {
    bodies.push({
      norm: packLandmarks(result.landmarks?.[i]),
      world: packLandmarks(result.worldLandmarks?.[i]),
    });
  }
  return bodies;
}
