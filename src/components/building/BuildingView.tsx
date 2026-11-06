// Vista 3D di Building: pezzi del modello (colori diversi), volume della
// macchina e anteprima degli strati con gli sbalzi in rosso. Dati in mm, Z in
// alto; la scena è in metri con Y in alto.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface ViewPiece {
  geometry: THREE.BufferGeometry;
  color: string;
}

export interface ViewLayer {
  /** segmenti (coppie di punti xyz in mm) dei percorsi dello strato */
  paths: Float32Array;
  /** contorni delle zone a sbalzo, segmenti xyz in mm */
  overhang: Float32Array | null;
}

interface Props {
  pieces: ViewPiece[];
  layers: ViewLayer[];
  /** strati mostrati: da 0 a upTo (incluso); -1 = vista del modello */
  upTo: number;
  volume: { x: number; y: number; z: number } | null;
}

export function BuildingView({ pieces, layers, upTo, volume }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const ctx = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    root: THREE.Group;
    model: THREE.Group;
    layerGroup: THREE.Group;
    box: THREE.LineSegments | null;
  } | null>(null);

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setClearColor(0x1b1b1d);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 2000);
    camera.position.set(6, 5, 8);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(5, 10, 7);
    scene.add(sun);
    const grid = new THREE.GridHelper(40, 40, 0x3a3a40, 0x2a2a2e);
    scene.add(grid);
    // contenuto in mm con Z in alto → metri con Y in alto
    const root = new THREE.Group();
    root.scale.setScalar(0.001);
    root.rotation.x = -Math.PI / 2;
    const model = new THREE.Group();
    const layerGroup = new THREE.Group();
    root.add(model, layerGroup);
    scene.add(root);
    ctx.current = { renderer, scene, camera, controls, root, model, layerGroup, box: null };

    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      ctx.current = null;
    };
  }, []);

  // pezzi del modello + inquadratura
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.model.clear();
    const box = new THREE.Box3();
    for (const p of pieces) {
      const mesh = new THREE.Mesh(
        p.geometry,
        new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.85, transparent: true, opacity: 1 }),
      );
      c.model.add(mesh);
      p.geometry.computeBoundingBox();
      box.union(p.geometry.boundingBox!);
    }
    if (!box.isEmpty()) {
      // centra sul piano: X/Y al centro, Z = 0 a terra
      const center = box.getCenter(new THREE.Vector3());
      c.model.position.set(-center.x, -center.y, -box.min.z);
      c.layerGroup.position.copy(c.model.position);
      const size = box.getSize(new THREE.Vector3()).multiplyScalar(0.001);
      const r = Math.max(size.x, size.y, size.z);
      c.camera.position.set(r * 1.3, r * 1.0, r * 1.6);
      c.controls.target.set(0, size.z * 0.4, 0);
      c.camera.near = r / 200;
      c.camera.far = r * 200;
      c.camera.updateProjectionMatrix();
    }
  }, [pieces]);

  // volume della macchina (filo)
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    if (c.box) {
      c.root.remove(c.box);
      c.box.geometry.dispose();
      c.box = null;
    }
    if (!volume) return;
    const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(volume.x, volume.y, volume.z));
    const box = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xff670d, transparent: true, opacity: 0.35 }));
    box.position.set(0, 0, volume.z / 2);
    c.root.add(box);
    c.box = box;
  }, [volume]);

  // strati fino a upTo
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.layerGroup.children.forEach((o) => (o as THREE.LineSegments).geometry?.dispose());
    c.layerGroup.clear();
    const showLayers = upTo >= 0 && layers.length > 0;
    c.model.children.forEach((m) => {
      const mat = (m as THREE.Mesh).material as THREE.MeshStandardMaterial;
      mat.opacity = showLayers ? 0.08 : 1;
      mat.depthWrite = !showLayers;
    });
    if (!showLayers) return;
    const last = Math.min(upTo, layers.length - 1);
    const pathMat = new THREE.LineBasicMaterial({ color: 0xd9d9d9 });
    const topMat = new THREE.LineBasicMaterial({ color: 0xff670d });
    const overMat = new THREE.LineBasicMaterial({ color: 0xff3b30 });
    for (let i = 0; i <= last; i++) {
      const L = layers[i];
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(L.paths, 3));
      c.layerGroup.add(new THREE.LineSegments(g, i === last ? topMat : pathMat));
      if (L.overhang && L.overhang.length) {
        const og = new THREE.BufferGeometry();
        og.setAttribute("position", new THREE.BufferAttribute(L.overhang, 3));
        c.layerGroup.add(new THREE.LineSegments(og, overMat));
      }
    }
  }, [layers, upTo]);

  return <div ref={host} className="size-full min-h-[320px]" aria-label="Vista 3D di Building" role="img" />;
}
