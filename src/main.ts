import * as THREE from 'three';
import { CameraError, getBestCamera, stopStream, type CameraResult, type QuestEye } from './camera';
import { intrinsicsFromCalibration, loadStoredCalibration, parseStereoCalibration, storeCalibration, type StereoCalibration } from './calib/stereo';
import { DEFAULT_CALIBRATION, SLIDERS, loadCalibration, saveCalibration, type Calibration } from './calibration';
import { debugReport, installRemoteDebug } from './debug/remote';
import { FpsCounter } from './fps';
import { Series } from './perf';
import { drawOverlay } from './overlay';
import { BodyView } from './scene/skeleton';
import { createProceduralMask, loadGlbMask } from './scene/mask';
import { OneEuroPose } from './scene/one-euro';
import { maskInHead, scaledFor, stereoHeadPoint } from './scene/place';
import { faceMatrixToCameraSpace } from './scene/pose';
import { PoseHistory } from './scene/pose-history';
import type { ScaledIntrinsics, Vec3 } from './scene/align-math';
import { createFaceDetector, type FaceDetector } from './vision/detector';
import { startInferencePump } from './vision/pump';
import { createPoseDetector, type PoseDetector } from './vision/pose-detector';
import { startPosePump } from './vision/pose-pump';
import type { PoseResultMsg } from './vision/pose-protocol';
import type { ResultMsg } from './vision/protocol';

installRemoteDebug();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const glCanvas = $<HTMLCanvasElement>('gl');
const overlay = $<HTMLCanvasElement>('overlay');
const stage = $<HTMLDivElement>('stage');
const statsEl = $<HTMLDivElement>('stats');
const logEl = $<HTMLPreElement>('log');
const bannerEl = $<HTMLDivElement>('banner');
const videoRight = document.createElement('video');
videoRight.playsInline = true;
videoRight.muted = true;
video.playsInline = true;
video.muted = true;

function showBanner(message: string, level: 'error' | 'warn'): void {
  bannerEl.hidden = false;
  bannerEl.classList.toggle('error', level === 'error');
  bannerEl.textContent = message;
}
function hideBanner(): void {
  bannerEl.hidden = true;
  bannerEl.textContent = '';
}
bannerEl.title = 'Pulsa para ocultar';
bannerEl.onclick = () => hideBanner();

function log(msg: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  logEl.textContent = (line + '\n' + (logEl.textContent ?? '')).slice(0, 6000);
}

