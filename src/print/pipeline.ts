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
  type BaseDecor,
  type BaseOptions,
  type MagnetOptions,
  type Placed,
  type Plate,
} from "./solid";
import { build3mf, build3mfPerPlate } from "./threemf";
import { voxelRemesh } from "./remesh";
import { wallThickness, type WallReport } from "./wall";
import { decorSection, loadFont, type DecorOptions } from "./decor";
import { minWallMm, reinforceThin, removeFragments, type FragmentReport, type ReinforceReport } from "./strength";

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
  /** diametro dell'ugello, mm (predefinito 0,4): la parete minima è il doppio */
  nozzleMm?: number;
  /** ispessisce le pareti troppo sottili (predefinito: sì) */
  reinforce?: boolean;
  /** testo e/o logo sulla base, davanti al modello */
  decor?: DecorOptions | null;
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
  fragments: FragmentReport;
  reinforced: ReinforceReport;
  nozzleMm: number;
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

  onStage("Controllo delle parti staccate");
  await tick();
  const frag = removeFragments(w, tracked);
  tracked = frag.tracked;
  if (frag.report.removed > 0) {
    warnings.push(`Tolti ${frag.report.removed} ${frag.report.removed === 1 ? "frammento staccato troppo piccolo" : "frammenti staccati troppo piccoli"} per essere stampati`);
  }
  if (frag.report.detached > 0) {
    warnings.push(
      `${frag.report.detached} ${frag.report.detached === 1 ? "parte è staccata" : "parti sono staccate"} dal corpo principale: ${opts.base ? "se non toccano la base, " : ""}lo slicer ${frag.report.detached === 1 ? "la stampa" : "le stampa"} come pezzi separati con i supporti`,
    );
  }

  const nozzleMm = opts.nozzleMm ?? 0.4;
  const minWall = minWallMm(nozzleMm);
  let reinforced: ReinforceReport = { share: 0, maxPushMm: 0, applied: false };
  if (opts.reinforce !== false) {
    onStage("Rinforzo delle parti sottili");
    await tick();
    const r = reinforceThin(w, tracked, minWall);
    tracked = r.tracked;
    reinforced = r.report;
    if (reinforced.applied) {
      const pct = reinforced.share * 100;
      warnings.push(
        `Rinforzate le parti sottili (${pct < 1 ? "meno dell'1" : Math.round(pct)}% della superficie, al massimo +${reinforced.maxPushMm.toFixed(2).replace(".", ",")} mm per lato) per arrivare a ${String(minWall).replace(".", ",")} mm con l'ugello da ${String(nozzleMm).replace(".", ",")}`,
      );
    }
  }

  let baseLabel = 0;
  let decorLabel = 0;
  if (opts.magnet) {
    onStage("Retro piatto e sede del magnete");
    await tick();
    const m = makeMagnet(w, tracked, opts.magnet);
    tracked = m.tracked;
    if (m.warning) warnings.push(m.warning);
  } else if (opts.base) {
    if (opts.baseColor === undefined && palette.length >= 4) {
      // un AMS ha 4 slot: la base usa il colore più scuro già presente
      // invece di chiedere un quinto filamento
      let dark = 0, darkL = Infinity;
      palette.forEach((hex, i) => {
        const v = parseInt(hex.slice(1), 16);
        const l = 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
        if (l < darkL) { darkL = l; dark = i; }
      });
      baseLabel = dark;
    } else if (opts.baseColor === "nuovo" || (opts.baseColor === undefined && palette.length > 1)) {
      baseLabel = palette.length;
      palette = [...palette, "#2b2b2e"];
    } else if (typeof opts.baseColor === "number") {
      baseLabel = Math.min(opts.baseColor, palette.length - 1);
    }
    let decor: BaseDecor | null = null;
    if (opts.decor && (opts.decor.text.trim() || opts.decor.logoSvg)) {
      onStage("Testo e logo");
      await tick();
      const font = opts.decor.text.trim() ? await loadFont(opts.decor.font) : null;
      const section = decorSection(w, font, opts.decor);
      if (section) decor = { section, mode: opts.decor.mode, depthMm: opts.decor.depthMm ?? (opts.decor.mode === "rilievo" ? 0.8 : 0.6) };
      else warnings.push("Il logo non contiene forme piene: usa un SVG con riempimento, non solo contorni");
    }
    onStage("Aggiunta della base");
    await tick();
    tracked = addBase(w, tracked, opts.base, baseLabel, decor);
    if (decor && tracked.decorRun == null) warnings.push("Non c'è spazio sulla base per il testo: aumenta la misura o usa la base quadrata");
    if (decor && tracked.decorRun != null) {
      if (opts.decor?.color === "contrasto") {
        // filamento in più: chiaro su base scura, scuro su base chiara
        const v = parseInt(palette[baseLabel].slice(1), 16);
        const lum = 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
        decorLabel = palette.length;
        palette = [...palette, lum < 128 ? "#f2f2f2" : "#1c1c1e"];
      } else {
        decorLabel = baseLabel;
      }
    }
  }
  const volumeCm3 = tracked.solid.volume() / 1000;

  onStage("Adattamento al piatto");
  await tick();
  const split = splitToPlate(w, tracked.solid, opts.plate, opts.connectors !== false);
  const extra = [{ run: tracked.decorRun, label: decorLabel }];
  const pieces = split.pieces.map((s) => toPrintMesh(s, tracked.modelRun, tracked.baseRun, baseLabel, extra));
  const pins = split.pins.map((s) => toPrintMesh(s, tracked.modelRun, tracked.baseRun, baseLabel, extra));
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
  const wall = wallThickness(biggest, minWall);
  if (wall.thinShare > 0.02) {
    warnings.push(
      reinforced.applied
        ? `Restano pareti sottili sul ${Math.round(wall.thinShare * 100)}% della superficie (sotto ${String(wall.thresholdMm).replace(".", ",")} mm): ingrandisci la stampa o usa un ugello più fine`
        : `Pareti sottili: il ${Math.round(wall.thinShare * 100)}% della superficie è sotto ${String(wall.thresholdMm).replace(".", ",")} mm. Attiva il rinforzo, ingrandisci la stampa o usa un ugello più fine`,
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
      fragments: frag.report,
      reinforced,
      nozzleMm,
      warnings,
    },
  };
}
