// Tripo API v3 — https://developers.tripo3d.ai/en/docs
// upload foto → task image/multiview-to-model → polling → download immediato
// (gli URL dei modelli scadono).
import { tripoRequest } from "../plan";
import { download, fetchWithTimeout, isGlb, readJson, sleep, type ExternalJson } from "../net";
import { ProviderError, type GenerationRequest, type GenerationResult, type ProgressFn, type Provider, type View } from "../types";

const BASE = process.env.TRIPO_API_BASE ?? "https://openapi.tripo3d.ai/v3";
const POLL_MS = 3000;
const MAX_WAIT_MS = 15 * 60 * 1000;

function key(): string {
  return process.env.TRIPO_API_KEY ?? "";
}

function checkCode(json: ExternalJson) {
  if (json?.code !== undefined && json.code !== 0) {
    throw new ProviderError("tripo", `codice ${json.code}: ${json.message ?? "errore"}`);
  }
}

async function upload(data: Buffer, mime: string, signal: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)], { type: mime }), mime === "image/png" ? "foto.png" : "foto.jpg");
  const res = await fetchWithTimeout(`${BASE}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}` },
    body: form,
  }, 120_000, signal);
  const json = await readJson("tripo", res);
  checkCode(json);
  const token = json?.data?.file_token;
  if (!token) throw new ProviderError("tripo", "upload senza file_token");
  return token;
}

export const tripoProvider: Provider = {
  id: "tripo",
  label: "Tripo",
  maxViews: 4,
  available: () => Boolean(key()),

  async generate(req: GenerationRequest, onProgress: ProgressFn, signal: AbortSignal): Promise<GenerationResult> {
    onProgress(2, "Caricamento foto");
    const tokens: Partial<Record<View, string>> = {};
    for (const img of req.images) tokens[img.view] = await upload(img.data, img.mime, signal);

    const { path, body } = tripoRequest(req.quality, req.target, tokens);
    const created = await readJson("tripo", await fetchWithTimeout(`${BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 60_000, signal));
    checkCode(created);
    const taskId: string | undefined = created?.data?.task_id;
    if (!taskId) throw new ProviderError("tripo", "task senza task_id");

    const start = Date.now();
    for (;;) {
      if (Date.now() - start > MAX_WAIT_MS) throw new ProviderError("tripo", "tempo massimo superato");
      await sleep(POLL_MS, signal);
      const json = await readJson("tripo", await fetchWithTimeout(`${BASE}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${key()}` },
      }, 30_000, signal));
      checkCode(json);
      const task = json.data ?? {};
      const status: string = task.status ?? "unknown";
      if (status === "success") {
        const modelUrl: string | undefined = task.output?.model_url ?? task.output?.pbr_model ?? task.output?.model;
        if (!modelUrl) throw new ProviderError("tripo", "task riuscito ma senza modello");
        onProgress(92, "Download del modello");
        const glb = await download("tripo", modelUrl, signal);
        if (!isGlb(glb)) throw new ProviderError("tripo", "il modello scaricato non è un GLB");
        let preview: GenerationResult["preview"];
        const previewUrl: string | undefined = task.output?.rendered_image_url ?? task.output?.rendered_image;
        if (previewUrl) {
          try {
            preview = { data: await download("tripo", previewUrl, signal, 60_000), mime: "image/webp" };
          } catch {
            preview = undefined; // l'anteprima è un extra
          }
        }
        return {
          glb,
          preview,
          provider: "tripo",
          providerModel: String(body.model),
          providerCredits: typeof task.credits_consumed === "number" ? task.credits_consumed : undefined,
        };
      }
      if (["failed", "cancelled", "banned", "expired"].includes(status)) {
        throw new ProviderError("tripo", `generazione ${status}${task.error_msg ? `: ${task.error_msg}` : ""}`);
      }
      const p = typeof task.progress === "number" ? task.progress : 0;
      onProgress(5 + Math.round(p * 0.85), status === "queued" ? "In coda" : "Generazione del modello");
    }
  },
};
