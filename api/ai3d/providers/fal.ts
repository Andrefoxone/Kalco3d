// fal.ai (coda asincrona): Hunyuan3D 3.1 Pro e TRELLIS.2.
// POST https://queue.fal.run/{model} → { request_id, status_url, response_url }
// le foto viaggiano come data URI: non serve uno storage pubblico.
import { FAL_HUNYUAN, FAL_TRELLIS, falHunyuanInput, falTrellisInput } from "../plan";
import { download, fetchWithTimeout, findGlbUrl, isGlb, readJson, sleep, toDataUri } from "../net";
import { ProviderError, type GenerationRequest, type GenerationResult, type ProgressFn, type Provider, type ProviderId, type View } from "../types";

const QUEUE = process.env.FAL_QUEUE_BASE ?? "https://queue.fal.run";
const POLL_MS = 3000;
const MAX_WAIT_MS = 15 * 60 * 1000;

function key(): string {
  return process.env.FAL_KEY ?? "";
}

async function runQueue(
  id: ProviderId,
  model: string,
  input: Record<string, unknown>,
  onProgress: ProgressFn,
  signal: AbortSignal,
): Promise<unknown> {
  const auth = { Authorization: `Key ${key()}` };
  const sub = await readJson(id, await fetchWithTimeout(`${QUEUE}/${model}`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, 120_000, signal));
  const statusUrl: string = sub?.status_url ?? `${QUEUE}/${model}/requests/${sub?.request_id}/status`;
  const responseUrl: string = sub?.response_url ?? `${QUEUE}/${model}/requests/${sub?.request_id}`;
  if (!sub?.request_id && !sub?.status_url) throw new ProviderError(id, "coda senza request_id");

  const start = Date.now();
  let tick = 0;
  for (;;) {
    if (Date.now() - start > MAX_WAIT_MS) throw new ProviderError(id, "tempo massimo superato");
    await sleep(POLL_MS, signal);
    const st = await readJson(id, await fetchWithTimeout(statusUrl, { headers: auth }, 30_000, signal));
    const status: string = st?.status ?? "";
    if (status === "COMPLETED") {
      if (st?.error) throw new ProviderError(id, String(st.error));
      break;
    }
    if (status === "FAILED" || status === "ERROR") throw new ProviderError(id, String(st?.error ?? "generazione fallita"));
    tick++;
    // fal non riporta una percentuale: avanzamento stimato e asintotico
    const pct = status === "IN_QUEUE" ? 5 : Math.min(85, 10 + Math.round(75 * (1 - Math.exp(-tick / 25))));
    onProgress(pct, status === "IN_QUEUE" ? "In coda" : "Generazione del modello");
  }
  return readJson(id, await fetchWithTimeout(responseUrl, { headers: auth }, 60_000, signal));
}

function urls(req: GenerationRequest): Partial<Record<View, string>> {
  const out: Partial<Record<View, string>> = {};
  for (const img of req.images) out[img.view] = toDataUri(img.data, img.mime);
  return out;
}

async function finish(id: ProviderId, model: string, result: unknown, onProgress: ProgressFn, signal: AbortSignal): Promise<GenerationResult> {
  const url = findGlbUrl(result);
  if (!url) throw new ProviderError(id, "nessun GLB nella risposta");
  onProgress(92, "Download del modello");
  const glb = await download(id, url, signal);
  if (!isGlb(glb)) throw new ProviderError(id, "il modello scaricato non è un GLB");
  return { glb, provider: id, providerModel: model };
}

export const falHunyuanProvider: Provider = {
  id: "fal-hunyuan",
  label: "Hunyuan3D 3.1 Pro",
  maxViews: 4,
  // Spento finché non è chiarita la licenza per l'UE (la licenza open source
  // Tencent esclude UE, Regno Unito e Corea del Sud). Riattivabile con ENABLE_HUNYUAN=1.
  available: () => Boolean(key()) && process.env.ENABLE_HUNYUAN === "1",
  async generate(req, onProgress, signal) {
    onProgress(2, "Invio foto");
    const input = falHunyuanInput(req.quality, req.target, urls(req));
    const result = await runQueue("fal-hunyuan", FAL_HUNYUAN, input, onProgress, signal);
    return finish("fal-hunyuan", FAL_HUNYUAN, result, onProgress, signal);
  },
};

export const falTrellisProvider: Provider = {
  id: "fal-trellis",
  label: "TRELLIS.2",
  maxViews: 1,
  available: () => Boolean(key()),
  async generate(req, onProgress, signal) {
    onProgress(2, "Invio foto");
    const input = falTrellisInput(urls(req));
    const result = await runQueue("fal-trellis", FAL_TRELLIS, input, onProgress, signal);
    return finish("fal-trellis", FAL_TRELLIS, result, onProgress, signal);
  },
};
