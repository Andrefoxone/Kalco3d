// Import di file CAD nel viewport: DWG (via conversione WASM LibreDWG → DXF),
// DXF, STEP/IGES (via OpenCascade WASM) e mesh STL/OBJ/PLY.
// Tutto nel browser: nessun servizio esterno, nessun credito.
// I disegni 2D diventano linee colorate per layer; le facce 3D (3DFACE, SOLID,
// solidi STEP) diventano mesh con colori originali (vertex colors, così i
// preset materiale dello studio non cancellano i colori CAD).
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { NURBSCurve } from "three/examples/jsm/curves/NURBSCurve.js";
import DxfParser from "dxf-parser";

export type CadFormat = "dwg" | "dxf" | "step" | "iges" | "stl" | "obj" | "ply";

export interface CadImportResult {
  object: THREE.Object3D;
  format: CadFormat;
  /** descrizione breve per l'utente, es. "54 entità · 5 layer" */
  stats: string;
  /** elementi volutamente ignorati, es. ["9 quote", "12 testi"] */
  skipped: string[];
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;

export const CAD_ACCEPT = ".dwg,.dxf,.step,.stp,.iges,.igs,.stl,.obj,.ply";

export function cadFormatFromName(name: string): CadFormat | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "stp") return "step";
  if (ext === "igs") return "iges";
  return (["dwg", "dxf", "step", "iges", "stl", "obj", "ply"] as const).find((f) => f === ext) ?? null;
}

// ---------- tavolozza ACI (AutoCAD Color Index) ----------

const ACI: string[] = [
  "#000000", "#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff",
  "#ffffff", "#808080", "#c0c0c0", "#ff0000", "#ff7f7f", "#cc0000", "#cc6666",
  "#990000", "#994c4c", "#7f0000", "#7f3f3f", "#4c0000", "#4c2626", "#ff3f00",
  "#ff9f7f", "#cc3300", "#cc7f66", "#992600", "#995f4c", "#7f1f00", "#7f4f3f",
  "#4c1300", "#4c2f26", "#ff7f00", "#ffbf7f", "#cc6600", "#cc9966", "#994c00",
  "#99724c", "#7f3f00", "#7f5f3f", "#4c2600", "#4c3826", "#ffbf00", "#ffdf7f",
  "#cc9900", "#ccb266", "#997200", "#99854c", "#7f5f00", "#7f6f3f", "#4c3900",
  "#4c4226", "#ffff00", "#ffff7f", "#cccc00", "#cccc66", "#999900", "#99994c",
  "#7f7f00", "#7f7f3f", "#4c4c00", "#4c4c26", "#bfff00", "#dfff7f", "#99cc00",
  "#b2cc66", "#729900", "#85994c", "#5f7f00", "#6f7f3f", "#394c00", "#424c26",
  "#7fff00", "#bfff7f", "#66cc00", "#99cc66", "#4c9900", "#72994c", "#3f7f00",
  "#5f7f3f", "#264c00", "#384c26", "#3fff00", "#9fff7f", "#33cc00", "#7fcc66",
  "#269900", "#5f994c", "#1f7f00", "#4f7f3f", "#134c00", "#2f4c26", "#00ff00",
  "#7fff7f", "#00cc00", "#66cc66", "#009900", "#4c994c", "#007f00", "#3f7f3f",
  "#004c00", "#264c26", "#00ff3f", "#7fff9f", "#00cc33", "#66cc7f", "#009926",
  "#4c995f", "#007f1f", "#3f7f4f", "#004c13", "#264c2f", "#00ff7f", "#7fffbf",
  "#00cc66", "#66cc99", "#00994c", "#4c9972", "#007f3f", "#3f7f5f", "#004c26",
  "#264c38", "#00ffbf", "#7fffdf", "#00cc99", "#66ccb2", "#009972", "#4c9985",
  "#007f5f", "#3f7f6f", "#004c39", "#264c42", "#00ffff", "#7fffff", "#00cccc",
  "#66cccc", "#009999", "#4c9999", "#007f7f", "#3f7f7f", "#004c4c", "#264c4c",
  "#00bfff", "#7fdfff", "#0099cc", "#66b2cc", "#007299", "#4c8599", "#005f7f",
  "#3f6f7f", "#00394c", "#26424c", "#007fff", "#7fbfff", "#0066cc", "#6699cc",
  "#004c99", "#4c7299", "#003f7f", "#3f5f7f", "#00264c", "#26384c", "#003fff",
  "#7f9fff", "#0033cc", "#667fcc", "#002699", "#4c5f99", "#001f7f", "#3f4f7f",
  "#00134c", "#262f4c", "#0000ff", "#7f7fff", "#0000cc", "#6666cc", "#000099",
  "#4c4c99", "#00007f", "#3f3f7f", "#00004c", "#26264c", "#3f00ff", "#9f7fff",
  "#3300cc", "#7f66cc", "#260099", "#5f4c99", "#1f007f", "#4f3f7f", "#13004c",
  "#2f264c", "#7f00ff", "#bf7fff", "#6600cc", "#9966cc", "#4c0099", "#724c99",
  "#3f007f", "#5f3f7f", "#26004c", "#38264c", "#bf00ff", "#df7fff", "#9900cc",
  "#b266cc", "#720099", "#854c99", "#5f007f", "#6f3f7f", "#39004c", "#42264c",
  "#ff00ff", "#ff7fff", "#cc00cc", "#cc66cc", "#990099", "#994c99", "#7f007f",
  "#7f3f7f", "#4c004c", "#4c264c", "#ff00bf", "#ff7fdf", "#cc0099", "#cc66b2",
  "#990072", "#994c85", "#7f005f", "#7f3f6f", "#4c0039", "#4c2642", "#ff007f",
  "#ff7fbf", "#cc0066", "#cc6699", "#99004c", "#994c72", "#7f003f", "#7f3f5f",
  "#4c0026", "#4c2638", "#ff003f", "#ff7f9f", "#cc0033", "#cc667f", "#990026",
  "#994c5f", "#7f001f", "#7f3f4f", "#4c0013", "#4c262f", "#333333", "#5b5b5b",
  "#848484", "#adadad", "#d6d6d6", "#ffffff",
];

