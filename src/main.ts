import * as THREE from 'three';
import { getBestCamera, stopStream, type CameraResult } from './camera';
import { DEFAULT_CALIBRATION, SLIDERS, loadCalibration, saveCalibration, type Calibration } from './calibration';
import { FpsCounter } from './fps';
import { drawOverlay } from './overlay';
import { createProceduralMask, loadGlbMask } from './scene/mask';
import { PoseSmoother, cameraOffsetMatrix, faceMatrixToCameraSpace } from './scene/pose';
import { createFaceDetector, type FaceDetector } from './vision/detector';
import type { ResultMsg } from './vision/protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const glCanvas = $<HTMLCanvasElement>('gl');
const overlay = $<HTMLCanvasElement>('overlay');
const stage = $<HTMLDivElement>('stage');
const statsEl = $<HTMLDivElement>('stats');
const logEl = $<HTMLPreElement>('log');

function log(msg: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  logEl.textContent = (line + '\n' + (logEl.textContent ?? '')).slice(0, 6000);
}

// ---------- Estado ----------
let calib: Calibration = loadCalibration();
let camera: CameraResult | null = null;
let detector: FaceDetector | null = null;
let running = false;
let lastResult: ResultMsg | null = null;
const renderFps = new FpsCounter();
const inferFps = new FpsCounter();
let lastInferMs = 0;

// ---------- three.js ----------
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

const faceRoot = new THREE.Group(); // pose suavizada (espacio mundo)
faceRoot.visible = false;
scene.add(faceRoot);
let maskObj: THREE.Object3D = createProceduralMask();
faceRoot.add(maskObj);
const smoother = new PoseSmoother();

// HUD 3D para ver FPS dentro de la sesión inmersiva (el DOM no es visible en AR).
const hudCanvas = document.createElement('canvas');
hudCanvas.width = 512; hudCanvas.height = 96;
const hudTex = new THREE.CanvasTexture(hudCanvas);
const hud = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.06), new THREE.MeshBasicMaterial({ map: hudTex, transparent: true, depthTest: false }));
hud.renderOrder = 999;
hud.visible = false;
scene.add(hud);

function setMask(obj: THREE.Object3D): void {
  faceRoot.remove(maskObj);
  maskObj = obj;
  faceRoot.add(maskObj);
}

function resize(): void {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!renderer.xr.isPresenting) renderer.setSize(w, h, false);
  cam3d.aspect = w / Math.max(1, h);
  cam3d.fov = calib.fovDeg;
  cam3d.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

// Historial de poses de la cabeza (XR) por timestamp de captura, para compensar latencia.
const headHistory = new Map<number, THREE.Matrix4>();
function snapshotHead(ts: number): void {
  if (!renderer.xr.isPresenting) return;
  headHistory.set(ts, renderer.xr.getCamera().matrixWorld.clone());
  if (headHistory.size > 30) headHistory.delete(headHistory.keys().next().value!);
}

const tmpFace = new THREE.Matrix4();
const tmpOffset = new THREE.Matrix4();
const tmpWorld = new THREE.Matrix4();
function onResult(r: ResultMsg): void {
  lastResult = r;
  inferFps.tick();
  lastInferMs = r.inferMs;
  if (!r.matrix) { headHistory.delete(r.timestamp); return; }
  faceMatrixToCameraSpace(r.matrix, calib, tmpFace);
  if (renderer.xr.isPresenting) {
    const head = headHistory.get(r.timestamp) ?? renderer.xr.getCamera().matrixWorld;
    headHistory.delete(r.timestamp);
    tmpWorld.copy(head).multiply(cameraOffsetMatrix(calib, tmpOffset)).multiply(tmpFace);
  } else {
    tmpWorld.copy(tmpFace); // escritorio: cámara 3D en el origen = cámara física
  }
  smoother.setTarget(tmpWorld);
}

