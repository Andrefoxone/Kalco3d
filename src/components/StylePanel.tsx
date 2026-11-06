import { useState } from "react";
import { Camera, CircleAlert, CircleCheck, Download, Images, Loader2, Save, ScanSearch } from "lucide-react";
import type { PrintReport } from "@/three/printCheck";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { MATERIAL_PRESETS, findPresetId } from "@/lib/materialPresets";
import type {
  BackgroundPreset,
  CameraView,
  CapturedView,
  LightingPreset,
  MaterialStyle,
} from "@/three/scene";

interface Props {
  material: MaterialStyle;
  onMaterial: (m: MaterialStyle) => void;
  lighting: LightingPreset;
  onLighting: (l: LightingPreset) => void;
  background: BackgroundPreset;
  onBackground: (b: BackgroundPreset) => void;
  gridOn: boolean;
  onGrid: (on: boolean) => void;
  onView: (v: CameraView) => void;
  onCaptureViews: () => CapturedView[];
  hasModel: boolean;
  onSave: () => Promise<void>;
  onExportGLB: () => void;
  onExportSTL: () => void;
  onExportUSDZ: () => Promise<void>;
  sizeMm: number;
  onSizeMm: (mm: number) => void;
  sizeFromSource: boolean;
  printReport: PrintReport | null;
  onCheckPrint: () => void;
}

const LIGHT_OPTIONS: { id: LightingPreset; label: string }[] = [
  { id: "studio", label: "Studio" },
  { id: "giorno", label: "Giorno" },
  { id: "tramonto", label: "Tramonto" },
  { id: "notte", label: "Notte" },
];

const BG_OPTIONS: { id: BackgroundPreset; label: string }[] = [
  { id: "scuro", label: "Scuro" },
  { id: "neutro", label: "Neutro" },
  { id: "chiaro", label: "Chiaro" },
];

const VIEW_OPTIONS: { id: CameraView; label: string }[] = [
  { id: "front", label: "Fronte" },
  { id: "side", label: "Lato" },
  { id: "top", label: "Alto" },
  { id: "iso", label: "ISO" },
];

