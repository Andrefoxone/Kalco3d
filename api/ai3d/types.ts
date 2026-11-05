// Tipi condivisi della pipeline foto → 3D multi-motore.

export const VIEWS = ["front", "left", "back", "right"] as const;
export type View = (typeof VIEWS)[number];

/** Livello di qualità che il cliente sceglie (e paga). */
export const QUALITIES = ["bozza", "standard", "pro"] as const;
export type Quality = (typeof QUALITIES)[number];

/** Uso finale del modello: decide texture, densità della mesh e formati. */
export const TARGETS = ["ecommerce", "stampa", "render", "gioco"] as const;
export type Target = (typeof TARGETS)[number];

export const PROVIDER_IDS = ["tripo", "meshy", "rodin", "fal-hunyuan", "fal-trellis"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface InputImage {
  view: View;
  data: Buffer;
  mime: "image/png" | "image/jpeg";
}

export interface GenerationRequest {
  images: InputImage[];
  quality: Quality;
  target: Target;
}

export interface GenerationResult {
  glb: Buffer;
  /** anteprima renderizzata dal motore (se disponibile) */
  preview?: { data: Buffer; mime: string };
  provider: ProviderId;
  /** modello/versione usato dal motore, per tracciabilità */
  providerModel: string;
  /** crediti consumati presso il motore, se il motore li riporta */
  providerCredits?: number;
}

export type ProgressFn = (percent: number, stage: string) => void;

export interface Provider {
  id: ProviderId;
  label: string;
  /** chiave API presente? */
  available(): boolean;
  /** quante foto accetta al massimo (1 = solo vista frontale) */
  maxViews: number;
  generate(req: GenerationRequest, onProgress: ProgressFn, signal: AbortSignal): Promise<GenerationResult>;
}

/** Errore del motore con messaggio leggibile per il cliente. */
export class ProviderError extends Error {
  readonly provider: ProviderId;
  constructor(provider: ProviderId, message: string) {
    super(message);
    this.provider = provider;
  }
}