// ---------- Bucle de inferencia (temporizador, no rAF: rAF de la página no corre en sesión XR) ----------
async function inferenceLoop(): Promise<void> {
  let lastVideoTime = -1;
  while (running && detector) {
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const ts = performance.now();
      snapshotHead(ts);
      try {
        const r = await detector.detect(video, ts);
        if (r) onResult(r);
        // En hilo principal detectForVideo es síncrono: ceder al event loop para no bloquear el render.
        if (detector?.kind === 'main-thread') await new Promise((res) => setTimeout(res, 0));
      } catch (e) {
        log(`Error de inferencia: ${(e as Error).message}`);
        await new Promise((res) => setTimeout(res, 200));
      }
    } else {
      await new Promise((res) => setTimeout(res, 4));
    }
  }
}

// ---------- Render ----------
let lastFrame = performance.now();
let lastHud = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min(100, now - lastFrame);
  lastFrame = now;
  renderFps.tick(now);

  smoother.step(dt, calib.smoothingMs);
  smoother.applyTo(faceRoot);
  const fresh = performance.now() - smoother.lastUpdate < 500 && !!lastResult?.matrix;
  faceRoot.visible = $<HTMLInputElement>('showMask').checked && fresh;
  if (!fresh) smoother.reset();

  if (renderer.xr.isPresenting) {
    const xrCam = renderer.xr.getCamera();
    hud.visible = true;
    hud.position.set(-0.12, -0.14, -0.6).applyMatrix4(xrCam.matrixWorld);
    hud.quaternion.setFromRotationMatrix(xrCam.matrixWorld);
  } else {
    hud.visible = false;
  }

  if (now - lastHud > 300) {
    lastHud = now;
    const det = detector ? `${detector.kind}/${detector.delegate}` : '–';
    const text = `render: ${renderFps.fps} fps · inferencia: ${inferFps.fps} fps · ${lastInferMs.toFixed(1)} ms · detector: ${det}`;
    statsEl.textContent = text + (camera ? ` · ${camera.source} ${camera.settings.width}x${camera.settings.height}` : '');
    if (renderer.xr.isPresenting) {
      const c = hudCanvas.getContext('2d')!;
      c.clearRect(0, 0, 512, 96);
      c.fillStyle = 'rgba(0,0,0,0.6)'; c.fillRect(0, 0, 512, 96);
      c.fillStyle = '#9fe8c9'; c.font = '22px monospace';
      c.fillText(`render ${renderFps.fps} fps | infer ${inferFps.fps} fps`, 12, 36);
      c.fillText(`${lastInferMs.toFixed(1)} ms | ${det}`, 12, 72);
      hudTex.needsUpdate = true;
    }
  }

  if ($<HTMLInputElement>('showOverlay').checked && !renderer.xr.isPresenting) drawOverlay(overlay, lastResult, calib.mirror);
  renderer.render(scene, cam3d);
});

// ---------- Arranque / parada ----------
async function start(): Promise<void> {
  $<HTMLButtonElement>('btnStart').disabled = true;
  try {
    camera = await getBestCamera($<HTMLSelectElement>('camMode').value as never, log);
    log(`Cámara: ${camera.label} (${camera.source}) ${camera.settings.width}x${camera.settings.height}@${camera.settings.frameRate}`);
    video.srcObject = camera.stream;
    await video.play();
    if (video.videoWidth && video.videoHeight) stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    // Espejo por defecto solo para webcam frontal.
    if (camera.source === 'quest-passthrough' && calib.mirror) { calib.mirror = false; saveCalibration(calib); syncCalibUI(); }
    applyMirror();
    resize();

    log('Cargando FaceLandmarker…');
    detector = await createFaceDetector({
      preferWorker: $<HTMLInputElement>('useWorker').checked,
      preferGPU: $<HTMLInputElement>('useGPU').checked,
      log,
    });
    log(`Detector listo: ${detector.kind} / ${detector.delegate}`);
    running = true;
    void inferenceLoop();
    $<HTMLButtonElement>('btnStop').disabled = false;
  } catch (e) {
    log(`Error al iniciar: ${(e as Error).message}`);
    stop();
  }
}

