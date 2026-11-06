// Generazione foto → 3D con l'AI: il servizio principale.
// 1 foto frontale obbligatoria + fino a 3 viste extra, controllo qualità
// della foto prima di spendere crediti, scelta di qualità e destinazione.
import { useEffect, useRef, useState } from "react";
import {
  Box,
  CircleAlert,
  CircleCheck,
  Gamepad2,
  ImagePlus,
  Loader2,
  Printer,
  ShoppingBag,
  Sparkles,
  TriangleAlert,
  X,
  Camera,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loadPhoto, type LoadedPhoto } from "@/lib/photo";
import { checkPhoto, pixelsFromCanvas, type PhotoCheck } from "@/lib/photoCheck";
import { creditCost } from "@contracts/billing";
import { handleNoCredits } from "@/lib/plansDialog";
import { TextToImage } from "@/components/TextToImage";

type View = "front" | "left" | "back" | "right";
type Quality = "bozza" | "standard" | "pro";
type Target = "ecommerce" | "stampa" | "render" | "gioco";

const VIEW_LABEL: Record<View, string> = {
  front: "Fronte",
  left: "Lato sinistro",
  back: "Retro",
  right: "Lato destro",
};

/** etichette corte per le miniature */
const VIEW_SHORT: Record<View, string> = { front: "Fronte", left: "Sinistra", back: "Retro", right: "Destra" };

const QUALITY: { id: Quality; label: string; hint: string }[] = [
  { id: "bozza", label: "Bozza", hint: "Veloce ed economica, per provare l'idea" },
  { id: "standard", label: "Standard", hint: "Il miglior rapporto qualità/prezzo" },
  { id: "pro", label: "Pro", hint: "Massimo dettaglio di forma e texture" },
];

const TARGET: { id: Target; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: "ecommerce", label: "E-commerce e AR", hint: "Texture PBR, leggero, misure reali per la realtà aumentata", icon: <ShoppingBag className="size-4" /> },
  { id: "stampa", label: "Stampa 3D", hint: "Colori per più filamenti, misure reali, 3MF pronto", icon: <Printer className="size-4" /> },
  { id: "render", label: "Render e design", hint: "Texture ad alta risoluzione per immagini da catalogo", icon: <Camera className="size-4" /> },
  { id: "gioco", label: "Giochi e real-time", hint: "Low-poly con topologia pulita per i motori di gioco", icon: <Gamepad2 className="size-4" /> },
];

interface Slot {
  photo: LoadedPhoto;
  check: PhotoCheck;
}

export interface IncomingPhoto {
  file: File;
  name: string;
  imageId: number | null;
}

interface Props {
  /** la foto frontale viene condivisa con il rilievo rapido */
  onFrontPhoto: (photo: LoadedPhoto) => void;
  onQueued: () => void;
  /** foto scelta dalla galleria Foto, da usare come frontale */
  incoming?: IncomingPhoto | null;
  onIncomingUsed?: () => void;
}

/** JPEG per l'invio: lato massimo 2048px (oltre non migliora e pesa). */
function encodeForUpload(canvas: HTMLCanvasElement): string {
  const MAX = 2048;
  let src = canvas;
  if (canvas.width > MAX || canvas.height > MAX) {
    const s = MAX / Math.max(canvas.width, canvas.height);
    src = document.createElement("canvas");
    src.width = Math.round(canvas.width * s);
    src.height = Math.round(canvas.height * s);
    src.getContext("2d")!.drawImage(canvas, 0, 0, src.width, src.height);
  }
  return src.toDataURL("image/jpeg", 0.92).split(",")[1];
}

