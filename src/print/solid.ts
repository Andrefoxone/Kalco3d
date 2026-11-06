// Operazioni "a tenuta" con Manifold: solido valido, base, taglio per il piatto.
// Le etichette colore viaggiano come faceID e sopravvivono a unione e taglio.
import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";
import { bounds, UNSET_LABEL, type PrintMesh } from "./meshOps";

export interface Plate {
  x: number;
  y: number;
  z: number;
}

export interface BaseOptions {
  shape: "tonda" | "quadrata";
  heightMm: number;
}

interface Tracked {
  solid: Manifold;
  modelRun: number;
  baseRun: number | null;
  /** testo/logo sulla base */
  decorRun?: number | null;
}

/** Testo o logo da mettere sulla base, davanti al modello. */
export interface BaseDecor {
  section: CrossSection;
  mode: "rilievo" | "incisione";
  depthMm: number;
}

/** Mesh già orientata e chiusa → Manifold. Lancia un errore leggibile se non è un solido valido. */
export function toManifold(w: ManifoldToplevel, m: PrintMesh): Tracked {
  const faceID = new Uint32Array(m.tri.length / 3);
  if (m.label) faceID.set(m.label);
  const mesh = new w.Mesh({ numProp: 3, vertProperties: m.vert, triVerts: m.tri, faceID });
  mesh.merge();
  const solid = new w.Manifold(mesh);
  const status = solid.status();
  if (status !== "NoError") {
    throw new Error(
      status === "NotManifold"
        ? "Il modello ha superfici che si toccano o si intersecano: la riparazione automatica non basta"
        : `Geometria non valida (${status})`,
    );
  }
  const own = solid.getMesh();
  // gusci separati che si compenetrano (assiemi, modelli in più parti):
  // l'unione booleana li fonde in un unico solido, come vuole lo slicer
  const parts = solid.decompose();
  const merged = parts.length > 1 ? w.Manifold.union(parts) : solid;
  return { solid: merged, modelRun: own.runOriginalID[0], baseRun: null };
}

/**
 * Aggiunge una base (piedistallo) sotto il modello. Il modello affonda di poco
 * nella base, così l'unione è un pezzo unico e solido. L'impronta si calcola
 * sul 15% più basso del modello: una statuina con le braccia aperte non deve
 * finire su un piedistallo enorme.
 */