function aciToColor(index: number | undefined): THREE.Color | null {
  if (index === undefined || index <= 0 || index > 255) return null;
  if (index === 256) return null; // BYLAYER
  return new THREE.Color(ACI[index] ?? "#ffffff");
}

// ---------- collettore di primitive ----------

class CadCollector {
  segPos: number[] = [];
  segCol: number[] = [];
  triPos: number[] = [];
  triCol: number[] = [];
  matrix = new THREE.Matrix4();
  /** primitive scartate perché lontanissime dal disegno (righe orfane a 1e6+) */
  droppedOutliers = 0;

  private tmp = new THREE.Vector3();

  private point(x: number, y: number, z: number): [number, number, number] {
    this.tmp.set(x, y, z).applyMatrix4(this.matrix);
    return [this.tmp.x, this.tmp.y, this.tmp.z];
  }

  seg(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, color: THREE.Color) {
    const [ax, ay, az] = this.point(x1, y1, z1);
    const [bx, by, bz] = this.point(x2, y2, z2);
    this.segPos.push(ax, ay, az, bx, by, bz);
    this.segCol.push(color.r, color.g, color.b, color.r, color.g, color.b);
  }

  tri(pts: [number, number, number][], color: THREE.Color) {
    for (const [x, y, z] of pts) {
      const [ax, ay, az] = this.point(x, y, z);
      this.triPos.push(ax, ay, az);
      this.triCol.push(color.r, color.g, color.b);
    }
  }

