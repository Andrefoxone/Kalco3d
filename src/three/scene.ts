// Viewport 3D: scena Three.js gestita fuori da React, con strumenti di editing
// in stile "programma 3D": gizmo di trasformazione, scultura a pennello,
// viste camera, materiali, luci ed export GLB/STL.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { USDZExporter } from "three/examples/jsm/exporters/USDZExporter.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { analyzePrintability, stlToPrintSpace, type PrintReport } from "./printCheck";
import { extractPrintInput } from "@/print/sceneSample";
import type { PrintInput } from "@/print/pipeline";
import { SculptTarget, type SculptMode } from "./sculpt";

export type { SculptMode } from "./sculpt";

export type LoadState = "empty" | "loading" | "ready" | "error";
export type TransformMode = "translate" | "rotate" | "scale";
export type CameraView = "front" | "side" | "top" | "iso";
export type LightingPreset = "studio" | "giorno" | "tramonto" | "notte";
export type BackgroundPreset = "scuro" | "neutro" | "chiaro";

export interface MaterialStyle {
  /** null = tinta disattivata, si usa la texture della foto */
  tint: string | null;
  useMap: boolean;
  metalness: number;
  roughness: number;
  /** lacca protettiva lucida 0..1 (ceramica, plastiche verniciate) */
  clearcoat?: number;
  /** trasmissione della luce 0..1 (vetro) */
  transmission?: number;
  /** colore emissivo opzionale (display, neon) */
  emissive?: string | null;
  /**
   * true = materiale originale del modello (preset "Foto"): colore, metallo,
   * ruvidità ed emissione restano quelli del GLB. Fondamentale per i modelli AI
   * con texture PBR: forzare metalness/roughness ne cancellerebbe le mappe.
   */
  original?: boolean;
}

/** Una vista renderizzata del modello (anteprima PNG in data URL). */
export interface CapturedView {
  id: string;
  label: string;
  dataUrl: string;
}

/** Valori del materiale come arrivati dal file, per poterli ripristinare. */
export interface MaterialOriginal {
  map: THREE.Texture | null;
  color: THREE.Color;
  metalness: number;
  roughness: number;
  emissive: THREE.Color;
  emissiveIntensity: number;
  clearcoat: number;
  transmission: number;
}

/**
 * Applica uno stile CMF a tutte le mesh di un oggetto, convertendo i materiali
 * in MeshPhysicalMaterial (necessario per clearcoat/transmission).
 * La conversione copia TUTTE le proprietà del materiale standard (mappe PBR,
 * normal/AO, alphaTest del ritaglio, lato, trasparenza): copiarne solo alcune
 * rovinava le texture dei modelli AI e bucava i rilievi con sfondo ritagliato.
 */
