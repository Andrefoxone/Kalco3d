// Registro dei motori ed esecuzione con ripiego automatico.
import { planProviders } from "./plan";
import { falHunyuanProvider, falTrellisProvider } from "./providers/fal";
import { rodinProvider } from "./providers/rodin";
import { tripoProvider } from "./providers/tripo";
import { meshyProvider } from "./providers/meshy";
import type { GenerationRequest, GenerationResult, ProgressFn, Provider, ProviderId } from "./types";

export * from "./types";

const PROVIDERS: Record<ProviderId, Provider> = {
  tripo: tripoProvider,
  meshy: meshyProvider,
  rodin: rodinProvider,
  "fal-hunyuan": falHunyuanProvider,
  "fal-trellis": falTrellisProvider,
};

export function availableProviders(): Set<ProviderId> {
  return new Set((Object.keys(PROVIDERS) as ProviderId[]).filter((id) => PROVIDERS[id].available()));
}

export function providerLabel(id: string): string {
  return PROVIDERS[id as ProviderId]?.label ?? id;
}

export function canGenerate(viewCount: number): boolean {
  return planProviders("standard", "ecommerce", viewCount, availableProviders()).length > 0;
}

export interface Attempt {
  provider: ProviderId;
  error: string;
}

/**
 * Prova i motori in ordine di preferenza. Se uno fallisce si passa al
 * successivo; l'errore finale elenca tutti i tentativi.
 */
export async function generateWithFallback(
  req: GenerationRequest,
  onProgress: ProgressFn,
  signal: AbortSignal,
  registry: Record<ProviderId, Provider> = PROVIDERS,
): Promise<GenerationResult & { attempts: Attempt[] }> {
  const available = new Set((Object.keys(registry) as ProviderId[]).filter((id) => registry[id].available()));
  const order = planProviders(req.quality, req.target, req.images.length, available);
  if (order.length === 0) {
    throw new Error(
      req.images.length > 1
        ? "Nessun motore 3D configurato che accetti più foto"
        : "Nessun motore 3D configurato: aggiungi una chiave API (TRIPO_API_KEY, MESHY_API_KEY, HYPER3D_API_KEY o FAL_KEY)",
    );
  }
  const attempts: Attempt[] = [];
  for (const id of order) {
    if (signal.aborted) throw signal.reason;
    try {
      const label = registry[id].label;
      const result = await registry[id].generate(req, (p, stage) => onProgress(p, `${stage} · ${label}`), signal);
      return { ...result, attempts };
    } catch (err) {
      if (signal.aborted) throw err;
      attempts.push({ provider: id, error: err instanceof Error ? err.message : String(err) });
      onProgress(3, `Ripiego su un altro motore`);
    }
  }
  throw new Error(attempts.map((a) => `${registry[a.provider].label}: ${a.error}`).join(" · "));
}