export function StylePanel({
  material,
  onMaterial,
  lighting,
  onLighting,
  background,
  onBackground,
  gridOn,
  onGrid,
  onView,
  onCaptureViews,
  hasModel,
  onSave,
  onExportGLB,
  onExportSTL,
  onExportUSDZ,
  sizeMm,
  onSizeMm,
  sizeFromSource,
  printReport,
  onCheckPrint,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [usdzBusy, setUsdzBusy] = useState(false);
  const [capturedViews, setCapturedViews] = useState<CapturedView[] | null>(null);
  const presetId = findPresetId(material);

  return (
    <div className="flex flex-col gap-6 p-5">
      {/* materiale */}
      <section>
        <SectionTitle>Materiale</SectionTitle>
        <div className="grid grid-cols-4 gap-1.5">
          {MATERIAL_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={!hasModel}
              onClick={() => onMaterial({ ...p.style })}
              aria-pressed={presetId === p.id}
              className={`flex flex-col items-center gap-1.5 border px-1 py-2.5 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
                presetId === p.id
                  ? "border-[#ff670d] bg-[#fff3ec]"
                  : "border-[#d4d4d4] hover:border-[#9a9a9a]"
              }`}
            >
              <span
                className="size-6 rounded-full border border-black/10"
                style={{ background: p.swatch }}
                aria-hidden="true"
              />
              <span className="text-[10px] uppercase tracking-wider text-[#525252]">
                {p.label}
              </span>
            </button>
          ))}
        </div>

        <label className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[11px] uppercase tracking-[0.18em] text-[#525252]">
            Colore personalizzato
          </span>
          <input
            type="color"
            value={material.tint ?? "#c8c8cc"}
            disabled={!hasModel}
            onChange={(e) =>
              onMaterial({
                ...material,
                tint: e.target.value,
                useMap: false,
                transmission: 0,
                emissive: null,
                original: false,
              })
            }
            className="h-8 w-14 cursor-pointer border border-[#d4d4d4] bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Colore personalizzato del materiale"
          />
        </label>

        <div className="mt-4 flex flex-col gap-4">
          <StyleSlider
            label="Metallico"
            value={material.metalness}
            display={`${Math.round(material.metalness * 100)}%`}
            onChange={(v) => onMaterial({ ...material, metalness: v, original: false })}
            disabled={!hasModel}
          />
          <StyleSlider
            label="Rugosità"
            value={material.roughness}
            display={`${Math.round(material.roughness * 100)}%`}
            onChange={(v) => onMaterial({ ...material, roughness: v, original: false })}
            disabled={!hasModel}
          />
          <StyleSlider
            label="Lacca lucida"
            value={material.clearcoat ?? 0}
            display={`${Math.round((material.clearcoat ?? 0) * 100)}%`}
            onChange={(v) => onMaterial({ ...material, clearcoat: v, original: false })}
            disabled={!hasModel}
          />
          <label className="flex cursor-pointer items-center justify-between">
            <span className="text-[11px] uppercase tracking-[0.18em] text-[#525252]">
              Texture foto
            </span>
            <Switch
              checked={material.useMap}
              onCheckedChange={(on) => onMaterial({ ...material, useMap: on })}
              disabled={!hasModel}
            />
          </label>
        </div>
      </section>

      {/* scena */}
      <section>
        <SectionTitle>Scena</SectionTitle>
        <div className="flex flex-col gap-4">
          <div>
            <div className="mb-1.5 text-[11px] uppercase tracking-[0.18em] text-[#525252]">Luci</div>
            <Segmented
              options={LIGHT_OPTIONS}
              value={lighting}
              onChange={onLighting}
            />
          </div>
          <div>
            <div className="mb-1.5 text-[11px] uppercase tracking-[0.18em] text-[#525252]">Sfondo</div>
            <Segmented
              options={BG_OPTIONS}
              value={background}
              onChange={onBackground}
            />
          </div>
          <label className="flex cursor-pointer items-center justify-between">
            <span className="text-[11px] uppercase tracking-[0.18em] text-[#525252]">
              Griglia e pavimento
            </span>
            <Switch checked={gridOn} onCheckedChange={onGrid} />
          </label>
        </div>
      </section>

      {/* viste */}
      <section>
        <SectionTitle>
          <span className="flex items-center gap-1.5">
            <Camera className="size-3.5" /> Viste
          </span>
        </SectionTitle>
        <div className="grid grid-cols-4 gap-1.5">
          {VIEW_OPTIONS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onView(v.id)}
              className="border border-[#d4d4d4] px-2 py-2 text-[11px] uppercase tracking-widest text-[#525252] transition-all duration-150 hover:border-[#ff670d] hover:text-[#ff670d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] active:scale-95"
            >
              {v.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={!hasModel}
          onClick={() => setCapturedViews(onCaptureViews())}
          className="mt-2 flex h-10 w-full items-center justify-center gap-2 border border-[#171717] text-[11px] uppercase tracking-[0.18em] text-[#171717] transition-all duration-150 hover:bg-[#171717] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Images className="size-3.5" />
          Render da 6 angolazioni
        </button>
        {capturedViews && capturedViews.length > 0 && (
          <div className="mt-2">
            <div className="grid grid-cols-3 gap-1.5">
              {capturedViews.map((v) => (
                <a
                  key={v.id}
                  href={v.dataUrl}
                  download={`vista-${v.id}.png`}
                  className="group border border-[#d4d4d4] transition-all duration-150 hover:border-[#ff670d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d]"
                  title={`Scarica ${v.label}`}
                >
                  <img src={v.dataUrl} alt={v.label} className="block w-full" />
                  <span className="flex items-center justify-center gap-1 px-1 py-1 text-[10px] uppercase tracking-wider text-[#525252] group-hover:text-[#ff670d]">
                    <Download className="size-3" />
                    {v.label}
                  </span>
                </a>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-[#6f6f6f]">
              Tocca una vista per scaricarla in PNG.
            </p>
          </div>
        )}
      </section>

      {/* esporta */}
      <section>
        <SectionTitle>Esporta</SectionTitle>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={!hasModel || saving}
            onClick={() => {
              setSaving(true);
              void onSave().finally(() => setSaving(false));
            }}
            className="flex h-11 items-center justify-center gap-2 bg-[#ff670d] text-[11px] font-medium uppercase tracking-[0.18em] text-white transition-all duration-150 hover:bg-[#e85c0b] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {saving ? "Salvataggio…" : "Salva modifica in Modelli"}
          </button>
          <label className="mt-1 flex items-center justify-between gap-3">
            <span className="text-[11px] uppercase tracking-[0.18em] text-[#525252]">
              Misura reale, lato più lungo
            </span>
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                max={5000}
                step={1}
                value={sizeMm}
                disabled={!hasModel}
                onChange={(e) => onSizeMm(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))}
                className="h-8 w-20 border border-[#d4d4d4] bg-transparent px-2 text-right text-sm tabular-nums focus-visible:border-[#ff670d] focus-visible:outline-none disabled:opacity-40"
                aria-label="Misura reale del lato più lungo in millimetri"
              />
              <span className="text-xs text-[#525252]">mm</span>
            </span>
          </label>
          <p className="-mt-1 text-[11px] text-[#6f6f6f]">
            {sizeFromSource ? "Rilevata dal motore AI: correggila se serve." : "Usata per STL e AR. Inserisci la misura dell'oggetto vero."}
          </p>
          <div className="grid grid-cols-3 gap-2">
            <ExportButton disabled={!hasModel} onClick={onExportGLB} label="GLB" />
            <ExportButton disabled={!hasModel} onClick={onExportSTL} label="STL" />
            <ExportButton
              disabled={!hasModel || usdzBusy}
              onClick={() => {
                setUsdzBusy(true);
                void onExportUSDZ().finally(() => setUsdzBusy(false));
              }}
              label={usdzBusy ? "…" : "USDZ"}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-[#6f6f6f]">
            GLB per web e motori 3D · STL in mm per la stampa · USDZ per l'AR su iPhone e iPad.
          </p>
          {hasModel && (
            <div
              role="status"
              className={`flex items-start gap-2 border px-3 py-2 text-xs leading-snug ${
                !printReport
                  ? "border-[#e4e4e4] text-[#525252]"
                  : printReport.watertight
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-amber-200 bg-amber-50 text-amber-900"
              }`}
            >
              {printReport?.watertight ? (
                <CircleCheck className="mt-px size-3.5 shrink-0" />
              ) : printReport ? (
                <CircleAlert className="mt-px size-3.5 shrink-0" />
              ) : (
                <ScanSearch className="mt-px size-3.5 shrink-0" />
              )}
              <span className="flex-1">
                {!printReport
                  ? "Stampabilità non ancora controllata."
                  : printReport.watertight
                    ? "Stampabile: superficie chiusa, nessun buco."
                    : `Non chiuso: ${printReport.openEdges.toLocaleString("it-IT")} bordi aperti${
                        printReport.nonManifoldEdges ? `, ${printReport.nonManifoldEdges.toLocaleString("it-IT")} spigoli ambigui` : ""
                      }. Molti slicer riparano da soli i buchi piccoli; per stampe sicure genera con destinazione «Stampa 3D».`}
              </span>
              <button
                type="button"
                onClick={onCheckPrint}
                className="shrink-0 underline decoration-current/30 underline-offset-2 hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d]"
              >
                {printReport ? "Ricontrolla" : "Controlla"}
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2.5 border-b border-[#e4e4e4] pb-1.5 text-[11px] uppercase tracking-[0.22em] text-[#171717]">
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className={`grid border border-[#d4d4d4]`} style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={`px-1 py-2.5 text-[11px] uppercase tracking-widest transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff670d] active:scale-95 ${
            value === o.id ? "bg-[#171717] text-[#fcfcfc]" : "text-[#6f6f6f] hover:bg-[#ededed]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StyleSlider({
  label,
  value,
  display,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  display: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-[0.18em] text-[#525252]">{label}</span>
        <span className="text-xs text-[#171717]">{display}</span>
      </div>
      <Slider
        value={[value]}
        min={0}
        max={1}
        step={0.01}
        onValueChange={(v) => onChange(v[0])}
        aria-label={label}
        disabled={disabled}
      />
    </div>
  );
}

function ExportButton({
  disabled,
  onClick,
  label,
}: {
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-10 items-center justify-center gap-2 border border-[#171717] text-[11px] uppercase tracking-[0.18em] text-[#171717] transition-all duration-150 hover:bg-[#171717] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Download className="size-3.5" />
      {label}
    </button>
  );
}
