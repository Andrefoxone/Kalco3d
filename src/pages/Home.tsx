import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/providers/trpc";
import { useAuth } from "@/lib/auth";
import { Viewport3D, type ViewportHandle } from "@/components/Viewport3D";
import { ViewportToolbar } from "@/components/ViewportToolbar";
import { CreatePanel } from "@/components/CreatePanel";
import { AiCreatePanel, type IncomingPhoto } from "@/components/AiCreatePanel";
import { PhotosPanel } from "@/components/PhotosPanel";
import { BillingWidget } from "@/components/BillingWidget";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { GalleryPanel } from "@/components/GalleryPanel";
import { StylePanel } from "@/components/StylePanel";
import { VariantsPanel } from "@/components/VariantsPanel";
import { AnimatePanel } from "@/components/AnimatePanel";
import { PrintPanel } from "@/components/PrintPanel";
import { CadImportPanel } from "@/components/CadImportPanel";
import { importCadFile } from "@/lib/cadImport";
import { drawSample } from "@/lib/photo";
import { suggestedLongestMm, type PrintReport } from "@/three/printCheck";
import type { LoadedPhoto } from "@/lib/photo";
import type { ModelItemDTO } from "@/types/model";
import type { Tool } from "@/types/tools";
import {
  DEFAULT_MATERIAL,
  type BackgroundPreset,
  type CameraView,
  type LightingPreset,
  type LoadState,
  type MaterialStyle,
} from "@/three/scene";
import { Grid2x2, RotateCw, Crosshair, Loader2, Undo2, Redo2, ChevronDown } from "lucide-react";

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Riduce un'immagine (data URL) a lato massimo `max` e la restituisce in PNG base64. */
async function shrinkToPngBase64(dataUrl: string, max: number): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * s));
  c.height = Math.max(1, Math.round(img.height * s));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/png").split(",")[1] ?? "";
}