export function addBase(w: ManifoldToplevel, t: Tracked, opts: BaseOptions, labelForBase: number, decor?: BaseDecor | null): Tracked {
  const mesh = t.solid.getMesh();
  const v = mesh.vertProperties;
  const np = mesh.numProp;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < v.length; i += np) {
    minZ = Math.min(minZ, v[i + 2]);
    maxZ = Math.max(maxZ, v[i + 2]);
  }
  const height = maxZ - minZ;
  const zCut = minZ + height * 0.15;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < v.length; i += np) {
    if (v[i + 2] > zCut) continue;
    x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i]);
    y0 = Math.min(y0, v[i + 1]); y1 = Math.max(y1, v[i + 1]);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let r = 0;
  for (let i = 0; i < v.length; i += np) {
    if (v[i + 2] > zCut) continue;
    r = Math.max(r, Math.hypot(v[i] - cx, v[i + 1] - cy));
  }
  // stabilità: la base non è mai più stretta del 60% dell'ingombro del modello
  // (un fondo a punta darebbe un'impronta minuscola e la statuina cadrebbe)
  let fullR = 0;
  for (let i = 0; i < v.length; i += np) fullR = Math.max(fullR, Math.hypot(v[i] - cx, v[i + 1] - cy));
  r = Math.max(r, fullR * 0.6);
  x0 = Math.min(x0, cx - r); x1 = Math.max(x1, cx + r);
  y0 = Math.min(y0, cy - r); y1 = Math.max(y1, cy + r);
  let margin = Math.max(3, r * 0.12);
  const h = Math.max(1.5, opts.heightMm);
  // affondamento: abbastanza da creare un buon appoggio, mai oltre metà base
  const sink = Math.min(h * 0.5, Math.max(0.8, height * 0.015));
  const topZ = minZ + sink;

  // testo/logo: serve una fascia libera davanti al modello (lato −Y = davanti)
  let frontModel = Infinity;
  for (let i = 0; i < v.length; i += np) if (v[i + 2] <= zCut) frontModel = Math.min(frontModel, v[i + 1]);
  if (!Number.isFinite(frontModel)) frontModel = y0;
  const bandNeed = decor ? Math.min(16, Math.max(7, (x1 - x0) * 0.16)) + 2 : 0;
  let extraFront = 0;

  let base: Manifold;
  let band: { y0: number; y1: number; width: (yc: number) => number } | null = null;
  if (opts.shape === "tonda") {
    if (decor) {
      // la base si allarga quanto basta per la fascia davanti
      const free = frontModel - (cy - (r + margin));
      if (free < bandNeed) margin += bandNeed - free;
    }
    const R = r + margin;
    const chamfer = Math.min(h * 0.35, R * 0.08);
    // leggera smussatura in alto: più elegante e niente spigolo vivo
    base = w.Manifold.cylinder(h, R, R - chamfer, 128).translate([cx, cy, minZ - h + sink]);
    const Rt = R - chamfer - 1;
    band = { y0: cy - Rt + 1, y1: frontModel - 1, width: (yc) => 2 * Math.sqrt(Math.max(0, Rt * Rt - (yc - cy) ** 2)) };
  } else {
    if (decor) {
      const free = frontModel - (y0 - margin);
      if (free < bandNeed) extraFront = bandNeed - free;
    }
    const sx = x1 - x0 + margin * 2, sy = y1 - y0 + margin * 2 + extraFront;
    const by0 = y0 - margin - extraFront;
    base = w.Manifold.cube([sx, sy, h], false).translate([cx - sx / 2, by0, minZ - h + sink]);
    band = { y0: by0 + 1.5, y1: frontModel - 1, width: () => sx - 3 };
  }
  const baseRun = base.getMesh().runOriginalID[0];
  void labelForBase;

  let decorRun: number | null = null;
  if (decor && band && band.y1 - band.y0 > 2) {
    const yc = (band.y0 + band.y1) / 2;
    const bh = band.y1 - band.y0;
    const b = decor.section.bounds();
    const sw = b.max[0] - b.min[0] || 1, sh = b.max[1] - b.min[1] || 1;
    const k = Math.min((band.width(yc) * 0.86) / sw, (bh * 0.8) / sh);
    const cs = decor.section.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2]).scale(k).translate([cx, yc]);
    if (decor.mode === "rilievo") {
      const relief = cs.extrude(decor.depthMm + 0.3).translate([0, 0, topZ - 0.3]);
      decorRun = relief.getMesh().runOriginalID[0];
      base = base.add(relief);
    } else {
      const depth = Math.min(decor.depthMm, h * 0.6);
      const cutter = cs.extrude(depth + 1).translate([0, 0, topZ - depth]);
      decorRun = cutter.getMesh().runOriginalID[0];
      base = base.subtract(cutter);
    }
  }

  // fondo a punta: si taglia in piano dove il modello è abbastanza largo (max
  // 12% dell'altezza) e lo si abbassa sulla base. Un appoggio di pochi mm
  // sarebbe un collo fragile, e la statuina sembrerebbe sospesa.
  let model = t.solid;
  const order: number[] = [];
  for (let i = 0; i < v.length; i += np) order.push(i);
  order.sort((a, b) => v[a + 2] - v[b + 2]);
  let reach = 0;
  let zFlat = minZ;
  for (const i of order) {
    reach = Math.max(reach, Math.hypot(v[i] - cx, v[i + 1] - cy));
    if (reach >= fullR * 0.35) {
      zFlat = v[i + 2];
      break;
    }
  }
  zFlat = Math.min(zFlat, minZ + height * 0.12);
  if (zFlat - minZ > sink) {
    model = model.trimByPlane([0, 0, 1], zFlat).translate([0, 0, -(zFlat - minZ)]);
  }
  const solid = model.add(base);
  return { solid, modelRun: t.modelRun, baseRun, decorRun };
}

/** Gioco radiale tra perno e foro (mm): incastro preciso ma che entra a mano */
export const PIN_CLEARANCE = 0.2;

export interface SplitResult {
  pieces: Manifold[];
  /** perni di allineamento da stampare a parte (uno per coppia di fori) */
  pins: Manifold[];
  cuts: number;
  /** sezioni di taglio troppo sottili per un perno: solo colla */
  cutsWithoutPins: number;
}

// rotazioni (gradi) che portano l'asse di taglio su Z, e ritorno
const TO_Z: [number, number, number][] = [[0, -90, 0], [90, 0, 0], [0, 0, 0]];
const FROM_Z: [number, number, number][] = [[0, 90, 0], [-90, 0, 0], [0, 0, 0]];

