// Preparazione alla stampa, dall'inizio alla fine:
// zuppa di triangoli (scena) → mm + Z in alto → saldatura → orientamento →
// chiusura buchi → colori → solido Manifold → base → taglio per il piatto →
// disposizione → controllo pareti → 3MF.
import { getManifold } from "./manifold";
import {
  dedupeTriangles,
  fillHoles,
  orientConsistently,
  propagateLabels,
  toPrintSpace,
  UNSET_LABEL,
  weld,
  type PrintMesh,
} from "./meshOps";
import { quantizeColors, smoothLabels, toHex } from "./colors";
import {
  addBase,
  makeMagnet,
  packPlates,
  splitToPlate,
  toManifold,
  toPrintMesh,
  type BaseOptions,
  type MagnetOptions,
  type Placed,
  type Plate,
} from "./solid";
import { build3mf, build3mfPerPlate } from "./threemf";
import { voxelRemesh } from "./remesh";
import { wallThickness, type WallReport } from "./wall";

export interface PrintInput {
  /** triangoli in coordinate scena (Y in alto), 9 valori per triangolo */
  soup: Float32Array;
  /** colore rgb 0..1 per triangolo (facoltativo) */
  triColor?: Float32Array;
}

export interface PrintOptions {
  longestMm: number;
  /** numero di filamenti: 1 = monocolore */
  colors: number;
  base: BaseOptions | null;
  /** colore della base: indice nella tavolozza, oppure "nuovo" = filamento aggiuntivo grigio scuro */
  baseColor?: number | "nuovo";
  plate: Plate;
  name: string;
  /** perni di allineamento sui tagli (predefinito: sì) */
  connectors?: boolean;
  /** calamita da frigo: retro piatto con sede per il magnete (esclude la base) */
  magnet?: MagnetOptions | null;
}

export interface PrintReport {
  holesFilled: number;
  holesSkipped: number;
  facesFlipped: number;
  pieces: number;
  /** il modello è stato rifuso con i voxel perché non era riparabile */
  rebuilt: boolean;
  /** perni di allineamento da stampare */
  pins: number;
  plates: number;
  fitsPlate: boolean;
  volumeCm3: number;
  wall: WallReport;
  warnings: string[];
}

export interface PrintOutput {
  placed: Placed[];
  palette: string[];
  report: PrintReport;
  file3mf: Uint8Array;
  /** con più piatti: zip con un 3MF per piatto */
  platesZip: Uint8Array | null;
}

export type Progress = (stage: string) => void;

const tick = () => new Promise((r) => setTimeout(r, 0));

