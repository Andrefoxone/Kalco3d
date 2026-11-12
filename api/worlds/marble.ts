// Client della World API di World Labs (modello Marble): ambienti 3D
// esplorabili da testo o da una foto. Documentazione: docs.worldlabs.ai/api
//   POST /marble/v1/worlds:generate          → operazione asincrona
//   GET  /marble/v1/operations/{id}           → polling fino a done = true
//   POST /marble/v1/worlds/{world_id}:export  → mesh GLB texturizzata (a pagamento)
// Autenticazione: header WLT-Api-Key. I crediti API si comprano su
// platform.worldlabs.ai (separati da quelli dell'app Marble).
import { WORLD_QUALITY_INFO, type WorldQuality } from "@contracts/worlds";

const BASE = (process.env.WORLDLABS_API_BASE ?? "https://api.worldlabs.ai/marble/v1").replace(/\/+$/, "");
const POLL_MS = 5000;

export class MarbleError extends Error {
  /** errore del cliente (contenuto rifiutato, input non valido): inutile riprovare */
  readonly userFacing: boolean;
  constructor(message: string, userFacing = false) {
    super(message);
    this.userFacing = userFacing;
  }
}

export function marbleAvailable(): boolean {
  return Boolean(process.env.WORLDLABS_API_KEY);
}

function headers(json = true): Record<string, string> {
  const h: Record<string, string> = { "WLT-Api-Key": process.env.WORLDLABS_API_KEY ?? "" };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

// ── Richiesta ────────────────────────────────────────────────

export type WorldInput =
  | { kind: "testo"; text: string }
  | { kind: "foto"; image: Buffer; ext: "png" | "jpg"; text?: string };

/** Corpo di worlds:generate. La scena resta privata (permission.public = false). */
export function buildGenerateBody(input: WorldInput, quality: WorldQuality, name: string): Record<string, unknown> {
  const model = WORLD_QUALITY_INFO[quality].model;
  const text = (input.kind === "testo" ? input.text : input.text ?? "").trim().replace(/\s+/g, " ").slice(0, 2000);
  let world_prompt: Record<string, unknown>;
  if (input.kind === "testo") {
    if (!text) throw new MarbleError("Descrivi la scena con qualche parola", true);
    world_prompt = { type: "text", text_prompt: text };
  } else {
    world_prompt = {
      type: "image",
      image_prompt: { source: "data_base64", data_base64: input.image.toString("base64"), extension: input.ext },
      is_pano: "auto",
      ...(text ? { text_prompt: text } : {}),
    };
  }
  return {
    display_name: name.slice(0, 64),
    model,
    world_prompt,
    permission: { public: false },
    tags: ["kalco3d"],
  };
}

// ── Chiamate ─────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal, timeoutMs = 60_000): Promise<Json> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new MarbleError(`risposta non valida (${res.status}): ${text.slice(0, 160)}`);
  }
  if (!res.ok) throw httpError(res.status, json, text);
  return json;
}

function httpError(status: number, json: Json, text: string): MarbleError {
  const detail = json?.detail ?? json?.message ?? json?.error?.message ?? json?.error ?? text.slice(0, 160);
  const msg = typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 160);
  if (status === 402) return new MarbleError("World Labs: crediti API esauriti (ricarica su platform.worldlabs.ai)");
  if (status === 401 || status === 403) return new MarbleError("World Labs: chiave API non valida");
  if (status === 429) return new MarbleError("World Labs: troppe richieste, riprova tra poco");
  if (status === 400 || status === 422) return new MarbleError(`La richiesta è stata rifiutata: ${msg}`, true);
  return new MarbleError(`World Labs errore ${status}: ${msg}`);
}

/** Avvia la generazione; restituisce l'id dell'operazione da interrogare. */
export async function startGeneration(body: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const op = await call("POST", "/worlds:generate", body, signal, 120_000);
  const id = op?.operation_id;
  if (typeof id !== "string" || !id) throw new MarbleError("risposta senza operation_id");
  return id;
}

/** Legge una scena già generata (gratis): serve per recuperare i file. */
export async function getWorld(worldId: string, signal: AbortSignal): Promise<Json> {
  const res = await call("GET", `/worlds/${encodeURIComponent(worldId)}`, undefined, signal, 30_000);
  // la risposta può essere il World o { world: World }
  return res?.world_id ? res : (res?.world ?? res);
}

/** Avvia l'export della mesh GLB texturizzata (3.500 crediti World Labs = 2,80 $). */
export async function startMeshExport(worldId: string, signal: AbortSignal): Promise<string> {
  const op = await call(
    "POST",
    `/worlds/${encodeURIComponent(worldId)}:export`,
    { asset_type: "mesh", format: "glb", mesh_variant: "textured" },
    signal,
  );
  const id = op?.operation_id;
  if (typeof id !== "string" || !id) throw new MarbleError("export senza operation_id");
  // un export già pronto in cache torna subito con done = true
  return id;
}

/** Avanzamento 0–100 da metadata.progress (frazione 0–1 o percentuale). */
export function progressOf(op: Json): number | null {
  const p = op?.metadata?.progress;
  const n = typeof p === "number" ? p : typeof p === "string" ? Number(p) : typeof p?.percent === "number" ? p.percent : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n <= 1 ? n * 100 : n));
}