/**
 * Taglia il solido in pezzi che entrano nel piatto (con 5% di margine).
 * I tagli di Manifold chiudono da soli le facce di taglio: ogni pezzo resta un
 * solido stampabile. Con `connectors`, su ogni taglio si scavano fori ciechi
 * allineati nelle due metà e si aggiungono i perni da inserire: i pezzi si
 * incollano dritti, senza scalini.
 */
export function splitToPlate(w: ManifoldToplevel, solid: Manifold, plate: Plate, connectors = true): SplitResult {
  const res: SplitResult = { pieces: [], pins: [], cuts: 0, cutsWithoutPins: 0 };
  splitRec(w, solid, plate, connectors, res);
  return res;
}

function splitRec(w: ManifoldToplevel, solid: Manifold, plate: Plate, connectors: boolean, res: SplitResult): void {
  const lim = [plate.x * 0.95, plate.y * 0.95, plate.z * 0.95];
  const box = solid.boundingBox();
  const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  // asse più "fuori misura" (rispetto al limite del piatto)
  let axis = -1;
  let worst = 1;
  for (let a = 0; a < 3; a++) {
    const ratio = size[a] / lim[a];
    if (ratio > worst) {
      worst = ratio;
      axis = a;
    }
  }
  if (axis < 0) {
    res.pieces.push(solid);
    return;
  }
  const parts = Math.ceil(worst);
  const slab = size[axis] / parts;
  // si lavora con l'asse di taglio portato su Z: la sezione si ottiene con slice()
  let rest = solid.rotate(TO_Z[axis]);
  const rb = rest.boundingBox();
  for (let i = 1; i < parts; i++) {
    const at = rb.min[2] + slab * i;
    res.cuts++;
    if (connectors) {
      const holes = planConnectors(w, rest, at, slab);
      if (holes.holes) {
        rest = rest.subtract(holes.holes);
        for (const p of holes.pins) res.pins.push(p.rotate(FROM_Z[axis]));
      } else {
        res.cutsWithoutPins++;
      }
    }
    const [above, below] = rest.splitByPlane([0, 0, 1], at);
    if (!below.isEmpty()) splitRec(w, below.rotate(FROM_Z[axis]), plate, connectors, res);
    rest = above;
  }
  if (!rest.isEmpty()) splitRec(w, rest.rotate(FROM_Z[axis]), plate, connectors, res);
}

/**
 * Sceglie dove mettere i perni sulla sezione z = at (asse di taglio già su Z):
 * per ogni isola della sezione, 1 perno (2 se c'è spazio, così il pezzo non
 * ruota), lontani dal bordo. Ogni foro è verificato: deve stare tutto dentro
 * il solido, altrimenti bucherebbe la superficie.
 */
function planConnectors(
  w: ManifoldToplevel,
  solid: Manifold,
  at: number,
  slab: number,
): { holes: Manifold | null; pins: Manifold[] } {
  const section = solid.slice(at);
  const holes: Manifold[] = [];
  const pins: Manifold[] = [];
  for (const island of section.decompose()) {
    const area = island.area();
    if (area < 30) continue; // isola minuscola (un dito, un orecchio): solo colla
    let done = false;
    // perno proporzionato alla sezione, da Ø3 a Ø8 mm; se non entra, si prova più piccolo
    for (const rp of [Math.min(4, Math.max(1.5, Math.sqrt(area) * 0.08)), 1.5]) {
      if (done) break;
      const rh = rp + PIN_CLEARANCE;
      const wall = Math.max(1.6, rp * 0.6);
      const points = pickPoints(island.offset(-(rh + wall), "Round"), 2, rh * 4);
      if (!points.length) continue;
      for (const depth0 of [Math.min(12, Math.max(4, rp * 3), slab * 0.4), Math.min(4, slab * 0.3)]) {
        const depth = Math.max(2, depth0);
        const ok: [number, number][] = [];
        for (const [u, v] of points) {
          const hole = w.Manifold.cylinder(depth * 2, rh, rh, 32).translate([u, v, at - depth]);
          // il foro deve essere interamente dentro il pezzo (tolleranza 1%)
          if (hole.subtract(solid).volume() < hole.volume() * 0.01) ok.push([u, v]);
        }
        if (!ok.length) continue;
        const len = depth * 2 - 0.8; // 0,4 mm più corto per lato: il perno non fa spessore
        for (const [u, v] of ok) {
          holes.push(w.Manifold.cylinder(depth * 2, rh, rh, 32).translate([u, v, at - depth]));
          pins.push(pinShape(w, rp, len).translate([u, v, at - len / 2]));
        }
        done = true;
        break;
      }
    }
  }
  return { holes: holes.length ? w.Manifold.union(holes) : null, pins };
}

