// "Non hai una foto? Creala": immagini da testo (FLUX.2) da usare come foto frontale.
import { useState } from "react";
import { Check, Loader2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { handleNoCredits } from "@/lib/plansDialog";
import { imageCreditCost, type ImageStyle } from "@contracts/billing";

const STYLES: { id: ImageStyle; label: string }[] = [
  { id: "realistico", label: "Realistico" },
  { id: "statuina", label: "Statuina" },
  { id: "giocattolo", label: "Giocattolo" },
  { id: "scultura", label: "Scultura" },
];

const EXAMPLES = ["un bulldog francese seduto con un papillon", "una lampada da tavolo in ceramica a forma di fungo", "un drago di fantasia arrotolato su una roccia"];

interface Props {
  forPrint: boolean;
  isAdmin: boolean;
  /** immagine scelta: diventa la foto frontale */
  onPick: (file: File, prompt: string) => void;
}

async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: blob.type || "image/jpeg" });
}

export function TextToImage({ forPrint, isAdmin, onPick }: Props) {
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState<ImageStyle>("realistico");
  const [count, setCount] = useState(2);
  const [results, setResults] = useState<string[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const utils = trpc.useUtils();
  const status = trpc.images.status.useQuery(undefined, { staleTime: 300_000 });
  const gen = trpc.images.generate.useMutation();

  async function create() {
    setPicked(null);
    try {
      const out = await gen.mutateAsync({ prompt, style, forPrint, count });
      setResults(out.images.map((i) => i.dataUrl));
      if (out.failed > 0) toast(`${out.failed} immagine non riuscita: crediti restituiti`);
      void utils.billing.account.invalidate();
    } catch (err) {
      if (handleNoCredits(err)) return;
      toast.error(err instanceof Error ? err.message : "Creazione delle immagini non riuscita");
    }
  }

  async function pick(i: number) {
    setPicked(i);
    const file = await dataUrlToFile(results[i], `${prompt.slice(0, 40) || "immagine"}.jpg`);
    onPick(file, prompt);
  }

  if (status.data && !status.data.enabled) {
    return <p className="border border-[#e4e4e4] p-3 text-xs text-[#525252]">La creazione di immagini non è ancora attiva su questo server.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        maxLength={600}
        rows={3}
        placeholder={`Descrivi l'oggetto, ad esempio: ${EXAMPLES[0]}`}
        className="w-full resize-none border border-[#d4d4d4] bg-white px-3 py-2 text-sm text-[#171717] placeholder:text-[#9a9a9a] focus-visible:border-[#ff670d] focus-visible:outline-none"
        aria-label="Descrizione dell'oggetto"
      />
      <div className="flex flex-wrap gap-1.5">
        {STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={style === s.id}
            onClick={() => setStyle(s.id)}
            className={`border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] ${
              style === s.id ? "border-[#171717] bg-[#171717] text-white" : "border-[#d4d4d4] text-[#3f3f3c] hover:bg-[#f2f2f2]"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex border border-[#d4d4d4]" role="group" aria-label="Quante immagini">
          {[1, 2, 4].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={count === n}
              onClick={() => setCount(n)}
              className={`px-2.5 py-1.5 text-xs tabular-nums ${count === n ? "bg-[#171717] text-white" : "text-[#525252] hover:bg-[#f2f2f2]"}`}
            >
              {n}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void create()}
          disabled={prompt.trim().length < 3 || gen.isPending}
          className="flex h-9 flex-1 items-center justify-center gap-2 bg-[#171717] text-xs uppercase tracking-[0.14em] text-white transition-colors hover:bg-[#ff670d] hover:text-[#171717] disabled:opacity-40"
        >
          {gen.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
          {gen.isPending ? "Creo…" : `Crea ${count === 1 ? "l'immagine" : `${count} immagini`} · ${isAdmin ? "admin" : `${imageCreditCost(count)} cr.`}`}
        </button>
      </div>

      {results.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {results.map((src, i) => (
            <button
              key={i}
              type="button"
              onClick={() => void pick(i)}
              className={`relative aspect-square overflow-hidden border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] ${
                picked === i ? "border-[#ff670d]" : "border-transparent hover:border-[#d4d4d4]"
              }`}
              aria-label={`Usa l'immagine ${i + 1}`}
            >
              <img src={src} alt={`Proposta ${i + 1}`} className="size-full object-cover" />
              {picked === i && (
                <span className="absolute right-1.5 top-1.5 flex items-center gap-1 bg-[#ff670d] px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-[#171717]">
                  <Check className="size-3" /> In uso
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-[#6f6f6f]">
        {results.length > 0
          ? "Scegli l'immagine da trasformare in 3D: diventa la foto frontale."
          : "Le immagini escono già adatte al 3D: un solo oggetto, intero, su fondo neutro."}
      </p>
    </div>
  );
}