export async function preparePrint(input: PrintInput, opts: PrintOptions, onStage: Progress = () => {}): Promise<PrintOutput> {
  const warnings: string[] = [];
  onStage("Conversione in millimetri");
  await tick();
  const triCount = input.soup.length / 9;
  const soupMm = toPrintSpace(input.soup, opts.longestMm);

  // colori: un'etichetta per triangolo della zuppa
  let palette: string[] = ["#c8c8cc"];
  let labels: Uint16Array | undefined;
  if (input.triColor && opts.colors > 1) {
    onStage("Riduzione dei colori");
    await tick();
    const areas = new Float32Array(triCount);
    for (let t = 0; t < triCount; t++) {
      const o = t * 9;
      const ux = soupMm[o + 3] - soupMm[o], uy = soupMm[o + 4] - soupMm[o + 1], uz = soupMm[o + 5] - soupMm[o + 2];
      const vx = soupMm[o + 6] - soupMm[o], vy = soupMm[o + 7] - soupMm[o + 1], vz = soupMm[o + 8] - soupMm[o + 2];
      areas[t] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    const q = quantizeColors(input.triColor, areas, opts.colors);
    labels = q.labels;
    palette = q.palette.map(toHex);
    if (palette.length < opts.colors) {
      warnings.push(
        palette.length === 1
          ? "Il modello ha un solo colore: stampa monocolore"
          : `Il modello ha solo ${palette.length} colori distinti: uso ${palette.length} filamenti`,
      );
    }
  } else if (input.triColor) {
    // monocolore: colore medio del modello come anteprima
    let r = 0, g = 0, b = 0;
    for (let t = 0; t < triCount; t++) {
      r += input.triColor[t * 3]; g += input.triColor[t * 3 + 1]; b += input.triColor[t * 3 + 2];
    }
    palette = [toHex([r / triCount, g / triCount, b / triCount])];
  }

  onStage("Riparazione della mesh");
  await tick();
  const w = await getManifold();
  let mesh: PrintMesh = dedupeTriangles(weld(soupMm, labels ?? new Uint16Array(triCount)));
  const oriented = orientConsistently(mesh);
  mesh = oriented.mesh;
  const filled = fillHoles(mesh, (polys) => w.triangulate(polys) as [number, number, number][]);
  mesh = filled.mesh;
  propagateLabels(mesh, (l) => l === UNSET_LABEL, 50);
  if (mesh.label) for (let t = 0; t < mesh.label.length; t++) if (mesh.label[t] === UNSET_LABEL) mesh.label[t] = 0;
  // i triangoli dei buchi chiusi potrebbero essere girati rispetto al resto
  mesh = orientConsistently(mesh).mesh;
  if (palette.length > 1) smoothLabels(mesh, 3);

  onStage("Costruzione del solido");
  await tick();
  let tracked: ReturnType<typeof toManifold>;
  let rebuilt = false;
  try {
    tracked = toManifold(w, mesh);
  } catch {
    // superfici che si incrociano o spigoli condivisi da 3+ facce (frequente
    // nei modelli AI): si rifonde il modello come un solido unico
    onStage("Ricostruzione del solido");
    await tick();
    const r = voxelRemesh(w, mesh);
    tracked = toManifold(w, r.mesh);
    rebuilt = true;
    warnings.push(
      `Il modello aveva superfici che si incrociano: l'ho ricostruito come un solido unico (dettagli sotto ${r.cellMm.toFixed(1).replace(".", ",")} mm leggermente smussati)`,
    );
  }

  let baseLabel = 0;
  if (opts.magnet) {
    onStage("Retro piatto e sede del magnete");
    await tick();
    const m = makeMagnet(w, tracked, opts.magnet);
    tracked = m.tracked;
    if (m.warning) warnings.push(m.warning);
  } else if (opts.base) {
    if (opts.baseColor === "nuovo" || (opts.baseColor === undefined && palette.length > 1)) {
      baseLabel = palette.length;
      palette = [...palette, "#2b2b2e"];
    } else if (typeof opts.baseColor === "number") {
      baseLabel = Math.min(opts.baseColor, palette.length - 1);
    }
    onStage("Aggiunta della base");
    await tick();
    tracked = addBase(w, tracked, opts.base, baseLabel);
  }
  const volumeCm3 = tracked.solid.volume() / 1000;

  onStage("Adattamento al piatto");
  await tick();
  const split = splitToPlate(w, tracked.solid, opts.plate, opts.connectors !== false);
  const pieces = split.pieces.map((s) => toPrintMesh(s, tracked.modelRun, tracked.baseRun, baseLabel));
  const pins = split.pins.map((s) => toPrintMesh(s, tracked.modelRun, tracked.baseRun, baseLabel));
  const { placed, plates, fits } = packPlates(
    [...pieces.map((mesh) => ({ mesh })), ...pins.map((mesh) => ({ mesh, pin: true }))],
    opts.plate,
  );
  if (pieces.length > 1) {
    warnings.push(
      pins.length
        ? `Il modello è più grande del piatto: diviso in ${pieces.length} pezzi con ${pins.length} perni di allineamento. Infila i perni nei fori e incolla`
        : `Il modello è più grande del piatto: diviso in ${pieces.length} pezzi da incollare`,
    );
  }
  if (split.cutsWithoutPins > 0 && opts.connectors !== false) {
    warnings.push(`${split.cutsWithoutPins} ${split.cutsWithoutPins === 1 ? "taglio è troppo sottile" : "tagli sono troppo sottili"} per i perni: lì solo colla`);
  }
  if (plates > 1) warnings.push(`Servono ${plates} piatti: nel 3MF li trovi già divisi, oppure scarica un file per piatto`);
  if (!fits) warnings.push("Un pezzo è più grande del piatto: controlla la misura della stampante");
  if (palette.length > 4) warnings.push(`${palette.length} filamenti: servono più AMS (o un cambio manuale)`);

  onStage("Controllo dello spessore delle pareti");
  await tick();
  // spessore misurato sul pezzo più grande (di solito rappresentativo)
  const biggest = (pieces.length ? pieces : pins).reduce((a, b) => (b.tri.length > a.tri.length ? b : a));
  const wall = wallThickness(biggest);
  if (wall.thinShare > 0.02) {
    warnings.push(
      `Pareti sottili: il ${Math.round(wall.thinShare * 100)}% della superficie è sotto ${wall.thresholdMm} mm. Ingrandisci la stampa o rinforza quei punti`,
    );
  }
  if (filled.skipped > 0 && !rebuilt) warnings.push(`${filled.skipped} buchi complessi non chiusi automaticamente`);

  onStage("Scrittura del file 3MF");
  await tick();
  const file3mf = build3mf(placed, { palette, name: opts.name, plate: opts.plate });
  const platesZip = plates > 1 ? build3mfPerPlate(placed, { palette, name: opts.name, plate: opts.plate }) : null;

  return {
    placed,
    palette,
    file3mf,
    platesZip,
    report: {
      holesFilled: filled.holes,
      holesSkipped: filled.skipped,
      facesFlipped: oriented.flipped,
      pieces: pieces.length,
      rebuilt,
      pins: pins.length,
      plates,
      fitsPlate: fits,
      volumeCm3,
      wall,
      warnings,
    },
  };
}
