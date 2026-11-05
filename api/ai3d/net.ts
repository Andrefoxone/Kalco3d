// Utility di rete comuni ai motori: timeout, attese annullabili, download.
import { ProviderError, type ProviderId } from "./types";

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
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

/** fetch con timeout per singola richiesta, legato anche al segnale del job. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Response> {
  const ctrl = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  return fetch(url, { ...init, signal: ctrl });
}

/** JSON di un'API esterna: la forma viene verificata campo per campo da chi lo legge. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ExternalJson = any;

export async function readJson(provider: ProviderId, res: Response): Promise<ExternalJson> {
  const text = await res.text();
  let json: ExternalJson;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderError(provider, `risposta non valida (${res.status}): ${text.slice(0, 160)}`);
  }
  if (!res.ok) {
    const msg = json?.message ?? json?.error ?? json?.detail ?? text.slice(0, 160);
    throw new ProviderError(provider, `errore ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg).slice(0, 160)}`);
  }
  return json;
}

export async function download(
  provider: ProviderId,
  url: string,
  signal: AbortSignal,
  timeoutMs = 5 * 60 * 1000,
): Promise<Buffer> {
  const res = await fetchWithTimeout(url, {}, timeoutMs, signal);
  if (!res.ok) throw new ProviderError(provider, `download fallito (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export function isGlb(buf: Buffer): boolean {
  return buf.length >= 20 && buf.readUInt32LE(0) === 0x46546c67;
}

export function toDataUri(data: Buffer, mime: string): string {
  return `data:${mime};base64,${data.toString("base64")}`;
}

/** Primo URL .glb trovato in una risposta JSON di forma non nota. */
export function findGlbUrl(obj: unknown): string | null {
  if (typeof obj === "string") return /^https?:\/\/\S+\.glb(\?|$)/i.test(obj) ? obj : null;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = findGlbUrl(v);
      if (r) return r;
    }
    return null;
  }
  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    // forme note: { url, content_type: "model/gltf-binary" }
    if (typeof rec.url === "string" && /gltf-binary|\.glb/i.test(String(rec.content_type ?? rec.file_name ?? rec.url))) {
      return rec.url;
    }
    for (const v of Object.values(rec)) {
      const r = findGlbUrl(v);
      if (r) return r;
    }
  }
  return null;
}
