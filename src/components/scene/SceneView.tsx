// Visualizzatore delle scene Marble: Gaussian splat (SPZ) con Spark dentro
// Three.js, più un modello della galleria da posizionare nella scena.
// Convenzioni World Labs (docs.worldlabs.ai/api/rendering-spz): gli SPZ sono
// in "marble_raw_opencv" (Y in basso); si scala in metri con
// metric_scale_factor, si porta il pavimento a y = 0 con ground_plane_offset
// e si ruota di 180° sull'asse X per il sistema di Three.js (Y in alto).
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

export interface SceneWorld {
  id: number;
  spzUrl: string;
  colliderUrl: string | null;
  panoUrl: string | null;
  metricScale: number;
  groundOffset: number;
}

export interface SceneObject {
  url: string;
  /** altezza reale in metri */
  heightM: number;
  /** rotazione attorno all'asse verticale, in gradi */
  rotationDeg: number;
}

export interface SceneViewHandle {
  /** foto della vista corrente (PNG) */
  snapshot(): Promise<Blob | null>;
  /** riporta la camera al punto di partenza della scena */
  resetCamera(): void;
}

interface Props {
  world: SceneWorld | null;
  object: SceneObject | null;
  showCollider: boolean;
  onStatus?: (s: { loading: boolean; progress: number; error: string | null }) => void;
}

interface Ctx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** contenitore della scena nel sistema Three.js (rotazione 180° su X) */
  worldRoot: THREE.Group;
  /** dentro worldRoot: scala metrica e pavimento */
  worldInner: THREE.Group;
  splat: SplatMesh | null;
  collider: THREE.Object3D | null;
  objectHolder: THREE.Group;
  objectModel: THREE.Object3D | null;
  ground: THREE.Mesh;
  pmrem: THREE.PMREMGenerator;
  envTex: THREE.Texture | null;
  eyeHeight: number;
  keys: Set<string>;
}

const PLACE_HINT_PX = 5;