/** Perno cilindrico con smusso alle estremità (entra più facilmente nel foro) */
function pinShape(w: ManifoldToplevel, r: number, len: number): Manifold {
  const c = Math.min(0.5, r * 0.25, len * 0.1);
  return w.Manifold.union([
    w.Manifold.cylinder(c, r - c, r, 32),
    w.Manifold.cylinder(len - 2 * c, r, r, 32).translate([0, 0, c]),
    w.Manifold.cylinder(c, r, r - c, 32).translate([0, 0, len - c]),
  ]);
}

/**
 * Punti dentro l'area ammessa: 1 vicino al centro, oppure i 2 più lontani tra
 * loro se distano almeno `minSpread`.
 */
function pickPoints(allowed: import("manifold-3d").CrossSection, max: number, minSpread: number): [number, number][] {
  if (allowed.isEmpty()) return [];
  const polys = allowed.toPolygons();
  const b = allowed.bounds();
  const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1];
  const step = Math.max(0.5, Math.max(sx, sy) / 24);
  const cand: [number, number][] = [];
  for (let x = b.min[0] + step / 2; x < b.max[0]; x += step) {
    for (let y = b.min[1] + step / 2; y < b.max[1]; y += step) {
      if (insidePolys(polys, x, y)) cand.push([x, y]);
    }
  }
  if (!cand.length) {
    // area ammessa più piccola del passo della griglia: si usa il suo baricentro
    let cx = 0, cy = 0, n = 0;
    for (const p of polys) for (const [x, y] of p) { cx += x; cy += y; n++; }
    if (n && insidePolys(polys, cx / n, cy / n)) cand.push([cx / n, cy / n]);
    return cand;
  }
  if (max >= 2 && cand.length > 1) {
    let best: [number, number] = [0, 0], bestD = -1;
    // al massimo ~600 candidati: il confronto a coppie è istantaneo
    for (let i = 0; i < cand.length; i++) {
      for (let j = i + 1; j < cand.length; j++) {
        const d = Math.hypot(cand[i][0] - cand[j][0], cand[i][1] - cand[j][1]);
        if (d > bestD) { bestD = d; best = [i, j]; }
      }
    }
    if (bestD >= minSpread) {
      // un po' verso l'interno: i punti estremi stanno proprio sul limite ammesso
      const a = cand[best[0]], c = cand[best[1]];
      const mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2;
      const pull = (p: [number, number]): [number, number] => {
        const q: [number, number] = [p[0] + (mx - p[0]) * 0.15, p[1] + (my - p[1]) * 0.15];
        return insidePolys(polys, q[0], q[1]) ? q : p;
      };
      return [pull(a), pull(c)];
    }
  }
  // un perno: il candidato più vicino al baricentro dei candidati
  let mx = 0, my = 0;
  for (const [x, y] of cand) { mx += x; my += y; }
  mx /= cand.length; my /= cand.length;
  let best = cand[0], bestD = Infinity;
  for (const p of cand) {
    const d = Math.hypot(p[0] - mx, p[1] - my);
    if (d < bestD) { bestD = d; best = p; }
  }
  return [best];
}

