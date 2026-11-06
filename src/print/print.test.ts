import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { unzipSync, strFromU8 } from "three/examples/jsm/libs/fflate.module.js";
import { preparePrint } from "./pipeline";
import { paintCode } from "./threemf";
import { wallThickness } from "./wall";
import { weld } from "./meshOps";
import { analyzePrintability } from "../three/printCheck";

/** geometria three → zuppa di triangoli (+ colore per triangolo) */
function soupOf(geom: THREE.BufferGeometry, color?: (c: THREE.Vector3) => [number, number, number]) {
  const g = geom.index ? geom.toNonIndexed() : geom;
  const pos = g.getAttribute("position");
  const soup = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) soup.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
  let triColor: Float32Array | undefined;
  if (color) {
    triColor = new Float32Array((pos.count / 3) * 3);
    for (let t = 0; t < pos.count / 3; t++) {
      const c = new THREE.Vector3(
        (soup[t * 9] + soup[t * 9 + 3] + soup[t * 9 + 6]) / 3,
        (soup[t * 9 + 1] + soup[t * 9 + 4] + soup[t * 9 + 7]) / 3,
        (soup[t * 9 + 2] + soup[t * 9 + 5] + soup[t * 9 + 8]) / 3,
      );
      triColor.set(color(c), t * 3);
    }
  }
  return { soup, triColor };
}

/** toglie alcuni triangoli (buco) e ne gira altri (facce rovesciate) */
function damage(soup: Float32Array, triColor?: Float32Array) {
  const T = soup.length / 9;
  const keep: number[] = [];
  for (let t = 0; t < T; t++) if (t % 97 !== 5) keep.push(t);
  const s = new Float32Array(keep.length * 9);
  const c = triColor ? new Float32Array(keep.length * 3) : undefined;
  keep.forEach((t, j) => {
    const tri = soup.slice(t * 9, t * 9 + 9);
    if (t % 13 === 0) {
      // inverte l'orientamento
      const tmp = tri.slice(3, 6);
      tri.set(tri.slice(6, 9), 3);
      tri.set(tmp, 6);
    }
    s.set(tri, j * 9);
    if (c && triColor) c.set(triColor.slice(t * 3, t * 3 + 3), j * 3);
  });
  return { soup: s, triColor: c };
}

function pieceToMesh(p: { mesh: { vert: Float32Array; tri: Uint32Array } }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p.mesh.vert, 3));
  g.setIndex(new THREE.BufferAttribute(p.mesh.tri, 1));
  return new THREE.Mesh(g);
}

const PLATE = { x: 256, y: 256, z: 256 };

