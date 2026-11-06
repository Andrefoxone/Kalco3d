// Galleria Foto: immagini create dal testo e foto usate per i modelli,
// separata dalla galleria dei modelli. Da qui una foto torna a essere il
// punto di partenza di un nuovo modello 3D.
import { useMemo, useState } from "react";
import { Box, Download, ImageOff, Loader2, Trash2, Wand2, Camera } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import type { IncomingPhoto } from "@/components/AiCreatePanel";

type Filter = "tutte" | "ai" | "foto";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "tutte", label: "Tutte" },
  { id: "ai", label: "Create dal testo" },
  { id: "foto", label: "Foto caricate" },
];

interface Props {
  onUseFor3d: (photo: IncomingPhoto) => void;
}

function safeName(s: string) {
  return (s || "foto").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 60) || "foto";
}

function dayLabel(d: Date) {
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Oggi";
  if (d.toDateString() === y.toDateString()) return "Ieri";
  return d.toLocaleDateString("it-IT", { day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

export function PhotosPanel({ onUseFor3d }: Props) {
  const [filter, setFilter] = useState<Filter>("tutte");
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const utils = trpc.useUtils();
  const list = trpc.images.list.useInfiniteQuery(
    { source: filter },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, staleTime: 30_000 },
  );
  const remove = trpc.images.remove.useMutation();
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  // raggruppate per giorno: più facili da scorrere
  const groups = useMemo(() => {
    const out: { label: string; items: typeof items }[] = [];
    for (const it of items) {
      const label = dayLabel(new Date(it.createdAt));
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(it);
      else out.push({ label, items: [it] });
    }
    return out;
  }, [items]);

  async function toFile(url: string, name: string): Promise<File> {
    const blob = await (await fetch(url)).blob();
    return new File([blob], `${safeName(name)}.${blob.type === "image/png" ? "png" : "jpg"}`, { type: blob.type || "image/jpeg" });
  }

  async function use(it: (typeof items)[number]) {
    if (!it.url) return;
    setBusy(it.id);
    try {
      const file = await toFile(it.url, it.name);
      onUseFor3d({ file, name: it.name, imageId: it.id });
    } catch {
      toast.error("Non riesco a caricare questa foto");
    } finally {
      setBusy(null);
    }
  }

  async function download(it: (typeof items)[number]) {
    if (!it.url) return;
    const file = await toFile(it.url, it.name);
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function del(id: number) {
    try {
      await remove.mutateAsync({ id });
      setSelected(null);
      await utils.images.list.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Eliminazione non riuscita");
    }
  }

  return (
    <div className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="font-display text-xl leading-tight tracking-tight text-[#171717]">Foto</h2>
        <p className="mt-1 text-xs leading-relaxed text-[#525252]">
          Le immagini create dal testo e le foto usate per i modelli. Tocca una foto per trasformarla in 3D.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtra le foto">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => { setFilter(f.id); setSelected(null); }}
            className={`border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] ${
              filter === f.id ? "border-[#171717] bg-[#171717] text-white" : "border-[#d4d4d4] text-[#3f3f3c] hover:bg-[#f2f2f2]"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {list.isLoading && (
        <div className="flex items-center gap-2 text-xs text-[#525252]">
          <Loader2 className="size-3.5 animate-spin" /> Carico le foto…
        </div>
      )}
      {!list.isLoading && items.length === 0 && (
        <div className="flex flex-col items-center gap-2 border border-dashed border-[#d4d4d4] px-4 py-8 text-center text-xs text-[#525252]">
          <ImageOff className="size-5 text-[#9a9a9a]" />
          {filter === "ai" ? "Nessuna immagine creata dal testo, per ora." : "Nessuna foto, per ora."}
        </div>
      )}

      {groups.map((g) => (
        <section key={g.label} className="flex flex-col gap-2">
          <h3 className="text-[11px] uppercase tracking-[0.18em] text-[#525252]">{g.label}</h3>
          <div className="grid grid-cols-3 gap-1.5">
            {g.items.map((it) => {
              const open = selected === it.id;
              return (
                <div key={it.id} className="relative aspect-square overflow-hidden bg-[#ececea]">
                  <button
                    type="button"
                    onClick={() => setSelected(open ? null : it.id)}
                    className="block size-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff670d]"
                    aria-label={`${it.name || "Foto"}: azioni`}
                    title={it.prompt ?? it.name}
                  >
                    {it.url ? (
                      <img src={it.url} alt={it.name} loading="lazy" className="size-full object-cover" />
                    ) : (
                      <ImageOff className="m-auto size-5 text-[#9a9a9a]" />
                    )}
                    <span className="absolute left-1 top-1 bg-black/55 p-0.5 text-white" aria-hidden="true">
                      {it.source === "ai" ? <Wand2 className="size-3" /> : <Camera className="size-3" />}
                    </span>
                  </button>
                  {open && (
                    <div className="absolute inset-0 flex flex-col justify-end gap-1 bg-black/60 p-1.5">
                      <button
                        type="button"
                        onClick={() => void use(it)}
                        disabled={busy === it.id}
                        className="flex items-center justify-center gap-1 bg-[#ff670d] px-1 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[#171717] hover:bg-[#e85c0b]"
                      >
                        {busy === it.id ? <Loader2 className="size-3 animate-spin" /> : <Box className="size-3" />}
                        Crea il 3D
                      </button>
                      <div className="grid grid-cols-2 gap-1">
                        <button
                          type="button"
                          onClick={() => void download(it)}
                          className="flex items-center justify-center bg-white/90 py-1 text-[#171717] hover:bg-white"
                          aria-label="Scarica"
                        >
                          <Download className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void del(it.id)}
                          className="flex items-center justify-center bg-white/90 py-1 text-red-700 hover:bg-white"
                          aria-label="Elimina"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {list.hasNextPage && (
        <button
          type="button"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
          className="h-9 border border-[#d4d4d4] text-xs uppercase tracking-[0.14em] text-[#3f3f3c] hover:bg-[#f2f2f2]"
        >
          {list.isFetchingNextPage ? "Carico…" : "Altre foto"}
        </button>
      )}
    </div>
  );
}
