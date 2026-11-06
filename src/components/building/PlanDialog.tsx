// Pianta (immagine) → muri stampabili. Si vedono i muri trovati in arancio;
// un clic su una parte la esclude (o la rimette). Scala: larghezza totale
// oppure una misura nota tra due punti cliccati.
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Ruler, Upload } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { components, inkMask, maskToSection, wallMask, wallsSoup, type Component } from "@/building/plan";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onWalls: (r: { name: string; soup: Float32Array; heightM: number }) => void;
}

interface Loaded {
  name: string;
  w: number;
  h: number;
  rgba: Uint8ClampedArray;
  /** immagine ridotta per lo sfondo del canvas */
  bitmap: ImageBitmap;
}

const MAX_SIDE = 1600;

export function PlanDialog({ open, onOpenChange, onWalls }: Props) {
  const [img, setImg] = useState<Loaded | null>(null);
  const [radius, setRadius] = useState(5);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [scaleMode, setScaleMode] = useState<"larghezza" | "misura">("larghezza");
  const [widthM, setWidthM] = useState(12);
  const [pts, setPts] = useState<[number, number][]>([]);
  const [knownM, setKnownM] = useState(1);
  const [heightM, setHeightM] = useState(2.7);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  // muri e parti: ricalcolati quando cambia il raggio
  const detected = useMemo(() => {
    if (!img) return null;
    const walls = wallMask(inkMask(img.rgba, img.w, img.h), radius);
    const { labels, list } = components(walls);
    const minArea = img.w * img.h * 0.0005;
    const small = new Set(list.filter((c) => c.area < minArea).map((c) => c.id));
    return { labels, list, small };
  }, [img, radius]);

  const kept = useMemo(() => {
    if (!detected) return [] as Component[];
    return detected.list.filter((c) => !detected.small.has(c.id) && !excluded.has(c.id));
  }, [detected, excluded]);

  const bboxPx = useMemo(() => {
    if (!kept.length) return null;
    return {
      x0: Math.min(...kept.map((c) => c.x0)),
      x1: Math.max(...kept.map((c) => c.x1)) + 1,
      y0: Math.min(...kept.map((c) => c.y0)),
      y1: Math.max(...kept.map((c) => c.y1)) + 1,
    };
  }, [kept]);

  const mmPerPx = useMemo(() => {
    if (scaleMode === "misura") {
      if (pts.length < 2) return null;
      const d = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
      return d > 2 ? (knownM * 1000) / d : null;
    }
    return bboxPx ? (widthM * 1000) / (bboxPx.x1 - bboxPx.x0) : null;
  }, [scaleMode, pts, knownM, widthM, bboxPx]);

  // disegno: pianta sbiadita, muri tenuti in arancio, esclusi in grigio
  useEffect(() => {
    const c = canvas.current;
    if (!c || !img || !detected) return;
    c.width = img.w;
    c.height = img.h;
    const ctx = c.getContext("2d")!;
    ctx.globalAlpha = 0.35;
    ctx.drawImage(img.bitmap, 0, 0, img.w, img.h);
    ctx.globalAlpha = 1;
    const over = ctx.getImageData(0, 0, img.w, img.h);
    const keepIds = new Set(kept.map((k) => k.id));
    for (let p = 0; p < img.w * img.h; p++) {
      const id = detected.labels[p];
      if (!id || detected.small.has(id)) continue;
      const i = p * 4;
      if (keepIds.has(id)) { over.data[i] = 255; over.data[i + 1] = 103; over.data[i + 2] = 13; }
      else { over.data[i] = 150; over.data[i + 1] = 150; over.data[i + 2] = 155; }
      over.data[i + 3] = 255;
    }
    ctx.putImageData(over, 0, 0);
    if (scaleMode === "misura" && pts.length) {
      ctx.strokeStyle = "#0a84ff";
      ctx.fillStyle = "#0a84ff";
      ctx.lineWidth = Math.max(2, img.w / 400);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      if (pts[1]) ctx.lineTo(pts[1][0], pts[1][1]);
      ctx.stroke();
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], ctx.lineWidth * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [img, detected, kept, pts, scaleMode]);

  async function load(file: File) {
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      setRadius(Math.min(10, Math.max(3, Math.round(Math.max(w, h) * 0.003))));
      setExcluded(new Set());
      setPts([]);
      setImg({ name: file.name.replace(/\.[^.]+$/, ""), w, h, rgba, bitmap: await createImageBitmap(cv) });
    } catch {
      toast.error("Immagine non leggibile");
    }
  }

  function onCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!img || !detected) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * img.w);
    const y = Math.round(((e.clientY - r.top) / r.height) * img.h);
    if (scaleMode === "misura" && pts.length < 2) {
      setPts((p) => [...p, [x, y]]);
      return;
    }
    // il clic cerca il muro più vicino entro pochi pixel
    let id = 0;
    for (let d = 0; d <= 6 && !id; d++) {
      for (let dy = -d; dy <= d && !id; dy++) for (let dx = -d; dx <= d && !id; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= img.w || yy >= img.h) continue;
        const l = detected.labels[yy * img.w + xx];
        if (l && !detected.small.has(l)) id = l;
      }
    }
    if (!id) return;
    setExcluded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function create() {
    if (!img || !detected || !mmPerPx || !kept.length) return;
    setBusy(true);
    try {
      await new Promise((r) => setTimeout(r, 20));
      const { getManifold } = await import("@/print/manifold");
      const w = await getManifold();
      const section = maskToSection(w, detected.labels, img.w, img.h, new Set(kept.map((k) => k.id)), mmPerPx);
      if (section.isEmpty()) throw new Error("Nessun muro da costruire");
      onWalls({ name: img.name, soup: wallsSoup(section, heightM * 1000), heightM });
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Costruzione dei muri non riuscita");
    } finally {
      setBusy(false);
    }
  }

  const sizeM = bboxPx && mmPerPx ? { w: ((bboxPx.x1 - bboxPx.x0) * mmPerPx) / 1000, h: ((bboxPx.y1 - bboxPx.y0) * mmPerPx) / 1000 } : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[94dvh] max-w-[calc(100%-2rem)] overflow-y-auto rounded-none font-mono sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl font-normal tracking-tight">Dalla pianta ai muri</DialogTitle>
          <DialogDescription className="text-xs text-[#525252]">
            Carica la pianta: i muri spessi diventano pareti da stampare, mobili e scritte si ignorano, porte e finestre restano aperte.
            Tocca un muro per escluderlo o rimetterlo.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[1fr_260px]">
          <div className="flex min-h-[260px] items-center justify-center border border-[#e4e4e4] bg-[#fafafa]">
            {img ? (
              <canvas
                ref={canvas}
                onClick={onCanvasClick}
                className={`max-h-[70dvh] w-full object-contain ${scaleMode === "misura" && pts.length < 2 ? "cursor-crosshair" : "cursor-pointer"}`}
                aria-label="Pianta con i muri trovati"
              />
            ) : (
              <label className="flex cursor-pointer flex-col items-center gap-2 p-10 text-xs text-[#525252]">
                <Upload className="size-6" />
                Carica la pianta (JPG o PNG)
                <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void load(f); }} />
              </label>
            )}
          </div>

          <div className="flex flex-col gap-4 text-xs">
            {img && (
              <>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] uppercase tracking-[0.16em] text-[#525252]">Spessore minimo dei muri</span>
                  <Slider value={[radius]} min={2} max={14} step={1} onValueChange={(v) => setRadius(v[0])} aria-label="Spessore minimo dei muri" />
                  <span className="text-[11px] text-[#6f6f6f]">Più alto: meno linee sottili scambiate per muri. Più basso: prende anche i tramezzi.</span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] uppercase tracking-[0.16em] text-[#525252]">Scala</span>
                  <div className="grid grid-cols-2 border border-[#d4d4d4]">
                    {(["larghezza", "misura"] as const).map((m) => (
                      <button key={m} type="button" aria-pressed={scaleMode === m} onClick={() => { setScaleMode(m); setPts([]); }} className={`px-1 py-1.5 text-[11px] ${scaleMode === m ? "bg-[#171717] text-white" : "hover:bg-[#ededed]"}`}>
                        {m === "larghezza" ? "Larghezza totale" : "Misura nota"}
                      </button>
                    ))}
                  </div>
                  {scaleMode === "larghezza" ? (
                    <label className="flex items-center justify-between gap-2">
                      Larghezza dei muri esterni
                      <span className="flex items-center gap-1">
                        <NumIn value={widthM} onChange={setWidthM} /> m
                      </span>
                    </label>
                  ) : (
                    <>
                      <p className="flex items-center gap-1.5 text-[11px] text-[#525252]">
                        <Ruler className="size-3.5" />
                        {pts.length < 2 ? `Clicca ${pts.length === 0 ? "il primo" : "il secondo"} punto di una misura che conosci` : "Misura segnata"}
                        {pts.length > 0 && <button type="button" onClick={() => setPts([])} className="ml-auto text-[#ff670d] underline">rifai</button>}
                      </p>
                      <label className="flex items-center justify-between gap-2">
                        Lunghezza reale
                        <span className="flex items-center gap-1">
                          <NumIn value={knownM} onChange={setKnownM} /> m
                        </span>
                      </label>
                    </>
                  )}
                </div>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-[11px] uppercase tracking-[0.16em] text-[#525252]">Altezza dei muri</span>
                  <span className="flex items-center gap-1">
                    <NumIn value={heightM} onChange={setHeightM} /> m
                  </span>
                </label>

                <div className="border-t border-[#e4e4e4] pt-3 text-[#3f3f3c]">
                  {kept.length} {kept.length === 1 ? "muro" : "muri"}
                  {excluded.size > 0 && ` · ${excluded.size} esclusi`}
                  {sizeM && <> · {sizeM.w.toFixed(2).replace(".", ",")} × {sizeM.h.toFixed(2).replace(".", ",")} m</>}
                </div>
                <p className="text-[11px] leading-relaxed text-[#6f6f6f]">
                  Porte e finestre diventano aperture a tutta altezza: architravi e davanzali si posano dopo, come di consueto nella stampa in cemento.
                </p>

                <button
                  type="button"
                  disabled={!mmPerPx || !kept.length || busy}
                  onClick={() => void create()}
                  className="flex h-11 items-center justify-center gap-2 bg-[#ff670d] text-xs font-medium uppercase tracking-[0.16em] text-white hover:bg-[#e85c0b] disabled:opacity-40"
                >
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  Crea i muri
                </button>
                <label className="cursor-pointer text-center text-[11px] text-[#525252] underline">
                  Cambia pianta
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void load(f); }} />
                </label>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NumIn({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    const v = Number(raw.replace(",", "."));
    if (Number.isFinite(v) && v > 0) onChange(v);
    setDraft(null);
  };
  return (
    <input
      inputMode="decimal"
      value={draft ?? String(value).replace(".", ",")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") commit((e.target as HTMLInputElement).value); }}
      className="h-8 w-16 border border-[#d4d4d4] bg-transparent px-1.5 text-right text-sm tabular-nums focus-visible:border-[#ff670d] focus-visible:outline-none"
    />
  );
}