export const SceneView = forwardRef<SceneViewHandle, Props>(function SceneView({ world, object, showCollider, onStatus }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const ctx = useRef<Ctx | null>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const [hasObject, setHasObject] = useState(false);
  // valori correnti letti dai callback asincroni (caricamenti)
  const showColliderRef = useRef(showCollider);
  showColliderRef.current = showCollider;
  const objectRef = useRef(object);
  objectRef.current = object;

  // ── setup ────────────────────────────────────────────────
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setClearColor(0x1b1b1d);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.02, 1000);
    camera.position.set(0, 1.6, 0.01);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 1.5, -1.5);

    const spark = new SparkRenderer({ renderer });
    scene.add(spark);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x50505a, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(4, 8, 5);
    scene.add(sun);

    const worldRoot = new THREE.Group();
    worldRoot.quaternion.set(1, 0, 0, 0); // 180° su X: da OpenCV (Y giù) a Three.js (Y su)
    const worldInner = new THREE.Group();
    worldRoot.add(worldInner);
    scene.add(worldRoot);

    // pavimento invisibile per posizionare l'oggetto quando manca la mesh di collisione
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ visible: false }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const objectHolder = new THREE.Group();
    scene.add(objectHolder);

    const c: Ctx = {
      renderer, scene, camera, controls, worldRoot, worldInner, splat: null, collider: null,
      objectHolder, objectModel: null, ground, pmrem: new THREE.PMREMGenerator(renderer), envTex: null,
      eyeHeight: 1.6, keys: new Set(),
    };
    ctx.current = c;

    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    // clic (non trascinamento) sulla scena = posiziona l'oggetto lì
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > PLACE_HINT_PX || !c.objectModel) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const targets = c.collider ? [c.collider, ground] : [ground];
      const hit = ray.intersectObjects(targets, true)[0];
      if (hit) objectHolder.position.copy(hit.point);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    // camminata con WASD / frecce (sposta camera e punto di mira insieme)
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const k = e.key.toLowerCase();
      if (!["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "q", "e", "shift"].includes(k)) return;
      if (e.type === "keydown") c.keys.add(k);
      else c.keys.delete(k);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    const clearKeys = () => c.keys.clear();
    window.addEventListener("blur", clearKeys);

    let raf = 0;
    let last = performance.now();
    const fwd = new THREE.Vector3();
    const side = new THREE.Vector3();
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (c.keys.size) {
        const speed = 1.6 * dt * (c.keys.has("shift") ? 3 : 1);
        camera.getWorldDirection(fwd);
        fwd.y = 0;
        if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
        fwd.normalize();
        side.crossVectors(fwd, camera.up).normalize();
        const move = new THREE.Vector3();
        if (c.keys.has("w") || c.keys.has("arrowup")) move.add(fwd);
        if (c.keys.has("s") || c.keys.has("arrowdown")) move.sub(fwd);
        if (c.keys.has("d") || c.keys.has("arrowright")) move.add(side);
        if (c.keys.has("a") || c.keys.has("arrowleft")) move.sub(side);
        if (c.keys.has("e")) move.y += 1;
        if (c.keys.has("q")) move.y -= 1;
        if (move.lengthSq() > 0) {
          move.normalize().multiplyScalar(speed);
          camera.position.add(move);
          controls.target.add(move);
        }
      }
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", clearKeys);
      c.splat?.dispose();
      c.envTex?.dispose();
      c.pmrem.dispose();
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      ctx.current = null;
    };
  }, []);

  function placeCamera(c: Ctx) {
    // in Marble la camera di partenza è all'origine del file: dopo la
    // conversione si trova a groundOffset metri sopra il pavimento
    const h = c.eyeHeight;
    c.camera.position.set(0, h, 0.01);
    c.controls.target.set(0, h * 0.9, -1.5);
    c.controls.update();
  }

  useImperativeHandle(ref, () => ({
    snapshot: () =>
      new Promise((resolve) => {
        const c = ctx.current;
        if (!c) return resolve(null);
        // render e lettura nello stesso frame: non serve preserveDrawingBuffer
        c.renderer.render(c.scene, c.camera);
        c.renderer.domElement.toBlob((b) => resolve(b), "image/png");
      }),
    resetCamera: () => {
      if (ctx.current) placeCamera(ctx.current);
    },
  }));

  // ── scena (splat + collisione + luce dal panorama) ───────
  const worldKey = world ? `${world.id}:${world.spzUrl.split("?")[0]}` : "";
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    let cancelled = false;
    c.splat?.dispose();
    if (c.splat) c.worldInner.remove(c.splat);
    c.splat = null;
    if (c.collider) c.worldInner.remove(c.collider);
    c.collider = null;
    c.scene.environment = null;
    c.envTex?.dispose();
    c.envTex = null;
    if (!world) {
      statusRef.current?.({ loading: false, progress: 0, error: null });
      return;
    }

    c.worldInner.scale.setScalar(world.metricScale || 1);
    c.worldInner.position.set(0, -(world.groundOffset || 0), 0);
    c.eyeHeight = world.groundOffset > 0.3 && world.groundOffset < 5 ? world.groundOffset : 1.6;
    placeCamera(c);
    c.objectHolder.position.set(0, 0, -2);

    statusRef.current?.({ loading: true, progress: 0, error: null });
    const splat = new SplatMesh({
      url: world.spzUrl,
      fileName: "scena.spz",
      onProgress: (ev) => {
        if (!cancelled && ev.lengthComputable && ev.total > 0) {
          statusRef.current?.({ loading: true, progress: Math.round((ev.loaded / ev.total) * 100), error: null });
        }
      },
    });
    c.splat = splat;
    c.worldInner.add(splat);
    splat.initialized
      .then(() => {
        if (!cancelled) statusRef.current?.({ loading: false, progress: 100, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) statusRef.current?.({ loading: false, progress: 0, error: err instanceof Error ? err.message : "Scena non caricata" });
      });

    if (world.colliderUrl) {
      new GLTFLoader().load(
        world.colliderUrl,
        (gltf) => {
          if (cancelled || !ctx.current) return;
          const mat = new THREE.MeshBasicMaterial({ color: 0xff670d, wireframe: true, transparent: true, opacity: 0.35 });
          gltf.scene.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = mat;
          });
          gltf.scene.visible = true;
          c.collider = gltf.scene;
          c.worldInner.add(gltf.scene);
          setColliderVisible(c, showColliderRef.current);
        },
        undefined,
        () => undefined, // senza collisione si posiziona sul pavimento
      );
    }

    if (world.panoUrl) {
      new THREE.TextureLoader().load(
        world.panoUrl,
        (tex) => {
          if (cancelled || !ctx.current) return tex.dispose();
          tex.mapping = THREE.EquirectangularReflectionMapping;
          tex.colorSpace = THREE.SRGBColorSpace;
          const env = c.pmrem.fromEquirectangular(tex).texture;
          tex.dispose();
          c.envTex = env;
          c.scene.environment = env; // riflessi e luce dell'oggetto presi dalla scena
        },
        undefined,
        () => undefined,
      );
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldKey]);

  // ── mesh di collisione visibile o no ─────────────────────
  useEffect(() => {
    if (ctx.current) setColliderVisible(ctx.current, showCollider);
  }, [showCollider]);

  // ── oggetto dalla galleria ───────────────────────────────
  const objectUrl = object?.url.split("?")[0] ?? "";
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    let cancelled = false;
    if (c.objectModel) {
      c.objectHolder.remove(c.objectModel);
      c.objectModel = null;
    }
    setHasObject(false);
    if (!object) return;
    new GLTFLoader().load(
      object.url,
      (gltf) => {
        if (cancelled || !ctx.current) return;
        const model = gltf.scene;
        // base al centro e appoggiata a y = 0, poi in scala con l'altezza scelta
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.position.set(-center.x, -box.min.y, -center.z);
        const pivot = new THREE.Group();
        pivot.add(model);
        pivot.userData.rawHeight = Math.max(1e-6, box.max.y - box.min.y);
        c.objectModel = pivot;
        c.objectHolder.add(pivot);
        applyObject(c, objectRef.current);
        setHasObject(true);
      },
      undefined,
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectUrl]);

  useEffect(() => {
    if (ctx.current) applyObject(ctx.current, object);
  }, [object?.heightM, object?.rotationDeg, hasObject]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={host} className="size-full min-h-[320px] touch-none" aria-label="Vista della scena 3D" role="img" />;
});

function setColliderVisible(c: Ctx, visible: boolean) {
  // resta raycastabile anche quando non si vede
  c.collider?.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
    if (m && "opacity" in m) {
      m.opacity = visible ? 0.35 : 0;
      m.colorWrite = visible;
      m.depthWrite = false;
    }
  });
}

function applyObject(c: Ctx, object: SceneObject | null) {
  const pivot = c.objectModel;
  if (!pivot || !object) return;
  const raw = pivot.userData.rawHeight as number;
  pivot.scale.setScalar(object.heightM / raw);
  pivot.rotation.y = THREE.MathUtils.degToRad(object.rotationDeg);
}