  polyline(pts: [number, number, number][], closed: boolean, color: THREE.Color) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      this.seg(a[0], a[1], a[2], b[0], b[1], b[2], color);
    }
    if (closed && pts.length > 2) {
      const a = pts[pts.length - 1];
      const b = pts[0];
      this.seg(a[0], a[1], a[2], b[0], b[1], b[2], color);
    }
  }

  /**
   * I file AutoCAD spesso contengono entità orfane a coordinate enormi: col
   * bounding box min/max il disegno vero diventerebbe invisibile. Se l'estensione
   * completa supera 3× quella "densa" (percentili 2–98), scarta le primitive
   * lontane (con margine generoso pari all'intera estensione densa).
   */
  private filterOutliers(): void {
    const pointCount = this.segPos.length / 3 + this.triPos.length / 3;
    if (pointCount < 64) return;
    const step = Math.max(1, Math.floor(pointCount / 20000));
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i + 2 < this.segPos.length; i += 3 * step) {
      xs.push(this.segPos[i]);
      ys.push(this.segPos[i + 1]);
      zs.push(this.segPos[i + 2]);
    }
    for (let i = 0; i + 2 < this.triPos.length; i += 3 * step) {
      xs.push(this.triPos[i]);
      ys.push(this.triPos[i + 1]);
      zs.push(this.triPos[i + 2]);
    }
    const pct = (arr: number[], p: number): number => {
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(s.length * p))];
    };
    const box = {
      minX: pct(xs, 0.02),
      maxX: pct(xs, 0.98),
      minY: pct(ys, 0.02),
      maxY: pct(ys, 0.98),
      minZ: pct(zs, 0.02),
      maxZ: pct(zs, 0.98),
    };
    const coreSpan = Math.max(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ) || 1;
    const fullSpan = Math.max(
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys),
      Math.max(...zs) - Math.min(...zs),
    );
    if (fullSpan <= coreSpan * 3) return;
    const pad = coreSpan;
    const inBox = (x: number, y: number, z: number): boolean =>
      x >= box.minX - pad &&
      x <= box.maxX + pad &&
      y >= box.minY - pad &&
      y <= box.maxY + pad &&
      z >= box.minZ - pad &&
      z <= box.maxZ + pad;
    const segPos: number[] = [];
    const segCol: number[] = [];
    for (let i = 0; i + 5 < this.segPos.length; i += 6) {
      if (
        inBox(this.segPos[i], this.segPos[i + 1], this.segPos[i + 2]) &&
        inBox(this.segPos[i + 3], this.segPos[i + 4], this.segPos[i + 5])
      ) {
        segPos.push(...this.segPos.slice(i, i + 6));
        segCol.push(...this.segCol.slice(i, i + 6));
      } else {
        this.droppedOutliers++;
      }
    }
    const triPos: number[] = [];
    const triCol: number[] = [];
    for (let i = 0; i + 8 < this.triPos.length; i += 9) {
      let inside = true;
      for (let v = 0; v < 3 && inside; v++) {
        inside = inBox(this.triPos[i + v * 3], this.triPos[i + v * 3 + 1], this.triPos[i + v * 3 + 2]);
      }
      if (inside) {
        triPos.push(...this.triPos.slice(i, i + 9));
        triCol.push(...this.triCol.slice(i, i + 9));
      } else {
        this.droppedOutliers++;
      }
    }
    this.segPos = segPos;
    this.segCol = segCol;
    this.triPos = triPos;
    this.triCol = triCol;
  }

  build(): THREE.Group {
    this.filterOutliers();
    const group = new THREE.Group();
    if (this.segPos.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(this.segPos, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(this.segCol, 3));
      const lines = new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({ vertexColors: true }),
      );
      group.add(lines);
    }
    if (this.triPos.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(this.triPos, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(this.triCol, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
          roughness: 0.7,
          metalness: 0.05,
        }),
      );
      group.add(mesh);
    }
    return group;
  }
}

// ---------- tessellazione curve ----------

