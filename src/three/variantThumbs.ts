// Anteprime delle varianti colore/materiale: il GLB del modello attivo viene
// renderizzato offscreen una volta per preset, in una mini-scena di studio
// coerente con il viewport principale. Tutto locale, nessun credito AI.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { applyStyleToMaterials, type MaterialOriginal, type MaterialStyle } from "./scene";
import type { MaterialPreset } from "@/lib/materialPresets";

export interface VariantThumb {
  id: string;
  label: string;
  swatch: string;
  style: MaterialStyle;
  dataUrl: string;
}

const THUMB_SIZE = 176;

/**
 * Renderizza il modello con ciascun preset e restituisce le miniature PNG.
 * Lancia un errore se il GLB non è leggibile (es. compressione non supportata):
 * il chiamante mostra un messaggio e lascia riprovare.
 */
export async function renderVariantThumbs(
  glb: ArrayBuffer,
  presets: MaterialPreset[],
): Promise<VariantThumb[]> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = THUMB_SIZE;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#2b2d33");
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.65;

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 4.5, 4);
  const rim = new THREE.DirectionalLight(0xff670d, 6);
  rim.position.set(-3.5, 2, -4);
  const fill = new THREE.HemisphereLight(0xdfe6f2, 0x141418, 0.4);
  scene.add(key, rim, fill);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);

  const parsed = await new GLTFLoader().parseAsync(glb.slice(0), "");
  const model = parsed.scene;

  // normalizza: centro nell'origine, dimensione costante qualunque sia la scala
  const sphere = new THREE.Box3()
    .setFromObject(model)
    .getBoundingSphere(new THREE.Sphere());
  const s = 1.55 / sphere.radius;
  model.scale.setScalar(s);
  model.position.set(-sphere.center.x * s, -sphere.center.y * s, -sphere.center.z * s);
  scene.add(model);

  const dist = (1.55 / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.18;
  camera.position.set(dist * 0.55, dist * 0.38, dist * 0.75);
  camera.lookAt(0, 0, 0);

  const originalMaps = new WeakMap<THREE.Material, MaterialOriginal>();
  const thumbs: VariantThumb[] = [];
  for (const p of presets) {
    applyStyleToMaterials(model, p.style, originalMaps);
    renderer.render(scene, camera);
    thumbs.push({
      id: p.id,
      label: p.label,
      swatch: p.swatch,
      style: { ...p.style },
      dataUrl: canvas.toDataURL("image/png"),
    });
  }

  // pulizia: il renderer offscreen non è nel DOM, va smaltito a mano
  scene.remove(model);
  model.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => {
        m.map?.dispose();
        m.dispose();
      });
    }
  });
  envTex.dispose();
  pmrem.dispose();
  renderer.dispose();
  // senza forceContextLoss il contesto WebGL resta vivo: dopo ~16 modelli il
  // browser chiude il più vecchio, cioè il viewport principale (schermo nero)
  renderer.forceContextLoss();
  return thumbs;
}