function downloadBuffer(buf: ArrayBuffer, name: string, mime: string) {
  const blob = new Blob([buf], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default function Home() {
  const viewportRef = useRef<ViewportHandle>(null);
  const [photo, setPhoto] = useState<LoadedPhoto | null>(null);
  const [active, setActive] = useState<ModelItemDTO | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("empty");
  const [wireframe, setWireframe] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [tab, setTab] = useState("crea");
  const [incomingPhoto, setIncomingPhoto] = useState<IncomingPhoto | null>(null);
  // strumenti di editing
  const [tool, setTool] = useState<Tool>("orbit");
  const [brushRadius, setBrushRadius] = useState(0.3);
  const [brushStrength, setBrushStrength] = useState(0.5);
  const [symmetry, setSymmetry] = useState(false);
  const [material, setMaterial] = useState<MaterialStyle>({ ...DEFAULT_MATERIAL });
  const [lighting, setLighting] = useState<LightingPreset>("studio");
  const [background, setBackground] = useState<BackgroundPreset>("scuro");
  const [gridOn, setGridOn] = useState(true);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [aiPolling, setAiPolling] = useState(false);
  const [sizeMm, setSizeMm] = useState(100);
  const [sizeFromSource, setSizeFromSource] = useState(false);
  const [printReport, setPrintReport] = useState<PrintReport | null>(null);
  const [cadBusy, setCadBusy] = useState(false);
  const [clips, setClips] = useState<string[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const auth = useAuth();
  const list = trpc.models.list.useQuery(undefined, {
    staleTime: 4 * 60 * 1000,
    // gli URL firmati durano ~10 min; con generazioni AI in corso il polling
    // si stringe a 5 s per aggiornare le card appena il modello è pronto
    refetchInterval: aiPolling ? 5_000 : 5 * 60 * 1000,
  });
  const items = (list.data ?? []) as ModelItemDTO[];
  const saveEdited = trpc.models.saveEdited.useMutation();
  const importCad = trpc.models.importCad.useMutation();

  const hasModel = loadState === "ready";

  // attiva il polling veloce finché ci sono job AI in lavorazione
  useEffect(() => {
    setAiPolling(items.some((i) => i.status === "processing"));
  }, [items]);

  // notifica quando una generazione AI termina (bene o male)
  const knownStatuses = useRef<Map<number, string> | null>(null);
  useEffect(() => {
    if (!list.data) return;
    const prev = knownStatuses.current;
    const next = new Map<number, string>();
    for (const item of items) {
      next.set(item.id, item.status);
      const before = prev?.get(item.id);
      if (before === "processing" && item.status === "ready") {
        toast.success(`"${item.name}" è pronto: lo trovi in Modelli`, { duration: 6000 });
      } else if (before === "processing" && item.status === "failed") {
        toast.error(`Generazione AI di "${item.name}" fallita: ${item.error ?? "errore sconosciuto"}`, {
          duration: 8000,
        });
      }
    }
    knownStatuses.current = next;
  }, [items, list.data]);

  // Ctrl/Cmd+Z e Ctrl+Shift+Z / Ctrl+Y per la cronologia delle modifiche
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k !== "z" && k !== "y") return;
      e.preventDefault();
      if (k === "y" || e.shiftKey) {
        viewportRef.current?.redo();
      } else {
        viewportRef.current?.undo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** dopo il caricamento: misura reale suggerita e controllo di stampabilità */
  const afterLoad = useCallback((item: ModelItemDTO) => {
    const vp = viewportRef.current;
    const src = vp?.getSourceMaxDim() ?? null;
    // i motori in scala reale (e-commerce, stampa) restituiscono metri;
    // i file CAD sono quasi sempre in millimetri
    const isCad = item.mode === "cad";
    const real = isCad || (item.mode === "ai" && (item.target === "ecommerce" || item.target === "stampa"));
    const mm = real ? suggestedLongestMm(src, isCad ? "mm" : "m") : 100;
    setSizeMm(mm);
    setSizeFromSource(real && mm !== 100);
    setPrintReport(null);
    // l'analisi può richiedere qualche centinaio di ms: dopo il primo frame
    setTimeout(() => setPrintReport(viewportRef.current?.analyzePrint() ?? null), 60);
  }, []);

  const resetTools = useCallback(() => {
    setTool("orbit");
    viewportRef.current?.setTransformMode(null);
    viewportRef.current?.setSculptMode(null);
    viewportRef.current?.setWireframe(false);
    setWireframe(false);
  }, []);

  const openModel = useCallback(
    async (item: ModelItemDTO) => {
      if (item.status !== "ready") return; // job AI ancora in lavorazione
      setActive(item);
      if (!item.glbUrl) return;
      const ok = await viewportRef.current?.loadModel(item.glbUrl);
      if (!ok) {
        // URL probabilmente scaduto: rinfresca e riprova una volta
        const fresh = await utils.models.list.fetch();
        const f = (fresh as ModelItemDTO[]).find((m) => m.id === item.id);
        if (f?.glbUrl) {
          const retry = await viewportRef.current?.loadModel(f.glbUrl);
          if (retry) {
            setActive(f);
            resetTools();
            afterLoad(f);
            return;
          }
        }
        toast.error("Impossibile caricare il modello");
        return;
      }
      resetTools();
      afterLoad(item);
    },
    [utils, resetTools, afterLoad],
  );

  const handleGenerated = useCallback(
    (item: ModelItemDTO) => {
      void openModel(item);
    },
    [openModel],
  );

  // Import CAD: il browser converte il file in geometria (WASM locale),
  // lo mostra nel viewport e lo salva in galleria come GLB + anteprima.
  const handleCadFile = useCallback(
    async (file: File) => {
      setCadBusy(true);
      try {
        const result = await importCadFile(file);
        const ok = viewportRef.current?.setModelFromObject(result.object);
        if (!ok) throw new Error("Il modello non è stato accettato dal visualizzatore");
        setActive(null);
        setPrintReport(null);
        const buf = await viewportRef.current?.exportGLB();
        // una sola vista, ridotta: a piena risoluzione su schermi retina la PNG
        // superava il limite del server e l'import falliva
        const full = viewportRef.current?.captureViews(["tre-quarti"])?.[0]?.dataUrl ?? null;
        const shot = full ? await shrinkToPngBase64(full, 640) : null;
        if (buf && shot) {
          const stats = viewportRef.current?.getStats() ?? { vertices: 0, triangles: 0 };
          const item = await importCad.mutateAsync({
            name: file.name.replace(/\.[^.]+$/, "").slice(0, 80),
            sourceFormat: result.format,
            glbBase64: arrayBufferToBase64(buf),
            previewPngBase64: shot,
            vertices: stats.vertices,
            triangles: stats.triangles,
          });
          await utils.models.list.invalidate();
          void openModel(item as ModelItemDTO);
        }
        toast.success(`«${file.name}» importato (${result.stats})`, { duration: 5000 });
        if (result.skipped.length > 0) {
          toast.info(`Elementi non importati: ${result.skipped.join(", ")}`, { duration: 6000 });
        }
      } finally {
        setCadBusy(false);
      }
    },
    [importCad, utils, openModel],
  );

  const handleDownload = useCallback(
    async (item: ModelItemDTO, format: "glb" | "fbx" = "glb") => {
      try {
        const { url, name } = await utils.models.download.fetch({ id: item.id, format });
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch {
        toast.error("Download non riuscito, riprova");
      }
    },
    [utils],
  );

  function handleSampleFromViewport() {
    const canvas = drawSample();
    setPhoto({
      canvas,
      width: canvas.width,
      height: canvas.height,
      previewUrl: canvas.toDataURL("image/jpeg", 0.85),
      fileName: "esempio-lunare.jpg",
    });
    setTab("crea");
  }

  // ---------- strumenti ----------

  function handleTool(t: Tool) {
    setTool(t);
    const vp = viewportRef.current;
    if (t === "orbit") {
      vp?.setTransformMode(null);
      vp?.setSculptMode(null);
    } else if (t === "translate" || t === "rotate" || t === "scale") {
      vp?.setSculptMode(null);
      vp?.setTransformMode(t);
    } else {
      vp?.setTransformMode(null);
      vp?.setSculptMode(t);
    }
  }

  function handleBrush(radius: number, strength: number) {
    setBrushRadius(radius);
    setBrushStrength(strength);
    viewportRef.current?.setSculptParams(radius, strength);
  }

  function handleMaterial(m: MaterialStyle) {
    setMaterial(m);
    viewportRef.current?.applyMaterialStyle(m);
  }

  function handleLighting(l: LightingPreset) {
    setLighting(l);
    viewportRef.current?.setLighting(l);
  }

  function handleBackground(b: BackgroundPreset) {
    setBackground(b);
    viewportRef.current?.setBackground(b);
  }

  function handleGrid(on: boolean) {
    setGridOn(on);
    viewportRef.current?.setGridVisible(on);
  }

  function handleView(v: CameraView) {
    viewportRef.current?.setView(v);
  }

  // ---------- export ----------

  async function handleSaveEdit() {
    if (!active) {
      toast.error("Carica prima un modello dalla galleria");
      return;
    }
    const buf = await viewportRef.current?.exportGLB();
    if (!buf) {
      toast.error("Esportazione del modello non riuscita");
      return;
    }
    const stats = viewportRef.current?.getStats() ?? { vertices: 0, triangles: 0 };
    try {
      const item = await saveEdited.mutateAsync({
        name: `${active.name} (modifica)`.slice(0, 80),
        parentId: active.id,
        glbBase64: arrayBufferToBase64(buf),
        vertices: stats.vertices,
        triangles: stats.triangles,
      });
      await utils.models.list.invalidate();
      setActive(item as ModelItemDTO);
      toast.success("Modifica salvata in Modelli");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Salvataggio non riuscito");
    }
  }

  async function handleExportGLB() {
    const buf = await viewportRef.current?.exportGLB();
    if (!buf) {
      toast.error("Esportazione non riuscita");
      return;
    }
    downloadBuffer(buf, `${active?.name ?? "modello"}.glb`, "model/gltf-binary");
    toast.success("GLB scaricato");
  }

  function handleExportSTL() {
    const buf = viewportRef.current?.exportSTL(sizeMm);
    if (!buf) {
      toast.error("Esportazione STL non riuscita");
      return;
    }
    downloadBuffer(buf, `${active?.name ?? "modello"}-${sizeMm}mm.stl`, "model/stl");
    toast.success(`STL scaricato: ${sizeMm} mm sul lato più lungo, Z in alto`);
  }

  async function handleExportUSDZ() {
    const buf = await viewportRef.current?.exportUSDZ(sizeMm);
    if (!buf) {
      toast.error("Esportazione USDZ non riuscita");
      return;
    }
    downloadBuffer(buf, `${active?.name ?? "modello"}.usdz`, "model/vnd.usdz+zip");
    toast.success("USDZ scaricato: aprilo su iPhone o iPad per vederlo in AR");
  }

  const count = items.length;

  return (
    <div className="flex min-h-dvh flex-col bg-[#fcfcfc] font-mono text-[#171717] lg:h-dvh lg:overflow-hidden">
      {/* header */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[#e4e4e4] px-4 lg:px-6">
        <div className="flex items-baseline gap-2.5">
          <span className="inline-block size-2.5 rounded-full bg-[#ff670d]" aria-hidden="true" />
          <span className="font-display text-2xl leading-none tracking-tight">Kalco3D</span>
          <span className="text-[11px] uppercase tracking-[0.22em] text-[#6f6f6f]">photo to 3D</span>
          <Link
            to="/building"
            className="ml-3 self-center border border-[#ff670d] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[#ff670d] transition-colors hover:bg-[#ff670d] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d]"
          >
            Building
          </Link>
        </div>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[#6f6f6f]">
          <span
            className={`inline-block size-1.5 rounded-full ${
              list.isError ? "bg-red-500" : "animate-pulse bg-[#ff670d]"
            }`}
            aria-hidden="true"
          />
          {list.isError
            ? "archivio offline"
            : `${count} ${count === 1 ? "modello" : "modelli"} in archivio`}
          {auth.email && (
            <>
              <span className="ml-3 hidden normal-case tracking-normal text-[#525252] sm:inline">{auth.email}</span>
              <span className="ml-2"><BillingWidget /></span>
              <button
                type="button"
                onClick={() => void auth.signOut()}
                className="ml-2 border border-[#d4d4d4] px-2 py-1 text-[#171717] transition-colors hover:bg-[#171717] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d]"
              >
                Esci
              </button>
            </>
          )}
        </div>
      </header>

      {/* corpo */}
      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* viewport */}
        <section className="relative h-[54dvh] shrink-0 overflow-hidden bg-[#101013] lg:h-auto lg:flex-1">
          <Viewport3D
            ref={viewportRef}
            onStateChange={setLoadState}
            onAnimations={(names) => {
              setClips(names);
              setPlaying(names[0] ?? null);
            }}
            onHistoryChange={(u, r) => {
              setCanUndo(u);
              setCanRedo(r);
            }}
          />

          {/* barra superiore: nome modello + controlli vista */}
          <div className="absolute inset-x-3 top-3 flex items-center justify-between gap-3">
            <div className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-[#4a4a5a54] bg-[#1e1e24f5] px-3 backdrop-blur-[8px]">
              <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.2em] text-[#9a9aab] [text-shadow:1px_1px_5px_rgba(0,0,0,0.7)]">
                Viewport
              </span>
              {active && (
                <span className="truncate text-xs text-[#e0e0e0] [text-shadow:1px_1px_5px_rgba(0,0,0,0.7)]">
                  {active.name}
                  <span className="ml-2 text-[#9a9aab]">
                    {active.vertices.toLocaleString("it-IT")} vertici
                  </span>
                </span>
              )}
            </div>
            <div className="flex shrink-0 gap-1.5 rounded-lg border border-[#4a4a5a54] bg-[#1e1e24f5] p-1.5 backdrop-blur-[8px]">
              <ViewportButton
                label="Annulla (Ctrl+Z)"
                disabled={!canUndo}
                onClick={() => viewportRef.current?.undo()}
              >
                <Undo2 className="size-4" />
              </ViewportButton>
              <ViewportButton
                label="Ripeti (Ctrl+Maiusc+Z)"
                disabled={!canRedo}
                onClick={() => viewportRef.current?.redo()}
              >
                <Redo2 className="size-4" />
              </ViewportButton>
              <ViewportButton
                label="Wireframe"
                pressed={wireframe}
                onClick={() => {
                  const next = !wireframe;
                  setWireframe(next);
                  viewportRef.current?.setWireframe(next);
                }}
              >
                <Grid2x2 className="size-4" />
              </ViewportButton>
              <ViewportButton
                label="Rotazione automatica"
                pressed={autoRotate}
                onClick={() => {
                  const next = !autoRotate;
                  setAutoRotate(next);
                  viewportRef.current?.setAutoRotate(next);
                }}
              >
                <RotateCw className="size-4" />
              </ViewportButton>
              <ViewportButton
                label="Ripristina visuale"
                onClick={() => viewportRef.current?.resetCamera()}
              >
                <Crosshair className="size-4" />
              </ViewportButton>
            </div>
          </div>

          {/* toolbar strumenti */}
          <ViewportToolbar
            tool={tool}
            onTool={handleTool}
            hasModel={hasModel}
            brushRadius={brushRadius}
            brushStrength={brushStrength}
            onBrush={handleBrush}
            symmetry={symmetry}
            onSymmetry={(on) => {
              setSymmetry(on);
              viewportRef.current?.setSculptSymmetry(on);
            }}
          />

          {/* stato caricamento */}
          {loadState === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="size-6 animate-spin text-[#ff670d]" />
            </div>
          )}

          {/* stato vuoto */}
          {loadState === "empty" && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
              <p className="max-w-xs text-sm leading-relaxed text-[#9a9aab] [text-shadow:1px_1px_5px_rgba(0,0,0,0.7)]">
                Il tuo modello apparirà qui. Carica una foto dal pannello oppure parti da un
                esempio.
              </p>
              <button
                type="button"
                onClick={handleSampleFromViewport}
                className="pointer-events-auto rounded-lg border border-[#ff670d] px-4 py-2.5 text-xs font-medium uppercase tracking-[0.18em] text-[#ff670d] transition-all duration-150 hover:bg-[#ff670d] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] active:scale-95"
              >
                Prova l'esempio lunare
              </button>
            </div>
          )}

          <div className="pointer-events-none absolute inset-x-0 bottom-3 hidden text-center text-[11px] uppercase tracking-[0.2em] text-[#9a9aab] [text-shadow:1px_1px_5px_rgba(0,0,0,0.7)] sm:block">
            trascina per ruotare · rotellina per lo zoom
          </div>
        </section>

        {/* pannello */}
        <aside className="flex min-h-0 w-full flex-1 flex-col border-t border-[#e4e4e4] bg-[#fcfcfc] lg:w-96 lg:flex-none lg:border-l lg:border-t-0">
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="grid h-[52px] w-full shrink-0 grid-cols-7 rounded-none border-b border-[#e4e4e4] bg-transparent p-0">
              <TabsTrigger
                value="crea"
                className="h-full rounded-none px-0.5 text-[10px] uppercase tracking-[0.06em] data-[state=active]:bg-transparent data-[state=active]:text-[#ff670d] data-[state=active]:shadow-[inset_0_-2px_0_#ff670d]"
              >
                Crea
              </TabsTrigger>
              <TabsTrigger
                value="stile"
                className="h-full rounded-none px-0.5 text-[10px] uppercase tracking-[0.06em] data-[state=active]:bg-transparent data-[state=active]:text-[#ff670d] data-[state=active]:shadow-[inset_0_-2px_0_#ff670d]"
              >
                Stile
              </TabsTrigger>
              <TabsTrigger
                value="varianti"
                className="h-full rounded-none px-0.5 text-[10px] uppercase tracking-[0.06em] data-[state=active]:bg-transparent data-[state=active]:text-[#ff670d] data-[state=active]:shadow-[inset_0_-2px_0_#ff670d]"
              >
                Varianti
              </TabsTrigger>
              <TabsTrigger
                value="stampa"
                className="h-full rounded-none px-0.5 text-[10px] uppercase tracking-[0.06em] data-[state=active]:bg-transparent data-[state=active]:text-[#ff670d] data-[state=active]:shadow-[inset_0_-2px_0_#ff670d]"
              >
                Stampa
              </TabsTrigger>
              <TabsTrigger
                value="anima"
                className="h-full rounded-none px-0.5 text-[10px] uppercase tracking-[0.06em] data-[state=active]:bg-transparent data-[state=active]:text-[#ff670d] data-[state=active]:shadow-[inset_0_-2px_0_#ff670d]"
              >
                Anima
              </TabsTrigger>
              <TabsTrigger
                value="galleria"
                className="h-full rounded-none px-0.5 text-[10px] uppercase tracking-[0.06em] data-[state=active]:bg-transparent data-[state=active]:text-[#ff670d] data-[state=active]:shadow-[inset_0_-2px_0_#ff670d]"
              >
                Modelli
                {count > 0 && <span className="ml-0.5 text-[9px] tracking-normal text-[#9a9a9a]">{count}</span>}
              </TabsTrigger>
              <TabsTrigger
                value="foto"
                className="h-full rounded-none px-0.5 text-[10px] uppercase tracking-[0.06em] data-[state=active]:bg-transparent data-[state=active]:text-[#ff670d] data-[state=active]:shadow-[inset_0_-2px_0_#ff670d]"
              >
                Foto
              </TabsTrigger>
            </TabsList>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <TabsContent value="crea" className="m-0">
                <AiCreatePanel
                  onFrontPhoto={setPhoto}
                  onQueued={() => setTab("galleria")}
                  incoming={incomingPhoto}
                  onIncomingUsed={() => setIncomingPhoto(null)}
                />
                <Collapsible className="border-t border-[#e4e4e4]">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between px-5 py-4 text-left text-[11px] uppercase tracking-[0.18em] text-[#525252] hover:text-[#171717] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff670d]">
                    Importa file CAD (DWG, STEP, STL…)
                    <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CadImportPanel busy={cadBusy} onFile={handleCadFile} />
                  </CollapsibleContent>
                </Collapsible>
                <Collapsible className="border-t border-[#e4e4e4]">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between px-5 py-4 text-left text-[11px] uppercase tracking-[0.18em] text-[#525252] hover:text-[#171717] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff670d]">
                    Rilievo rapido senza AI
                    <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CreatePanel photo={photo} onPhoto={setPhoto} onGenerated={handleGenerated} />
                  </CollapsibleContent>
                </Collapsible>
              </TabsContent>
              <TabsContent value="stile" className="m-0">
                <StylePanel
                  material={material}
                  onMaterial={handleMaterial}
                  lighting={lighting}
                  onLighting={handleLighting}
                  background={background}
                  onBackground={handleBackground}
                  gridOn={gridOn}
                  onGrid={handleGrid}
                  onView={handleView}
                  onCaptureViews={() => viewportRef.current?.captureViews() ?? []}
                  hasModel={hasModel}
                  onSave={handleSaveEdit}
                  onExportGLB={() => void handleExportGLB()}
                  onExportSTL={handleExportSTL}
                  onExportUSDZ={handleExportUSDZ}
                  sizeMm={sizeMm}
                  onSizeMm={setSizeMm}
                  sizeFromSource={sizeFromSource}
                  printReport={printReport}
                  onCheckPrint={() => setPrintReport(viewportRef.current?.analyzePrint() ?? null)}
                />
              </TabsContent>
              <TabsContent value="varianti" className="m-0">
                <VariantsPanel
                  active={active}
                  hasModel={hasModel}
                  material={material}
                  onMaterial={handleMaterial}
                  exportGlb={() => viewportRef.current?.exportGLB() ?? Promise.resolve(null)}
                  onQueued={() => setTab("galleria")}
                />
              </TabsContent>
              <TabsContent value="stampa" className="m-0">
                <PrintPanel
                  hasModel={hasModel}
                  name={active?.name ?? "modello"}
                  sizeMm={sizeMm}
                  onSizeMm={setSizeMm}
                  getInput={() => viewportRef.current?.getPrintInput() ?? null}
                  modelSize={printReport?.size ?? null}
                />
              </TabsContent>
              <TabsContent value="anima" className="m-0">
                <AnimatePanel
                  active={active}
                  hasModel={hasModel}
                  clips={clips}
                  playing={playing}
                  onPlay={(name) => {
                    setPlaying(name);
                    viewportRef.current?.playAnimation(name);
                  }}
                  onQueued={() => setTab("galleria")}
                  onDownload={(item, format) => void handleDownload(item, format)}
                />
              </TabsContent>
              <TabsContent value="foto" className="m-0">
                <PhotosPanel
                  onUseFor3d={(p) => {
                    setIncomingPhoto(p);
                    setTab("crea");
                  }}
                />
              </TabsContent>
              <TabsContent value="galleria" className="m-0">
                <GalleryPanel
                  items={items}
                  loading={list.isLoading}
                  activeId={active?.id ?? null}
                  onSelect={(item) => void openModel(item)}
                  onDownload={(item) => void handleDownload(item)}
                />
              </TabsContent>
            </div>
          </Tabs>
        </aside>
      </main>

      <Toaster position="top-center" />
    </div>
  );
}

function ViewportButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex size-9 items-center justify-center rounded-md transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 ${
        pressed
          ? "bg-[#ff670d] text-white"
          : "text-[#9a9aab] hover:bg-white/10 hover:text-[#e0e0e0]"
      }`}
    >
      {children}
    </button>
  );
}
