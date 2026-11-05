// Pannello Varianti: due strade in stile Vizcom.
// 1. Colore e materiale — anteprime locali del modello con ogni preset CMF,
//    clic per applicare (gratis, istantaneo).
// 2. Forma — una nuova generazione AI dalla foto originale (usa crediti Tripo,
//    dichiarato in chiaro prima del clic).
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Palette, RefreshCw, Sparkles } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { MATERIAL_PRESETS, findPresetId } from "@/lib/materialPresets";
import { renderVariantThumbs, type VariantThumb } from "@/three/variantThumbs";
import type { MaterialStyle } from "@/three/scene";
import type { ModelItemDTO } from "@/types/model";

type Quality = "bozza" | "standard" | "pro";

const QUALITY: { id: Quality; label: string; hint: string }[] = [
  { id: "bozza", label: "Bozza", hint: "Veloce ed economica, per provare l'idea" },
  { id: "standard", label: "Standard", hint: "Il miglior rapporto qualità/prezzo" },
  { id: "pro", label: "Pro", hint: "Massimo dettaglio di forma e texture" },
];

interface Props {
  active: ModelItemDTO | null;
  hasModel: boolean;
  material: MaterialStyle;
  onMaterial: (m: MaterialStyle) => void;
  exportGlb: () => Promise<ArrayBuffer | null>;
  onQueued: () => void;
}

export function VariantsPanel({ active, hasModel, material, onMaterial, exportGlb, onQueued }: Props) {
  const [thumbs, setThumbs] = useState<VariantThumb[] | null>(null);
  const [thumbsBusy, setThumbsBusy] = useState(false);
  const [thumbsError, setThumbsError] = useState(false);
  const [quality, setQuality] = useState<Quality>("standard");
  const status = trpc.models.aiStatus.useQuery(undefined, { staleTime: 60_000 });
  const generateVariant = trpc.models.generateVariant.useMutation();

  async function buildThumbs() {
    setThumbsBusy(true);
    setThumbsError(false);
    try {
      const buf = await exportGlb();
      if (!buf) throw new Error("glb mancante");
      setThumbs(await renderVariantThumbs(buf, MATERIAL_PRESETS));
    } catch {
      setThumbs(null);
      setThumbsError(true);
    } finally {
      setThumbsBusy(false);
    }
  }

  // rigenera le anteprime quando cambia il modello caricato
  useEffect(() => {
    if (!hasModel || !active) {
      setThumbs(null);
      return;
    }
    void buildThumbs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, hasModel]);

  const selectedPreset = findPresetId(material);
  const canAi = !!status.data?.canSingle;

  async function handleAiVariant() {
    if (!active) return;
    try {
      const item = await generateVariant.mutateAsync({ id: active.id, quality });
      toast.success(`"${item.name}" in lavorazione: segui l'avanzamento in galleria`, {
        duration: 6000,
      });
      onQueued();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Generazione della variante non riuscita");
    }
  }

  if (!active || !hasModel) {
    return (
      <div className="flex flex-col gap-3 p-5">
        <p className="text-sm leading-relaxed text-[#525252]">
          Carica un modello dalla galleria o generane uno: qui potrai vederlo in altri colori e
          materiali, e creare varianti di forma con l'AI.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-5">
      {/* varianti colore/materiale, tutto locale */}
      <section>
        <div className="mb-2.5 flex items-center justify-between border-b border-[#e4e4e4] pb-1.5">
          <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.22em] text-[#171717]">
            <Palette className="size-3.5" /> Colore e materiale
          </span>
          <button
            type="button"
            onClick={() => void buildThumbs()}
            disabled={thumbsBusy}
            title="Rigenera le anteprime (dopo scultura o modifiche)"
            className="flex items-center gap-1 text-[11px] uppercase tracking-widest text-[#525252] transition-colors hover:text-[#ff670d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] disabled:opacity-40"
          >
            <RefreshCw className={`size-3.5 ${thumbsBusy ? "animate-spin" : ""}`} />
            Aggiorna
          </button>
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-[#6f6f6f]">
          Anteprime reali del tuo modello, generate in locale: tocca una variante per applicarla.
          Nessun credito AI.
        </p>
        {thumbsBusy && !thumbs && (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-[#6f6f6f]">
            <Loader2 className="size-4 animate-spin" />
            Preparo le anteprime…
          </div>
        )}
        {thumbsError && (
          <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-900">
            Anteprime non riuscite per questo modello.{" "}
            <button
              type="button"
              onClick={() => void buildThumbs()}
              className="underline decoration-current/30 underline-offset-2 hover:opacity-70"
            >
              Riprova
            </button>
          </div>
        )}
        {thumbs && (
          <div className="grid grid-cols-4 gap-1.5">
            {thumbs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onMaterial({ ...t.style })}
                aria-pressed={selectedPreset === t.id}
                className={`flex flex-col items-center gap-1 border p-1 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] active:scale-95 ${
                  selectedPreset === t.id
                    ? "border-[#ff670d] bg-[#fff3ec]"
                    : "border-[#d4d4d4] hover:border-[#9a9a9a]"
                }`}
              >
                <img src={t.dataUrl} alt={t.label} className="block w-full" />
                <span className="text-[10px] uppercase tracking-wider text-[#525252]">
                  {t.label}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* varianti di forma via AI */}
      <section>
        <div className="mb-2.5 border-b border-[#e4e4e4] pb-1.5 text-[11px] uppercase tracking-[0.22em] text-[#171717]">
          <span className="flex items-center gap-1.5">
            <Sparkles className="size-3.5" /> Forma (AI)
          </span>
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-[#6f6f6f]">
          Il motore AI reinterpreta la foto originale di «{active.name}»: ogni generazione è
          un'interpretazione nuova della forma. La variante appare in galleria accanto
          all'originale.
        </p>
        <div className="grid grid-cols-3 border border-[#d4d4d4]">
          {QUALITY.map((q) => (
            <button
              key={q.id}
              type="button"
              onClick={() => setQuality(q.id)}
              aria-pressed={quality === q.id}
              className={`px-1 py-2.5 text-[11px] uppercase tracking-widest transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff670d] active:scale-95 ${
                quality === q.id ? "bg-[#171717] text-[#fcfcfc]" : "text-[#6f6f6f] hover:bg-[#ededed]"
              }`}
            >
              {q.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-[#525252]">{QUALITY.find((q) => q.id === quality)!.hint}</p>
        <button
          type="button"
          disabled={!canAi || generateVariant.isPending}
          onClick={() => void handleAiVariant()}
          className="mt-3 flex h-11 w-full items-center justify-center gap-2 bg-[#ff670d] text-[11px] font-medium uppercase tracking-[0.18em] text-white transition-all duration-150 hover:bg-[#e85c0b] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {generateVariant.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          {generateVariant.isPending ? "Avvio…" : "Genera variante AI"}
        </button>
        <p className="mt-1.5 text-[11px] leading-relaxed text-[#6f6f6f]">
          {canAi
            ? "Costo trasparente: 1 generazione AI, crediti Tripo API. Durata tipica 2–4 minuti."
            : "Nessun motore AI disponibile sul server: serve una chiave API (es. Tripo)."}
        </p>
      </section>
    </div>
  );
}