export function AiCreatePanel({ onFrontPhoto, onQueued, incoming, onIncomingUsed }: Props) {
  const [slots, setSlots] = useState<Partial<Record<View, Slot>>>({});
  const [quality, setQuality] = useState<Quality>("standard");
  const [target, setTarget] = useState<Target>("ecommerce");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState(false);
  const [source, setSource] = useState<"foto" | "testo">("foto");
  /** la frontale viene dalla galleria Foto: il server non la duplica */
  const [frontImageId, setFrontImageId] = useState<number | null>(null);
  const utils = trpc.useUtils();
  const isAdmin = trpc.billing.account.useQuery(undefined, { staleTime: 15_000 }).data?.admin ?? false;
  const generateAi = trpc.models.generateAi.useMutation();
  const status = trpc.models.aiStatus.useQuery(undefined, { staleTime: 60_000 });

  const views = Object.keys(slots) as View[];
  const front = slots.front;
  const hasProblems = views.some((v) => slots[v]!.check.level === "problema");
  const blocking = hasProblems && !override;
  const noEngine = status.data && !status.data.canSingle;

  async function setSlot(view: View, file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("Formato non supportato: carica un'immagine");
      return;
    }
    try {
      const photo = await loadPhoto(file);
      // dimensioni del file originale (loadPhoto riduce a 1600px)
      const bmp = await createImageBitmap(file);
      const size = { width: bmp.width, height: bmp.height };
      bmp.close();
      const check = checkPhoto(pixelsFromCanvas(photo.canvas), size);
      setOverride(false);
      setSlots((s) => ({ ...s, [view]: { photo, check } }));
      if (view === "front") {
        onFrontPhoto(photo);
        if (!name) setName(file.name.replace(/\.[^.]+$/, "").slice(0, 60));
      }
    } catch {
      toast.error("Non riesco a leggere questa immagine");
    }
  }

  useEffect(() => {
    if (!incoming) return;
    setSource("foto");
    setName(incoming.name.slice(0, 60));
    void setSlot("front", incoming.file).then(() => setFrontImageId(incoming.imageId));
    onIncomingUsed?.();
  }, [incoming]); // eslint-disable-line react-hooks/exhaustive-deps

  function removeSlot(view: View) {
    if (view === "front") setFrontImageId(null);
    setSlots((s) => {
      const next = { ...s };
      delete next[view];
      return next;
    });
  }

  async function handleGenerate() {
    if (!front) return;
    setBusy(true);
    try {
      await new Promise((r) => setTimeout(r, 20));
      const photos = views.map((view) => ({ view, base64: encodeForUpload(slots[view]!.photo.canvas) }));
      await generateAi.mutateAsync({
        name: name.trim() || "Senza titolo",
        photos,
        quality,
        target,
        imageId: frontImageId,
      });
      await Promise.all([utils.models.list.invalidate(), utils.billing.account.invalidate()]);
      toast.success("Generazione avviata: segui l'avanzamento in Modelli");
      onQueued();
    } catch (err) {
      if (handleNoCredits(err)) return;
      toast.error(err instanceof Error ? err.message : "Avvio della generazione fallito");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 p-5">
      <div>
        <h2 className="font-display text-xl leading-tight tracking-tight text-[#171717]">Dalla foto al 3D</h2>
        <p className="mt-1 text-xs leading-relaxed text-[#525252]">
          {source === "foto"
            ? "Basta una foto frontale. Aggiungere lato e retro rende fedele anche la parte che non si vede."
            : "Non hai una foto? Descrivi l'oggetto: creiamo l'immagine e poi il modello 3D."}
        </p>
      </div>

      <div className="grid grid-cols-2 border border-[#d4d4d4]" role="tablist" aria-label="Da dove parti">
        {([
          ["foto", "Ho una foto"],
          ["testo", "Creala dal testo"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={source === id}
            onClick={() => setSource(id)}
            className={`px-2 py-2 text-xs uppercase tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff670d] ${
              source === id ? "bg-[#171717] text-white" : "text-[#6f6f6f] hover:bg-[#ededed]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {source === "testo" && (
        <TextToImage
          forPrint={target === "stampa"}
          isAdmin={isAdmin}
          onPick={(file, prompt, imageId) => {
            if (!name) setName(prompt.trim().slice(0, 60));
            void setSlot("front", file).then(() => setFrontImageId(imageId));
          }}
        />
      )}

      {/* foto */}
      <div className="grid grid-cols-3 gap-2">
        <PhotoSlot
          view="front"
          slot={slots.front}
          big
          onFile={(f) => {
            setFrontImageId(null);
            void setSlot("front", f);
          }}
          onRemove={() => removeSlot("front")}
        />
        {(["left", "back", "right"] as View[]).map((v) => (
          <PhotoSlot
            key={v}
            view={v}
            slot={slots[v]}
            disabled={!front}
            onFile={(f) => void setSlot(v, f)}
            onRemove={() => removeSlot(v)}
          />
        ))}
      </div>

      {/* esito del controllo foto */}
      {views.length > 0 && <CheckReport slots={slots} />}

      {/* destinazione */}
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-[#525252]">Per cosa ti serve</div>
        <div className="grid grid-cols-2 gap-2">
          {TARGET.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={target === t.id}
              onClick={() => setTarget(t.id)}
              className={`flex flex-col items-start gap-1 border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] ${
                target === t.id ? "border-[#171717] bg-[#171717] text-white" : "border-[#d4d4d4] text-[#171717] hover:bg-[#f2f2f2]"
              }`}
            >
              <span className="flex items-center gap-1.5 text-xs font-medium">
                {t.icon}
                {t.label}
              </span>
              <span className={`text-[11px] leading-snug ${target === t.id ? "text-[#d4d4d4]" : "text-[#6f6f6f]"}`}>{t.hint}</span>
            </button>
          ))}
        </div>
      </div>

      {/* qualità */}
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-[#525252]">Qualità</div>
        <div className="grid grid-cols-3 border border-[#d4d4d4]">
          {QUALITY.map((q) => (
            <button
              key={q.id}
              type="button"
              aria-pressed={quality === q.id}
              onClick={() => setQuality(q.id)}
              className={`px-2 py-2.5 text-xs uppercase tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff670d] ${
                quality === q.id ? "bg-[#ff670d] text-white" : "text-[#6f6f6f] hover:bg-[#ededed]"
              }`}
            >
              {q.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-[#525252]">{QUALITY.find((q) => q.id === quality)!.hint}</p>
      </div>

      {/* nome */}
      <div>
        <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-[#525252]">Nome</div>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Il mio modello"
          maxLength={80}
          className="rounded-none border-0 border-b border-[#d4d4d4] bg-transparent px-0 text-base shadow-none focus-visible:border-[#ff670d] focus-visible:ring-0"
        />
      </div>

      <Button
        onClick={() => void handleGenerate()}
        disabled={!front || busy || blocking || Boolean(noEngine)}
        className="h-12 w-full rounded-none bg-[#ff670d] text-sm font-medium uppercase tracking-[0.18em] text-white transition-transform hover:bg-[#e85c0b] active:scale-[0.98] disabled:opacity-40"
      >
        {busy ? (
          <span className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            Invio foto…
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <Sparkles className="size-4" />
            Genera il modello 3D
            <span className="ml-1 border-l border-white/40 pl-2 tabular-nums">{isAdmin ? "admin" : `${creditCost(quality, target)} crediti`}</span>
          </span>
        )}
      </Button>
      <p className="-mt-3 text-[11px] leading-relaxed text-[#6f6f6f]">
        {noEngine
          ? "Nessun motore 3D configurato sul server: serve almeno una chiave API."
          : blocking
            ? "Correggi le foto segnate in rosso prima di generare: risparmi crediti e tempo."
            : hasProblems
              ? "Generi ignorando gli avvisi: il risultato potrebbe deludere."
              : `${views.length > 1 ? `${views.length} foto` : "1 foto"} · di solito 1–4 minuti. Il modello compare in Modelli da solo.`}
        {blocking && !noEngine && (
          <>
            {" "}
            <button
              type="button"
              onClick={() => setOverride(true)}
              className="underline decoration-[#d4d4d4] underline-offset-2 hover:text-[#ff670d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d]"
            >
              Genera comunque
            </button>
          </>
        )}
      </p>
    </div>
  );
}

function PhotoSlot({
  view,
  slot,
  big,
  disabled,
  onFile,
  onRemove,
}: {
  view: View;
  slot?: Slot;
  big?: boolean;
  disabled?: boolean;
  onFile: (f: File) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const level = slot?.check.level;
  return (
    <div className={`relative ${big ? "col-span-3 aspect-[16/10]" : "aspect-square"}`}>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={disabled}
        aria-label={`${slot ? "Sostituisci" : "Carica"} foto: ${VIEW_LABEL[view]}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f && !disabled) onFile(f);
        }}
        className={`group flex size-full flex-col items-center justify-center gap-1 overflow-hidden border border-dashed text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] disabled:cursor-not-allowed disabled:opacity-40 ${
          over
            ? "border-[#ff670d] bg-[#fff3ec]"
            : level === "problema"
              ? "border-red-400 bg-red-50"
              : level === "avviso"
                ? "border-amber-400 bg-amber-50"
                : "border-[#d4d4d4] bg-[#f6f6f6] hover:border-[#9a9a9a]"
        }`}
      >
        {slot ? (
          <img src={slot.photo.previewUrl} alt={VIEW_LABEL[view]} className="size-full object-contain" />
        ) : (
          <>
            {big ? <ImagePlus className="size-6 text-[#6f6f6f] group-hover:text-[#ff670d]" /> : <Box className="size-4 text-[#9a9a9a]" />}
            <span className={big ? "text-sm text-[#171717]" : "text-[11px] text-[#525252]"}>
              {big ? "Foto frontale" : VIEW_LABEL[view]}
            </span>
            <span className="text-[10px] uppercase tracking-widest text-[#9a9a9a]">
              {big ? "trascina o clicca · obbligatoria" : "facoltativa"}
            </span>
          </>
        )}
      </button>
      {slot && (
        <>
          <span className="pointer-events-none absolute bottom-1 right-1 bg-black/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-white">
            {VIEW_SHORT[view]}
          </span>
          <span className="pointer-events-none absolute bottom-1 left-1">
            {level === "ok" ? (
              <CircleCheck className="size-4 rounded-full bg-white text-emerald-600" />
            ) : level === "avviso" ? (
              <CircleAlert className="size-4 rounded-full bg-white text-amber-600" />
            ) : (
              <TriangleAlert className="size-4 text-red-600" />
            )}
          </span>
          <button
            type="button"
            aria-label={`Rimuovi foto: ${VIEW_LABEL[view]}`}
            onClick={onRemove}
            className="absolute right-1 top-1 flex size-6 items-center justify-center bg-black/60 text-white hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d]"
          >
            <X className="size-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

function CheckReport({ slots }: { slots: Partial<Record<View, Slot>> }) {
  const entries = (Object.keys(slots) as View[]).flatMap((v) =>
    slots[v]!.check.items.map((it) => ({ view: v, ...it })),
  );
  if (entries.length === 0) {
    return (
      <div role="status" className="flex items-center gap-2 border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
        <CircleCheck className="size-4 shrink-0" />
        Foto ok: nitide, ben esposte e inquadrate.
      </div>
    );
  }
  return (
    <ul role="status" className="flex flex-col gap-1.5">
      {entries.map((e, i) => (
        <li
          key={i}
          className={`flex items-start gap-2 border px-3 py-2 text-xs leading-snug ${
            e.level === "problema" ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
        >
          {e.level === "problema" ? <TriangleAlert className="mt-px size-3.5 shrink-0" /> : <CircleAlert className="mt-px size-3.5 shrink-0" />}
          <span>
            <strong className="font-medium">{VIEW_LABEL[e.view]}:</strong> {e.message}
          </span>
        </li>
      ))}
    </ul>
  );
}
