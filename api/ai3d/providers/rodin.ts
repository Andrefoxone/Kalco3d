// Rodin (Hyper3D) API v2: invio multipart → polling stato con subscription_key
// → elenco file da scaricare. Endpoint: /api/v2/rodin, /api/v2/status, /api/v2/download.
// NB: verificare i nomi dei campi con la prima chiave reale (documentazione
// pubblica parziale); in caso di errore la pipeline passa al motore successivo.
import { rodinFields } from "../plan";
import { download, fetchWithTimeout, isGlb, readJson, sleep } from "../net";
import { ProviderError, VIEWS, type GenerationRequest, type GenerationResult, type ProgressFn, type Provider } from "../types";

const BASE = process.env.HYPER3D_API_BASE ?? "https://api.hyper3d.com/api/v2";
const POLL_MS = 5000;
const MAX_WAIT_MS = 15 * 60 * 1000;

function key(): string {
  return process.env.HYPER3D_API_KEY ?? "";
}

export const rodinProvider: Provider = {
  id: "rodin",
  label: "Rodin Gen-2",
  maxViews: 4,
  available: () => Boolean(key()),

  async generate(req: GenerationRequest, onProgress: ProgressFn, signal: AbortSignal): Promise<GenerationResult> {
    onProgress(2, "Invio foto");
    const form = new FormData();
    // la vista frontale per prima: Rodin la usa come riferimento principale
    const ordered = [...req.images].sort((a, b) => VIEWS.indexOf(a.view) - VIEWS.indexOf(b.view));
    for (const img of ordered) {
      form.append("images", new Blob([new Uint8Array(img.data)], { type: img.mime }), `${img.view}.${img.mime === "image/png" ? "png" : "jpg"}`);
    }
    const fields = rodinFields(req.quality, req.target, req.images.length);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);

    const auth = { Authorization: `Bearer ${key()}` };
    const created = await readJson("rodin", await fetchWithTimeout(`${BASE}/rodin`, {
      method: "POST", headers: auth, body: form,
    }, 120_000, signal));
    if (created?.error) throw new ProviderError("rodin", String(created.error));
    const taskUuid: string | undefined = created?.uuid;
    const subKey: string | undefined = created?.jobs?.subscription_key;
    if (!taskUuid || !subKey) throw new ProviderError("rodin", "risposta senza uuid/subscription_key");

    const start = Date.now();
    for (;;) {
      if (Date.now() - start > MAX_WAIT_MS) throw new ProviderError("rodin", "tempo massimo superato");
      await sleep(POLL_MS, signal);
      const st = await readJson("rodin", await fetchWithTimeout(`${BASE}/status`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ subscription_key: subKey }),
      }, 30_000, signal));
      const jobs: { status?: string }[] = Array.isArray(st?.jobs) ? st.jobs : [];
      if (jobs.some((j) => j.status === "Failed")) throw new ProviderError("rodin", "generazione fallita");
      const done = jobs.filter((j) => j.status === "Done").length;
      if (jobs.length > 0 && done === jobs.length) break;
      const generating = jobs.some((j) => j.status === "Generating");
      onProgress(10 + Math.round((done / Math.max(1, jobs.length)) * 75), generating ? "Generazione del modello" : "In coda");
    }

    onProgress(90, "Download del modello");
    const dl = await readJson("rodin", await fetchWithTimeout(`${BASE}/download`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ task_uuid: taskUuid }),
    }, 30_000, signal));
    const list: { url: string; name: string }[] = Array.isArray(dl?.list) ? dl.list : [];
    const glbItem = list.find((f) => /\.glb$/i.test(f.name));
    if (!glbItem) throw new ProviderError("rodin", "nessun GLB tra i file prodotti");
    const glb = await download("rodin", glbItem.url, signal);
    if (!isGlb(glb)) throw new ProviderError("rodin", "il modello scaricato non è un GLB");
    const prevItem = list.find((f) => /\.(webp|png|jpe?g)$/i.test(f.name));
    let preview: GenerationResult["preview"];
    if (prevItem) {
      try {
        const ext = prevItem.name.split(".").pop()!.toLowerCase();
        preview = { data: await download("rodin", prevItem.url, signal, 60_000), mime: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg" };
      } catch {
        preview = undefined;
      }
    }
    return { glb, preview, provider: "rodin", providerModel: `Gen-2/${fields.quality}` };
  },
};
