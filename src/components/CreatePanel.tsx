import { useEffect, useRef, useState } from "react";
import { Coffee, ImagePlus, Loader2, Moon, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  drawSample,
  drawSampleObject,
  extractHeightmap,
  extractMask,
  extractTextureBase64,
  loadPhoto,
  maskToCanvas,
  shapeHeightsFromMask,
  type LoadedPhoto,
} from "@/lib/photo";
import { MODEL_MODES, MODE_LABELS, MODE_HINTS, type ModelMode } from "@contracts/types";
import type { ModelItemDTO } from "@/types/model";

type Step = "idle" | "analisi" | "generazione" | "fatto" | "errore";

const STEP_LABEL: Record<Exclude<Step, "idle">, string> = {
  analisi: "Analisi della foto…",
  generazione: "Costruzione mesh e salvataggio…",
  fatto: "Modello pronto",
  errore: "Qualcosa è andato storto",
};

interface Props {
  photo: LoadedPhoto | null;
  onPhoto: (photo: LoadedPhoto) => void;
  onGenerated: (item: ModelItemDTO) => void;
}

export function CreatePanel({ photo, onPhoto, onGenerated }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const maskPreview = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<ModelMode>("rilievo");
  const [depth, setDepth] = useState(55);
  const [resolution, setResolution] = useState(128);
  const [smooth, setSmooth] = useState(2);
  const [invert, setInvert] = useState(false);
  const [cutBg, setCutBg] = useState(true);
  const [solidVol, setSolidVol] = useState(true);
  const [tolerance, setTolerance] = useState(30);
  const [coverage, setCoverage] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [dragOver, setDragOver] = useState(false);
  const utils = trpc.useUtils();
  const generate = trpc.models.generate.useMutation();

  // se la foto arriva dal pulsante nel viewport, precompila il nome
  useEffect(() => {
    if (photo) {
      setName((prev) => prev || photo.fileName.replace(/\.[^.]+$/, "").slice(0, 60));
    }
  }, [photo]);

  // anteprima della sagoma rilevata, aggiornata al variare dei parametri
  useEffect(() => {
    if (!photo || (!cutBg && mode !== "torno")) {
      setCoverage(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      const gridW = resolution;
      const gridH = Math.max(
        16,
        Math.round((resolution * photo.canvas.height) / photo.canvas.width),
      );
      const mask = extractMask(photo.canvas, gridW, gridH, tolerance / 100);
      if (!alive) return;
      setCoverage(mask.coverage);
      const canvas = maskPreview.current;
      if (!canvas) return;
      const pw = 288;
      const ph = Math.max(1, Math.round((pw * photo.height) / photo.width));
      canvas.width = pw;
      canvas.height = ph;
      const ctx = canvas.getContext("2d")!;
      // scacchiera per leggere la trasparenza
      const sq = 9;
      for (let y = 0; y < ph; y += sq) {
        for (let x = 0; x < pw; x += sq) {
          ctx.fillStyle = ((x / sq + y / sq) | 0) % 2 === 0 ? "#efefef" : "#dcdcdc";
          ctx.fillRect(x, y, sq, sq);
        }
      }
      ctx.drawImage(photo.canvas, 0, 0, pw, ph);
      ctx.globalCompositeOperation = "destination-in";
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(maskToCanvas(mask), 0, 0, pw, ph);
      ctx.globalCompositeOperation = "source-over";
    }, 140);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [photo, cutBg, tolerance, resolution, mode]);

  async function handleFile(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("Formato non supportato: carica un'immagine");
      return;
    }
    try {
      const loaded = await loadPhoto(file);
      onPhoto(loaded);
      if (!name) {
        setName(file.name.replace(/\.[^.]+$/, "").slice(0, 60));
      }
      setStep("idle");
    } catch {
      toast.error("Non riesco a leggere questa immagine");
    }
  }

  async function handleSample() {
    const canvas = drawSample();
    onPhoto({
      canvas,
      width: canvas.width,
      height: canvas.height,
      previewUrl: canvas.toDataURL("image/jpeg", 0.85),
      fileName: "esempio-lunare.jpg",
    });
    if (!name) setName("Luna di esempio");
    setCutBg(false); // paesaggio: il rilievo classico usa tutta la foto
    setStep("idle");
  }

  async function handleSampleObject() {
    const canvas = drawSampleObject();
    onPhoto({
      canvas,
      width: canvas.width,
      height: canvas.height,
      previewUrl: canvas.toDataURL("image/png"),
      fileName: "vaso-esempio.png",
    });
    if (!name) setName("Vaso di esempio");
    setCutBg(true);
    setMode("torno"); // il vaso è l'oggetto d'esempio perfetto per il tornio
    setStep("idle");
  }

  async function handleGenerate() {
    if (!photo) return;
    const finalName = name.trim() || "Senza titolo";
    setStep("analisi");
    // lascia respirare la UI prima del lavoro sincrono
    await new Promise((r) => setTimeout(r, 30));
    try {
      const hm = extractHeightmap(photo.canvas, resolution, smooth);
      let maskData: Uint8Array | undefined;
      let textureBase64: string;
      // il tornio lavora sempre sulla sagoma: il ritaglio è obbligatorio
      const needCut = cutBg || mode === "torno";
      if (needCut) {
        const mask = extractMask(photo.canvas, hm.width, hm.height, tolerance / 100);
        if (mask.coverage < 0.02) {
          setStep("errore");
          toast.error(
            "Il ritaglio ha eliminato quasi tutto: alza la tolleranza o disattiva il ritaglio sfondo",
          );
          return;
        }
        // la forma 3D del rilievo nasce dalla sagoma (cupola + dettaglio);
        // per sfera/cilindro lo sfondo viene azzerato dal server; il tornio
        // usa la luminanza grezza come dettaglio radiale della parete
        if (mode === "rilievo") {
          shapeHeightsFromMask(hm.heights, mask);
        }
        textureBase64 = extractTextureBase64(photo.canvas, mask);
        maskData = mask.data;
      } else {
        textureBase64 = extractTextureBase64(photo.canvas);
      }
      setStep("generazione");
      const item = await generate.mutateAsync({
        name: finalName,
        mode,
        width: hm.width,
        height: hm.height,
        heights: hm.heights,
        depth: depth / 100,
        invert,
        cutBackground: needCut,
        mask: maskData ? Array.from(maskData) : undefined,
        solid: cutBg && mode === "rilievo" && solidVol,
        textureBase64,
      });
      setStep("fatto");
      await utils.models.list.invalidate();
      onGenerated(item as ModelItemDTO);
      toast.success("Modello generato e salvato in Modelli");
    } catch (err) {
      setStep("errore");
      toast.error(
        err instanceof Error ? err.message : "Generazione fallita, riprova",
      );
    }
  }

  const busy = step === "analisi" || step === "generazione";

  return (
    <div className="flex flex-col gap-5 px-5 pb-5">
      <p className="text-xs leading-relaxed text-[#525252]">
        Bassorilievo istantaneo calcolato nel browser, senza AI e senza costi: utile per targhe,
        litofanie e bozze veloci.
      </p>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = "";
        }}
      />

      {/* dropzone */}
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void handleFile(f);
        }}
        className={`group relative flex min-h-36 w-full cursor-pointer flex-col items-center justify-center gap-2 border border-dashed px-4 py-6 text-center transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] ${
          dragOver ? "border-[#ff670d] bg-[#fff3ec]" : "border-[#d4d4d4] bg-[#f6f6f6] hover:border-[#9a9a9a]"
        }`}
      >
        {photo ? (
          <img
            src={photo.previewUrl}
            alt="Foto caricata"
            className="max-h-40 max-w-full object-contain"
          />
        ) : (
          <>
            <ImagePlus className="size-6 text-[#6f6f6f] transition-colors group-hover:text-[#ff670d]" />
            <span className="text-sm text-[#171717]">Trascina una foto qui</span>
            <span className="text-xs uppercase tracking-widest text-[#6f6f6f]">
              oppure clicca per sceglierla
            </span>
          </>
        )}
      </button>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <button
          type="button"
          onClick={() => void handleSample()}
          className="flex items-center gap-2 self-start text-xs uppercase tracking-widest text-[#525252] underline decoration-[#d4d4d4] underline-offset-4 transition-colors hover:text-[#ff670d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d]"
        >
          <Moon className="size-3.5" />
          Esempio: luna
        </button>
        <button
          type="button"
          onClick={() => void handleSampleObject()}
          className="flex items-center gap-2 self-start text-xs uppercase tracking-widest text-[#525252] underline decoration-[#d4d4d4] underline-offset-4 transition-colors hover:text-[#ff670d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d]"
        >
          <Coffee className="size-3.5" />
          Esempio: vaso
        </button>
      </div>

      {/* modalità */}
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-[#525252]">Modalità</div>
        <div className="grid grid-cols-2 border border-[#d4d4d4]">
          {MODEL_MODES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                // il tornio rivoluziona la sagoma: serve il ritaglio attivo
                if (m === "torno") setCutBg(true);
              }}
              className={`px-2 py-2.5 text-xs uppercase tracking-widest transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff670d] active:scale-95 ${
                mode === m
                  ? "bg-[#171717] text-[#fcfcfc]"
                  : "bg-transparent text-[#6f6f6f] hover:bg-[#ededed]"
              }`}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-[#525252]">{MODE_HINTS[mode]}</p>
      </div>

      {/* parametri */}
      <div className="flex flex-col gap-4">
        <ParamSlider
          label={mode === "torno" ? "Dettaglio superficie" : "Profondità rilievo"}
          value={depth}
          display={`${depth}%`}
          min={5}
          max={100}
          onChange={setDepth}
        />
        <ParamSlider
          label="Dettaglio mesh"
          value={resolution}
          display={`${resolution} px`}
          min={64}
          max={256}
          step={16}
          onChange={setResolution}
        />
        <ParamSlider
          label="Levigatura"
          value={smooth}
          display={smooth === 0 ? "nessuna" : `${smooth}`}
          min={0}
          max={4}
          onChange={setSmooth}
        />
        <label className="flex cursor-pointer items-center justify-between">
          <span className="text-[11px] uppercase tracking-[0.18em] text-[#525252]">
            Inverti rilievo
          </span>
          <Switch checked={invert} onCheckedChange={setInvert} />
        </label>
        <label className="flex cursor-pointer items-center justify-between">
          <span className="text-[11px] uppercase tracking-[0.18em] text-[#525252]">
            Ritaglia oggetto dallo sfondo
          </span>
          <Switch checked={cutBg} onCheckedChange={setCutBg} />
        </label>
        {cutBg && mode === "rilievo" && (
          <label className="flex cursor-pointer items-center justify-between">
            <span className="text-[11px] uppercase tracking-[0.18em] text-[#525252]">
              Volume chiuso fronte/retro
            </span>
            <Switch checked={solidVol} onCheckedChange={setSolidVol} />
          </label>
        )}
        {(cutBg || mode === "torno") && (
          <>
            <ParamSlider
              label="Tolleranza sfondo"
              value={tolerance}
              display={`${tolerance}%`}
              min={5}
              max={80}
              onChange={setTolerance}
            />
            {photo && (
              <div>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <span className="text-[11px] uppercase tracking-[0.18em] text-[#525252]">
                    Anteprima ritaglio
                  </span>
                  {coverage !== null && (
                    <span className="text-xs text-[#171717]">
                      soggetto {Math.round(coverage * 100)}%
                    </span>
                  )}
                </div>
                <canvas
                  ref={maskPreview}
                  className="max-h-44 w-full border border-[#e4e4e4] object-contain"
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* nome */}
      <div>
        <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-[#525252]">Nome</div>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Il mio modello"
          maxLength={80}
          className="rounded-none border-0 border-b border-[#d4d4d4] bg-transparent px-0 text-base shadow-none focus-visible:ring-0 focus-visible:border-[#ff670d]"
        />
      </div>

      {/* azione */}
      <Button
        onClick={() => void handleGenerate()}
        disabled={!photo || busy}
        className="h-12 w-full rounded-none bg-[#ff670d] text-sm font-medium uppercase tracking-[0.18em] text-white transition-transform hover:bg-[#e85c0b] active:scale-[0.98] disabled:opacity-40"
      >
        {busy ? (
          <span className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            Generazione…
          </span>
        ) : step === "fatto" ? (
          <span className="flex items-center gap-2">
            <RefreshCw className="size-4" />
            Rigenera
          </span>
        ) : (
          "Genera il 3D"
        )}
      </Button>

      {step !== "idle" && (
        <div
          role="status"
          className={`border px-3 py-2 text-xs ${
            step === "errore"
              ? "border-red-300 bg-red-50 text-red-700"
              : step === "fatto"
                ? "border-[#ffd9c2] bg-[#fff3ec] text-[#b34a08]"
                : "border-[#d4d4d4] bg-[#f6f6f6] text-[#6f6f6f]"
          }`}
        >
          {STEP_LABEL[step]}
        </div>
      )}

    </div>
  );
}

function ParamSlider({
  label,
  value,
  display,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-[0.18em] text-[#525252]">{label}</span>
        <span className="text-xs text-[#171717]">{display}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0])}
        aria-label={label}
      />
    </div>
  );
}
