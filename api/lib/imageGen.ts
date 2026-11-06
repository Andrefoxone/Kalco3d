// Immagini da testo con FLUX.2 [pro] su fal: servono come "foto" di partenza
// per il 3D, quindi il prompt dell'utente viene avvolto in una ricetta che
// produce un oggetto unico, intero, centrato, su fondo neutro.
import type { ImageStyle } from "@contracts/billing";
import { log } from "./logger";

export const FLUX_MODEL = "fal-ai/flux-2-pro";
const RUN = process.env.FAL_RUN_BASE ?? "https://fal.run";

const STYLE: Record<ImageStyle, string> = {
  realistico: "photorealistic product photo, true-to-life materials and colors",
  statuina: "collectible painted figurine, smooth sculpted forms, vivid matte paint",
  giocattolo: "cute stylized toy, chunky simple shapes, soft plastic look",
  scultura: "single-material sculpture, smooth surfaces, no color variation",
};

/** Ricetta del prompt: l'oggetto dell'utente + regole per una buona conversione in 3D. */
export function buildImagePrompt(userPrompt: string, style: ImageStyle, forPrint: boolean): string {
  const subject = userPrompt.trim().replace(/\s+/g, " ");
  const rules = [
    STYLE[style],
    "one single object, entire object fully visible and centered, nothing cropped",
    "three-quarter front view, slightly above eye level",
    "plain light grey seamless studio background, soft even lighting, no harsh shadows",
    "no text, no logos, no watermark, no other objects, no people unless described",
  ];
  if (forPrint) rules.push("solid sturdy shapes, no thin fragile parts, standing on a flat base");
  return `${subject}. ${rules.join(". ")}.`;
}

export function imageGenEnabled(): boolean {
  return Boolean(process.env.FAL_KEY);
}

export interface GeneratedImage {
  dataUrl: string;
}

/** Una chiamata = una immagine (fal non ha num_images per FLUX.2 pro). */
async function generateOne(prompt: string, seed: number): Promise<GeneratedImage> {
  const res = await fetch(`${RUN}/${FLUX_MODEL}`, {
    method: "POST",
    headers: { Authorization: `Key ${process.env.FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      image_size: "square_hd",
      output_format: "jpeg",
      seed,
      sync_mode: true,
      enable_safety_checker: true,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  let json: { images?: { url?: string }[]; detail?: unknown; message?: unknown } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`risposta non valida (${res.status})`);
  }
  if (!res.ok) {
    const msg = json.detail ?? json.message ?? text.slice(0, 160);
    throw new Error(`errore ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg).slice(0, 160)}`);
  }
  const url = json.images?.[0]?.url;
  if (!url) throw new Error("nessuna immagine nella risposta");
  if (url.startsWith("data:")) return { dataUrl: url };
  // se fal restituisce un link invece del data URI, lo scarichiamo qui
  const img = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!img.ok) throw new Error(`download immagine fallito (${img.status})`);
  const mime = img.headers.get("content-type") ?? "image/jpeg";
  return { dataUrl: `data:${mime};base64,${Buffer.from(await img.arrayBuffer()).toString("base64")}` };
}

/** Genera count immagini in parallelo; restituisce quelle riuscite e quante sono fallite. */
export async function generateImages(
  userPrompt: string,
  style: ImageStyle,
  forPrint: boolean,
  count: number,
): Promise<{ images: GeneratedImage[]; failed: number; lastError: string | null }> {
  const prompt = buildImagePrompt(userPrompt, style, forPrint);
  const base = Math.floor(Math.random() * 1_000_000_000);
  const results = await Promise.allSettled(Array.from({ length: count }, (_, i) => generateOne(prompt, base + i)));
  const images: GeneratedImage[] = [];
  let lastError: string | null = null;
  for (const r of results) {
    if (r.status === "fulfilled") images.push(r.value);
    else lastError = r.reason instanceof Error ? r.reason.message : String(r.reason);
  }
  if (lastError) log.warn("flux: immagini non riuscite", { failed: count - images.length, error: lastError });
  return { images, failed: count - images.length, lastError };
}