function arcPoints(
  cx: number,
  cy: number,
  cz: number,
  r: number,
  startRad: number,
  endRad: number,
): [number, number, number][] {
  let sweep = endRad - startRad;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(8, Math.ceil(sweep / (Math.PI / 48)));
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = startRad + (sweep * i) / n;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t), cz]);
  }
  return pts;
}

/**
 * Segmento di polilinea con bulge (arco) → punti tessellati.
 * Standard DXF: bulge = tan(angolo incluso / 4); positivo = arco antiorario
 * dal punto iniziale al finale, cioè l'arco sporge a DESTRA della direzione
 * di marcia (es. da (0,0) a (2,0) con bulge 1 passa per (1,-1)).
 */
function bulgePoints(
  x1: number,
  y1: number,
  z: number,
  x2: number,
  y2: number,
  bulge: number,
): [number, number, number][] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const c = Math.hypot(dx, dy);
  if (c < 1e-9 || Math.abs(bulge) < 1e-9) {
    return [
      [x1, y1, z],
      [x2, y2, z],
    ];
  }
  const theta = 4 * Math.atan(bulge); // angolo incluso, con segno (+ = antiorario)
  const r = c / (2 * Math.sin(Math.abs(theta) / 2));
  // centro: dal punto medio lungo la normale sinistra, distanza c / (2·tan(θ/2))
  const offset = c / (2 * Math.tan(theta / 2));
  const cx = (x1 + x2) / 2 + (-dy / c) * offset;
  const cy = (y1 + y2) / 2 + (dx / c) * offset;
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  const n = Math.max(4, Math.ceil(Math.abs(theta) / (Math.PI / 36)));
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = a1 + (theta * i) / n;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t), z]);
  }
  // estremi esatti (niente micro-scarti di arrotondamento)
  pts[0] = [x1, y1, z];
  pts[n] = [x2, y2, z];
  return pts;
}

// ---------- DXF ----------

interface DxfEntity {
  type: string;
  layer?: string;
  colorNumber?: number;
  color?: number;
  inPaperSpace?: boolean;
  // geometrie (campi opzionali, dipendono dal tipo)
  vertices?: { x: number; y: number; z?: number; bulge?: number }[];
  shape?: boolean;
  closed?: boolean;
  center?: { x: number; y: number; z?: number };
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  majorAxisEndPoint?: { x: number; y: number; z?: number };
  axisRatio?: number;
  controlPoints?: { x: number; y: number; z?: number }[];
  knotValues?: number[];
  degreeOfSplineCurve?: number;
  weights?: number[];
  position?: { x: number; y: number; z?: number };
  corners?: { x: number; y: number; z?: number }[];
  points?: { x: number; y: number; z?: number }[];
  name?: string;
  rotation?: number;
  xScale?: number;
  yScale?: number;
  zScale?: number;
  columnCount?: number;
  rowCount?: number;
  columnSpacing?: number;
  rowSpacing?: number;
}

interface DxfBlock {
  name: string;
  position?: { x: number; y: number; z?: number };
  entities?: DxfEntity[];
}

interface DxfDoc {
  entities?: DxfEntity[];
  blocks?: Record<string, DxfBlock>;
  tables?: { layer?: { layers?: Record<string, { color?: number; colorNumber?: number }> } };
}

interface DxfRenderStats {
  entities: number;
  layers: number;
  skipped: Map<string, number>;
}

const SKIPPED_LABELS: Record<string, string> = {
  testi: "testi",
  quote: "quote",
  campiture: "campiture",
  altro: "altri elementi",
};

function resolveColor(
  e: DxfEntity,
  layers: Record<string, { color?: number; colorNumber?: number }>,
): THREE.Color {
  if (e.color !== undefined && e.color !== null && e.color > 0) {
    return new THREE.Color(e.color);
  }
  const byAci = aciToColor(e.colorNumber);
  if (byAci) return byAci;
  const layer = e.layer ? layers[e.layer] : undefined;
  if (layer) {
    if (layer.color !== undefined && layer.color > 0) return new THREE.Color(layer.color);
    const lc = aciToColor(layer.colorNumber);
    if (lc) return lc;
  }
  return new THREE.Color("#d8d8dc");
}