/** volume (mm³) di una mesh chiusa indicizzata, col teorema della divergenza */
function volumeOf(m: { vert: Float32Array; tri: Uint32Array }) {
  let v = 0;
  for (let t = 0; t < m.tri.length; t += 3) {
    const a = m.tri[t] * 3, b = m.tri[t + 1] * 3, c = m.tri[t + 2] * 3;
    const [ax, ay, az] = [m.vert[a], m.vert[a + 1], m.vert[a + 2]];
    const [bx, by, bz] = [m.vert[b], m.vert[b + 1], m.vert[b + 2]];
    const [cx, cy, cz] = [m.vert[c], m.vert[c + 1], m.vert[c + 2]];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

describe("paintCode (formato pittura Bambu/Orca/Prusa)", () => {
  it("codifica i filamenti come il TriangleSelector", () => {
    expect([1, 2, 3, 4, 5, 16].map(paintCode)).toEqual(["4", "8", "0C", "1C", "2C", "DC"]);
  });
});

describe("preparePrint", () => {
  it("ripara, colora in 2 filamenti, aggiunge la base e scrive un 3MF valido", async () => {
    const sphere = soupOf(new THREE.SphereGeometry(1, 48, 32), (c) => (c.y > 0 ? [0.9, 0.2, 0.1] : [0.1, 0.2, 0.9]));
    const broken = damage(sphere.soup, sphere.triColor);
    const out = await preparePrint(broken, {
      longestMm: 60,
      colors: 2,
      base: { shape: "tonda", heightMm: 4 },
      plate: PLATE,
      name: "Sfera di prova",
    });
    expect(out.report.holesFilled).toBeGreaterThan(0);
    expect(out.report.facesFlipped).toBeGreaterThan(0);
    expect(out.report.pieces).toBe(1);
    expect(out.palette).toHaveLength(3); // 2 colori + base
    // il colore principale è rosso o blu, non una media grigia
    expect(out.palette[0]).toMatch(/^#(e|d|f)|^#1/);

    // il pezzo è un solido chiuso
    const piece = pieceToMesh(out.placed[0]);
    expect(analyzePrintability(piece).watertight).toBe(true);

    // il 3MF contiene il modello con la pittura multi-filamento
    const files = unzipSync(out.file3mf);
    expect(Object.keys(files).sort()).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
    const xml = strFromU8(files["3D/3dmodel.model"]);
    expect(xml).toContain('unit="millimeter"');
    const codes = new Set([...xml.matchAll(/paint_color="([0-9A-F]+)"/g)].map((m) => m[1]));
    expect([...codes].sort()).toEqual(["0C", "4", "8"]); // filamenti 1, 2 e base (3)
    const tris = (xml.match(/<triangle /g) ?? []).length;
    expect(tris).toBe(out.placed[0].mesh.tri.length / 3);
    // indici dei vertici validi
    const nv = (xml.match(/<vertex /g) ?? []).length;
    const maxIdx = Math.max(...[...xml.matchAll(/v[123]="(\d+)"/g)].map((m) => Number(m[1])));
    expect(maxIdx).toBeLessThan(nv);
  });

  it("taglia un modello più grande del piatto in pezzi chiusi che ci stanno", async () => {
    const box = soupOf(new THREE.BoxGeometry(1, 3, 1, 4, 12, 4));
    const out = await preparePrint(box, { longestMm: 600, colors: 1, base: null, plate: PLATE, name: "Colonna" });
    expect(out.report.pieces).toBeGreaterThanOrEqual(3);
    for (const p of out.placed) {
      const r = analyzePrintability(pieceToMesh(p));
      expect(r.watertight).toBe(true);
      expect(Math.max(r.size.x, r.size.y, r.size.z)).toBeLessThanOrEqual(256 * 0.95 + 0.01);
    }
    // volume conservato: 200 × 600 × 200 mm
    expect(out.report.volumeCm3).toBeCloseTo(24000, -2);
  });
});

describe("wallThickness", () => {
  it("riconosce le pareti troppo sottili", () => {
    const toMm = (g: THREE.BufferGeometry) => weld(soupOf(g).soup);
    const thick = wallThickness(toMm(new THREE.BoxGeometry(10, 10, 10)));
    expect(thick.minMm).toBeGreaterThan(9.9);
    expect(thick.thinShare).toBe(0);
    const thin = wallThickness(toMm(new THREE.BoxGeometry(40, 40, 0.4, 8, 8, 1)));
    expect(thin.minMm).toBeLessThan(0.5);
    expect(thin.thinShare).toBeGreaterThan(0.9);
  });
});

describe("gusci che si compenetrano", () => {
  it("due sfere sovrapposte diventano un solo solido senza volume doppio", async () => {
    const a = new THREE.SphereGeometry(1, 32, 24);
    const b = new THREE.SphereGeometry(1, 32, 24).translate(1, 0, 0);
    const sa = soupOf(a).soup, sb = soupOf(b).soup;
    const soup = new Float32Array(sa.length + sb.length);
    soup.set(sa);
    soup.set(sb, sa.length);
    const out = await preparePrint({ soup }, { longestMm: 30, colors: 1, base: null, plate: PLATE, name: "Due sfere" });
    // estensione totale 3 unità = 30 mm → 10 mm per unità, raggio 10 mm.
    // Due sfere separate: 2 × 4,19 = 8,38 cm³. Unione (centri a 1 raggio):
    // 8,38 − lente (π/12)(4r+d)(2r−d)² = 8,38 − 1,31 = 7,07 cm³
    const twoSpheres = 2 * (4 / 3) * Math.PI;
    const union = twoSpheres - (Math.PI / 12) * 5;
    expect(out.report.volumeCm3).toBeGreaterThan(union * 0.97);
    expect(out.report.volumeCm3).toBeLessThan(union * 1.01);
    expect(out.report.volumeCm3).toBeLessThan(twoSpheres * 0.9);
    expect(analyzePrintability(pieceToMesh(out.placed[0])).watertight).toBe(true);
  });
});

describe("incastri sui tagli", () => {
  it("scava fori allineati nei due pezzi e aggiunge perni che ci entrano", async () => {
    const box = soupOf(new THREE.BoxGeometry(1, 3, 1, 4, 12, 4));
    const plate = { x: 256, y: 256, z: 256 };
    const out = await preparePrint(box, { longestMm: 400, colors: 1, base: null, plate, name: "Colonna" });
    expect(out.report.pieces).toBe(2);
    expect(out.report.pins).toBeGreaterThanOrEqual(1);
    const pieces = out.placed.filter((p) => !p.pin);
    const pins = out.placed.filter((p) => p.pin);
    // pezzi e perni sono solidi chiusi
    for (const p of out.placed) expect(analyzePrintability(pieceToMesh(p)).watertight).toBe(true);
    // i fori tolgono volume ai pezzi: (pieno − fori) < pieno
    const full = (out.report.volumeCm3 * 1000) / 2;
    for (const p of pieces) {
      const v = volumeOf(p.mesh);
      expect(v).toBeLessThan(full);
      expect(v).toBeGreaterThan(full * 0.95);
    }
    // perno più stretto del foro (gioco) e più corto della somma delle profondità
    for (const p of pins) {
      const s = analyzePrintability(pieceToMesh(p)).size;
      expect(Math.max(s.x, s.y)).toBeGreaterThanOrEqual(3 - 0.01);
      expect(Math.max(s.x, s.y)).toBeLessThanOrEqual(8 + 0.01);
    }
  });

  it("senza incastri non ci sono perni", async () => {
    const box = soupOf(new THREE.BoxGeometry(1, 3, 1, 4, 12, 4));
    const out = await preparePrint(box, { longestMm: 400, colors: 1, base: null, plate: PLATE, name: "Colonna", connectors: false });
    expect(out.report.pins).toBe(0);
  });
});

describe("più piatti", () => {
  it("distribuisce i pezzi su più piatti e prepara un file per piatto", async () => {
    const box = soupOf(new THREE.BoxGeometry(1, 4, 1, 4, 12, 4));
    const small = { x: 180, y: 180, z: 180 };
    const out = await preparePrint(box, { longestMm: 600, colors: 1, base: null, plate: small, name: "Torre" });
    expect(out.report.plates).toBeGreaterThan(1);
    expect(out.report.fitsPlate).toBe(true);
    // su ogni piatto i pezzi stanno dentro i bordi
    for (const p of out.placed) {
      const b = pieceToMesh(p).geometry;
      b.computeBoundingBox();
      const bb = b.boundingBox!;
      expect(bb.min.x + p.offset[0]).toBeGreaterThanOrEqual(-0.01);
      expect(bb.max.x + p.offset[0]).toBeLessThanOrEqual(small.x + 0.01);
      expect(bb.min.y + p.offset[1]).toBeGreaterThanOrEqual(-0.01);
      expect(bb.max.y + p.offset[1]).toBeLessThanOrEqual(small.y + 0.01);
    }
    expect(out.platesZip).not.toBeNull();
    const files = Object.keys(unzipSync(out.platesZip!));
    expect(files).toHaveLength(out.report.plates);
    expect(files[0]).toMatch(/piatto 1\.3mf$/);
  });
});

describe("calamita", () => {
  it("retro piatto appoggiato sul piatto con la sede del magnete", async () => {
    const sphere = soupOf(new THREE.SphereGeometry(1, 48, 32));
    const out = await preparePrint(sphere, {
      longestMm: 60,
      colors: 1,
      base: null,
      magnet: { diameterMm: 10, depthMm: 3 },
      plate: PLATE,
      name: "Calamita",
    });
    expect(out.report.warnings.join(" ")).not.toMatch(/magnete/);
    const mesh = pieceToMesh(out.placed[0]);
    const r = analyzePrintability(mesh);
    expect(r.watertight).toBe(true);
    // spessore ridotto (metà davanti, al massimo 25% del lato) e base piatta a z = 0
    expect(r.size.z).toBeLessThanOrEqual(60 * 0.25 + 0.5);
    // volume: calotta meno la sede del magnete (≈ 0,26 cm³)
    const pos = mesh.geometry.getAttribute("position");
    let onBed = 0;
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getZ(i) + out.placed[0].offset[2]) < 1e-3) onBed++;
    expect(onBed).toBeGreaterThan(20);
    // la sede: vertici a z = profondità del magnete (+0,2 di gioco)
    let pocketTop = 0;
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getZ(i) + out.placed[0].offset[2] - 3.2) < 1e-3) pocketTop++;
    expect(pocketTop).toBeGreaterThan(8);
  });
});

