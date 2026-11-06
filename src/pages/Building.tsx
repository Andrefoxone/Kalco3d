// Kalco3D Building: grandi stampe 3D (cemento, pellet/bracci robot, oppure
// stampanti normali a pezzi). Modello → misure reali → strati → sbalzi →
// preventivo → G-code o pezzi con istruzioni di montaggio.
import { useMemo, useState } from "react";
import { Link } from "react-router";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ArrowLeft, Building2, Download, FileText, Loader2, TriangleAlert, Upload } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Slider } from "@/components/ui/slider";
import { trpc } from "@/providers/trpc";
import { BuildingView, type ViewLayer, type ViewPiece } from "@/components/building/BuildingView";
import { CAD_ACCEPT, importCadFile } from "@/lib/cadImport";
import { extractPrintInput } from "@/print/sceneSample";
import type { PrintInput } from "@/print/pipeline";
import { MACHINES, machineById, type Estimate, type Machine, type Overhang, type Piece } from "@/building/engine";

type Src = { name: string; input: PrintInput; size: { x: number; y: number; z: number } };

interface PieceResult {
  piece: Piece;
  layers: ViewLayer[];
  layerStep: number;
  overhangs: Overhang[];
  estimate: Estimate;
}

interface Result {
  machine: Machine;
  name: string;
  sizeMm: [number, number, number];
  /** angolo minimo del modello montato (per le posizioni dei pezzi) */
  originMm: [number, number, number];
  pieces: PieceResult[];
  pins: Piece["solid"][];
  total: Estimate;
  warnings: string[];
}

const COLORS = ["#c9c3b8", "#ff8a3d", "#7fb3d5", "#9bc995", "#d9a7c7", "#e6c86e", "#8fd1c4", "#c7a27c"];
const tick = () => new Promise((r) => setTimeout(r, 0));
const nf = (n: number, d = 1) => n.toLocaleString("it-IT", { maximumFractionDigits: d });
const eur = (n: number) => n.toLocaleString("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

function sizeOfSoup(soup: Float32Array) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], soup[i + k]);
    max[k] = Math.max(max[k], soup[i + k]);
  }
  return { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] };
}

function segmentsOf(rings: [number, number][][], closed: boolean, z: number, out: number[]) {
  for (const r of rings) {
    const n = closed ? r.length : r.length - 1;
    for (let i = 0; i < n; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      out.push(p[0], p[1], z, q[0], q[1], z);
    }
  }
}

function geometryOf(solid: Piece["solid"]): THREE.BufferGeometry {
  const mesh = solid.getMesh();
  const np = mesh.numProp;
  const pos = new Float32Array((mesh.vertProperties.length / np) * 3);
  for (let i = 0, j = 0; i < mesh.vertProperties.length; i += np, j += 3) {
    pos[j] = mesh.vertProperties[i];
    pos[j + 1] = mesh.vertProperties[i + 1];
    pos[j + 2] = mesh.vertProperties[i + 2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.triVerts), 1));
  g.computeVertexNormals();
  return g;
}

function sumEstimates(list: Estimate[]): Estimate {
  const z: Estimate = { layers: 0, extrudeM: 0, travelM: 0, volumeM3: 0, kg: 0, hours: 0, materialCost: 0, machineCost: 0, total: 0 };
  for (const e of list) for (const k of Object.keys(z) as (keyof Estimate)[]) z[k] += e[k];
  return z;
}