function emitEntity(
  e: DxfEntity,
  col: CadCollector,
  doc: DxfDoc,
  layers: Record<string, { color?: number; colorNumber?: number }>,
  stats: DxfRenderStats,
  depth: number,
): void {
  const color = resolveColor(e, layers);
  const z = (p?: { z?: number }) => p?.z ?? 0;
  switch (e.type) {
    case "LINE": {
      const v = e.vertices;
      if (v && v.length >= 2) {
        col.seg(v[0].x, v[0].y, z(v[0]), v[1].x, v[1].y, z(v[1]), color);
        stats.entities++;
      }
      break;
    }
    case "POINT":
      break; // marcatori: non li disegniamo
    case "LWPOLYLINE":
    case "POLYLINE": {
      const v = e.vertices ?? [];
      if (v.length < 2) break;
      const closed = !!(e.shape ?? e.closed);
      const pts: [number, number, number][] = [];
      for (let i = 0; i < v.length; i++) {
        const cur = v[i];
        const nxt = v[(i + 1) % v.length];
        // nelle polilinee chiuse anche l'ultimo vertice può avere un bulge
        // (il tratto di chiusura verso il primo punto è un arco)
        if (cur.bulge && (i < v.length - 1 || closed)) {
          const arc = bulgePoints(cur.x, cur.y, z(cur), nxt.x, nxt.y, cur.bulge);
          pts.push(...arc.slice(0, -1));
        } else {
          pts.push([cur.x, cur.y, z(cur)]);
        }
      }
      col.polyline(pts, closed, color);
      stats.entities++;
      break;
    }
    case "CIRCLE": {
      if (!e.center || !e.radius) break;
      col.polyline(arcPoints(e.center.x, e.center.y, z(e.center), e.radius, 0, Math.PI * 2), true, color);
      stats.entities++;
      break;
    }
    case "ARC": {
      if (!e.center || !e.radius) break;
      // dxf-parser converte già gli angoli degli ARC in radianti
      const start = e.startAngle ?? 0;
      const end = e.endAngle ?? Math.PI * 2;
      col.polyline(arcPoints(e.center.x, e.center.y, z(e.center), e.radius, start, end), false, color);
      stats.entities++;
      break;
    }
    case "ELLIPSE": {
      const c = e.center;
      const maj = e.majorAxisEndPoint;
      const ratio = e.axisRatio ?? 1;
      if (!c || !maj) break;
      const majLen = Math.hypot(maj.x, maj.y) || 1e-9;
      const ux = maj.x / majLen;
      const uy = maj.y / majLen;
      const minLen = majLen * ratio;
      const start = e.startAngle ?? 0;
      let end = e.endAngle ?? Math.PI * 2;
      while (end <= start) end += Math.PI * 2;
      const n = Math.max(16, Math.ceil((end - start) / (Math.PI / 48)));
      const pts: [number, number, number][] = [];
      for (let i = 0; i <= n; i++) {
        const t = start + ((end - start) * i) / n;
        pts.push([
          c.x + majLen * ux * Math.cos(t) - minLen * uy * Math.sin(t),
          c.y + majLen * uy * Math.cos(t) + minLen * ux * Math.sin(t),
          z(c),
        ]);
      }
      col.polyline(pts, false, color);
      stats.entities++;
      break;
    }
    case "SPLINE": {
      const ctrl = e.controlPoints ?? [];
      if (ctrl.length < 2) break;
      let pts: [number, number, number][] | null = null;
      try {
        const degree = e.degreeOfSplineCurve ?? 3;
        const knots = e.knotValues ?? [];
        if (knots.length === ctrl.length + degree + 1) {
          const weights = e.weights ?? ctrl.map(() => 1);
          const cps = ctrl.map(
            (p, i) => new THREE.Vector4(p.x * weights[i], p.y * weights[i], z(p) * weights[i], weights[i]),
          );
          const curve = new NURBSCurve(degree, knots, cps);
          pts = curve.getPoints(96).map((p) => [p.x, p.y, p.z]);
        }
      } catch {
        pts = null;
      }
      if (!pts) pts = ctrl.map((p) => [p.x, p.y, z(p)]);
      col.polyline(pts, false, color);
      stats.entities++;
      break;
    }
    case "SOLID": {
      // dxf-parser mette i 4 vertici del SOLID in `points`
      const c = e.points ?? e.corners ?? e.vertices ?? [];
      if (c.length >= 3) {
        const p = c.map((k) => [k.x, k.y, z(k)] as [number, number, number]);
        col.tri([p[0], p[1], p[3] ?? p[2]], color);
        if (p[3]) col.tri([p[0], p[3], p[2]], color);
        stats.entities++;
      }
      break;
    }
    case "3DFACE": {
      const v = e.vertices ?? [];
      if (v.length >= 3) {
        const p = v.map((k) => [k.x, k.y, z(k)] as [number, number, number]);
        col.tri([p[0], p[1], p[2]], color);
        if (p[3] && (p[3][0] !== p[2][0] || p[3][1] !== p[2][1] || p[3][2] !== p[2][2])) {
          col.tri([p[0], p[2], p[3]], color);
        }
        stats.entities++;
      }
      break;
    }
    case "INSERT": {
      if (depth > 8) break; // blocchi ricorsivi: stop
      const block = e.name ? doc.blocks?.[e.name] : undefined;
      if (!block?.entities?.length) break;
      const pos = e.position ?? { x: 0, y: 0 };
      const base = block.position ?? { x: 0, y: 0 };
      const parent = col.matrix.clone();
      const cols = Math.max(1, e.columnCount ?? 1);
      const rows = Math.max(1, e.rowCount ?? 1);
      for (let r = 0; r < rows; r++) {
        for (let q = 0; q < cols; q++) {
          const m = new THREE.Matrix4()
            .makeTranslation(pos.x + q * (e.columnSpacing ?? 0), pos.y + r * (e.rowSpacing ?? 0), z(pos))
            .multiply(new THREE.Matrix4().makeRotationZ(((e.rotation ?? 0) * Math.PI) / 180))
            .multiply(new THREE.Matrix4().makeScale(e.xScale ?? 1, e.yScale ?? 1, e.zScale ?? 1))
            .multiply(new THREE.Matrix4().makeTranslation(-base.x, -base.y, -z(base)));
          col.matrix.copy(parent).multiply(m);
          for (const child of block.entities) {
            emitEntity(child, col, doc, layers, stats, depth + 1);
          }
        }
      }
      col.matrix.copy(parent);
      break;
    }
    case "TEXT":
    case "MTEXT":
    case "ATTDEF":
    case "ATTRIB":
      stats.skipped.set("testi", (stats.skipped.get("testi") ?? 0) + 1);
      break;
    case "DIMENSION":
    case "LEADER":
    case "MULTILEADER":
      stats.skipped.set("quote", (stats.skipped.get("quote") ?? 0) + 1);
      break;
    case "HATCH":
      stats.skipped.set("campiture", (stats.skipped.get("campiture") ?? 0) + 1);
      break;
    default:
      stats.skipped.set("altro", (stats.skipped.get("altro") ?? 0) + 1);
  }
}