function stop(): void {
  running = false;
  detector?.dispose();
  detector = null;
  stopStream(camera?.stream);
  camera = null;
  video.srcObject = null;
  lastResult = null;
  overlay.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height);
  $<HTMLButtonElement>('btnStart').disabled = false;
  $<HTMLButtonElement>('btnStop').disabled = true;
}

// ---------- WebXR immersive-ar ----------
async function setupAR(): Promise<void> {
  const btn = $<HTMLButtonElement>('btnAR');
  const supported = !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar').catch(() => false));
  btn.disabled = !supported;
  btn.title = supported ? '' : 'immersive-ar no soportado en este navegador';
  if (!supported) log('immersive-ar no soportado aquí (normal en escritorio).');
  btn.onclick = async () => {
    if (renderer.xr.isPresenting) { await renderer.xr.getSession()?.end(); return; }
    if (!running) await start(); // la cámara debe pedirse antes de entrar en la sesión
    try {
      const session = await navigator.xr!.requestSession('immersive-ar', { optionalFeatures: ['local-floor'] });
      await renderer.xr.setSession(session);
      smoother.reset();
      btn.textContent = 'Salir de AR';
      log('Sesión immersive-ar iniciada');
      session.addEventListener('end', () => {
        btn.textContent = 'Entrar en AR';
        smoother.reset();
        resize();
        log('Sesión AR terminada');
      });
    } catch (e) {
      log(`No se pudo iniciar AR: ${(e as Error).message}`);
    }
  };
}

// ---------- UI ----------
function applyMirror(): void {
  stage.classList.toggle('mirror', calib.mirror);
}

const sliderInputs = new Map<keyof Calibration, { input: HTMLInputElement; val: HTMLSpanElement }>();
function buildSliders(): void {
  const host = $<HTMLDivElement>('sliders');
  for (const s of SLIDERS) {
    const label = document.createElement('label');
    label.textContent = s.label;
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min: String(s.min), max: String(s.max), step: String(s.step) });
    const val = document.createElement('span');
    val.className = 'val';
    input.oninput = () => {
      (calib as unknown as Record<string, number>)[s.key] = Number(input.value);
      val.textContent = input.value;
      saveCalibration(calib);
      resize();
    };
    label.append(input, val);
    host.append(label);
    sliderInputs.set(s.key, { input, val });
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

buildSliders();
syncCalibUI();
$<HTMLInputElement>('mirror').onchange = (e) => { calib.mirror = (e.target as HTMLInputElement).checked; saveCalibration(calib); applyMirror(); };
$<HTMLButtonElement>('btnResetCalib').onclick = () => { calib = { ...DEFAULT_CALIBRATION }; saveCalibration(calib); syncCalibUI(); resize(); };
$<HTMLButtonElement>('btnStart').onclick = () => void start();
$<HTMLButtonElement>('btnStop').onclick = stop;
$<HTMLInputElement>('showVideo').onchange = (e) => { video.style.visibility = (e.target as HTMLInputElement).checked ? 'visible' : 'hidden'; };
$<HTMLInputElement>('showOverlay').onchange = (e) => {
  overlay.style.display = (e.target as HTMLInputElement).checked ? 'block' : 'none';
};
overlay.style.display = 'none';

async function loadGlb(url: string): Promise<void> {
  try {
    log(`Cargando GLB ${url}…`);
    setMask(await loadGlbMask(url));
    log('GLB cargado');
  } catch (e) {
    log(`Error cargando GLB: ${(e as Error).message}`);
  }
}
$<HTMLButtonElement>('btnGlb').onclick = () => {
  const url = $<HTMLInputElement>('glbUrl').value.trim();
  if (url) void loadGlb(url);
};
$<HTMLButtonElement>('btnProcedural').onclick = () => setMask(createProceduralMask());

const glbParam = new URLSearchParams(location.search).get('glb');
if (glbParam) { $<HTMLInputElement>('glbUrl').value = glbParam; void loadGlb(glbParam); }

if (!window.isSecureContext) log('⚠️ No es contexto seguro: usa https o http://localhost (adb reverse).');
void setupAR();
resize();