function n(value: number, digits = 0): string {
  return new Intl.NumberFormat('es', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

let calib: Calibration = loadCalibration();
let camera: CameraResult | null = null;
let detector: FaceDetector | null = null;
let poseDetector: PoseDetector | null = null;
let stopPump: (() => void) | null = null;
let stopPosePump: (() => void) | null = null;
let running = false;
let lastResult: ResultMsg | null = null;
let lastLeft: ResultMsg | null = null;
let lastPose: PoseResultMsg | null = null;
let posePeople = 0;
let poseCapture: number | null = null;
let stereoCalib: StereoCalibration | null = loadStoredCalibration();
let kLeft: ScaledIntrinsics | null = null;
let kRight: ScaledIntrinsics | null = null;
const renderFps = new FpsCounter();
const cameraFps = new FpsCounter();
const inferTimes = new Series();
const latencies = new Series();
const poseTimes = new Series();
const poseLats = new Series();
const dropTicks = new FpsCounter();
const poseDrops = new FpsCounter();
let shownCapture: number | null = null;
let lastAppliedAt = 0;

const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');

const scene = new THREE.Scene();
const cam3d = new THREE.PerspectiveCamera(calib.fovDeg, 4 / 3, 0.01, 50);
scene.add(new THREE.HemisphereLight(0xffffff, 0x334466, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(0.5, 1, 1);
scene.add(sun);

const faceRoot = new THREE.Group();
faceRoot.visible = false;
scene.add(faceRoot);
let maskObj: THREE.Object3D = createProceduralMask();
faceRoot.add(maskObj);
const poseFilter = new OneEuroPose(OneEuroPose.cutoffFromMs(calib.smoothingMs));
const headHistory = new PoseHistory();
const world = new THREE.Matrix4();
const headMat = new THREE.Matrix4();
const decomposedPos = new THREE.Vector3();
const decomposedQuat = new THREE.Quaternion();
const decomposedScale = new THREE.Vector3();

const hudCanvas = document.createElement('canvas');
hudCanvas.width = 1024;
hudCanvas.height = 280;
const hudTex = new THREE.CanvasTexture(hudCanvas);
const hud = new THREE.Mesh(
  new THREE.PlaneGeometry(0.52, 0.15),
  new THREE.MeshBasicMaterial({ map: hudTex, transparent: true, depthTest: false }),
);
hud.renderOrder = 999;
hud.visible = false;
scene.add(hud);
const bodies = new BodyView();
scene.add(bodies.group);

function setMask(obj: THREE.Object3D): void {
  faceRoot.remove(maskObj);
  maskObj = obj;
  faceRoot.add(maskObj);
}

function resize(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!renderer.xr.isPresenting) renderer.setSize(w, h, false);
  cam3d.aspect = w / Math.max(1, h);
  cam3d.fov = calib.fovDeg;
  cam3d.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

function selectedSize(): { width: number; height: number } {
  return $<HTMLSelectElement>('res').value === '640x480' ? { width: 640, height: 480 } : { width: 1280, height: 960 };
}
function capHz(): number {
  const value = Number($<HTMLInputElement>('inferCap').value);
  return Number.isFinite(value) ? Math.min(30, Math.max(5, value)) : 20;
}
function appMode(): 'face' | 'pose' | 'both' {
  const value = $<HTMLSelectElement>('mode').value;
  return value === 'pose' || value === 'both' ? value : 'face';
}
function poseVariant(): 'lite' | 'full' {
  return $<HTMLSelectElement>('poseModel').value === 'full' ? 'full' : 'lite';
}
function numPoses(): number {
  return $<HTMLSelectElement>('numPoses').value === '2' ? 2 : 1;
}
function kFor(eye: QuestEye, width: number, height: number): ScaledIntrinsics {
  const factory = scaledFor(eye, width, height);
  if (!stereoCalib) return factory;
  const file = intrinsicsFromCalibration(stereoCalib, eye, width, height);
  return { ...factory, fx: file.fx, fy: file.fy, cx: file.cx, cy: file.cy, translationM: file.translationM ?? factory.translationM };
}
function stereoOn(): boolean {
  return $<HTMLInputElement>('stereo').checked && !!camera?.rightStream;
}

function refreshIntrinsics(): void {
  kLeft = null;
  kRight = null;
  if (!video.videoWidth) return;
  if (camera?.source !== 'quest-passthrough' && !stereoCalib) return;
  const eye: QuestEye = camera?.eye === 'right' ? 'right' : 'left';
  kLeft = kFor(eye, video.videoWidth, video.videoHeight);
  if (camera?.otherEye && videoRight.videoWidth) kRight = kFor(camera.otherEye, videoRight.videoWidth, videoRight.videoHeight);
  const source = stereoCalib ? `JSON v${stereoCalib.version} (${stereoCalib.distortion_model}, D sin aplicar)` : 'fábrica, recorte 1728×1296 centrado';
  log(`Intrínsecos ${eye} a ${kLeft.width}×${kLeft.height}: fx ${kLeft.fx.toFixed(1)} fy ${kLeft.fy.toFixed(1)} cx ${kLeft.cx.toFixed(1)} cy ${kLeft.cy.toFixed(1)} (${source}).`);
}

function headMatrix(sample: { p: [number, number, number]; q: [number, number, number, number] } | null): THREE.Matrix4 {
  if (!sample) return headMat.identity();
  return headMat.compose(
    decomposedPos.set(sample.p[0], sample.p[1], sample.p[2]),
    decomposedQuat.set(sample.q[0], sample.q[1], sample.q[2], sample.q[3]),
    new THREE.Vector3(1, 1, 1),
  );
}

function publishPose(matrix: THREE.Matrix4, captureTime: number | null): void {
  matrix.decompose(decomposedPos, decomposedQuat, decomposedScale);
  poseFilter.setGains(OneEuroPose.cutoffFromMs(calib.smoothingMs));
  const filtered = poseFilter.filter({
    p: [decomposedPos.x, decomposedPos.y, decomposedPos.z],
    q: [decomposedQuat.x, decomposedQuat.y, decomposedQuat.z, decomposedQuat.w],
  }, (captureTime ?? performance.now()) / 1000);
  faceRoot.position.set(filtered.p[0], filtered.p[1], filtered.p[2]);
  faceRoot.quaternion.set(filtered.q[0], filtered.q[1], filtered.q[2], filtered.q[3]);
  faceRoot.scale.copy(decomposedScale);
  shownCapture = captureTime;
  lastAppliedAt = performance.now();
}

function placeLeft(result: ResultMsg, stereoPoint: Vec3 | null): void {
  if (renderer.xr.isPresenting && camera?.source === 'quest-passthrough' && kLeft) {
    const local = maskInHead(result, kLeft, calib, stereoPoint);
    if (!local) return;
    const head = headHistory.at(result.captureTime ?? performance.now());
    publishPose(world.copy(headMatrix(head)).multiply(local), result.captureTime);
    return;
  }
  if (!result.matrix) return;
  publishPose(faceMatrixToCameraSpace(result.matrix, calib, world), result.captureTime);
}

function onDetectorResult(result: ResultMsg): void {
  if (result.eye === 'right') {
    if (!lastLeft?.landmarks || !kLeft || !kRight || lastLeft.captureTime == null || result.captureTime == null) return;
    if (Math.abs(result.captureTime - lastLeft.captureTime) >= 5) return;
    const point = stereoHeadPoint(lastLeft, result, kLeft, kRight);
    if (point) {
      log(`Estéreo |Δ| ${n(Math.abs(result.captureTime - lastLeft.captureTime), 1)} ms: triangulado.`);
      placeLeft(lastLeft, point);
    }
    return;
  }
  lastResult = result;
  lastLeft = result;
  inferTimes.push(result.inferMs);
  if (result.captureTime != null) latencies.push(performance.now() - result.captureTime);
  placeLeft(result, null);
}

function onPoseResult(result: PoseResultMsg): void {
  if (result.eye !== 'left') return;
  lastPose = result;
  posePeople = result.bodies.length;
  poseTimes.push(result.inferMs);
  if (result.droppedBefore) { for (let i = 0; i < result.droppedBefore; i++) poseDrops.tick(); }
  if (result.captureTime != null) poseLats.push(performance.now() - result.captureTime);
  poseCapture = result.captureTime;
  const head = headHistory.at(result.captureTime ?? performance.now());
  bodies.update({
    bodies: result.bodies,
    width: result.width,
    height: result.height,
    k: kLeft,
    calib,
    head: headMatrix(head),
    presenting: renderer.xr.isPresenting && !!kLeft,
    captureTime: result.captureTime,
  });
}

async function start(): Promise<void> {
  $<HTMLButtonElement>('btnStart').disabled = true;
  hideBanner();
  try {
    const size = selectedSize();
    camera = await getBestCamera({
      mode: $<HTMLSelectElement>('camMode').value as 'auto' | 'quest-left' | 'quest-right' | 'webcam',
      width: size.width,
      height: size.height,
      stereo: $<HTMLInputElement>('stereo').checked,
    }, log);
    if (camera.notice) showBanner(camera.notice, 'warn');
    log(`Cámara: ${camera.label} (${camera.source}, ${camera.eye}) ${camera.settings.width ?? '–'}×${camera.settings.height ?? '–'}@${camera.settings.frameRate ?? '–'}`);
    video.srcObject = camera.stream;
    await video.play();
    if (camera.rightStream) {
      videoRight.srcObject = camera.rightStream;
      try { await videoRight.play(); } catch (error) { log(`La segunda cámara no reproduce: ${(error as Error).message}`); }
    }
    if (video.videoWidth && video.videoHeight) stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    refreshIntrinsics();
    video.requestVideoFrameCallback(() => refreshIntrinsics());
    debugReport({
      kind: 'camera',
      level: camera.notice ? 'warn' : 'info',
      message: camera.notice ?? `Cámara: ${camera.label} (${camera.source})`,
      data: {
        source: camera.source,
        eye: camera.eye,
        label: camera.label,
        settings: camera.settings,
        rightLabel: camera.rightLabel,
        rightSettings: camera.rightSettings,
        stereo: !!camera.rightStream,
      },
    });
    if (camera.source === 'quest-passthrough' && calib.mirror) {
      calib.mirror = false;
      saveCalibration(calib);
      syncCalibUI();
    }
    applyMirror();
    resize();

    const mode = appMode();
    const wantFace = mode !== 'pose';
    const wantPose = mode !== 'face';
    if (wantFace) {
      log('Cargando FaceLandmarker…');
      detector = await createFaceDetector({
        preferWorker: $<HTMLInputElement>('useWorker').checked,
        preferGPU: $<HTMLInputElement>('useGPU').checked,
        log,
      });
      log(`Cara lista: ${detector.kind} / ${detector.delegate}. Tope ${n(capHz())} Hz.`);
    }
    if (wantPose) {
      log(`Cargando PoseLandmarker ${poseVariant()} × ${numPoses()}…`);
      poseDetector = await createPoseDetector({
        preferWorker: $<HTMLInputElement>('useWorker').checked,
        preferGPU: $<HTMLInputElement>('useGPU').checked,
        variant: poseVariant(),
        numPoses: numPoses(),
        log,
      });
      log(`Pose lista: ${poseDetector.kind} / ${poseDetector.delegate}.`);
    }
    running = true;
    poseFilter.reset();
    bodies.reset();
    lastAppliedAt = 0;
    if (detector) {
      stopPump = startInferencePump({
        detector,
        video,
        right: camera.rightStream ? videoRight : null,
        capHz,
        stereo: stereoOn,
        onResult: onDetectorResult,
        onCameraFrame: () => cameraFps.tick(),
        onDrop: (count) => { for (let i = 0; i < count; i++) dropTicks.tick(); },
        log,
      });
    }
    if (poseDetector) {
      stopPosePump = startPosePump({
        detector: poseDetector,
        video,
        capHz,
        onResult: onPoseResult,
        onCameraFrame: detector ? undefined : () => cameraFps.tick(),
        onDrop: (count) => { for (let i = 0; i < count; i++) poseDrops.tick(); },
        log,
      });
    }
    syncOverlayVisibility();
    $<HTMLButtonElement>('btnStop').disabled = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Error al iniciar: ${message}`);
    showBanner(message, 'error');
    debugReport({
      kind: 'camera',
      level: 'error',
      message,
      data: { code: error instanceof CameraError ? error.code : 'failed', devices: error instanceof CameraError ? error.devices : [] },
    });
    stop();
  }
}

function stop(): void {
  running = false;
  stopPump?.();
  stopPump = null;
  stopPosePump?.();
  stopPosePump = null;
  detector?.dispose();
  detector = null;
  poseDetector?.dispose();
  poseDetector = null;
  stopStream(camera?.rightStream);
  stopStream(camera?.stream);
  camera = null;
  video.srcObject = null;
  videoRight.srcObject = null;
  lastResult = null;
  lastLeft = null;
  lastPose = null;
  posePeople = 0;
  poseCapture = null;
  bodies.reset();
  kLeft = null;
  kRight = null;
  shownCapture = null;
  lastAppliedAt = 0;
  poseFilter.reset();
  overlay.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height);
  $<HTMLButtonElement>('btnStart').disabled = false;
  $<HTMLButtonElement>('btnStop').disabled = true;
}

function perfLines(): string[] {
  const presenting = renderer.xr.isPresenting;
  const age = shownCapture == null ? null : performance.now() - shownCapture;
  const poseAge = poseCapture == null ? null : performance.now() - poseCapture;
  const mode = appMode();
  const lines = [`${presenting ? 'XR' : 'render'} ${n(renderFps.fps)} fps · cam ${n(cameraFps.fps)} fps`];
  if (mode !== 'pose') {
    lines.push(`cara ${n(inferTimes.count())} Hz · ${n(inferTimes.mean(), 1)} ms · p95 ${n(inferTimes.p95(), 1)} · lat ${age == null ? '–' : n(age)} ms`);
  }
  if (mode !== 'face') {
    lines.push(`pose ${n(poseTimes.count())} Hz · ${n(poseTimes.mean(), 1)} ms · p95 ${n(poseTimes.p95(), 1)} · ${n(posePeople)} pers · lat ${poseAge == null ? '–' : n(poseAge)} ms`);
  }
  const faceDet = detector ? `${detector.kind}/${detector.delegate}` : '';
  const poseDet = poseDetector ? `pose ${poseDetector.kind}/${poseDetector.delegate}` : '';
  lines.push(`desc ${n(dropTicks.fps + poseDrops.fps)} · ${[faceDet, poseDet].filter(Boolean).join(' · ') || '–'}`);
  return lines;
}

let lastHud = 0;
let lastLog = 0;
renderer.setAnimationLoop(((now: number, frame?: XRFrame) => {
  renderFps.tick(now);
  if (frame && renderer.xr.isPresenting) {
    const ref = renderer.xr.getReferenceSpace();
    if (ref) {
      try {
        const pose = frame.getViewerPose(ref);
        if (pose) {
          const p = pose.transform.position;
          const q = pose.transform.orientation;
          headHistory.push(now, { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] });
        }
      } catch { /* el reference space aún no vale para este frame */ }
    }
    const xrCam = renderer.xr.getCamera();
    hud.visible = true;
    hud.position.set(0, -0.18, -0.7).applyMatrix4(xrCam.matrixWorld);
    hud.quaternion.setFromRotationMatrix(xrCam.matrixWorld);
  } else {
    hud.visible = false;
  }

  const poseFresh = poseFilter.hasValue && performance.now() - lastAppliedAt < 500;
  faceRoot.visible = $<HTMLInputElement>('showMask').checked && poseFresh;
  if (!poseFresh && poseFilter.hasValue) poseFilter.reset();

  bodies.hideIfStale();

  if (now - lastHud > 300) {
    lastHud = now;
    const lines = perfLines();
    statsEl.textContent = lines.join(' · ') + (camera ? ` · ${camera.eye} ${camera.settings.width ?? ''}×${camera.settings.height ?? ''}` : '');
    if (renderer.xr.isPresenting) paintHud(lines);
  }
  if (now - lastLog > 1000) {
    lastLog = now;
    const age = shownCapture == null ? null : now - shownCapture;
    const poseAge = poseCapture == null ? null : now - poseCapture;
    debugReport({
      kind: 'perf',
      level: 'info',
      message: perfLines().join(' · '),
      data: {
        presenting: renderer.xr.isPresenting,
        mode: appMode(),
        xrFps: renderer.xr.isPresenting ? renderFps.fps : null,
        renderFps: renderFps.fps,
        cameraFps: cameraFps.fps,
        inferHz: inferTimes.count(),
        inferMeanMs: inferTimes.mean(),
        inferP95Ms: inferTimes.p95(),
        latencyMs: age,
        poseHz: poseTimes.count(),
        poseMeanMs: poseTimes.mean(),
        poseP95Ms: poseTimes.p95(),
        poseLatencyMs: poseAge,
        people: posePeople,
        droppedPerSec: dropTicks.fps + poseDrops.fps,
        detector: detector ? `${detector.kind}/${detector.delegate}` : null,
        poseDetector: poseDetector ? `${poseDetector.kind}/${poseDetector.delegate}` : null,
      },
    });
  }

  if (!renderer.xr.isPresenting && (appMode() !== 'face' || $<HTMLInputElement>('showOverlay').checked)) {
    drawOverlay(
      overlay,
      $<HTMLInputElement>('showOverlay').checked ? lastResult : null,
      appMode() === 'face' ? null : lastPose?.bodies ?? null,
      calib.mirror,
      lastPose?.width || lastResult?.width || video.videoWidth,
      lastPose?.height || lastResult?.height || video.videoHeight,
    );
  }
  renderer.render(scene, cam3d);
}) as unknown as XRFrameRequestCallback);

function paintHud(lines: string[]): void {
  const ctx = hudCanvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, 1024, 280);
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, 1024, 280);
  ctx.fillStyle = '#d6ffe8';
  ctx.font = 'bold 34px sans-serif';
  lines.slice(0, 4).forEach((row, index) => ctx.fillText(row, 24, 52 + index * 58));
  hudTex.needsUpdate = true;
}

async function setupAR(): Promise<void> {
  const btn = $<HTMLButtonElement>('btnAR');
  const supported = !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar').catch(() => false));
  btn.disabled = !supported;
  btn.title = supported ? '' : 'immersive-ar no soportado en este navegador';
  debugReport({
    kind: 'webxr',
    level: supported ? 'info' : 'warn',
    message: supported ? 'immersive-ar disponible' : 'immersive-ar no soportado',
    data: { available: !!navigator.xr, immersiveAr: supported },
  });
  if (!supported) log('immersive-ar no soportado aquí (normal en escritorio).');
  btn.onclick = async () => {
    if (renderer.xr.isPresenting) { await renderer.xr.getSession()?.end(); return; }
    if (!running) await start();
    if (!running) return;
    try {
      const session = await navigator.xr!.requestSession('immersive-ar', { optionalFeatures: ['local-floor', 'hand-tracking'] });
      await renderer.xr.setSession(session);
      poseFilter.reset();
      bodies.reset();
      headHistory.clear();
      btn.textContent = 'Salir de AR';
      log('Sesión immersive-ar iniciada. La máscara usa intrínsecos de fábrica y la pose del visor en captureTime.');
      debugReport({ kind: 'webxr', level: 'info', message: 'sesión immersive-ar iniciada', data: { enabledFeatures: session.enabledFeatures ?? [] } });
      session.addEventListener('end', () => {
        btn.textContent = 'Entrar en AR';
        poseFilter.reset();
        bodies.reset();
        headHistory.clear();
        resize();
        log('Sesión AR terminada');
        debugReport({ kind: 'webxr', level: 'info', message: 'sesión immersive-ar terminada' });
      });
    } catch (error) {
      const message = `No se pudo iniciar AR: ${(error as Error).message}`;
      log(message);
      debugReport({ kind: 'webxr', level: 'error', message, stack: error instanceof Error ? error.stack : undefined });
    }
  };
}

function applyMirror(): void {
  stage.classList.toggle('mirror', calib.mirror);
}

const sliderInputs = new Map<keyof Calibration, { input: HTMLInputElement; val: HTMLSpanElement }>();
function buildSliders(): void {
  const host = $<HTMLDivElement>('sliders');
  for (const spec of SLIDERS) {
    const label = document.createElement('label');
    label.textContent = spec.label;
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min: String(spec.min), max: String(spec.max), step: String(spec.step) });
    const val = document.createElement('span');
    val.className = 'val';
    input.oninput = () => {
      (calib as unknown as Record<string, number>)[spec.key] = Number(input.value);
      val.textContent = input.value;
      saveCalibration(calib);
      resize();
    };
    label.append(input, val);
    host.append(label);
    sliderInputs.set(spec.key, { input, val });
  }
}
function syncCalibUI(): void {
  for (const [key, { input, val }] of sliderInputs) {
    input.value = String(calib[key]);
    val.textContent = String(calib[key]);
  }
  $<HTMLInputElement>('mirror').checked = calib.mirror;
  applyMirror();
}

function readQuery(): void {
  const params = new URLSearchParams(location.search);
  const res = params.get('res');
  if (res === '640' || res === '640x480') $<HTMLSelectElement>('res').value = '640x480';
  const infer = Number(params.get('infer'));
  if (infer >= 5 && infer <= 30) $<HTMLInputElement>('inferCap').value = String(infer);
  if (params.get('gpu') === '0' || params.get('delegate') === 'cpu') $<HTMLInputElement>('useGPU').checked = false;
  if (params.get('worker') === '0') $<HTMLInputElement>('useWorker').checked = false;
  if (params.get('stereo') === '1') $<HTMLInputElement>('stereo').checked = true;
  if (params.get('overlay') === '1') {
    $<HTMLInputElement>('showOverlay').checked = true;
    overlay.style.display = 'block';
  }
  const poses = Number(params.get('poses'));
  if (poses === 2) $<HTMLSelectElement>('numPoses').value = '2';
  if (params.get('pose') === 'full') $<HTMLSelectElement>('poseModel').value = 'full';
  const mode = params.get('mode');
  if (mode === 'face' || mode === 'pose' || mode === 'both') $<HTMLSelectElement>('mode').value = mode;
  const calibUrl = params.get('calib');
  if (calibUrl) void fetchCalibration(calibUrl);
  const cam = params.get('cam');
  if (cam === 'left' || cam === 'quest-left') $<HTMLSelectElement>('camMode').value = 'quest-left';
  else if (cam === 'right' || cam === 'quest-right') $<HTMLSelectElement>('camMode').value = 'quest-right';
  else if (cam === 'webcam') $<HTMLSelectElement>('camMode').value = 'webcam';
}

function syncOverlayVisibility(): void {
  const show = $<HTMLInputElement>('showOverlay').checked || appMode() !== 'face';
  overlay.style.display = show ? 'block' : 'none';
}

async function fetchCalibration(url: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    adoptCalibration(await response.json(), url);
  } catch (error) {
    log(`No se pudo leer la calibración ${url}: ${(error as Error).message}`);
  }
}

function adoptCalibration(input: unknown, source: string): void {
  const parsed = parseStereoCalibration(input);
  if (!parsed) {
    log(`Calibración inválida (${source}). Se mantienen los intrínsecos de fábrica.`);
    return;
  }
  stereoCalib = parsed;
  storeCalibration(parsed);
  log(`Calibración v${parsed.version} ${parsed.distortion_model} ${parsed.image_size[0]}×${parsed.image_size[1]} desde ${source}. La distorsión se guarda y no se aplica (fase 2).`);
  refreshIntrinsics();
}

buildSliders();
syncCalibUI();
readQuery();
$<HTMLInputElement>('mirror').onchange = (event) => {
  calib.mirror = (event.target as HTMLInputElement).checked;
  saveCalibration(calib);
  applyMirror();
};
$<HTMLButtonElement>('btnResetCalib').onclick = () => { calib = { ...DEFAULT_CALIBRATION }; saveCalibration(calib); syncCalibUI(); resize(); };
$<HTMLButtonElement>('btnStart').onclick = () => void start();
$<HTMLButtonElement>('btnStop').onclick = stop;
$<HTMLInputElement>('showVideo').onchange = (event) => { video.style.visibility = (event.target as HTMLInputElement).checked ? 'visible' : 'hidden'; };
$<HTMLInputElement>('showOverlay').onchange = () => syncOverlayVisibility();
syncOverlayVisibility();
$<HTMLInputElement>('calibFile').onchange = () => {
  const file = $<HTMLInputElement>('calibFile').files?.[0];
  if (!file) return;
  void file.text().then((text) => {
    try { adoptCalibration(JSON.parse(text), file.name); }
    catch (error) { log(`JSON ilegible (${file.name}): ${(error as Error).message}`); }
  });
};
$<HTMLButtonElement>('btnClearCalib').onclick = () => {
  stereoCalib = null;
  storeCalibration(null);
  log('Calibración olvidada. Se usan los intrínsecos de fábrica.');
  refreshIntrinsics();
};

async function loadGlb(url: string): Promise<void> {
  try {
    log(`Cargando GLB ${url}…`);
    setMask(await loadGlbMask(url));
    log('GLB cargado');
  } catch (error) {
    log(`Error cargando GLB: ${(error as Error).message}`);
  }
}
$<HTMLButtonElement>('btnGlb').onclick = () => {
  const url = $<HTMLInputElement>('glbUrl').value.trim();
  if (url) void loadGlb(url);
};
$<HTMLButtonElement>('btnProcedural').onclick = () => setMask(createProceduralMask());

const glbParam = new URLSearchParams(location.search).get('glb');
if (glbParam) { $<HTMLInputElement>('glbUrl').value = glbParam; void loadGlb(glbParam); }

if (!window.isSecureContext) {
  const message = 'No es un contexto seguro: getUserMedia y WebXR no funcionan por http://IP. Usa npm run dev:lan y abre la URL https de la LAN.';
  log(message);
  showBanner(message, 'error');
}
debugReport({
  kind: 'startup',
  level: 'info',
  message: 'arranque v0.3',
  data: { userAgent: navigator.userAgent, secureContext: window.isSecureContext, mediaDevices: !!navigator.mediaDevices?.getUserMedia },
});
void setupAR();
resize();