function renderDxf(doc: DxfDoc): { object: THREE.Object3D; stats: string; skipped: string[] } {
  const layers = doc.tables?.layer?.layers ?? {};
  const stats: DxfRenderStats = { entities: 0, layers: Object.keys(layers).length, skipped: new Map() };
  const col = new CadCollector();
  for (const e of doc.entities ?? []) {
    if (e.inPaperSpace) continue; // solo spazio modello
    emitEntity(e, col, doc, layers, stats, 0);
  }
  const group = col.build();
  if (group.children.length === 0) {
    throw new Error("Il file non contiene geometrie nello spazio modello");
  }
  group.rotation.x = -Math.PI / 2; // i CAD sono Z-up, la scena è Y-up
  const skipped = [...stats.skipped.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${SKIPPED_LABELS[k] ?? k}`);
  if (col.droppedOutliers > 0) {
    skipped.push(`${col.droppedOutliers} elementi fuori scala`);
  }
  const layerTxt = stats.layers > 0 ? ` · ${stats.layers} layer` : "";
  return { object: group, stats: `${stats.entities} entità${layerTxt}`, skipped };
}

export function parseDxfText(text: string): { object: THREE.Object3D; stats: string; skipped: string[] } {
  const parser = new DxfParser();
  const doc = parser.parseSync(text) as DxfDoc | null;
  if (!doc) throw new Error("File DXF non leggibile");
  return renderDxf(doc);
}

// ---------- DWG (conversione WASM LibreDWG → DXF) ----------

let libredwgPromise: Promise<{
  dwg_write_dxf: (content: ArrayBuffer) => Uint8Array | null;
}> | null = null;

async function getLibreDwg() {
  if (!libredwgPromise) {
    libredwgPromise = import("@mlightcad/libredwg-web").then((m) =>
      m.LibreDwg.create("/wasm"),
    ) as Promise<{ dwg_write_dxf: (content: ArrayBuffer) => Uint8Array | null }>;
    libredwgPromise.catch(() => {
      libredwgPromise = null; // permette un nuovo tentativo
    });
  }
  return libredwgPromise;
}

// ---------- STEP / IGES (OpenCascade WASM) ----------

interface OcctMesh {
  name?: string;
  color?: [number, number, number];
  attributes?: { position?: { array: ArrayLike<number> } };
  index?: { array: ArrayLike<number> };
}

interface OcctModule {
  ReadStepFile: (content: Uint8Array, params: unknown) => { success: boolean; meshes?: OcctMesh[] };
  ReadIgesFile: (content: Uint8Array, params: unknown) => { success: boolean; meshes?: OcctMesh[] };
}

let occtPromise: Promise<OcctModule> | null = null;

async function getOcct(): Promise<OcctModule> {
  if (!occtPromise) {
    occtPromise = import("occt-import-js").then((m) =>
      (m.default as (opts: { locateFile: () => string }) => Promise<OcctModule>)({
        locateFile: () => "/wasm/occt-import-js.wasm",
      }),
    );
    occtPromise.catch(() => {
      occtPromise = null;
    });
  }
  return occtPromise;
}

function coloredMesh(pos: ArrayLike<number>, index: ArrayLike<number> | undefined, color: THREE.Color): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(Array.from(pos) as number[], 3));
  if (index && index.length >= 3) {
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(Array.from(index) as number[]), 1));
  }
  const count = geo.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 }),
  );
}

async function importStepIges(
  buf: ArrayBuffer,
  kind: "step" | "iges",
): Promise<CadImportResult> {
  const occt = await getOcct();
  const res = kind === "step" ? occt.ReadStepFile(new Uint8Array(buf), null) : occt.ReadIgesFile(new Uint8Array(buf), null);
  if (!res?.success) {
    throw new Error(`Il file ${kind.toUpperCase()} non è leggibile (formato non supportato o danneggiato)`);
  }
  const meshes = res.meshes ?? [];
  const group = new THREE.Group();
  let tris = 0;
  for (const m of meshes) {
    const pos = m.attributes?.position?.array;
    if (!pos || pos.length < 9) continue;
    const raw = m.color;
    const scale = raw && Math.max(...raw) > 1.001 ? 1 / 255 : 1;
    const color = raw
      ? new THREE.Color(raw[0] * scale, raw[1] * scale, raw[2] * scale)
      : new THREE.Color("#b8bcc2");
    const mesh = coloredMesh(pos, m.index?.array, color);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    tris += (m.index?.array?.length ?? pos.length / 3) / 3;
  }
  if (group.children.length === 0) {
    throw new Error("Il file non contiene solidi o superfici visibili");
  }
  group.rotation.x = -Math.PI / 2; // STEP/IGES sono Z-up
  return {
    object: group,
    format: kind,
    stats: `${group.children.length} corpi · ${Math.round(tris).toLocaleString("it-IT")} triangoli`,
    skipped: [],
  };
}

// ---------- STL / OBJ / PLY ----------

function meshFromGeometry(geo: THREE.BufferGeometry): THREE.Mesh {
  if (!geo.getAttribute("normal")) geo.computeVertexNormals();
  if (!geo.getAttribute("color")) {
    const count = geo.getAttribute("position").count;
    const colors = new Float32Array(count * 3).fill(0.78);
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.08 }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function triangleStats(object: THREE.Object3D): string {
  let tris = 0;
  let parts = 0;
  object.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      parts++;
      const pos = o.geometry.getAttribute("position");
      tris += (o.geometry.index?.count ?? pos?.count ?? 0) / 3;
    }
  });
  return `${parts} corpi · ${Math.round(tris).toLocaleString("it-IT")} triangoli`;
}

// ---------- entry point ----------

export async function importCadFile(file: File): Promise<CadImportResult> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("File troppo grande: il limite è 64 MB");
  }
  const format = cadFormatFromName(file.name);
  if (!format) {
    throw new Error("Formato non riconosciuto: uso DWG, DXF, STEP, IGES, STL, OBJ o PLY");
  }
  const buf = await file.arrayBuffer();

  switch (format) {
    case "dwg": {
      let dxfText: string;
      try {
        const lib = await getLibreDwg();
        const dxf = lib.dwg_write_dxf(buf);
        if (!dxf) throw new Error("null");
        dxfText = new TextDecoder("utf-8").decode(dxf);
      } catch {
        throw new Error(
          "Questo DWG non è convertibile (versione troppo vecchia/nuova o contenuto non supportato). Esportalo in DXF da AutoCAD o dal convertitore gratuito ODA e riprova.",
        );
      }
      const r = parseDxfText(dxfText);
      return { ...r, format };
    }
    case "dxf": {
      const r = parseDxfText(new TextDecoder("utf-8").decode(buf));
      return { ...r, format };
    }
    case "step":
    case "iges":
      return importStepIges(buf, format);
    case "stl": {
      const geo = new STLLoader().parse(buf);
      const mesh = meshFromGeometry(geo);
      mesh.rotation.x = -Math.PI / 2; // gli STL da CAD sono quasi sempre Z-up
      return { object: mesh, format, stats: triangleStats(mesh), skipped: [] };
    }
    case "obj": {
      const group = new OBJLoader().parse(new TextDecoder().decode(buf));
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.6,
        metalness: 0.08,
      });
      let hasMesh = false;
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          hasMesh = true;
          if (!o.geometry.getAttribute("normal")) o.geometry.computeVertexNormals();
          if (!o.geometry.getAttribute("color")) {
            const count = o.geometry.getAttribute("position").count;
            o.geometry.setAttribute(
              "color",
              new THREE.BufferAttribute(new Float32Array(count * 3).fill(0.78), 3),
            );
          }
          o.material = mat;
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      if (!hasMesh) throw new Error("Il file OBJ non contiene mesh");
      return { object: group, format, stats: triangleStats(group), skipped: [] };
    }
    case "ply": {
      const geo = new PLYLoader().parse(buf);
      const mesh = meshFromGeometry(geo);
      return { object: mesh, format, stats: triangleStats(mesh), skipped: [] };
    }
  }
}