/** Interroga l'operazione finché non è conclusa; restituisce `response`. */
export async function waitOperation(
  opId: string,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
  maxWaitMs: number,
  pollMs = POLL_MS,
): Promise<Json> {
  const start = Date.now();
  for (;;) {
    const op = await call("GET", `/operations/${encodeURIComponent(opId)}`, undefined, signal, 30_000);
    if (op?.done) {
      if (op.error) {
        const msg = op.error.message ?? "generazione non riuscita";
        // i rifiuti per contenuto arrivano qui: messaggio da mostrare al cliente
        throw new MarbleError(String(msg).slice(0, 200), /polic|safety|content|inappropriate/i.test(String(msg)));
      }
      if (!op.response) throw new MarbleError("operazione conclusa senza risultato");
      return op.response;
    }
    const p = progressOf(op);
    if (p !== null) onProgress(p);
    if (Date.now() - start > maxWaitMs) throw new MarbleError("tempo massimo superato");
    await sleep(pollMs, signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Risultato ────────────────────────────────────────────────

export interface ParsedWorld {
  worldId: string;
  marbleUrl: string | null;
  caption: string | null;
  /** Gaussian splat SPZ per il visualizzatore web */
  spzUrl: string;
  /** chiave della risoluzione scelta (es. "500k") */
  spzResolution: string;
  /** versione a piena risoluzione (più nitida, file più grande), se diversa */
  spzHqUrl: string | null;
  spzHqResolution: string | null;
  /** tutte le risoluzioni offerte dal motore (per i log) */
  spzResolutions: string[];
  colliderUrl: string | null;
  panoUrl: string | null;
  thumbUrl: string | null;
  /** unità del motore → metri, e quota del pavimento (docs: rendering-spz) */
  metricScale: number;
  groundOffset: number;
}

/** Per il web: abbastanza dettaglio senza file enormi. */
const SPZ_PREFERENCE = ["500k", "full_res", "1m", "100k"];
/** Per l'alta qualità: la risoluzione più piena disponibile. */
const SPZ_HQ_PREFERENCE = ["full_res", "2m", "1m"];

/** Versione ad alta risoluzione, se diversa da quella leggera. */
export function pickHqSpz(urls: unknown, light: string | null): { key: string; url: string } | null {
  if (!urls || typeof urls !== "object") return null;
  const map = urls as Record<string, unknown>;
  for (const k of SPZ_HQ_PREFERENCE) {
    if (k !== light && typeof map[k] === "string" && map[k]) return { key: k, url: map[k] as string };
  }
  return null;
}

export function pickSpz(urls: unknown): { key: string; url: string } | null {
  if (!urls || typeof urls !== "object") return null;
  const map = urls as Record<string, unknown>;
  for (const k of SPZ_PREFERENCE) {
    if (typeof map[k] === "string" && map[k]) return { key: k, url: map[k] as string };
  }
  for (const [k, v] of Object.entries(map)) if (typeof v === "string" && v) return { key: k, url: v };
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function parseWorld(resp: Json): ParsedWorld {
  const worldId = str(resp?.world_id);
  if (!worldId) throw new MarbleError("risultato senza world_id");
  const assets = resp?.assets ?? {};
  const urls = assets?.splats?.spz_urls;
  const spz = pickSpz(urls);
  if (!spz) throw new MarbleError("la scena non contiene un file SPZ");
  const hq = pickHqSpz(urls, spz.key);
  const sem = assets?.splats?.semantics_metadata ?? {};
  const scale = Number(sem.metric_scale_factor);
  const ground = Number(sem.ground_plane_offset);
  return {
    worldId,
    marbleUrl: str(resp?.world_marble_url),
    caption: str(resp?.caption)?.slice(0, 600) ?? null,
    spzUrl: spz.url,
    spzResolution: spz.key,
    spzHqUrl: hq?.url ?? null,
    spzHqResolution: hq?.key ?? null,
    spzResolutions: urls && typeof urls === "object" ? Object.keys(urls as object) : [],
    colliderUrl: str(assets?.mesh?.collider_mesh_url),
    panoUrl: str(assets?.imagery?.pano_url),
    thumbUrl: str(resp?.thumbnail_url) ?? str(assets?.thumbnail_url),
    metricScale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    groundOffset: Number.isFinite(ground) ? ground : 0,
  };
}

/** URL della mesh dal risultato di un export. */
export function parseExport(resp: Json): string {
  const url = str(resp?.url);
  if (!url) throw new MarbleError("export concluso senza URL del file");
  return url;
}

/** Scarica un file del motore, con limite di dimensione (il bucket accetta 100 MB). */
export async function fetchAsset(url: string, signal: AbortSignal, maxBytes = 95 * 1024 * 1024): Promise<{ data: Buffer; mime: string }> {
  const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]) });
  if (!res.ok) throw new MarbleError(`download fallito (${res.status})`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new MarbleError(`file troppo grande (${Math.round(len / 1048576)} MB)`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxBytes) throw new MarbleError(`file troppo grande (${Math.round(data.length / 1048576)} MB)`);
  return { data, mime: res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream" };
}
