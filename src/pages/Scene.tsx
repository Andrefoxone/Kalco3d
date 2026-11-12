// Kalco3D Scene: ambienti 3D esplorabili con World Labs Marble, da una foto o
// da una descrizione. Dentro la scena si mette un modello della galleria
// (render nel contesto, set per giochi, terreni per Building).
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, Box, Camera, Download, Eye, EyeOff, ImagePlus, Loader2, Mountain, RotateCcw, Sparkles, Trash2, Type } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Slider } from "@/components/ui/slider";
import { trpc } from "@/providers/trpc";
import { SceneView, type SceneViewHandle } from "@/components/scene/SceneView";
import { WORLD_QUALITIES, WORLD_QUALITY_INFO, WORLD_MESH_CREDITS, type WorldQuality } from "@contracts/worlds";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";

type WorldItem = inferRouterOutputs<AppRouter>["worlds"]["list"][number];

const MAX_SIDE = 2048;

/** Foto ridotta a 2048 px (JPEG): basta al motore e il caricamento è veloce. */
async function photoToBase64(file: File): Promise<{ base64: string; preview: string }> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), preview: dataUrl };
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function openUrl(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const mb = (n: number) => `${(n / 1048576).toLocaleString("it-IT", { maximumFractionDigits: 1 })} MB`;

export default function Scene() {
  const utils = trpc.useUtils();
  const status = trpc.worlds.status.useQuery(undefined, { staleTime: 300_000 });
  const list = trpc.worlds.list.useQuery(undefined, {
    refetchInterval: (q) => ((q.state.data ?? []).some((w) => w.status === "processing" || w.meshStatus === "processing") ? 4000 : false),
  });
  const models = trpc.models.list.useQuery(undefined, { staleTime: 30_000 });
  const account = trpc.billing.account.useQuery(undefined, { staleTime: 15_000 });
  const generate = trpc.worlds.generate.useMutation();
  const exportMesh = trpc.worlds.exportMesh.useMutation();
  const remove = trpc.worlds.remove.useMutation();
  const fetchHq = trpc.worlds.fetchHq.useMutation();

  // creazione
  const [mode, setMode] = useState<"foto" | "testo">("foto");
  const [photo, setPhoto] = useState<{ base64: string; preview: string } | null>(null);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [quality, setQuality] = useState<WorldQuality>("standard");

  // visualizzazione
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [view, setView] = useState({ loading: false, progress: 0, error: null as string | null });
  const [showCollider, setShowCollider] = useState(false);
  // alta qualità di default sui computer; sul telefono la versione leggera
  const [hq, setHq] = useState(() => typeof window === "undefined" || window.innerWidth >= 1024);
  const [modelId, setModelId] = useState<number | null>(null);
  const [heightM, setHeightM] = useState(0.6);
  const [rotationDeg, setRotationDeg] = useState(0);
  const viewer = useRef<SceneViewHandle>(null);

  const items = list.data ?? [];
  const selected: WorldItem | null = items.find((w) => w.id === selectedId && w.status === "ready" && w.spzUrl) ?? null;
  const readyModels = (models.data ?? []).filter((m) => m.status === "ready" && m.glbUrl);
  const chosenModel = readyModels.find((m) => m.id === modelId) ?? null;
  const admin = account.data?.admin ?? false;
  const cost = admin ? 0 : WORLD_QUALITY_INFO[quality].credits;
  const enabled = status.data?.enabled ?? false;
  const canSubmit = enabled && !generate.isPending && name.trim().length > 0 && (mode === "foto" ? Boolean(photo) : text.trim().length >= 3);

  // gli URL firmati cambiano a ogni aggiornamento della lista: il visualizzatore
  // ricarica solo se cambia la scena (chiave = id + percorso del file)
  const useHq = hq && Boolean(selected?.spzHqUrl);
  const activeSpz = selected ? (useHq ? selected.spzHqUrl! : selected.spzUrl!) : null;
  const sceneWorld = useMemo(
    () =>
      selected
        ? {
            id: selected.id,
            spzUrl: activeSpz!,
            colliderUrl: selected.colliderUrl,
            panoUrl: selected.panoUrl,
            metricScale: selected.metricScale,
            groundOffset: selected.groundOffset,
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected?.id, activeSpz?.split("?")[0]],
  );
  const sceneObject = useMemo(
    () => (chosenModel?.glbUrl ? { url: chosenModel.glbUrl, heightM, rotationDeg } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chosenModel?.id, chosenModel?.glbUrl?.split("?")[0], heightM, rotationDeg],
  );

  async function onPhoto(file: File) {
    try {
      const p = await photoToBase64(file);
      setPhoto(p);
      if (!name) setName(file.name.replace(/\.[^.]+$/, "").slice(0, 80));
    } catch {
      toast.error("Non riesco a leggere questa immagine");
    }
  }

  async function submit() {
    try {
      const w = await generate.mutateAsync({
        name: name.trim(),
        quality,
        text: text.trim() || undefined,
        photoBase64: mode === "foto" ? photo?.base64 : undefined,
      });
      toast.success("Scena in lavorazione: ci vogliono alcuni minuti");
      setSelectedId(w.id);
      void utils.worlds.list.invalidate();
      void utils.billing.account.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Creazione non riuscita");
    }
  }

  async function askMesh(w: WorldItem) {
    try {
      await exportMesh.mutateAsync({ id: w.id });
      toast.success("Preparo la mesh della scena");
      void utils.worlds.list.invalidate();
      void utils.billing.account.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export non riuscito");
    }
  }

  async function download(w: WorldItem, file: "spz" | "mesh" | "collider" | "pano") {
    try {
      const { url } = await utils.worlds.download.fetch({ id: w.id, file });
      openUrl(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download non riuscito");
    }
  }

  async function loadHq(w: WorldItem) {
    try {
      await fetchHq.mutateAsync({ id: w.id });
      toast.success("Alta qualità pronta");
      setHq(true);
      void utils.worlds.list.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Alta qualità non disponibile");
    }
  }

  async function del(w: WorldItem) {
    if (!window.confirm(`Eliminare la scena «${w.name}»?`)) return;
    try {
      await remove.mutateAsync({ id: w.id });
      if (selectedId === w.id) setSelectedId(null);
      void utils.worlds.list.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Eliminazione non riuscita");
    }
  }

  async function snapshot() {
    const blob = await viewer.current?.snapshot();
    if (!blob) return toast.error("Foto non riuscita");
    downloadBlob(blob, `${selected?.name ?? "scena"}${chosenModel ? ` - ${chosenModel.name}` : ""}.png`);
  }

  return (
    <div className="flex h-dvh flex-col bg-[#f7f7f5] font-mono text-[#171717]">
      <Toaster />
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[#e4e4e4] px-4 lg:px-6">
        <div className="flex items-baseline gap-2.5">
          <span className="inline-block size-2.5 rounded-full bg-[#ff670d]" aria-hidden="true" />
          <span className="font-display text-2xl leading-none tracking-tight">Kalco3D</span>
          <span className="text-[11px] uppercase tracking-[0.22em] text-[#ff670d]">Scene</span>
        </div>
        <Link to="/" className="flex items-center gap-1.5 border border-[#d4d4d4] px-2 py-1 text-[11px] uppercase tracking-[0.16em] hover:bg-[#171717] hover:text-white">
          <ArrowLeft className="size-3.5" /> Studio
        </Link>
      </header>

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="relative h-[50vh] flex-none bg-[#1b1b1d] lg:h-auto lg:flex-1">
          <SceneView ref={viewer} world={sceneWorld} object={sceneObject} showCollider={showCollider} onStatus={setView} />
          {!selected && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-[#9a9aab]">
              <Mountain className="size-8" />
              <p className="max-w-sm text-sm">Crea una scena da una foto o da una descrizione, oppure aprine una dall'elenco.</p>
            </div>
          )}
          {selected && view.loading && (
            <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
              <span className="flex items-center gap-2 bg-black/60 px-3 py-1.5 text-[11px] text-white">
                <Loader2 className="size-3.5 animate-spin" /> Carico la scena {view.progress > 0 ? `${view.progress}%` : ""}
              </span>
            </div>
          )}
          {selected && view.error && (
            <div className="absolute inset-x-4 top-4 bg-red-600/90 px-3 py-2 text-xs text-white">Scena non caricata: {view.error}</div>
          )}
          {selected && (
            <div className="absolute inset-x-4 bottom-4 flex flex-wrap items-center gap-2 text-[11px] text-white">
              <span className="bg-black/60 px-2 py-1.5">Trascina per guardarti intorno · WASD o frecce per muoverti · Q/E giù/su{chosenModel ? " · clic per posizionare l'oggetto" : ""}</span>
              <div className="ml-auto flex gap-1.5">
                {selected.spzHqUrl ? (
                  <ToolButton onClick={() => setHq((v) => !v)} label={useHq ? "Passa alla versione leggera" : "Passa all'alta qualità"}>
                    <Sparkles className="size-3.5" /> {useHq ? "Alta qualità" : "Leggera"}
                  </ToolButton>
                ) : selected.canFetchHq ? (
                  <ToolButton onClick={() => void loadHq(selected)} label="Carica l'alta qualità">
                    {fetchHq.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Carica alta qualità
                  </ToolButton>
                ) : null}
                <ToolButton onClick={() => viewer.current?.resetCamera()} label="Punto di partenza"><RotateCcw className="size-3.5" /></ToolButton>
                {selected.colliderUrl && (
                  <ToolButton onClick={() => setShowCollider((v) => !v)} label={showCollider ? "Nascondi collisioni" : "Mostra collisioni"}>
                    {showCollider ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </ToolButton>
                )}
                <ToolButton onClick={() => void snapshot()} label="Scatta foto"><Camera className="size-3.5" /> Foto</ToolButton>
              </div>
            </div>
          )}
        </section>

        <aside className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto border-t border-[#e4e4e4] bg-[#fcfcfc] lg:w-[400px] lg:flex-none lg:border-l lg:border-t-0">
          <div className="flex flex-col gap-6 p-5">
            <div>
              <h1 className="font-display text-xl leading-tight tracking-tight">Scene 3D</h1>
              <p className="mt-1 text-xs leading-relaxed text-[#525252]">
                Ambienti esplorabili generati dall'AI: metti i tuoi modelli nel contesto giusto, prepara set per giochi e render, studia un terreno prima di costruire.
              </p>
            </div>

            {status.data && !enabled && (
              <p className="border border-[#e6c86e] bg-[#fff8e1] px-3 py-2 text-xs leading-relaxed text-[#6b5900]">
                Le scene non sono ancora attive su questo server: serve la chiave <code>WORLDLABS_API_KEY</code>.
              </p>
            )}

            <Section title="1 · Nuova scena">
              <div className="grid grid-cols-2 border border-[#d4d4d4] text-xs">
                <TabButton active={mode === "foto"} onClick={() => setMode("foto")}><ImagePlus className="size-3.5" /> Da foto</TabButton>
                <TabButton active={mode === "testo"} onClick={() => setMode("testo")}><Type className="size-3.5" /> Da testo</TabButton>
              </div>
              {mode === "foto" && (
                <label className="flex cursor-pointer flex-col items-center justify-center gap-2 border border-dashed border-[#bdbdbd] p-2 text-xs text-[#525252] hover:bg-[#f2f2f2]">
                  {photo ? (
                    <img src={photo.preview} alt="Foto della scena" className="max-h-40 w-full object-contain" />
                  ) : (
                    <span className="flex items-center gap-2 py-4"><ImagePlus className="size-4" /> Foto di un ambiente, una stanza, un terreno o un panorama 360°</span>
                  )}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void onPhoto(f);
                    }}
                  />
                </label>
              )}
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={2000}
                rows={mode === "testo" ? 4 : 2}
                placeholder={mode === "testo" ? "Es. cortile di una masseria pugliese al tramonto, muri a secco, ulivi" : "Indicazioni facoltative sulla scena"}
                className="w-full resize-y border border-[#d4d4d4] bg-transparent px-2 py-1.5 text-sm focus-visible:border-[#ff670d] focus-visible:outline-none"
              />
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder="Nome della scena"
                className="h-9 w-full border border-[#d4d4d4] bg-transparent px-2 text-sm focus-visible:border-[#ff670d] focus-visible:outline-none"
              />
              <div className="flex flex-col gap-1" role="radiogroup" aria-label="Qualità">
                {WORLD_QUALITIES.map((q) => {
                  const info = WORLD_QUALITY_INFO[q];
                  return (
                    <button
                      key={q}
                      type="button"
                      role="radio"
                      aria-checked={quality === q}
                      onClick={() => setQuality(q)}
                      className={`flex items-center justify-between border px-2.5 py-1.5 text-left text-xs ${quality === q ? "border-[#ff670d] bg-[#fff4ec]" : "border-[#e4e4e4] hover:bg-[#f2f2f2]"}`}
                    >
                      <span>
                        <span className="font-semibold">{info.label}</span>
                        <span className="ml-2 text-[#6f6f6f]">{info.hint}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-[#525252]">{admin ? "—" : `${info.credits} cr.`}</span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => void submit()}
                className="flex h-10 items-center justify-center gap-2 bg-[#171717] text-xs uppercase tracking-[0.16em] text-white hover:bg-[#ff670d] disabled:cursor-not-allowed disabled:bg-[#bdbdbd]"
              >
                {generate.isPending ? <Loader2 className="size-4 animate-spin" /> : <Mountain className="size-4" />}
                Crea scena{cost > 0 ? ` · ${cost} crediti` : ""}
              </button>
            </Section>

            <Section title="2 · Le tue scene">
              {list.isLoading && <p className="text-xs text-[#6f6f6f]">Carico…</p>}
              {!list.isLoading && items.length === 0 && <p className="text-xs text-[#6f6f6f]">Ancora nessuna scena.</p>}
              <ul className="flex flex-col gap-2">
                {items.map((w) => (
                  <li key={w.id} className={`border ${selectedId === w.id ? "border-[#ff670d]" : "border-[#e4e4e4]"} bg-white`}>
                    <button
                      type="button"
                      disabled={w.status !== "ready"}
                      onClick={() => setSelectedId(w.id)}
                      className="flex w-full gap-3 p-2 text-left disabled:cursor-default"
                    >
                      <div className="size-16 shrink-0 overflow-hidden bg-[#1b1b1d]">
                        {(w.thumbUrl ?? w.photoUrl) && <img src={(w.thumbUrl ?? w.photoUrl)!} alt="" className="size-full object-cover" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{w.name}</div>
                        <div className="text-[11px] text-[#6f6f6f]">
                          {WORLD_QUALITY_INFO[w.quality as WorldQuality]?.label ?? w.quality} · {w.source === "foto" ? "da foto" : "da testo"}
                          {w.status === "ready" && w.sizeBytes > 0 ? ` · ${mb(w.spzHqBytes || w.sizeBytes)}` : ""}
                          {w.status === "ready" && w.spzHqUrl ? " · alta qualità" : ""}
                        </div>
                        {w.status === "processing" && (
                          <div className="mt-1.5">
                            <div className="h-1 bg-[#eee]"><div className="h-1 bg-[#ff670d] transition-all" style={{ width: `${Math.max(3, w.progress)}%` }} /></div>
                            <div className="mt-1 truncate text-[11px] text-[#525252]">{w.stage ?? "In lavorazione"}</div>
                          </div>
                        )}
                        {w.status === "failed" && <div className="mt-1 line-clamp-2 text-[11px] text-red-600">{w.error ?? "Non riuscita"}{w.stage ? ` · ${w.stage}` : ""}</div>}
                        {w.status === "ready" && w.caption && <div className="mt-1 line-clamp-2 text-[11px] text-[#525252]">{w.caption}</div>}
                      </div>
                    </button>
                    {w.status !== "processing" && (
                      <div className="flex flex-wrap gap-1 border-t border-[#f0f0f0] px-2 py-1.5 text-[11px]">
                        {w.status === "ready" && (
                          <>
                            <SmallButton onClick={() => void download(w, "spz")}><Download className="size-3" /> SPZ</SmallButton>
                            {w.meshStatus === "ready" ? (
                              <SmallButton onClick={() => void download(w, "mesh")}><Download className="size-3" /> Mesh GLB</SmallButton>
                            ) : w.meshStatus === "processing" ? (
                              <span className="flex items-center gap-1 px-1.5 py-0.5 text-[#525252]"><Loader2 className="size-3 animate-spin" /> Mesh in preparazione</span>
                            ) : (
                              <SmallButton onClick={() => void askMesh(w)} disabled={exportMesh.isPending || !enabled}>
                                <Box className="size-3" /> Mesh GLB{admin ? "" : ` · ${status.data?.meshCredits ?? WORLD_MESH_CREDITS} cr.`}
                              </SmallButton>
                            )}
                            {w.colliderUrl && <SmallButton onClick={() => void download(w, "collider")}><Download className="size-3" /> Collisione</SmallButton>}
                            {w.panoUrl && <SmallButton onClick={() => void download(w, "pano")}><Download className="size-3" /> Panorama</SmallButton>}
                          </>
                        )}
                        <SmallButton onClick={() => void del(w)} className="ml-auto text-red-600"><Trash2 className="size-3" /></SmallButton>
                        {w.meshStatus === "failed" && w.meshError && <div className="w-full text-red-600">Mesh: {w.meshError} · crediti restituiti</div>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="3 · Il tuo modello nella scena">
              <select
                value={modelId ?? ""}
                onChange={(e) => setModelId(e.target.value ? Number(e.target.value) : null)}
                disabled={!selected}
                className="h-9 w-full border border-[#d4d4d4] bg-transparent px-2 text-sm focus-visible:border-[#ff670d] focus-visible:outline-none disabled:opacity-50"
                aria-label="Modello dalla galleria"
              >
                <option value="">{!selected ? "Apri prima una scena" : models.isLoading ? "Carico la galleria…" : "Nessun modello"}</option>
                {readyModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {chosenModel && selected && (
                <>
                  <Labeled label="Altezza reale" value={`${heightM.toLocaleString("it-IT", { maximumFractionDigits: 2 })} m`}>
                    <Slider value={[heightM]} min={0.05} max={8} step={0.05} onValueChange={(v) => setHeightM(v[0])} aria-label="Altezza reale" />
                  </Labeled>
                  <Labeled label="Rotazione" value={`${rotationDeg}°`}>
                    <Slider value={[rotationDeg]} min={-180} max={180} step={5} onValueChange={(v) => setRotationDeg(v[0])} aria-label="Rotazione" />
                  </Labeled>
                  <p className="text-[11px] leading-relaxed text-[#6f6f6f]">
                    Clicca su un punto della scena per appoggiarci il modello. La luce e i riflessi del modello vengono dal panorama della scena.
                  </p>
                </>
              )}
            </Section>
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

function Labeled({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-xs text-[#525252]">
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      {children}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`flex items-center justify-center gap-1.5 py-2 ${active ? "bg-[#171717] text-white" : "hover:bg-[#f2f2f2]"}`}>
      {children}
    </button>
  );
}

function SmallButton({ onClick, children, disabled, className = "" }: { onClick: () => void; children: React.ReactNode; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 border border-[#e4e4e4] px-1.5 py-0.5 hover:bg-[#171717] hover:text-white disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

function ToolButton({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className="flex items-center gap-1 bg-black/60 px-2 py-1.5 hover:bg-[#ff670d]">
      {children}
    </button>
  );
}
