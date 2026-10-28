import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Máscara procedural en unidades del modelo canónico de MediaPipe (cm; la cara mira hacia +Z;
 * extensión aprox. x ±7.7, y −9.4…8.3, z −2.4…7.6; punta de la nariz ≈ (0, −1.1, 7.5)). Se escala a metros mediante la matriz del grupo padre.
 */
export function createProceduralMask(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'procedural-mask';

  const gold = new THREE.MeshStandardMaterial({ color: 0xd4a017, metalness: 0.85, roughness: 0.3, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, metalness: 0.2, roughness: 0.6 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xc0392b, metalness: 0.4, roughness: 0.4, emissive: 0x300000 });

  // Concha frontal: media elipsoide (phi ∈ [0, π] ⇒ z ≥ 0, mira hacia +Z).
  const shellGeo = new THREE.SphereGeometry(1, 48, 32, 0, Math.PI, 0, Math.PI);
  const shell = new THREE.Mesh(shellGeo, gold);
  shell.scale.set(8.2, 10, 8);
  shell.position.set(0, -0.5, 0);
  group.add(shell);

  // Ojos (anillos oscuros) a la altura aproximada de los ojos del modelo canónico.
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.35, 12, 32), dark);
    eye.position.set(sx * 3.2, 2.7, 7.0);
    eye.rotation.y = sx * 0.35;
    group.add(eye);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.5, 0.6), accent);
    brow.position.set(sx * 3.2, 4.8, 6.3);
    brow.rotation.z = sx * -0.2;
    group.add(brow);
  }

  // Nariz.
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.9, 3.2, 16), gold);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, -1.1, 8.6);
  group.add(nose);

  // Cuerno decorativo.
  const horn = new THREE.Mesh(new THREE.ConeGeometry(0.8, 4, 16), accent);
  horn.position.set(0, 10.5, 1);
  group.add(horn);

  return group;
}

/** Carga un GLB/GLTF. Se espera en metros, centrado en la cabeza y mirando a +Z; se convierte a cm. */
export async function loadGlbMask(url: string): Promise<THREE.Group> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const group = new THREE.Group();
  group.name = 'glb-mask';
  gltf.scene.scale.setScalar(100); // m -> cm (espacio canónico de MediaPipe)
  group.add(gltf.scene);
  return group;
}
