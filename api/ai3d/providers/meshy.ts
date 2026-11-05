// Meshy API v1: image-to-3d (1 foto) o multi-image-to-3d (fino a 4), foto come
// data URI, polling del task, download immediato del GLB.
import { meshyRequest } from "../plan";
import { download, fetchWithTimeout, isGlb, readJson, sleep, toDataUri } from "../net";
import { ProviderError, VIEWS, type GenerationRequest, type GenerationResult, type ProgressFn, type Provider } from "../types";

const BASE = process.env.MESHY_API_BASE ?? "https://api.meshy.ai";
const POLL_MS = 3000;
const MAX_WAIT_MS = 15 * 60 * 1000;

function key(): string {
  return process.env.MESHY_API_KEY ?? "";
}

export const meshyProvider: Provider = {
  id: "meshy",
  label: "Meshy",
  maxViews: 4,
  available: () => Boolean(key()),

  async generate(req: GenerationRequest, onProgress: ProgressFn, signal: AbortSignal): Promise<GenerationResult> {
    onProgress(2, "Invio foto");
    const ordered = [...req.images].sort((a, b) => VIEWS.indexOf(a.view) - VIEWS.indexOf(b.view));
    const urls = ordered.map((i) => toDataUri(i.data, i.mime));
    const { path, body } = meshyRequest(req.quality, req.target, urls);
    const auth = { Authorization: `Bearer ${key()}` };
    const created = await readJson("meshy", await fetchWithTimeout(`${BASE}${path}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 120_000, signal));
    const id: string | undefined = created?.result;
    if (!id) throw new ProviderError("meshy", "risposta senza id del task");

    const start = Date.now();
    for (;;) {
      if (Date.now() - start > MAX_WAIT_MS) throw new ProviderError("meshy", "tempo massimo superato");
      await sleep(POLL_MS, signal);
      const task = await readJson("meshy", await fetchWithTimeout(`${BASE}${path}/${id}`, { headers: auth }, 30_000, signal));
      const status: string = task?.status ?? "";
      if (status === "SUCCEEDED") {
        const url: string | undefined = task.model_urls?.glb;
        if (!url) throw new ProviderError("meshy", "task riuscito ma senza GLB");
        onProgress(92, "Download del modello");
        const glb = await download("meshy", url, signal);
        if (!isGlb(glb)) throw new ProviderError("meshy", "il modello scaricato non è un GLB");
        let preview: GenerationResult["preview"];
        if (task.thumbnail_url) {
          try {
            preview = { data: await download("meshy", task.thumbnail_url, signal, 60_000), mime: "image/png" };
          } catch {
            preview = undefined;
          }
        }
        return {
          glb,
          preview,
          provider: "meshy",
          providerModel: String(body.ai_model),
          providerCredits: typeof task.consumed_credits === "number" ? task.consumed_credits : undefined,
        };
      }
      if (status === "FAILED" || status === "CANCELED") {
        const msg = task?.task_error?.message ?? status.toLowerCase();
        throw new ProviderError("meshy", `generazione non riuscita: ${msg}`);
      }
      const p = typeof task?.progress === "number" ? task.progress : 0;
      onProgress(5 + Math.round(p * 0.85), status === "PENDING" ? "In coda" : "Generazione del modello");
    }
  },
};
