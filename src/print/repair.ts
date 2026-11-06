// Dalla zuppa di triangoli (già in mm, Z in alto) a un solido Manifold valido:
// saldatura → orientamento → chiusura buchi → solido, con ricostruzione a voxel
// se il modello ha superfici che si incrociano. Condiviso da Stampa e Building.
import type { ManifoldToplevel } from "manifold-3d";
import { dedupeTriangles, fillHoles, orientConsistently, propagateLabels, UNSET_LABEL, weld, type PrintMesh } from "./meshOps";
import { smoothLabels } from "./colors";
import { toManifold } from "./solid";
import { voxelRemesh } from "./remesh";

const tick = () => new Promise((r) => setTimeout(r, 0));

export interface RepairResult {
  tracked: ReturnType<typeof toManifold>;
  holesFilled: number;
  holesSkipped: number;
  facesFlipped: number;
  rebuilt: boolean;
  /** lato del voxel della ricostruzione, mm (solo se rebuilt) */
  cellMm: number;
}

export async function repairToSolid(
  w: ManifoldToplevel,
  soupMm: Float32Array,
  labels: Uint16Array | undefined,
  smoothColors: boolean,
  onStage: (s: string) => void = () => {},
): Promise<RepairResult> {
  const triCount = soupMm.length / 9;
  onStage("Riparazione della mesh");
  await tick();
  let mesh: PrintMesh = dedupeTriangles(weld(soupMm, labels ?? new Uint16Array(triCount)));
  const oriented = orientConsistently(mesh);
  mesh = oriented.mesh;
  const filled = fillHoles(mesh, (polys) => w.triangulate(polys) as [number, number, number][]);
  mesh = filled.mesh;
  propagateLabels(mesh, (l) => l === UNSET_LABEL, 50);
  if (mesh.label) for (let t = 0; t < mesh.label.length; t++) if (mesh.label[t] === UNSET_LABEL) mesh.label[t] = 0;
  // i triangoli dei buchi chiusi potrebbero essere girati rispetto al resto
  mesh = orientConsistently(mesh).mesh;
  if (smoothColors) smoothLabels(mesh, 3);

  onStage("Costruzione del solido");
  await tick();
  try {
    return { tracked: toManifold(w, mesh), holesFilled: filled.holes, holesSkipped: filled.skipped, facesFlipped: oriented.flipped, rebuilt: false, cellMm: 0 };
  } catch {
    // superfici che si incrociano o spigoli condivisi da 3+ facce (frequente
    // nei modelli AI): si rifonde il modello come un solido unico
    onStage("Ricostruzione del solido");
    await tick();
    const r = voxelRemesh(w, mesh);
    return { tracked: toManifold(w, r.mesh), holesFilled: filled.holes, holesSkipped: filled.skipped, facesFlipped: oriented.flipped, rebuilt: true, cellMm: r.cellMm };
  }
}