function insidePolys(polys: [number, number][][], x: number, y: number): boolean {
  // regola pari/dispari: i contorni dei buchi hanno verso opposto e si annullano
  let inside = false;
  for (const p of polys) {
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i], [xj, yj] = p[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export interface MagnetOptions {
  diameterMm: number;
  depthMm: number;
}

/**
 * Calamita da frigo: si tiene la metà frontale del modello (il davanti è -Y),
 * la si stende con il retro piatto sul piatto di stampa e si scava la sede del
 * magnete nel retro. Restituisce anche un eventuale avviso.
 */
export function makeMagnet(w: ManifoldToplevel, t: Tracked, opts: MagnetOptions): { tracked: Tracked; warning?: string } {
  const box = t.solid.boundingBox();
  const depthY = box.max[1] - box.min[1];
  const face = Math.max(box.max[0] - box.min[0], box.max[2] - box.min[2]);
  // spessore: metà profondità, ma non un mattone (≤ 25% del lato) e mai sotto la sede + 2 mm
  const keep = Math.max(opts.depthMm + 2, Math.min(depthY * 0.5, face * 0.25));
  const yCut = Math.min(box.max[1], box.min[1] + keep);
  let s = t.solid;
  if (yCut < box.max[1]) s = s.trimByPlane([0, -1, 0], -yCut);
  // retro (y = yCut, normale +Y) verso il basso
  s = s.rotate([-90, 0, 0]);
  const b = s.boundingBox();
  s = s.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]]);
  const tracked: Tracked = { ...t, solid: s };

  const rh = opts.diameterMm / 2 + 0.15;
  const pocketH = opts.depthMm + 0.2;
  const section = s.slice(0.05);
  const pts = pickPoints(section.offset(-(rh + 1.2), "Round"), 1, Infinity);
  for (const [u, v] of pts) {
    // la sede deve avere sopra almeno 1 mm di materiale
    const probe = w.Manifold.cylinder(pocketH + 1, rh, rh, 48).translate([u, v, 0]);
    if (probe.subtract(s).volume() < probe.volume() * 0.01) {
      const pocket = w.Manifold.cylinder(pocketH + 1, rh, rh, 48).translate([u, v, -1]);
      return { tracked: { ...tracked, solid: s.subtract(pocket) } };
    }
  }
  return {
    tracked,
    warning: `Il retro è troppo piccolo o sottile per un magnete Ø${opts.diameterMm} mm: incollalo senza sede`,
  };
}

/**
 * Manifold → PrintMesh con etichette: triangoli del modello = loro colore,
 * della base = baseLabel, facce di taglio = colore dei vicini.
 */
export function toPrintMesh(
  solid: Manifold,
  modelRun: number,
  baseRun: number | null,
  baseLabel: number,
  extra: { run: number | null | undefined; label: number }[] = [],
): PrintMesh {
  const mesh = solid.getMesh();
  const np = mesh.numProp;
  const nv = mesh.vertProperties.length / np;
  const vert = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    vert[i * 3] = mesh.vertProperties[i * np];
    vert[i * 3 + 1] = mesh.vertProperties[i * np + 1];
    vert[i * 3 + 2] = mesh.vertProperties[i * np + 2];
  }
  // il Mesh di Manifold duplica i vertici lungo i bordi delle proprietà: si
  // riuniscono con mergeFromVert/mergeToVert per avere un solido indicizzato
  const remap = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) remap[i] = i;
  for (let i = 0; i < mesh.mergeFromVert.length; i++) remap[mesh.mergeFromVert[i]] = mesh.mergeToVert[i];
  const tri = new Uint32Array(mesh.triVerts.length);
  for (let i = 0; i < tri.length; i++) tri[i] = remap[mesh.triVerts[i]];
  const T = tri.length / 3;
  const label = new Uint16Array(T).fill(UNSET_LABEL);
  for (let r = 0; r < mesh.runOriginalID.length; r++) {
    const id = mesh.runOriginalID[r];
    for (let t = mesh.runIndex[r] / 3; t < mesh.runIndex[r + 1] / 3; t++) {
      if (id === modelRun) label[t] = mesh.faceID[t];
      else if (baseRun !== null && id === baseRun) label[t] = baseLabel;
      else for (const e of extra) if (e.run != null && id === e.run) label[t] = e.label;
    }
  }
  const pm: PrintMesh = { vert, tri, label };
  colorCutFaces(pm);
  return pm;
}

export interface Placed {
  mesh: PrintMesh;
  /** traslazione per disporlo sul suo piatto (coordinate del piatto) */
  offset: [number, number, number];
  /** indice del piatto (0 = primo) */
  plate: number;
  /** perno di allineamento (non un pezzo del modello) */
  pin?: boolean;
}

interface Shelf {
  x: number;
  y: number;
  rowH: number;
}

/**
 * Dispone i pezzi sui piatti, ognuno appoggiato a z = 0: righe su ogni piatto,
 * e un piatto nuovo quando quello corrente è pieno. I pezzi più grandi vanno
 * per primi; i perni riempiono gli spazi rimasti.
 */
