// Job asincroni foto → 3D. La mutation crea subito il record "processing";
// qui il job gira in background sulla pipeline multi-motore (api/ai3d),
// aggiorna avanzamento e fase nel DB, salva GLB + anteprima nello storage.
import { and, eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { models } from "../db/schema";
import { storage } from "./lib/storage";
import { log } from "./lib/logger";
import { addCredits } from "./lib/credits";
import { generateWithFallback, QUALITIES, TARGETS, type GenerationRequest } from "./ai3d";
import { creditCost } from "@contracts/billing";

const MAX_CONCURRENT = Number(process.env.AI_MAX_CONCURRENT ?? 3);
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const PROGRESS_WRITE_MS = 2500;

let running = 0;

export function aiJobsRunning(): number {
  return running;
}

export function canStartAiJob(): boolean {
  return running < MAX_CONCURRENT;
}

export function parseGlbStats(glb: Buffer): { vertices: number; triangles: number } {
  try {
    const jsonLen = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString("utf8")) as {
      meshes?: { primitives?: { attributes?: Record<string, number>; indices?: number }[] }[];
      accessors?: { count: number }[];
    };
    let vertices = 0;
    let triangles = 0;
    for (const mesh of json.meshes ?? []) {
      for (const prim of mesh.primitives ?? []) {
        const posIdx = prim.attributes?.POSITION;
        const vcount = posIdx !== undefined ? (json.accessors?.[posIdx]?.count ?? 0) : 0;
        vertices += vcount;
        if (prim.indices !== undefined) {
          triangles += Math.floor((json.accessors?.[prim.indices]?.count ?? 0) / 3);
        } else {
          triangles += Math.floor(vcount / 3);
        }
      }
    }
    return { vertices, triangles };
  } catch {
    return { vertices: 0, triangles: 0 };
  }
}

/**
 * Avvia il job in background; gli errori finiscono nel record (status=failed).
 * `safeName` include la cartella dell'utente: "<userId>/<nome>".
 */
export function startAiJob(
  modelId: number,
  req: GenerationRequest,
  safeName: string,
  charge?: { userId: string; cost: number },
): void {
  running++;
  void executeAiJob(modelId, req, safeName)
    .catch(async (err) => {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 250);
      log.error("ai job failed", { modelId, error: msg });
      // generazione non riuscita: i crediti tornano al cliente
      if (charge) {
        await addCredits(charge.userId, charge.cost, "rimborso", modelId, null).catch((e) =>
          log.error("rimborso crediti fallito", { modelId, error: e instanceof Error ? e.message : String(e) }),
        );
      }
      await getDb()
        .update(models)
        .set({ status: "failed", error: msg, stage: charge ? "Non riuscita · crediti restituiti" : "Generazione non riuscita" })
        .where(eq(models.id, modelId))
        .catch(() => undefined);
    })
    .finally(() => {
      running--;
    });
}

async function executeAiJob(modelId: number, req: GenerationRequest, safeName: string) {
  const signal = AbortSignal.timeout(JOB_TIMEOUT_MS);

  // avanzamento: scrittura nel DB al massimo ogni PROGRESS_WRITE_MS
  let lastWrite = 0;
  let lastStage = "";
  const onProgress = (percent: number, stage: string) => {
    const now = Date.now();
    if (stage === lastStage && now - lastWrite < PROGRESS_WRITE_MS) return;
    lastWrite = now;
    lastStage = stage;
    void getDb()
      .update(models)
      .set({ progress: Math.max(0, Math.min(99, Math.round(percent))), stage: stage.slice(0, 96) })
      .where(eq(models.id, modelId))
      .catch(() => undefined);
  };

  const result = await generateWithFallback(req, onProgress, signal);
  onProgress(96, "Salvataggio");

  const stats = parseGlbStats(result.glb);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const saved = await storage.uploadFile({
    fileContent: new Uint8Array(result.glb),
    fileName: fileIn(safeName, "modelli", stamp, "glb"),
    contentType: "model/gltf-binary",
  });
  let previewKey: string | null = null;
  if (result.preview) {
    const ext = result.preview.mime.split("/")[1] ?? "png";
    try {
      const p = await storage.uploadFile({
        fileContent: new Uint8Array(result.preview.data),
        fileName: fileIn(safeName, "anteprime", stamp, ext),
        contentType: result.preview.mime,
      });
      previewKey = p.key;
    } catch {
      previewKey = null; // l'anteprima è un extra, il modello è il prodotto
    }
  }

  await getDb()
    .update(models)
    .set({
      glbKey: saved.key,
      previewKey,
      status: "ready",
      progress: 100,
      stage: null,
      error: null,
      provider: result.provider,
      providerModel: result.providerModel.slice(0, 64),
      vertices: stats.vertices,
      triangles: stats.triangles,
      sizeBytes: result.glb.length,
    })
    .where(eq(models.id, modelId));
  log.info("ai job done", {
    modelId,
    provider: result.provider,
    fallbacks: result.attempts.length,
    sizeBytes: result.glb.length,
    ...stats,
  });
}

/** "<userId>/<nome>" → "<userId>/<cartella>/<data>-<nome>.<ext>" */
function fileIn(owned: string, folder: string, stamp: string, ext: string): string {
  const slash = owned.indexOf("/");
  const owner = slash > 0 ? owned.slice(0, slash) : "anonimo";
  const name = slash > 0 ? owned.slice(slash + 1) : owned;
  return `${owner}/${folder}/${stamp}-${name}.${ext}`;
}

/** Al boot: i job "processing" di un processo ormai morto vanno marcati falliti. */
export async function sweepStaleAiJobs(): Promise<void> {
  try {
    const stale = await getDb()
      .update(models)
      .set({ status: "failed", error: "Generazione interrotta: il server è stato riavviato", stage: "Interrotta · crediti restituiti" })
      .where(and(eq(models.status, "processing"), eq(models.mode, "ai")))
      .returning({ id: models.id, userId: models.userId, quality: models.quality, target: models.target });
    for (const m of stale) {
      const cost = creditCost(
        (QUALITIES as readonly string[]).includes(m.quality ?? "") ? (m.quality as (typeof QUALITIES)[number]) : "standard",
        (TARGETS as readonly string[]).includes(m.target ?? "") ? (m.target as (typeof TARGETS)[number]) : "ecommerce",
      );
      await addCredits(m.userId, cost, "rimborso_riavvio", m.id, null).catch(() => undefined);
    }
    if (stale.length) log.info("lavori interrotti rimborsati", { count: stale.length });
  } catch (err) {
    // drizzle avvolge l'errore di Postgres: la causa vera (password, host, SSL…) è in err.cause
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null;
    log.error("database non raggiungibile all'avvio", {
      error: cause?.message ?? (err instanceof Error ? err.message : String(err)),
      code: (cause as { code?: string } | null)?.code,
    });
  }
}
