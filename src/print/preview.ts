// Anteprima della stampa: i pezzi con i colori dei filamenti, sul piatto.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { plateOrigin, type Placed, type Plate } from "./solid";

export function renderPrintPreview(placed: Placed[], palette: string[], plate: Plate, size = 560): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = Math.round(size * 0.72);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.toneMapping = THREE.NeutralToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#f2f2f0");
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.7;
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(plate.x * 0.2, -plate.y * 0.6, plate.z * 1.4);
  scene.add(sun);

  // piatti (Z in alto, come nello slicer), in griglia come in Bambu Studio
  const plates = Math.max(1, ...placed.map((p) => p.plate + 1));
  const bedGeom = new THREE.PlaneGeometry(plate.x, plate.y);
  const bedMat = new THREE.MeshStandardMaterial({ color: "#3a3a40", roughness: 0.9 });
  const pinMat = new THREE.MeshStandardMaterial({ color: "#ff670d", roughness: 0.5 });
  const box = new THREE.Box3();
  for (let k = 0; k < plates; k++) {
    const [ox, oy] = plateOrigin(k, plates, plate);
    const bed = new THREE.Mesh(bedGeom, bedMat);
    bed.position.set(ox + plate.x / 2, oy + plate.y / 2, -0.05);
    scene.add(bed);
    if (plates > 1) box.expandByObject(bed);
    const grid = new THREE.GridHelper(Math.max(plate.x, plate.y), Math.round(Math.max(plate.x, plate.y) / 20), 0x55555c, 0x4a4a50);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(ox + plate.x / 2, oy + plate.y / 2, 0.02);
    scene.add(grid);
  }

  const cols = palette.map((h) => new THREE.Color(h));
  const disposables: THREE.BufferGeometry[] = [];
  for (const p of placed) {
    const { vert, tri, label } = p.mesh;
    const [ox, oy] = plateOrigin(p.plate, plates, plate);
    // vertici duplicati per triangolo: colore netto per faccia
    const pos = new Float32Array(tri.length * 3);
    const col = new Float32Array(tri.length * 3);
    for (let t = 0; t < tri.length / 3; t++) {
      const c = cols[label ? label[t] : 0] ?? cols[0];
      for (let k = 0; k < 3; k++) {
        const vi = tri[t * 3 + k];
        pos.set([vert[vi * 3] + p.offset[0] + ox, vert[vi * 3 + 1] + p.offset[1] + oy, vert[vi * 3 + 2] + p.offset[2]], (t * 3 + k) * 3);
        col.set([c.r, c.g, c.b], (t * 3 + k) * 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    disposables.push(g);
    // i perni in arancio: si riconoscono subito nell'anteprima
    const mesh = new THREE.Mesh(g, p.pin ? pinMat : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }));
    scene.add(mesh);
    box.expandByObject(mesh);
  }
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2 * (plates > 1 ? 0.85 : 1), Math.max(plate.x, plate.y) * 0.35);
  const cam = new THREE.PerspectiveCamera(35, canvas.width / canvas.height, 1, radius * 20);
  cam.up.set(0, 0, 1);
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(17.5)) * 1.05;
  cam.position.set(center.x + dist * 0.45, center.y - dist * 0.75, center.z + dist * 0.5);
  cam.lookAt(center);
  renderer.render(scene, cam);
  const url = canvas.toDataURL("image/png");

  disposables.forEach((g) => g.dispose());
  bedGeom.dispose();
  env.dispose();
  pmrem.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  return url;
}