export function packPlates(
  pieces: { mesh: PrintMesh; pin?: boolean }[],
  plate: Plate,
  gap = 6,
): { placed: Placed[]; plates: number; fits: boolean } {
  const placed: Placed[] = [];
  const shelves: Shelf[] = [];
  let fits = true;
  const sized = pieces
    .map((p) => ({ ...p, b: bounds(p.mesh.vert) }))
    .sort((a, b) => Number(!!a.pin) - Number(!!b.pin) || (b.b.max[1] - b.b.min[1]) - (a.b.max[1] - a.b.min[1]));
  for (const { mesh, pin, b } of sized) {
    const w = b.max[0] - b.min[0];
    const d = b.max[1] - b.min[1];
    if (w > plate.x || d > plate.y || b.max[2] - b.min[2] > plate.z) fits = false;
    let target = -1;
    let at: [number, number] = [0, 0];
    for (let i = 0; i < shelves.length && target < 0; i++) {
      const s = shelves[i];
      if (s.x + w <= plate.x && s.y + d <= plate.y) {
        target = i;
        at = [s.x, s.y];
      } else if (s.y + s.rowH + gap + d <= plate.y && w <= plate.x) {
        // nuova riga sullo stesso piatto
        s.y += s.rowH + gap;
        s.x = 0;
        s.rowH = 0;
        target = i;
        at = [0, s.y];
      }
    }
    if (target < 0) {
      shelves.push({ x: 0, y: 0, rowH: 0 });
      target = shelves.length - 1;
      at = [0, 0];
    }
    const s = shelves[target];
    placed.push({ mesh, pin, plate: target, offset: [at[0] - b.min[0], at[1] - b.min[1], -b.min[2]] });
    s.x = at[0] + w + gap;
    s.rowH = Math.max(s.rowH, d);
  }
  // centra il contenuto di ogni piatto
  for (let k = 0; k < shelves.length; k++) {
    const mine = placed.filter((p) => p.plate === k);
    let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
    for (const p of mine) {
      const b = bounds(p.mesh.vert);
      gx0 = Math.min(gx0, b.min[0] + p.offset[0]); gx1 = Math.max(gx1, b.max[0] + p.offset[0]);
      gy0 = Math.min(gy0, b.min[1] + p.offset[1]); gy1 = Math.max(gy1, b.max[1] + p.offset[1]);
    }
    const dx = plate.x / 2 - (gx0 + gx1) / 2, dy = plate.y / 2 - (gy0 + gy1) / 2;
    for (const p of mine) {
      p.offset[0] += dx;
      p.offset[1] += dy;
    }
  }
  return { placed, plates: Math.max(1, shelves.length), fits };
}

/** Distanza tra piatti come in Bambu Studio / OrcaSlicer (piatto + 20%), in griglia quasi quadrata */
export function plateOrigin(index: number, plates: number, plate: Plate): [number, number] {
  const cols = Math.ceil(Math.sqrt(plates));
  const col = index % cols, row = Math.floor(index / cols);
  return [col * plate.x * 1.2, -row * plate.y * 1.2];
}

/**
 * Facce di taglio (senza colore): ogni faccia connessa prende UN solo colore,
 * quello più presente lungo il suo bordo. Le facce interne non si vedono, e un
 * colore unico evita cambi di filamento inutili.
 */
function colorCutFaces(m: PrintMesh): void {
  const label = m.label!;
  const T = m.tri.length / 3;
  const key = (a: number, b: number) => Math.min(a, b) * 4_294_967_296 + Math.max(a, b);
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < T; t++) {
    for (let e = 0; e < 3; e++) {
      const k = key(m.tri[t * 3 + e], m.tri[t * 3 + ((e + 1) % 3)]);
      const l = edgeTris.get(k);
      if (l) l.push(t);
      else edgeTris.set(k, [t]);
    }
  }
  const seen = new Uint8Array(T);
  for (let s0 = 0; s0 < T; s0++) {
    if (label[s0] !== UNSET_LABEL || seen[s0]) continue;
    const comp: number[] = [];
    const votes = new Map<number, number>();
    const stack = [s0];
    seen[s0] = 1;
    while (stack.length) {
      const t = stack.pop()!;
      comp.push(t);
      for (let e = 0; e < 3; e++) {
        for (const n of edgeTris.get(key(m.tri[t * 3 + e], m.tri[t * 3 + ((e + 1) % 3)])) ?? []) {
          if (n === t) continue;
          if (label[n] === UNSET_LABEL) {
            if (!seen[n]) {
              seen[n] = 1;
              stack.push(n);
            }
          } else {
            votes.set(label[n], (votes.get(label[n]) ?? 0) + 1);
          }
        }
      }
    }
    let best = 0, bestN = -1;
    for (const [l, n] of votes) if (n > bestN) { best = l; bestN = n; }
    for (const t of comp) label[t] = best;
  }
}