export function applyStyleToMaterials(
  root: THREE.Object3D,
  style: MaterialStyle,
  originals: WeakMap<THREE.Material, MaterialOriginal>,
): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const next = mats.map((m) => {
      let mat: THREE.MeshPhysicalMaterial;
      if (m instanceof THREE.MeshPhysicalMaterial) {
        mat = m;
      } else if (m instanceof THREE.MeshStandardMaterial) {
        mat = new THREE.MeshPhysicalMaterial();
        // copia completa delle proprietà "standard" (mappe, fattori, alphaTest…)
        THREE.MeshStandardMaterial.prototype.copy.call(mat, m);
        // la copy standard reimposta i define: senza PHYSICAL lo shader ignora
        // clearcoat e transmission
        mat.defines = { STANDARD: "", PHYSICAL: "" };
        m.dispose();
      } else {
        // materiali non PBR (es. Lambert/Phong da OBJ): conversione essenziale
        const src = m as THREE.MeshLambertMaterial;
        mat = new THREE.MeshPhysicalMaterial({
          color: src.color ?? new THREE.Color("#ffffff"),
          map: src.map ?? null,
          vertexColors: src.vertexColors ?? false,
          side: src.side,
          transparent: src.transparent,
          opacity: src.opacity,
          alphaTest: src.alphaTest,
          roughness: 0.7,
          metalness: 0,
        });
        m.dispose();
      }
      let orig = originals.get(mat);
      if (!orig) {
        orig = {
          map: mat.map ?? null,
          color: mat.color.clone(),
          metalness: mat.metalness,
          roughness: mat.roughness,
          emissive: mat.emissive.clone(),
          emissiveIntensity: mat.emissiveIntensity,
          clearcoat: mat.clearcoat,
          transmission: mat.transmission,
        };
        originals.set(mat, orig);
      }
      mat.map = style.useMap ? orig.map : null;
      if (style.original) {
        mat.color.copy(orig.color);
        mat.metalness = orig.metalness;
        mat.roughness = orig.roughness;
        mat.emissive.copy(orig.emissive);
        mat.emissiveIntensity = orig.emissiveIntensity;
        mat.clearcoat = orig.clearcoat;
        mat.transmission = orig.transmission;
      } else {
        mat.color.set(style.tint ?? "#ffffff");
        mat.metalness = style.metalness;
        mat.roughness = style.roughness;
        mat.clearcoat = style.clearcoat ?? 0;
        mat.transmission = style.transmission ?? 0;
        if (style.emissive) {
          mat.emissive.set(style.emissive);
          mat.emissiveIntensity = 0.9;
        } else {
          mat.emissive.set("#000000");
        }
      }
      mat.clearcoatRoughness = mat.clearcoat ? 0.22 : 1;
      if (mat.transmission > 0) {
        mat.thickness = 0.4;
        mat.ior = 1.5;
        mat.transparent = false; // la transmission gestisce da sé la trasparenza
      }
      mat.needsUpdate = true;
      return mat;
    });
    obj.material = Array.isArray(obj.material) ? next : next[0];
  });
}

export const DEFAULT_MATERIAL: MaterialStyle = {
  tint: null,
  useMap: true,
  metalness: 0.02,
  roughness: 0.85,
  original: true,
};

export interface ViewportCallbacks {
  onStateChange?: (state: LoadState) => void;
  /** nomi delle animazioni del modello caricato (vuoto se statico) */
  onAnimations?: (names: string[]) => void;
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
}

type SculptSnap = ReturnType<SculptTarget["snapshot"]>;

type Snapshot =
  | { kind: "sculpt"; entries: { target: SculptTarget; data: SculptSnap }[] }
  | {
      kind: "xform";
      position: THREE.Vector3;
      quaternion: THREE.Quaternion;
      scale: THREE.Vector3;
    };

const HISTORY_LIMIT = 40;

const BG_COLORS: Record<BackgroundPreset, string> = {
  scuro: "#101013",
  neutro: "#3a3a40",
  chiaro: "#d8d8dc",
};

