// Pannello "Stampa 3D": dal modello nel viewport a un 3MF pronto per lo
// slicer, con riparazione, colori per filamento, base e taglio per il piatto.
import { useState } from "react";
import { dimsMm, fmtMm, longestFor, valueFor, type Axis, type SceneSize } from "@/print/dimensions";
import { CircleAlert, CircleCheck, Download, Gift, Loader2, Magnet, PawPrint, Printer, User } from "lucide-react";
import { toast } from "sonner";
import { Slider } from "@/components/ui/slider";
import type { PrintInput, PrintOutput } from "@/print/pipeline";
import type { Plate } from "@/print/solid";

const PRINTERS: { id: string; label: string; plate: Plate }[] = [
  { id: "a1mini", label: "Bambu Lab A1 mini", plate: { x: 180, y: 180, z: 180 } },
  { id: "bambu256", label: "Bambu Lab A1 / P1S / X1C", plate: { x: 256, y: 256, z: 256 } },
  { id: "mk4s", label: "Prusa MK4S", plate: { x: 250, y: 210, z: 220 } },
  { id: "k1c", label: "Creality K1C", plate: { x: 220, y: 220, z: 250 } },
  { id: "custom", label: "Personalizzata", plate: { x: 200, y: 200, z: 200 } },
];

type BaseShape = "nessuna" | "tonda" | "quadrata";

/** Modelli pronti: un clic imposta misura, colori e base giusti per il prodotto */
const TEMPLATES: {
  id: string;
  label: string;
  hint: string;
  icon: typeof User;
  sizeMm: number;
  colors: number;
  base: BaseShape;
  baseH: number;
  magnet: boolean;
}[] = [
  { id: "statuina", label: "Statuina", hint: "12 cm · base tonda", icon: User, sizeMm: 120, colors: 4, base: "tonda", baseH: 4, magnet: false },
  { id: "animale", label: "Animale", hint: "9 cm · base tonda", icon: PawPrint, sizeMm: 90, colors: 4, base: "tonda", baseH: 3, magnet: false },
  { id: "regalo", label: "Regalo", hint: "15 cm · base quadrata", icon: Gift, sizeMm: 150, colors: 4, base: "quadrata", baseH: 6, magnet: false },
  { id: "calamita", label: "Calamita", hint: "5,5 cm · retro piatto", icon: Magnet, sizeMm: 55, colors: 4, base: "nessuna", baseH: 3, magnet: true },
];

const MAGNET = { diameterMm: 10, depthMm: 3 };

interface Props {
  hasModel: boolean;
  name: string;
  sizeMm: number;
  onSizeMm: (mm: number) => void;
  getInput: () => PrintInput | null;
  /** ingombro del modello nella scena (Y in alto), per le misure reali */
  modelSize: SceneSize | null;
}