describe("modelli non riparabili (stile AI)", () => {
  it("due cubi compenetrati con una pinna (3 facce su uno spigolo) diventano un solido stampabile", async () => {
    const a = soupOf(new THREE.BoxGeometry(1, 1, 1));
    const b = soupOf(new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0));
    // pinna: un triangolo isolato attaccato a uno spigolo (3 facce sullo stesso spigolo)
    const fin = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, -0.5, -1.0, -1.2, 0]);
    const soup = new Float32Array(a.soup.length + b.soup.length + fin.length);
    soup.set(a.soup);
    soup.set(b.soup, a.soup.length);
    soup.set(fin, a.soup.length + b.soup.length);
    const T = soup.length / 9;
    const triColor = new Float32Array(T * 3);
    for (let t = 0; t < T; t++) triColor.set(t < a.soup.length / 9 ? [0.9, 0.1, 0.1] : [0.1, 0.1, 0.9], t * 3);
    const out = await preparePrint({ soup, triColor }, { longestMm: 60, colors: 2, base: null, plate: PLATE, name: "Rotto" });
    expect(out.report.rebuilt).toBe(true);
    expect(out.report.warnings.join(" ")).toMatch(/ricostruito/);
    const r = analyzePrintability(pieceToMesh(out.placed[0]));
    expect(r.watertight).toBe(true);
    // estensione 1,5 unità (+ pinna) = 60 mm; unione dei due cubi = 2 − 0,25 = 1,75 unità³.
    // La pinna allarga l'ingombro: si misura la scala reale dal report delle dimensioni
    const unit = 60 / Math.max(1.5 + 0.5, 1.5 + 0.7); // pinna fino a -1,0 / -1,2
    const expected = (1.75 * unit ** 3) / 1000;
    expect(out.report.volumeCm3).toBeGreaterThan(expected * 0.95);
    expect(out.report.volumeCm3).toBeLessThan(expected * 1.05);
    // i due colori sopravvivono
    expect(out.palette.length).toBe(2);
    expect(new Set(out.placed[0].mesh.label).size).toBe(2);
  }, 60_000);
});