function downloadBytes(data: Uint8Array | string, name: string, type: string) {
  const blob = new Blob([typeof data === "string" ? data : new Uint8Array(data)], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default function Building() {
  const models = trpc.models.list.useQuery(undefined, { staleTime: 30_000 });
  const ready = (models.data ?? []).filter((m) => m.status === "ready" && m.glbUrl);
  const [src, setSrc] = useState<Src | null>(null);
  const [loading, setLoading] = useState(false);
  const [machine, setMachine] = useState<Machine>(MACHINES[0]);
  const [heightM, setHeightM] = useState(2);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [sel, setSel] = useState(0);
  const [upTo, setUpTo] = useState(-1);

  const dims = useMemo(() => {
    if (!src) return null;
    const k = (heightM * 1000) / (src.size.y || 1);
    return { l: (src.size.x * k) / 1000, p: (src.size.z * k) / 1000, a: heightM };
  }, [src, heightM]);

  /** unit: unità del file (i CAD sono in mm, i modelli AI in metri) per proporre l'altezza reale */
  async function loadObject(object: THREE.Object3D, name: string, unit: "mm" | "m") {
    const input = extractPrintInput(object);
    if (!input || input.soup.length === 0) throw new Error("Il file non contiene superfici");
    const size = sizeOfSoup(input.soup);
    const h = unit === "mm" ? size.y / 1000 : size.y;
    if (h >= 0.05 && h <= 50) setHeightM(Math.round(h * 100) / 100);
    setSrc({ name, input, size });
    setResult(null);
    setUpTo(-1);
  }

  /** Ruota il modello di 90° (asse X: lo alza o lo corica; asse Y: lo gira sul piano). */
  function rotate(axis: "x" | "z") {
    if (!src) return;
    const s2 = new Float32Array(src.input.soup);
    for (let i = 0; i < s2.length; i += 3) {
      const x = s2[i], y = s2[i + 1], z = s2[i + 2];
      if (axis === "x") { s2[i + 1] = -z; s2[i + 2] = y; }
      else { s2[i] = z; s2[i + 2] = -x; }
    }
    setSrc({ ...src, input: { ...src.input, soup: s2 }, size: sizeOfSoup(s2) });
    setResult(null);
    setUpTo(-1);
  }

  async function fromGallery(id: number) {
    const m = ready.find((x) => x.id === id);
    if (!m?.glbUrl) return;
    setLoading(true);
    try {
      const gltf = await new GLTFLoader().loadAsync(m.glbUrl);
      await loadObject(gltf.scene, m.name, "m");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Non riesco ad aprire il modello");
    } finally {
      setLoading(false);
    }
  }

  async function fromFile(file: File) {
    setLoading(true);
    try {
      const name = file.name.replace(/\.[^.]+$/, "");
      if (/\.glb$/i.test(file.name)) {
        const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), "");
        await loadObject(gltf.scene, name, "m");
      } else {
        const r = await importCadFile(file);
        await loadObject(r.object, name, "mm");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "File non leggibile");
    } finally {
      setLoading(false);
    }
  }

  function setMachineField<K extends keyof Machine>(k: K, v: Machine[K]) {
    setMachine((m) => ({ ...m, [k]: v, id: "personalizzata" }));
    setResult(null);
  }

  async function compute() {
    if (!src) return;
    setBusy(true);
    setResult(null);
    setUpTo(-1);
    try {
      const [{ getManifold }, { toPrintSpace }, { repairToSolid }, { removeFragments }, { splitToPlate }, eng] = await Promise.all([
        import("@/print/manifold"),
        import("@/print/meshOps"),
        import("@/print/repair"),
        import("@/print/strength"),
        import("@/print/solid"),
        import("@/building/engine"),
      ]);
      const warnings: string[] = [];
      const w = await getManifold();
      // altezza reale → lato più lungo per toPrintSpace
      const longest = (heightM * 1000 * Math.max(src.size.x, src.size.y, src.size.z)) / (src.size.y || 1);
      const soupMm = toPrintSpace(src.input.soup, longest);
      const repaired = await repairToSolid(w, soupMm, undefined, false, setStage);
      if (repaired.rebuilt) warnings.push("Il modello aveva superfici che si incrociano: ricostruito come solido unico");
      const solid = removeFragments(w, repaired.tracked).tracked.solid;
      const bb = solid.boundingBox();
      const sizeMm: [number, number, number] = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];

      let parts = [solid];
      let pins: Piece["solid"][] = [];
      if (!eng.fitsVolume(solid, machine)) {
        setStage("Divisione in pezzi");
        await tick();
        const split = splitToPlate(w, solid, machine.volume, machine.kind !== "cemento");
        parts = split.pieces;
        pins = split.pins;
        warnings.push(`Il modello non entra nella macchina: diviso in ${parts.length} pezzi${pins.length ? ` con ${pins.length} perni` : ""}`);
      }
      const pieces = eng.numberPieces(w, parts);

      const out: PieceResult[] = [];
      for (const p of pieces) {
        setStage(`Strati del pezzo ${p.index} di ${pieces.length}`);
        await tick();
        const sl = await eng.sliceLayers(p.solid, machine.layerMm, { maxLayers: pieces.length > 6 ? 120 : 300 });
        const paths = sl.layers.map((l) => ({ ...l, ...eng.layerPaths(l.section, machine, l.index) }));
        const overhangs = eng.findOverhangs(sl.layers, machine, sl.step);
        const ovByLayer = new Map(overhangs.map((o) => [o.layer, o]));
        const layers: ViewLayer[] = paths.map((l) => {
          const seg: number[] = [];
          segmentsOf(l.perimeters, true, l.z, seg);
          segmentsOf(l.infill, false, l.z, seg);
          const ov = ovByLayer.get(l.index);
          let over: Float32Array | null = null;
          if (ov) {
            const s2: number[] = [];
            segmentsOf(ov.rings, true, l.z + machine.layerMm * 0.2, s2);
            over = new Float32Array(s2);
          }
          return { paths: new Float32Array(seg), overhang: over };
        });
        out.push({ piece: p, layers, layerStep: sl.step, overhangs, estimate: eng.estimate(paths, machine, sl.step, sl.total) });
      }
      const ovLayers = out.reduce((s, r) => s + r.overhangs.length, 0);
      if (ovLayers > 0) warnings.push(`${ovLayers} strati hanno sbalzi oltre ${machine.maxOverhangDeg}° (in rosso nell'anteprima)`);
      setResult({ machine, name: src.name, sizeMm, originMm: [bb.min[0], bb.min[1], bb.min[2]], pieces: out, pins, total: sumEstimates(out.map((r) => r.estimate)), warnings });
      setSel(0);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Calcolo non riuscito");
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  async function downloadGcode() {
    if (!result) return;
    setBusy(true);
    try {
      const eng = await import("@/building/engine");
      const { zipSync, strToU8 } = await import("three/examples/jsm/libs/fflate.module.js");
      const files: Record<string, Uint8Array> = {};
      for (const r of result.pieces) {
        setStage(`G-code del pezzo ${r.piece.index}`);
        await tick();
        const sl = await eng.sliceLayers(r.piece.solid, result.machine.layerMm);
        const paths = sl.layers.map((l) => ({ ...l, ...eng.layerPaths(l.section, result.machine, l.index) }));
        const g = eng.toGcode(paths, result.machine, { name: `${result.name} — pezzo ${r.piece.index}`, origin: r.piece.min });
        files[`${result.name}-pezzo-${String(r.piece.index).padStart(2, "0")}.gcode`] = strToU8(g);
      }
      const names = Object.keys(files);
      if (names.length === 1) downloadBytes(files[names[0]], names[0], "text/plain");
      else downloadBytes(zipSync(files), `${result.name}-gcode.zip`, "application/zip");
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  async function downloadPieces() {
    if (!result) return;
    const { pieceStl } = await import("@/building/files");
    const { zipSync } = await import("three/examples/jsm/libs/fflate.module.js");
    const files: Record<string, Uint8Array> = {};
    for (const r of result.pieces) files[`${result.name}-pezzo-${String(r.piece.index).padStart(2, "0")}.stl`] = pieceStl(r.piece.solid);
    result.pins.forEach((p, i) => (files[`${result.name}-perno-${i + 1}.stl`] = pieceStl(p)));
    downloadBytes(zipSync(files), `${result.name}-pezzi-stl.zip`, "application/zip");
  }

  async function downloadInstructions() {
    if (!result) return;
    const { assemblyHtml } = await import("@/building/files");
    const html = assemblyHtml({
      name: result.name,
      machine: result.machine,
      sizeMm: result.sizeMm,
      pieces: result.pieces.map((r) => ({
        ...r.piece,
        min: [r.piece.min[0] - result.originMm[0], r.piece.min[1] - result.originMm[1], r.piece.min[2] - result.originMm[2]] as [number, number, number],
      })),
      estimate: result.total,
      overhangLayers: result.pieces.reduce((s, r) => s + r.overhangs.length, 0),
      pins: result.pins.length,
    });
    downloadBytes(html, `${result.name}-montaggio.html`, "text/html");
  }

  const viewPieces: ViewPiece[] = useMemo(() => {
    if (result) return result.pieces.map((r, i) => ({ geometry: geometryOf(r.piece.solid), color: COLORS[i % COLORS.length] }));
    if (!src) return [];
    // anteprima prima del calcolo: il modello com'è, Z in alto, in proporzione all'altezza scelta
    const soup = src.input.soup;
    const k = (heightM * 1000) / (src.size.y || 1);
    const pos = new Float32Array(soup.length);
    for (let i = 0; i < soup.length; i += 3) {
      pos[i] = soup[i] * k;
      pos[i + 1] = -soup[i + 2] * k;
      pos[i + 2] = soup[i + 1] * k;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return [{ geometry: g, color: COLORS[0] }];
  }, [result, src, heightM]);
  const current = result?.pieces[sel] ?? null;

  return (
    <div className="flex h-dvh flex-col bg-[#f7f7f5] font-mono text-[#171717]">
      <Toaster />
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[#e4e4e4] px-4 lg:px-6">
        <div className="flex items-baseline gap-2.5">
          <span className="inline-block size-2.5 rounded-full bg-[#ff670d]" aria-hidden="true" />
          <span className="font-display text-2xl leading-none tracking-tight">Kalco3D</span>
          <span className="text-[11px] uppercase tracking-[0.22em] text-[#ff670d]">Building</span>
        </div>
        <Link to="/" className="flex items-center gap-1.5 border border-[#d4d4d4] px-2 py-1 text-[11px] uppercase tracking-[0.16em] hover:bg-[#171717] hover:text-white">
          <ArrowLeft className="size-3.5" /> Studio
        </Link>
      </header>

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="relative h-[45vh] flex-none bg-[#1b1b1d] lg:h-auto lg:flex-1">
          <BuildingView
            pieces={viewPieces}
            layers={current?.layers ?? []}
            upTo={upTo}
            volume={src ? (result ? result.machine.volume : machine.volume) : null}
          />
          {!src && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-[#9a9aab]">
              <Building2 className="size-8" />
              <p className="max-w-sm text-sm">
                Scegli un modello dalla galleria o carica un file 3D.
              </p>
            </div>
          )}
          {current && current.layers.length > 1 && (
            <div className="absolute inset-x-4 bottom-4 flex items-center gap-3 bg-black/60 px-3 py-2 text-[11px] text-white">
              <button type="button" onClick={() => setUpTo(-1)} className={`shrink-0 uppercase tracking-wider ${upTo < 0 ? "text-[#ff670d]" : ""}`}>
                Modello
              </button>
              <Slider
                value={[Math.max(0, upTo)]}
                min={0}
                max={current.layers.length - 1}
                step={1}
                onValueChange={(v) => setUpTo(v[0])}
                aria-label="Strati mostrati"
                className="flex-1"
              />
              <span className="w-28 shrink-0 text-right tabular-nums">
                {upTo < 0 ? `${current.estimate.layers} strati` : `strato ${Math.min(current.estimate.layers, (upTo + 1) * current.layerStep)}`}
              </span>
            </div>
          )}
        </section>

        <aside className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto border-t border-[#e4e4e4] bg-[#fcfcfc] lg:w-[400px] lg:flex-none lg:border-l lg:border-t-0">
          <div className="flex flex-col gap-5 p-5">
            <div>
              <h1 className="font-display text-xl leading-tight tracking-tight">Grandi stampe 3D</h1>
              <p className="mt-1 text-xs leading-relaxed text-[#525252]">
                Sculture, arredo urbano, muri e case: strati, sbalzi, preventivo e G-code per la tua macchina, oppure pezzi da assemblare.
              </p>
            </div>

            <Section title="1 · Modello">
              <select
                value=""
                onChange={(e) => e.target.value && void fromGallery(Number(e.target.value))}
                className="h-9 w-full border border-[#d4d4d4] bg-transparent px-2 text-sm focus-visible:border-[#ff670d] focus-visible:outline-none"
                aria-label="Modello dalla galleria"
              >
                <option value="">{models.isLoading ? "Carico la galleria…" : models.isError ? "Galleria non disponibile" : "Dalla galleria Modelli…"}</option>
                {ready.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <label className="flex cursor-pointer items-center justify-center gap-2 border border-dashed border-[#bdbdbd] px-2 py-2 text-xs text-[#525252] hover:bg-[#f2f2f2]">
                <Upload className="size-3.5" /> Carica un file 3D (STL, OBJ, GLB, STEP, DXF…)
                <input
                  type="file"
                  accept={`${CAD_ACCEPT},.glb`}
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void fromFile(f);
                  }}
                />
              </label>
              {loading && <p className="flex items-center gap-2 text-xs text-[#525252]"><Loader2 className="size-3.5 animate-spin" /> Apro il modello…</p>}
              {src && !loading && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="mr-auto">Modello: <b>{src.name}</b></span>
                  <button type="button" onClick={() => rotate("x")} className="border border-[#d4d4d4] px-2 py-1 hover:bg-[#f2f2f2]">Alza / corica 90°</button>
                  <button type="button" onClick={() => rotate("z")} className="border border-[#d4d4d4] px-2 py-1 hover:bg-[#f2f2f2]">Gira 90°</button>
                </div>
              )}
            </Section>

            <Section title="2 · Macchina">
              <select
                value={MACHINES.some((m) => m.id === machine.id) ? machine.id : ""}
                onChange={(e) => { setMachine(machineById(e.target.value)); setResult(null); }}
                className="h-9 w-full border border-[#d4d4d4] bg-transparent px-2 text-sm focus-visible:border-[#ff670d] focus-visible:outline-none"
                aria-label="Tipo di macchina"
              >
                {!MACHINES.some((m) => m.id === machine.id) && <option value="">Personalizzata</option>}
                {MACHINES.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <div className="grid grid-cols-3 gap-2">
                <Num label="Volume X (m)" value={machine.volume.x / 1000} step={0.1} onChange={(v) => setMachineField("volume", { ...machine.volume, x: v * 1000 })} />
                <Num label="Volume Y (m)" value={machine.volume.y / 1000} step={0.1} onChange={(v) => setMachineField("volume", { ...machine.volume, y: v * 1000 })} />
                <Num label="Volume Z (m)" value={machine.volume.z / 1000} step={0.1} onChange={(v) => setMachineField("volume", { ...machine.volume, z: v * 1000 })} />
                <Num label="Ugello (mm)" value={machine.nozzleMm} step={0.1} onChange={(v) => setMachineField("nozzleMm", v)} />
                <Num label="Strato (mm)" value={machine.layerMm} step={0.1} onChange={(v) => setMachineField("layerMm", v)} />
                <Num label="Perimetri" value={machine.walls} step={1} onChange={(v) => setMachineField("walls", Math.max(1, Math.round(v)))} />
                <Num label="Velocità (mm/s)" value={machine.speedMmS} step={5} onChange={(v) => setMachineField("speedMmS", v)} />
                <Num label="Sbalzo max (°)" value={machine.maxOverhangDeg} step={1} onChange={(v) => setMachineField("maxOverhangDeg", v)} />
                <Num label="Passo zig-zag (mm)" value={machine.infillSpacingMm} step={5} onChange={(v) => setMachineField("infillSpacingMm", v)} />
                <Num label="Materiale (€/kg)" value={machine.material.costPerKg} step={0.01} onChange={(v) => setMachineField("material", { ...machine.material, costPerKg: v })} />
                <Num label="Densità (kg/m³)" value={machine.material.densityKgM3} step={10} onChange={(v) => setMachineField("material", { ...machine.material, densityKgM3: v })} />
                <Num label="Macchina (€/h)" value={machine.machineCostH} step={1} onChange={(v) => setMachineField("machineCostH", v)} />
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={machine.infill === "zigzag"}
                  onChange={(e) => setMachineField("infill", e.target.checked ? "zigzag" : "nessuno")}
                  className="size-4 accent-[#ff670d]"
                />
                Riempimento a zig-zag tra le pareti
              </label>
              <p className="text-[11px] text-[#6f6f6f]">Valori tipici di partenza: mettili uguali alla tua macchina e ai tuoi prezzi.</p>
            </Section>

            <Section title="3 · Misure reali">
              <div className="flex items-center gap-3">
                <Num label="Altezza (m)" value={heightM} step={0.05} onChange={(v) => { setHeightM(Math.max(0.05, v)); setResult(null); }} />
                {dims && (
                  <p className="text-xs tabular-nums text-[#3f3f3c]">
                    L {nf(dims.l, 2)} × P {nf(dims.p, 2)} × A {nf(dims.a, 2)} m
                  </p>
                )}
              </div>
            </Section>

            <button
              type="button"
              disabled={!src || busy}
              onClick={() => void compute()}
              className="flex h-12 items-center justify-center gap-2 bg-[#ff670d] text-sm font-medium uppercase tracking-[0.18em] text-white transition-colors hover:bg-[#e85c0b] disabled:opacity-40"
            >
              {busy ? <><Loader2 className="size-4 animate-spin" /> {stage || "Calcolo…"}</> : "Calcola strati e preventivo"}
            </button>

            {result && (
              <>
                <Section title="Preventivo">
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <dt className="text-[#525252]">Strati</dt><dd className="text-right tabular-nums">{nf(result.total.layers, 0)}</dd>
                    <dt className="text-[#525252]">Materiale</dt><dd className="text-right tabular-nums">{nf(result.total.volumeM3, 3)} m³ · {nf(result.total.kg, 0)} kg</dd>
                    <dt className="text-[#525252]">Tempo di stampa</dt><dd className="text-right tabular-nums">{nf(result.total.hours, 1)} ore</dd>
                    <dt className="text-[#525252]">Costo materiale</dt><dd className="text-right tabular-nums">{eur(result.total.materialCost)}</dd>
                    <dt className="text-[#525252]">Costo macchina</dt><dd className="text-right tabular-nums">{eur(result.total.machineCost)}</dd>
                    <dt className="font-medium">Totale stimato</dt><dd className="text-right font-medium tabular-nums">{eur(result.total.total)}</dd>
                  </dl>
                  <p className="text-[11px] text-[#6f6f6f]">Stima dai percorsi di stampa. Esclusi trasporto, posa, armature e finiture.</p>
                </Section>

                {result.warnings.length > 0 && (
                  <ul className="flex flex-col gap-1.5">
                    {result.warnings.map((wn, i) => (
                      <li key={i} className="flex items-start gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        <TriangleAlert className="mt-px size-3.5 shrink-0" /> {wn}
                      </li>
                    ))}
                  </ul>
                )}

                {result.pieces.length > 1 && (
                  <Section title={`Pezzi (${result.pieces.length})`}>
                    <div className="flex flex-wrap gap-1.5">
                      {result.pieces.map((r, i) => (
                        <button
                          key={r.piece.index}
                          type="button"
                          aria-pressed={sel === i}
                          onClick={() => { setSel(i); setUpTo(-1); }}
                          className={`flex items-center gap-1.5 border px-2 py-1 text-xs ${sel === i ? "border-[#171717] bg-[#171717] text-white" : "border-[#d4d4d4] hover:bg-[#f2f2f2]"}`}
                        >
                          <span className="inline-block size-2.5" style={{ background: COLORS[i % COLORS.length] }} aria-hidden="true" />
                          {r.piece.index}
                        </button>
                      ))}
                    </div>
                    {current && (
                      <p className="text-xs tabular-nums text-[#3f3f3c]">
                        Pezzo {current.piece.index}: {nf(current.piece.size[0] / 1000, 2)} × {nf(current.piece.size[1] / 1000, 2)} × {nf(current.piece.size[2] / 1000, 2)} m · {nf(current.estimate.hours, 1)} h
                        {current.overhangs.length > 0 && ` · ${current.overhangs.length} strati con sbalzi`}
                      </p>
                    )}
                  </Section>
                )}

                <Section title="Scarica">
                  {result.machine.kind !== "pezzi" && (
                    <button type="button" disabled={busy} onClick={() => void downloadGcode()} className="flex h-10 items-center justify-center gap-2 bg-[#171717] text-xs uppercase tracking-[0.16em] text-white hover:bg-[#ff670d] hover:text-[#171717] disabled:opacity-40">
                      <Download className="size-3.5" /> G-code{result.pieces.length > 1 ? ` (${result.pieces.length} pezzi, zip)` : ""}
                    </button>
                  )}
                  <button type="button" onClick={() => void downloadPieces()} className="flex h-10 items-center justify-center gap-2 border border-[#171717] text-xs uppercase tracking-[0.16em] hover:bg-[#171717] hover:text-white">
                    <Download className="size-3.5" /> {result.machine.kind === "pezzi" ? "Pezzi STL per il tuo slicer" : "Modelli STL dei pezzi"}
                  </button>
                  <button type="button" onClick={() => void downloadInstructions()} className="flex h-10 items-center justify-center gap-2 border border-[#d4d4d4] text-xs uppercase tracking-[0.16em] hover:bg-[#f2f2f2]">
                    <FileText className="size-3.5" /> Preventivo e istruzioni di montaggio
                  </button>
                  {result.machine.kind !== "pezzi" && (
                    <p className="text-[11px] text-[#6f6f6f]">G-code generico (G0/G1, millimetri): verificalo con il produttore della macchina prima di stampare.</p>
                  )}
                </Section>
              </>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[11px] uppercase tracking-[0.18em] text-[#525252]">{title}</h2>
      {children}
    </section>
  );
}

function Num({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    const v = Number(raw.replace(",", "."));
    if (Number.isFinite(v) && v > 0) onChange(v);
    setDraft(null);
  };
  return (
    <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-[#6f6f6f]">
      {label}
      <input
        inputMode="decimal"
        step={step}
        value={draft ?? String(Math.round(value * 1000) / 1000).replace(".", ",")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit((e.target as HTMLInputElement).value); }}
        className="h-8 w-full border border-[#d4d4d4] bg-transparent px-1.5 text-right text-sm normal-case tracking-normal text-[#171717] tabular-nums focus-visible:border-[#ff670d] focus-visible:outline-none"
      />
    </label>
  );
}