function download(data: Uint8Array, name: string, type = "model/3mf") {
  const blob = new Blob([new Uint8Array(data)], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function PrintPanel({ hasModel, name, sizeMm, onSizeMm, getInput, modelSize }: Props) {
  const [axis, setAxis] = useState<Axis>("altezza");
  const [printerId, setPrinterId] = useState("bambu256");
  const [custom, setCustom] = useState<Plate>({ x: 200, y: 200, z: 200 });
  const [colors, setColors] = useState(4);
  const [base, setBase] = useState<BaseShape>("tonda");
  const [baseH, setBaseH] = useState(4);
  const [magnet, setMagnet] = useState(false);
  const [connectors, setConnectors] = useState(true);
  const [nozzle, setNozzle] = useState(0.4);
  const [reinforce, setReinforce] = useState(true);
  const [template, setTemplate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [result, setResult] = useState<(PrintOutput & { preview: string }) | null>(null);

  const plate = printerId === "custom" ? custom : PRINTERS.find((p) => p.id === printerId)!.plate;

  function applyTemplate(t: (typeof TEMPLATES)[number]) {
    setTemplate(t.id);
    onSizeMm(t.sizeMm);
    setColors(t.colors);
    setBase(t.base);
    setBaseH(t.baseH);
    setMagnet(t.magnet);
    setResult(null);
  }

  async function handlePrepare() {
    const input = getInput();
    if (!input) {
      toast.error("Carica prima un modello");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      // moduli pesanti caricati solo quando servono
      const [{ preparePrint }, { renderPrintPreview }] = await Promise.all([
        import("@/print/pipeline"),
        import("@/print/preview"),
      ]);
      const out = await preparePrint(
        input,
        {
          longestMm: sizeMm,
          colors,
          base: base === "nessuna" || magnet ? null : { shape: base, heightMm: baseH },
          magnet: magnet ? MAGNET : null,
          connectors,
          nozzleMm: nozzle,
          reinforce,
          plate,
          name: name || "modello",
        },
        setStage,
      );
      setStage("Anteprima");
      const preview = renderPrintPreview(out.placed, out.palette, plate);
      setResult({ ...out, preview });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Preparazione non riuscita");
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  if (!hasModel) {
    return (
      <div className="p-5 text-sm leading-relaxed text-[#525252]">
        Carica un modello dalla galleria o generane uno: qui lo prepari per la stampa 3D, anche a
        più colori.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-5">
      <div>
        <h2 className="flex items-center gap-2 font-display text-xl tracking-tight text-[#171717]">
          <Printer className="size-5" /> Pronto da stampare
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-[#525252]">
          Ripara il modello, lo divide in colori per filamento, aggiunge la base e lo adatta al tuo
          piatto. Esce un 3MF che apri direttamente in Bambu Studio, OrcaSlicer o PrusaSlicer.
        </p>
      </div>

      <Field label="Che cosa stampi">
        <div className="grid grid-cols-2 gap-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={template === t.id}
              onClick={() => applyTemplate(t)}
              className={`flex items-center gap-2 border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] ${
                template === t.id ? "border-[#171717] bg-[#171717] text-white" : "border-[#d4d4d4] text-[#171717] hover:bg-[#ededed]"
              }`}
            >
              <t.icon className="size-4 shrink-0" />
              <span className="flex flex-col leading-tight">
                <span className="text-xs font-medium">{t.label}</span>
                <span className={`text-[10px] ${template === t.id ? "text-white/70" : "text-[#6f6f6f]"}`}>{t.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Stampante">
        <select
          value={printerId}
          onChange={(e) => setPrinterId(e.target.value)}
          className="h-9 w-full border border-[#d4d4d4] bg-transparent px-2 text-sm focus-visible:border-[#ff670d] focus-visible:outline-none"
        >
          {PRINTERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.id !== "custom" ? ` — ${p.plate.x}×${p.plate.y}×${p.plate.z} mm` : ""}
            </option>
          ))}
        </select>
        {printerId === "custom" && (
          <div className="mt-2 grid grid-cols-3 gap-2">
            {(["x", "y", "z"] as const).map((k) => (
              <label key={k} className="flex items-center gap-1 text-xs text-[#525252]">
                {k.toUpperCase()}
                <input
                  type="number"
                  min={50}
                  max={1000}
                  value={custom[k]}
                  onChange={(e) => setCustom({ ...custom, [k]: Math.max(50, Number(e.target.value) || 50) })}
                  className="h-8 w-full border border-[#d4d4d4] bg-transparent px-1.5 text-right text-sm tabular-nums"
                  aria-label={`Piatto ${k.toUpperCase()} in mm`}
                />
              </label>
            ))}
          </div>
        )}
      </Field>

      <Field label="Misure reali">
        <SizeControl
          size={modelSize}
          axis={axis}
          onAxis={setAxis}
          longestMm={sizeMm}
          onLongest={(mm) => { onSizeMm(Math.round(Math.min(600, Math.max(10, mm)) * 10) / 10); setTemplate(null); }}
        />
      </Field>

      <Field label={colors === 1 ? "Colori: monocolore" : `Colori: ${colors} filamenti`}>
        <Slider value={[colors]} min={1} max={8} step={1} onValueChange={(v) => setColors(v[0])} aria-label="Numero di filamenti" />
        <p className="mt-1.5 text-[11px] text-[#6f6f6f]">Un AMS ha 4 slot. Con la base colorata si aggiunge un filamento.</p>
      </Field>

      <Field label="Base">
        {magnet ? (
          <div className="flex items-start justify-between gap-3 border border-[#d4d4d4] px-3 py-2 text-xs leading-snug text-[#171717]">
            <span>
              Calamita: retro piatto con sede per magnete Ø{MAGNET.diameterMm}×{MAGNET.depthMm} mm (si incolla dopo la stampa)
            </span>
            <button type="button" onClick={() => { setMagnet(false); setTemplate(null); }} className="shrink-0 text-[11px] uppercase tracking-widest text-[#ff670d] hover:underline">
              Togli
            </button>
          </div>
        ) : (
        <>
        <div className="grid grid-cols-3 border border-[#d4d4d4]">
          {(["nessuna", "tonda", "quadrata"] as BaseShape[]).map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={base === b}
              onClick={() => { setBase(b); setTemplate(null); }}
              className={`px-1 py-2 text-[11px] uppercase tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff670d] ${
                base === b ? "bg-[#171717] text-white" : "text-[#6f6f6f] hover:bg-[#ededed]"
              }`}
            >
              {b}
            </button>
          ))}
        </div>
        {base !== "nessuna" && (
          <div className="mt-2">
            <Slider value={[baseH]} min={2} max={15} step={0.5} onValueChange={(v) => setBaseH(v[0])} aria-label="Altezza base in millimetri" />
            <p className="mt-1 text-[11px] text-[#6f6f6f]">Spessore base: {baseH} mm</p>
          </div>
        )}
        </>
        )}
      </Field>

      <Field label={`Ugello: ${String(nozzle).replace(".", ",")} mm · parete minima ${String(Math.round(nozzle * 200) / 100).replace(".", ",")} mm`}>
        <div className="grid grid-cols-4 border border-[#d4d4d4]">
          {[0.2, 0.4, 0.6, 0.8].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={nozzle === n}
              onClick={() => setNozzle(n)}
              className={`px-1 py-2 text-[11px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff670d] ${
                nozzle === n ? "bg-[#171717] text-white" : "text-[#6f6f6f] hover:bg-[#ededed]"
              }`}
            >
              {String(n).replace(".", ",")}
            </button>
          ))}
        </div>
      </Field>

      <label className="flex cursor-pointer items-start gap-2.5 text-xs leading-snug text-[#171717]">
        <input
          type="checkbox"
          checked={reinforce}
          onChange={(e) => setReinforce(e.target.checked)}
          className="mt-0.5 size-4 accent-[#ff670d]"
        />
        <span>
          Rinforza le parti sottili
          <span className="block text-[11px] text-[#6f6f6f]">
            Ispessisce solo le pareti più sottili di quanto l'ugello riesce a stampare: antenne, dita, orecchie non spariscono più.
          </span>
        </span>
      </label>

      <label className="flex cursor-pointer items-start gap-2.5 text-xs leading-snug text-[#171717]">
        <input
          type="checkbox"
          checked={connectors}
          onChange={(e) => setConnectors(e.target.checked)}
          className="mt-0.5 size-4 accent-[#ff670d]"
        />
        <span>
          Incastri sui tagli
          <span className="block text-[11px] text-[#6f6f6f]">
            Se il modello va diviso in pezzi, aggiunge fori e perni di allineamento: i pezzi si incollano dritti.
          </span>
        </span>
      </label>

      <button
        type="button"
        disabled={busy}
        onClick={() => void handlePrepare()}
        className="flex h-12 items-center justify-center gap-2 bg-[#ff670d] text-sm font-medium uppercase tracking-[0.18em] text-white transition-transform hover:bg-[#e85c0b] active:scale-[0.98] disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Printer className="size-4" />}
        {busy ? stage || "Preparazione…" : "Prepara la stampa"}
      </button>

      {result && (
        <div className="flex flex-col gap-3">
          <img src={result.preview} alt="Anteprima dei pezzi sul piatto" className="w-full border border-[#e4e4e4]" />
          <div className="flex flex-col gap-1.5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#525252]">Filamenti (slot AMS)</div>
            <div className="flex flex-wrap gap-2">
              {result.palette.map((hex, i) => (
                <span key={i} className="flex items-center gap-1.5 border border-[#e4e4e4] px-2 py-1 text-xs">
                  <span className="size-4 rounded-full border border-black/10" style={{ background: hex }} />
                  {i + 1}
                  <span className="text-[#6f6f6f]">{hex.toUpperCase()}</span>
                </span>
              ))}
            </div>
          </div>
          <ul className="flex flex-col gap-1 text-xs text-[#171717]">
            <li className="flex items-center gap-1.5">
              <CircleCheck className="size-3.5 text-emerald-600" />
              Solido chiuso
              {result.report.holesFilled > 0 && ` · ${result.report.holesFilled} buchi riparati`}
              {result.report.facesFlipped > 0 && ` · ${result.report.facesFlipped.toLocaleString("it-IT")} facce raddrizzate`}
            </li>
            <li className="flex items-center gap-1.5">
              <CircleCheck className="size-3.5 text-emerald-600" />
              Volume {result.report.volumeCm3.toFixed(1)} cm³ · {result.report.pieces} {result.report.pieces === 1 ? "pezzo" : "pezzi"}
              {result.report.pins > 0 && ` + ${result.report.pins} perni`}
              {result.report.plates > 1 && ` · ${result.report.plates} piatti`}
            </li>
            <li className="flex items-center gap-1.5">
              {result.report.wall.thinShare > 0.02 ? (
                <CircleAlert className="size-3.5 text-amber-600" />
              ) : (
                <CircleCheck className="size-3.5 text-emerald-600" />
              )}
              Parete più sottile ≈ {Number.isFinite(result.report.wall.minMm) ? result.report.wall.minMm.toFixed(1).replace(".", ",") : "–"} mm
              {result.report.reinforced.applied && " · parti sottili rinforzate"}
            </li>
            <li className="flex items-center gap-1.5">
              {result.report.fragments.detached > 0 ? (
                <CircleAlert className="size-3.5 text-amber-600" />
              ) : (
                <CircleCheck className="size-3.5 text-emerald-600" />
              )}
              {result.report.fragments.detached > 0
                ? `${result.report.fragments.detached} ${result.report.fragments.detached === 1 ? "parte staccata" : "parti staccate"}`
                : "Un solo corpo, nessuna parte staccata"}
              {result.report.fragments.removed > 0 && ` · ${result.report.fragments.removed} briciole tolte`}
            </li>
          </ul>
          {result.report.warnings.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {result.report.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-900">
                  <CircleAlert className="mt-px size-3.5 shrink-0" />
                  {w}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => download(result.file3mf, `${(name || "modello").replace(/[^\p{L}\p{N} _-]/gu, "")}-${sizeMm}mm.3mf`)}
            className="flex h-11 items-center justify-center gap-2 border border-[#171717] text-[11px] font-medium uppercase tracking-[0.18em] text-[#171717] transition-all hover:bg-[#171717] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] active:scale-[0.98]"
          >
            <Download className="size-4" />
            {result.report.plates > 1 ? `Scarica 3MF (${result.report.plates} piatti)` : "Scarica 3MF"}
          </button>
          {result.platesZip && (
            <button
              type="button"
              onClick={() => download(result.platesZip!, `${(name || "modello").replace(/[^\p{L}\p{N} _-]/gu, "")}-${sizeMm}mm-piatti.zip`, "application/zip")}
              className="-mt-1 text-[11px] uppercase tracking-[0.18em] text-[#525252] underline-offset-4 hover:text-[#171717] hover:underline"
            >
              Oppure un file per piatto (.zip)
            </button>
          )}
          <p className="text-[11px] leading-relaxed text-[#6f6f6f]">
            Nello slicer assegna a ogni slot il filamento del colore indicato. Il materiale effettivo
            (peso, tempo) lo calcola lo slicer.
          </p>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-[#525252]">{label}</div>
      {children}
    </div>
  );
}

const AXES: { id: Axis; label: string }[] = [
  { id: "altezza", label: "Altezza" },
  { id: "larghezza", label: "Larghezza" },
  { id: "profondita", label: "Profondità" },
  { id: "lungo", label: "Lato lungo" },
];

/** Una misura nota (es. alta 120 mm) → scala; sotto, le tre misure risultanti. */
function SizeControl({
  size,
  axis,
  onAxis,
  longestMm,
  onLongest,
}: {
  size: SceneSize | null;
  axis: Axis;
  onAxis: (a: Axis) => void;
  longestMm: number;
  onLongest: (mm: number) => void;
}) {
  const s = size ?? { x: 1, y: 1, z: 1 };
  const value = valueFor(s, axis, longestMm);
  const [draft, setDraft] = useState<string | null>(null);
  const d = dimsMm(s, longestMm);
  const commit = (raw: string) => {
    const v = Number(raw.replace(",", "."));
    if (v > 0) onLongest(longestFor(s, axis, v));
    setDraft(null);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-4 border border-[#d4d4d4]">
        {AXES.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-pressed={axis === a.id}
            onClick={() => onAxis(a.id)}
            className={`px-1 py-2 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff670d] ${
              axis === a.id ? "bg-[#171717] text-white" : "text-[#6f6f6f] hover:bg-[#ededed]"
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Slider
          value={[value]}
          min={10}
          max={Math.max(50, valueFor(s, axis, 600))}
          step={1}
          onValueChange={(v) => onLongest(longestFor(s, axis, v[0]))}
          aria-label={`${AXES.find((a) => a.id === axis)!.label} in millimetri`}
          className="flex-1"
        />
        <label className="flex items-center gap-1 text-xs text-[#525252]">
          <input
            inputMode="decimal"
            value={draft ?? fmtMm(value)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commit((e.target as HTMLInputElement).value); }}
            className="h-8 w-16 border border-[#d4d4d4] bg-transparent px-1.5 text-right text-sm tabular-nums focus-visible:border-[#ff670d] focus-visible:outline-none"
            aria-label="Misura in millimetri"
          />
          mm
        </label>
      </div>
      <p className="text-[11px] tabular-nums text-[#3f3f3c]">
        {size
          ? <>L {fmtMm(d.larghezza)} × P {fmtMm(d.profondita)} × A {fmtMm(d.altezza)} mm <span className="text-[#6f6f6f]">(senza base)</span></>
          : "Le misure compaiono quando il modello è caricato"}
      </p>
    </div>
  );
}