describe("filamenti", () => {
  it("fonde colori quasi uguali e con 4 colori la base riusa il più scuro", async () => {
    // quattro fasce: due neri quasi identici, rosso, blu, giallo
    const sphere = soupOf(new THREE.SphereGeometry(1, 48, 32), (c) =>
      c.y > 0.5 ? [0.05, 0.05, 0.04] : c.y > 0 ? [0.17, 0.17, 0.18] : c.y > -0.5 ? [0.85, 0.1, 0.1] : c.x > 0 ? [0.1, 0.2, 0.85] : [0.95, 0.85, 0.1],
    );
    const out = await preparePrint(sphere, { longestMm: 60, colors: 5, base: { shape: "tonda", heightMm: 4 }, plate: PLATE, name: "Fasce" });
    // i due neri diventano uno: nero, rosso, blu, giallo = 4, e la base non aggiunge il quinto
    expect(out.palette).toHaveLength(4);
    expect(out.report.warnings.join(" ")).not.toMatch(/più AMS/);
  });
});

describe("stampabilità vera", () => {
  it("toglie le briciole staccate e rinforza una pinna troppo sottile", async () => {
    const { getManifold } = await import("./manifold");
    const { removeFragments, reinforceThin, minWallMm } = await import("./strength");
    const w = await getManifold();
    // corpo 20 mm + pinna da 0,3 mm + briciola da 0,2 mm³ staccata
    const body = w.Manifold.cube([20, 20, 20], true);
    const fin = w.Manifold.cube([10, 0.3, 10], true).translate([10 + 4.9, 0, 0]);
    const crumb = w.Manifold.cube([0.5, 0.5, 0.8], true).translate([40, 0, 0]);
    const solid = w.Manifold.union([body, fin, crumb]);
    const tracked = { solid, modelRun: solid.getMesh().runOriginalID[0], baseRun: null };

    const f = removeFragments(w, tracked);
    expect(f.report.removed).toBe(1);
    expect(f.report.detached).toBe(0);
    expect(f.tracked.solid.decompose()).toHaveLength(1);

    expect(minWallMm(0.4)).toBe(0.8);
    const before = f.tracked.solid.volume();
    const r = reinforceThin(w, f.tracked, 0.8);
    expect(r.report.applied).toBe(true);
    expect(r.tracked.solid.status()).toBe("NoError");
    expect(r.report.maxPushMm).toBeLessThanOrEqual(0.4 + 1e-6);
    // la pinna si ispessisce, il cubo grande no: il volume cresce poco
    const after = r.tracked.solid.volume();
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeLessThan(150);
    expect(r.report.share).toBeLessThan(0.5);
  });

  it("il rinforzo mantiene i colori nel percorso completo", async () => {
    // disco sottile (0,5 mm su 60 mm) a due colori: va rinforzato
    const disc = soupOf(new THREE.CylinderGeometry(1, 1, 0.5 / 60, 64, 1), (c) => (c.x > 0 ? [0.9, 0.2, 0.1] : [0.1, 0.2, 0.9]));
    const out = await preparePrint(disc, { longestMm: 60, colors: 2, base: null, plate: PLATE, name: "Disco" });
    expect(out.report.reinforced.applied).toBe(true);
    expect(out.report.nozzleMm).toBe(0.4);
    const labels = new Set(out.placed[0].mesh.label);
    expect(labels.size).toBe(2);
    expect(analyzePrintability(pieceToMesh(out.placed[0])).watertight).toBe(true);
  });

  it("nessun rinforzo se le pareti sono già spesse", async () => {
    const { getManifold } = await import("./manifold");
    const { reinforceThin } = await import("./strength");
    const w = await getManifold();
    const solid = w.Manifold.cube([10, 10, 10], true);
    const r = reinforceThin(w, { solid, modelRun: 0, baseRun: null }, 0.8);
    expect(r.report.applied).toBe(false);
  });
});