export class ViewportScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private transform: TransformControls;
  private model: THREE.Object3D | null = null;
  private modelCenter = new THREE.Vector3();
  /** lato più lungo del modello come arriva dal GLB (in metri se il motore usa misure reali) */
  private sourceMaxDim: number | null = null;
  /** scala applicata per mostrare il modello a 2 unità: va tolta all'export */
  private normScale = 1;
  private raf = 0;
  private mixer: THREE.AnimationMixer | null = null;
  private clips: THREE.AnimationClip[] = [];
  private clock = new THREE.Clock();
  private resizeObserver: ResizeObserver;
  private callbacks: ViewportCallbacks;
  private container: HTMLElement;
  private hemi: THREE.HemisphereLight;
  private key: THREE.DirectionalLight;
  private rim: THREE.PointLight;
  private grid: THREE.GridHelper;
  private floor: THREE.Mesh;
  private envMap: THREE.Texture | null = null;
  private envIntensity = 0.6;
  private originalMaps = new WeakMap<THREE.Material, MaterialOriginal>();
  private materialStyle: MaterialStyle = { ...DEFAULT_MATERIAL };

  // stato scultura
  private sculptMode: SculptMode | null = null;
  private sculptRadius = 0.3;
  private sculptStrength = 0.5;
  private sculptSymmetryX = false;
  private sculpting = false;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private lastNormalRecompute = 0;
  /** un motore di scultura (vertici saldati + BVH) per ogni mesh del modello */
  private targets = new Map<THREE.Mesh, SculptTarget>();
  /** centro di simmetria X per mesh (spazio locale), dal bbox originale */
  private mirrorCenter = new Map<SculptTarget, number>();
  /** ultimo punto (mondo) in cui è stata applicata una pennellata: spacing */
  private lastDabPoint: THREE.Vector3 | null = null;
  /** piano di "appiattisci" in spazio mondo, catturato al primo tocco */
  private flattenPlane: { point: THREE.Vector3; normal: THREE.Vector3 } | null = null;

  // cronologia annulla/ripeti (scultura e trasformazioni)
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  /** snapshot pre-tratto, preso alla prima pennellata su ciascuna mesh */
  private pendingStroke: Map<SculptTarget, SculptSnap> | null = null;
  private pendingXform: Snapshot | null = null;

  constructor(container: HTMLElement, callbacks: ViewportCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // resa "da render": tone mapping Khronos PBR Neutral (colori della foto fedeli,
    // alte luci morbide) e ombre morbide
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG_COLORS.scuro);
    this.scene.fog = new THREE.Fog(BG_COLORS.scuro, 9, 24);

    // illuminazione ambientale (IBL): riflessi credibili, i metalli non sono più neri
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envMap = pmrem.fromScene(room, 0.04).texture;
    room.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    pmrem.dispose();
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = this.envIntensity;

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 100);
    this.camera.position.set(2.5, 1.6, 3.9);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 14;
    this.controls.autoRotateSpeed = 1.6;

    // gizmo di trasformazione (sposta / ruota / scala)
    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.addEventListener("dragging-changed", (e) => {
      this.controls.enabled = !e.value;
      if (e.value) {
        this.pendingXform = this.snapshotTransform();
      } else if (this.pendingXform) {
        this.pushUndo(this.pendingXform);
        this.pendingXform = null;
      }
    });
    const transformHelper = (this.transform as unknown as { getHelper?: () => THREE.Object3D }).getHelper?.();
    this.scene.add(transformHelper ?? (this.transform as unknown as THREE.Object3D));

    // luci
    this.hemi = new THREE.HemisphereLight(0xdfe6f2, 0x141418, 0.35);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 1.7);
    this.key.position.set(3.5, 4.5, 4);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.radius = 4;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    const sc = this.key.shadow.camera;
    sc.left = -3; sc.right = 3; sc.top = 3; sc.bottom = -3; sc.near = 0.5; sc.far = 16;
    this.scene.add(this.key);
    this.rim = new THREE.PointLight(0xff670d, 26, 30, 2);
    this.rim.position.set(-4.5, -0.6, -3.5);
    this.scene.add(this.rim);

    // pavimento tecnico
    this.grid = new THREE.GridHelper(12, 24, 0xff670d, 0x2a2a31);
    this.grid.position.y = -1.45;
    const gridMat = this.grid.material as THREE.Material;
    gridMat.transparent = true;
    gridMat.opacity = 0.35;
    this.scene.add(this.grid);

    this.floor = new THREE.Mesh(
      new THREE.CircleGeometry(7, 48),
      // il pavimento prende poca luce ambientale: resta scuro e fa risaltare il modello
      new THREE.MeshStandardMaterial({ color: 0x141417, roughness: 1, metalness: 0, envMapIntensity: 0.15 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -1.46;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    // scultura: ascolto i pointer event sul canvas
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.clock.getDelta();
    this.mixer?.update(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private setState(state: LoadState) {
    this.callbacks.onStateChange?.(state);
  }

  hasModel(): boolean {
    return this.model !== null;
  }

  // ---------- caricamento ----------

  loadModel(url: string): Promise<boolean> {
    this.setState("loading");
    return new Promise((resolve) => {
      new GLTFLoader().load(
        url,
        (gltf) => {
          this.clearModel();
          this.placeModel(gltf.scene);
          this.applyMaterialStyle(this.materialStyle);
          this.setupAnimations(gltf.scene, gltf.animations);
          this.setState("ready");
          resolve(true);
        },
        undefined,
        () => {
          this.setState("error");
          resolve(false);
        },
      );
    });
  }

  /** Inserisce un Object3D costruito in locale (es. import CAD) come modello attivo. */
  setModelFromObject(obj: THREE.Object3D): boolean {
    try {
      this.setState("loading");
      this.clearModel();
      this.placeModel(obj);
      this.applyMaterialStyle(this.materialStyle);
      this.setState("ready");
      return true;
    } catch {
      this.setState("error");
      return false;
    }
  }

  private placeModel(obj: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    this.sourceMaxDim = maxDim;
    const scale = 2.0 / maxDim;
    this.normScale = scale;
    obj.scale.setScalar(scale);
    obj.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    // pavimento e griglia appoggiati sotto il modello (prima fluttuava)
    const bottom = -(size.y * scale) / 2;
    this.floor.position.y = bottom - 0.004;
    this.grid.position.y = bottom - 0.002;
    this.model = obj;
    this.modelCenter.set(0, 0, 0);
    this.scene.add(obj);
    this.resetCamera();
  }

  // ---------- animazioni (modelli con scheletro) ----------

  private setupAnimations(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.clips = clips.filter((c) => c.duration > 0);
    if (this.clips.length > 0) {
      this.mixer = new THREE.AnimationMixer(root);
      this.playAnimation(this.clips[0].name);
    }
    this.callbacks.onAnimations?.(this.clips.map((c) => c.name));
  }

  /** Avvia un'animazione per nome; null ferma tutto e torna alla posa di riposo. */
  playAnimation(name: string | null) {
    if (!this.mixer) return;
    this.mixer.stopAllAction();
    if (!name) return;
    const clip = this.clips.find((c) => c.name === name);
    if (!clip) return;
    this.mixer.clipAction(clip).reset().setLoop(THREE.LoopRepeat, Infinity).play();
  }

  private stopAnimations() {
    if (this.mixer) {
      this.mixer.stopAllAction();
      if (this.model) this.mixer.uncacheRoot(this.model);
    }
    this.mixer = null;
    if (this.clips.length > 0) this.callbacks.onAnimations?.([]);
    this.clips = [];
  }

  private clearModel() {
    if (!this.model) return;
    this.stopAnimations();
    this.transform.detach();
    this.clearHistory();
    this.targets.forEach((t) => t.dispose());
    this.targets.clear();
    this.mirrorCenter.clear();
    this.scene.remove(this.model);
    this.model.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => {
          const std = m as THREE.MeshStandardMaterial;
          std.map?.dispose();
          m.dispose();
        });
      }
    });
    this.model = null;
  }

  // ---------- gizmo trasformazione ----------

  setTransformMode(mode: TransformMode | null) {
    if (!mode || !this.model) {
      this.transform.detach();
      return;
    }
    this.transform.attach(this.model);
    this.transform.setMode(mode);
  }

  // ---------- scultura ----------

  setSculptMode(mode: SculptMode | null) {
    this.sculptMode = mode;
    this.renderer.domElement.style.cursor = mode ? "crosshair" : "";
    if (mode) this.ensureTargets();
  }

  setSculptSymmetry(on: boolean) {
    this.sculptSymmetryX = on;
  }

  /** Prepara (una volta per modello) saldatura vertici e BVH di ogni mesh. */
  private ensureTargets() {
    this.model?.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || obj instanceof THREE.SkinnedMesh) return;
      if (this.targets.has(obj)) return;
      const target = new SculptTarget(obj);
      this.targets.set(obj, target);
      const box = obj.geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
        obj.geometry.getAttribute("position") as THREE.BufferAttribute,
      );
      this.mirrorCenter.set(target, (box.min.x + box.max.x) / 2);
    });
  }

  setSculptParams(radius: number, strength: number) {
    this.sculptRadius = radius;
    this.sculptStrength = strength;
  }

  // ---------- cronologia annulla/ripeti ----------

  private snapshotTransform(): Snapshot | null {
    if (!this.model) return null;
    return {
      kind: "xform",
      position: this.model.position.clone(),
      quaternion: this.model.quaternion.clone(),
      scale: this.model.scale.clone(),
    };
  }

  private notifyHistory() {
    this.callbacks.onHistoryChange?.(this.undoStack.length > 0, this.redoStack.length > 0);
  }

  private pushUndo(snap: Snapshot) {
    this.undoStack.push(snap);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.notifyHistory();
  }

  private clearHistory() {
    this.undoStack = [];
    this.redoStack = [];
    this.pendingStroke = null;
    this.pendingXform = null;
    this.notifyHistory();
  }

  private applySnapshot(snap: Snapshot) {
    if (snap.kind === "sculpt") {
      for (const e of snap.entries) e.target.restore(e.data);
    } else if (this.model) {
      this.model.position.copy(snap.position);
      this.model.quaternion.copy(snap.quaternion);
      this.model.scale.copy(snap.scale);
    }
  }

  private inverseOf(snap: Snapshot): Snapshot | null {
    if (snap.kind === "sculpt") {
      return {
        kind: "sculpt",
        entries: snap.entries.map((e) => ({ target: e.target, data: e.target.snapshot() })),
      };
    }
    return this.snapshotTransform();
  }

  undo(): boolean {
    const snap = this.undoStack.pop();
    if (!snap) return false;
    const inverse = this.inverseOf(snap);
    this.applySnapshot(snap);
    if (inverse) this.redoStack.push(inverse);
    this.notifyHistory();
    return true;
  }

  redo(): boolean {
    const snap = this.redoStack.pop();
    if (!snap) return false;
    const inverse = this.inverseOf(snap);
    this.applySnapshot(snap);
    if (inverse) this.undoStack.push(inverse);
    this.notifyHistory();
    return true;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.sculptMode || !this.model || e.button !== 0) return;
    this.ensureTargets();
    const hit = this.pick(e);
    if (!hit) return;
    this.sculpting = true;
    this.controls.enabled = false;
    this.pendingStroke = new Map();
    this.lastDabPoint = null;
    this.flattenPlane = null;
    if (this.sculptMode === "flatten") {
      // piano = normale d'area sotto il pennello al primo tocco (più stabile della faccia)
      const mesh = hit.object as THREE.Mesh;
      const target = this.targets.get(mesh);
      if (target && hit.face) {
        const local = mesh.worldToLocal(hit.point.clone());
        const n = target.sampleAreaNormal(local, this.localRadius(mesh), hit.face.normal);
        this.flattenPlane = {
          point: hit.point.clone(),
          normal: n.transformDirection(mesh.matrixWorld),
        };
      }
    }
    this.stroke(hit);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.sculpting) return;
    const hit = this.pick(e);
    if (hit) this.stroke(hit);
  };

  private onPointerUp = () => {
    if (!this.sculpting) return;
    this.sculpting = false;
    this.controls.enabled = true;
    this.targets.forEach((t) => t.updateNormals(true));
    if (this.pendingStroke && this.pendingStroke.size > 0) {
      this.pushUndo({
        kind: "sculpt",
        entries: [...this.pendingStroke].map(([target, data]) => ({ target, data })),
      });
    }
    this.pendingStroke = null;
    this.flattenPlane = null;
    this.lastDabPoint = null;
  };

  private pick(e: PointerEvent): THREE.Intersection | null {
    if (!this.model) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    // con il BVH basta il primo impatto: molto più veloce sulle mesh grandi
    (this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
    const hits = this.raycaster.intersectObject(this.model, true);
    return hits.find((h) => h.object instanceof THREE.Mesh) ?? null;
  }

  private localRadius(mesh: THREE.Mesh): number {
    const s = mesh.getWorldScale(new THREE.Vector3());
    return this.sculptRadius / (Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)) || 1);
  }

  /** Spacing: una pennellata ogni ~20% del raggio percorso, indipendente dalla velocità. */
  private stroke(hit: THREE.Intersection) {
    const spacing = this.sculptRadius * 0.2;
    if (this.lastDabPoint && this.lastDabPoint.distanceTo(hit.point) < spacing) return;
    this.lastDabPoint = hit.point.clone();
    this.applyBrush(hit);
  }

  private applyBrush(hit: THREE.Intersection) {
    const mesh = hit.object as THREE.Mesh;
    const target = this.targets.get(mesh);
    const mode = this.sculptMode;
    if (!target || !mode || !hit.face) return;

    // snapshot per l'annulla alla prima pennellata su questa mesh
    if (this.pendingStroke && !this.pendingStroke.has(target)) {
      this.pendingStroke.set(target, target.snapshot());
    }

    const radius = this.localRadius(mesh);
    const center = mesh.worldToLocal(hit.point.clone());
    const hitNormal = hit.face.normal.clone();
    let plane: { point: THREE.Vector3; normal: THREE.Vector3 } | undefined;
    if (mode === "flatten") {
      if (!this.flattenPlane) return;
      const inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
      plane = {
        point: mesh.worldToLocal(this.flattenPlane.point.clone()),
        normal: this.flattenPlane.normal.clone().transformDirection(inv),
      };
    }
    target.applyDab({ mode, center, hitNormal, radius, strength: this.sculptStrength, plane });

    if (this.sculptSymmetryX) {
      const cx = this.mirrorCenter.get(target) ?? 0;
      const mirrored = new THREE.Vector3(2 * cx - center.x, center.y, center.z);
      if (mirrored.distanceTo(center) > radius * 0.05) {
        const mn = new THREE.Vector3(-hitNormal.x, hitNormal.y, hitNormal.z);
        const mplane = plane && {
          point: new THREE.Vector3(2 * cx - plane.point.x, plane.point.y, plane.point.z),
          normal: new THREE.Vector3(-plane.normal.x, plane.normal.y, plane.normal.z),
        };
        target.applyDab({
          mode, center: mirrored, hitNormal: mn, radius, strength: this.sculptStrength, plane: mplane,
        });
      }
    }

    // normali della zona scolpita, a intervalli durante il tratto
    const now = performance.now();
    if (now - this.lastNormalRecompute > 80) {
      this.lastNormalRecompute = now;
      target.updateNormals(false);
    }
  }

  // ---------- viste camera ----------

  setView(view: CameraView) {
    const d = 3.9;
    const c = this.modelCenter;
    const positions: Record<CameraView, [number, number, number]> = {
      front: [c.x, c.y, c.z + d],
      side: [c.x + d, c.y, c.z],
      top: [c.x, c.y + d, c.z + 0.001],
      iso: [c.x + d * 0.65, c.y + d * 0.42, c.z + d * 0.65],
    };
    const [x, y, z] = positions[view];
    this.camera.position.set(x, y, z);
    this.controls.target.copy(c);
  }

  resetCamera() {
    this.setView("iso");
  }

  /**
   * Renderizza il modello da 6 angolazioni e restituisce le PNG come data URL.
   * La camera viene ripristinata alla fine; il render è sincrono quindi non
   * serve preserveDrawingBuffer. Per la vista "dal basso" pavimento e griglia
   * vengono nascosti un attimo (altrimenti occluderebbero il modello).
   */
  captureViews(only?: string[]): CapturedView[] {
    if (!this.model) return [];
    const cam = this.camera;
    const savedPos = cam.position.clone();
    const savedQuat = cam.quaternion.clone();
    const sphere = new THREE.Box3()
      .setFromObject(this.model)
      .getBoundingSphere(new THREE.Sphere());
    const dist = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2))) * 1.14;
    const defs: { id: string; label: string; az: number; el: number }[] = [
      { id: "frontale", label: "Frontale", az: 0, el: 10 },
      { id: "tre-quarti", label: "Tre quarti", az: 45, el: 24 },
      { id: "laterale", label: "Laterale", az: 90, el: 10 },
      { id: "posteriore", label: "Posteriore", az: 180, el: 14 },
      { id: "dall-alto", label: "Dall'alto", az: 30, el: 62 },
      { id: "dal-basso", label: "Dal basso", az: -55, el: -18 },
    ];
    const shots: CapturedView[] = [];
    for (const d of only ? defs.filter((x) => only.includes(x.id)) : defs) {
      const az = THREE.MathUtils.degToRad(d.az);
      const el = THREE.MathUtils.degToRad(d.el);
      cam.position.set(
        sphere.center.x + dist * Math.sin(az) * Math.cos(el),
        sphere.center.y + dist * Math.sin(el),
        sphere.center.z + dist * Math.cos(az) * Math.cos(el),
      );
      cam.lookAt(sphere.center);
      const hideFloor = d.el < 0;
      const floorWas = this.floor.visible;
      const gridWas = this.grid.visible;
      if (hideFloor) {
        this.floor.visible = false;
        this.grid.visible = false;
      }
      this.renderer.render(this.scene, cam);
      shots.push({
        id: d.id,
        label: d.label,
        dataUrl: this.renderer.domElement.toDataURL("image/png"),
      });
      if (hideFloor) {
        this.floor.visible = floorWas;
        this.grid.visible = gridWas;
      }
    }
    cam.position.copy(savedPos);
    cam.quaternion.copy(savedQuat);
    return shots;
  }

  // ---------- materiali (stile Vizcom) ----------

  private forEachMaterial(fn: (m: THREE.MeshStandardMaterial) => void) {
    this.model?.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => fn(m as THREE.MeshStandardMaterial));
      }
    });
  }

  applyMaterialStyle(style: MaterialStyle) {
    this.materialStyle = { ...style };
    if (this.model) applyStyleToMaterials(this.model, style, this.originalMaps);
  }

  getMaterialStyle(): MaterialStyle {
    return { ...this.materialStyle };
  }

  setWireframe(on: boolean) {
    this.forEachMaterial((m) => {
      m.wireframe = on;
    });
  }

  // ---------- scena: sfondo, luci, griglia ----------

  setBackground(preset: BackgroundPreset) {
    const color = BG_COLORS[preset];
    this.scene.background = new THREE.Color(color);
    this.scene.fog = new THREE.Fog(color, 9, 24);
    const dark = preset === "chiaro";
    (this.floor.material as THREE.MeshStandardMaterial).color.set(dark ? 0xc6c6ca : 0x141417);
  }

  setLighting(preset: LightingPreset) {
    switch (preset) {
      case "studio":
        this.hemi.color.set(0xdfe6f2);
        this.hemi.groundColor.set(0x141418);
        this.hemi.intensity = 0.35;
        this.setEnvIntensity(0.6);
        this.key.color.set(0xffffff);
        this.key.intensity = 1.7;
        this.key.position.set(3.5, 4.5, 4);
        this.rim.color.set(0xff670d);
        this.rim.intensity = 26;
        break;
      case "giorno":
        this.hemi.color.set(0xf2f6ff);
        this.hemi.groundColor.set(0x30404f);
        this.hemi.intensity = 0.55;
        this.setEnvIntensity(1.0);
        this.key.color.set(0xfff4e0);
        this.key.intensity = 2.3;
        this.key.position.set(2, 5, 2.5);
        this.rim.color.set(0x9ab8ff);
        this.rim.intensity = 10;
        break;
      case "tramonto":
        this.hemi.color.set(0xffd9b0);
        this.hemi.groundColor.set(0x1c1008);
        this.hemi.intensity = 0.3;
        this.setEnvIntensity(0.3);
        this.key.color.set(0xff9a4d);
        this.key.intensity = 2.1;
        this.key.position.set(-4, 1.6, 3);
        this.rim.color.set(0xff5c1f);
        this.rim.intensity = 34;
        break;
      case "notte":
        this.hemi.color.set(0x2b3a55);
        this.hemi.groundColor.set(0x05060a);
        this.hemi.intensity = 0.2;
        this.setEnvIntensity(0.08);
        this.key.color.set(0x8fb4ff);
        this.key.intensity = 0.8;
        this.key.position.set(1, 5, -2);
        this.rim.color.set(0xff670d);
        this.rim.intensity = 44;
        break;
    }
  }

  private setEnvIntensity(v: number) {
    this.envIntensity = v;
    this.scene.environmentIntensity = v;
  }

  setGridVisible(visible: boolean) {
    this.grid.visible = visible;
    this.floor.visible = visible;
  }

  setAutoRotate(on: boolean) {
    this.controls.autoRotate = on;
  }

  // ---------- export ----------

  /** Statistiche della mesh corrente (per il salvataggio in galleria). */
  getStats(): { vertices: number; triangles: number } {
    let vertices = 0;
    let triangles = 0;
    this.model?.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const geom = obj.geometry as THREE.BufferGeometry;
        vertices += geom.attributes.position?.count ?? 0;
        triangles += Math.floor((geom.index?.count ?? geom.attributes.position?.count ?? 0) / 3);
      }
    });
    return { vertices, triangles };
  }

  /**
   * GLB nelle unità ORIGINALI del modello (metri per i motori AI in scala reale,
   * millimetri per molti CAD). Il viewport ingrandisce/rimpicciolisce tutto a
   * 2 unità: senza togliere quella scala, salvare una modifica o un import CAD
   * faceva perdere le misure vere (l'oggetto rientrava lungo "2").
   * Le trasformazioni del gizmo (sposta/ruota/scala) restano incluse.
   */
  exportGLB(): Promise<ArrayBuffer | null> {
    if (!this.model) return Promise.resolve(null);
    const holder = new THREE.Group();
    holder.name = "Modello";
    holder.scale.setScalar(1 / (this.normScale || 1));
    holder.add(this.model.clone(true));
    return new Promise((resolve) => {
      new GLTFExporter().parse(
        holder,
        (result) => resolve(result instanceof ArrayBuffer ? result : null),
        () => resolve(null),
        { binary: true },
      );
    });
  }

  /** Triangoli e colori del modello così come si vede, per la stampa. */
  getPrintInput(): PrintInput | null {
    return this.model ? extractPrintInput(this.model) : null;
  }

  /** Lato più lungo originale del GLB (metri se il motore ha usato misure reali). */
  getSourceMaxDim(): number | null {
    return this.sourceMaxDim;
  }

  /** Buchi e geometria ambigua: dice se il modello si stampa così com'è. */
  analyzePrint(): PrintReport | null {
    return this.model ? analyzePrintability(this.model) : null;
  }

  /** STL per lo slicer: millimetri, Z in alto, appoggiato sul piano. */
  exportSTL(longestMm = 100): ArrayBuffer | null {
    if (!this.model) return null;
    const result = new STLExporter().parse(this.model, { binary: true });
    if (!(result instanceof DataView)) return null;
    const buf = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
    return stlToPrintSpace(buf, longestMm);
  }

  /** USDZ per la realtà aumentata su iPhone/iPad, in scala reale e appoggiato a terra. */
  async exportUSDZ(longestMm = 300): Promise<ArrayBuffer | null> {
    if (!this.model) return null;
    this.model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3());
    const k = longestMm / 1000 / (Math.max(size.x, size.y, size.z) || 1);
    const holder = new THREE.Group();
    holder.add(this.model.clone(true));
    holder.scale.setScalar(k);
    const center = box.getCenter(new THREE.Vector3());
    holder.position.set(-center.x * k, -box.min.y * k, -center.z * k);
    const root = new THREE.Group();
    root.add(holder);
    root.updateMatrixWorld(true);
    try {
      const data = await new USDZExporter().parseAsync(root);
      return (data as Uint8Array).slice().buffer as ArrayBuffer;
    } catch {
      return null;
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.transform.detach();
    this.transform.dispose();
    this.clearModel();
    this.controls.dispose();
    this.envMap?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
