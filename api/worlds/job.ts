// Job in background delle scene Marble: stesso schema dei job AI dei modelli
// (record "processing" → avanzamento nel DB → file nello storage, rimborso
// dei crediti se qualcosa va storto).
import { eq, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { worlds } from "../../db/schema";
import { storage } from "../lib/storage";
import { log } from "../lib/logger";
import { addCredits } from "../lib/credits";
import {
  fetchAsset,
  MarbleError,
  parseExport,
  parseWorld,
  startGeneration,
  startMeshExport,
  waitOperation,
} from "./marble";

const MAX_CONCURRENT = Number(process.env.WORLD_MAX_CONCURRENT ?? 4);
const WORLD_TIMEOUT_MS = 30 * 60 * 1000;
const PROGRESS_WRITE_MS = 2500;

let running = 0;

export function canStartWorldJob(): boolean {
  return running < MAX_CONCURRENT;
}

type Patch = Partial<typeof worlds.$inferInsert>;

async function update(id: number, patch: Patch): Promise<void> {
  await getDb().update(worlds).set(patch).where(eq(worlds.id, id));
}

/** Scrive avanzamento e fase al massimo ogni PROGRESS_WRITE_MS. */
function progressWriter(id: number) {
  let lastWrite = 0;
  let lastStage = "";
  return (percent: number, stage: string) => {
    const now = Date.now();
    if (stage === lastStage && now - lastWrite < PROGRESS_WRITE_MS) return;
    lastWrite = now;
    lastStage = stage;
    void update(id, { progress: Math.max(0, Math.min(99, Math.round(percent))), stage: stage.slice(0, 96) }).catch(() => undefined);
  };
}

function errorText(err: unknown): string {
  if (err instanceof MarbleError) return err.message.slice(0, 250);
  if (err instanceof Error && err.name === "TimeoutError") return "Tempo massimo superato";
  return (err instanceof Error ? err.message : String(err)).slice(0, 250);
}

const stampNow = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

function extOf(mime: string, url: string, fallback: string): string {
  if (/png/.test(mime)) return "png";
  if (/jpe?g/.test(mime)) return "jpg";
  if (/webp/.test(mime)) return "webp";
  const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(url);
  return m ? m[1].toLowerCase() : fallback;
}

// ── Generazione della scena ──────────────────────────────────

export function startWorldJob(id: number, body: Record<string, unknown>, userId: string, cost: number): void {
  running++;
  void executeWorldJob(id, body, userId)
    .catch(async (err) => {
      const msg = errorText(err);
      log.error("world job failed", { worldRowId: id, error: msg });
      if (cost > 0) {
        await addCredits(userId, cost, "rimborso_scena", null, null).catch((e) =>
          log.error("rimborso scena fallito", { worldRowId: id, error: e instanceof Error ? e.message : String(e) }),
        );
      }
      await update(id, {
        status: "failed",
        error: msg,
        stage: cost > 0 ? "Non riuscita · crediti restituiti" : "Scena non riuscita",
        creditsPaid: 0,
      }).catch(() => undefined);
    })
    .finally(() => {
      running--;
    });
}

async function executeWorldJob(id: number, body: Record<string, unknown>, userId: string) {
  const signal = AbortSignal.timeout(WORLD_TIMEOUT_MS);
  const onProgress = progressWriter(id);
  onProgress(2, "Invio a World Labs");
  const opId = await startGeneration(body, signal);
  onProgress(5, "In coda");
  const response = await waitOperation(opId, (p) => onProgress(5 + p * 0.8, "Generazione della scena"), signal, WORLD_TIMEOUT_MS - 5 * 60_000);
  const world = parseWorld(response);

  onProgress(88, "Download della scena");
  const stamp = stampNow();
  const base = `${userId}/scene/${stamp}-${id}`;
  // lo splat è il prodotto: se non si salva, la scena fallisce (e si rimborsa)
  const spz = await fetchAsset(world.spzUrl, signal);
  const spzSaved = await storage.uploadFile({
    fileContent: new Uint8Array(spz.data),
    fileName: `${base}-${world.spzResolution}.spz`,
    contentType: "application/octet-stream",
  });

  // extra: miniatura, panorama e mesh di collisione (se mancano, pazienza)
  onProgress(94, "Salvataggio");
  const extra = async (url: string | null, name: string, fallbackExt: string, max = 40 * 1024 * 1024) => {
    if (!url) return null;
    try {
      const f = await fetchAsset(url, signal, max);
      const saved = await storage.uploadFile({
        fileContent: new Uint8Array(f.data),
        fileName: `${base}-${name}.${extOf(f.mime, url, fallbackExt)}`,
        contentType: f.mime,
      });
      return { key: saved.key, bytes: f.data.length };
    } catch (err) {
      log.warn("world: file extra non salvato", { worldRowId: id, file: name, error: errorText(err) });
      return null;
    }
  };
  const [thumb, pano, collider] = await Promise.all([
    extra(world.thumbUrl, "miniatura", "jpg", 10 * 1024 * 1024),
    extra(world.panoUrl, "panorama", "png"),
    extra(world.colliderUrl, "collisione", "glb"),
  ]);

  await update(id, {
    status: "ready",
    progress: 100,
    stage: null,
    error: null,
    worldId: world.worldId.slice(0, 96),
    marbleUrl: world.marbleUrl?.slice(0, 255) ?? null,
    caption: world.caption,
    spzKey: spzSaved.key,
    spzResolution: world.spzResolution.slice(0, 16),
    thumbKey: thumb?.key ?? null,
    panoKey: pano?.key ?? null,
    colliderKey: collider?.key ?? null,
    metricScale: world.metricScale,
    groundOffset: world.groundOffset,
    sizeBytes: spz.data.length,
  });
  log.info("world job done", { worldRowId: id, worldId: world.worldId, spzBytes: spz.data.length, resolution: world.spzResolution });
}

// ── Mesh GLB della scena (su richiesta) ─────────────────────

export function startMeshJob(id: number, worldId: string, userId: string, cost: number): void {
  running++;
  void executeMeshJob(id, worldId, userId)
    .catch(async (err) => {
      const msg = errorText(err);
      log.error("world mesh job failed", { worldRowId: id, error: msg });
      if (cost > 0) await addCredits(userId, cost, "rimborso_mesh_scena", null, null).catch(() => undefined);
      await update(id, { meshStatus: "failed", meshError: msg, meshCreditsPaid: 0, stage: null }).catch(() => undefined);
    })
    .finally(() => {
      running--;
    });
}

async function executeMeshJob(id: number, worldId: string, userId: string) {
  const signal = AbortSignal.timeout(WORLD_TIMEOUT_MS);
  const opId = await startMeshExport(worldId, signal);
  const write = progressWriter(id);
  const response = await waitOperation(opId, (p) => write(p, "Mesh della scena"), signal, WORLD_TIMEOUT_MS - 5 * 60_000);
  const url = parseExport(response);
  const glb = await fetchAsset(url, signal);
  if (glb.data.length < 20 || glb.data.readUInt32LE(0) !== 0x46546c67) throw new MarbleError("la mesh scaricata non è un GLB");
  const saved = await storage.uploadFile({
    fileContent: new Uint8Array(glb.data),
    fileName: `${userId}/scene/${stampNow()}-${id}-mesh.glb`,
    contentType: "model/gltf-binary",
  });
  await update(id, { meshStatus: "ready", meshKey: saved.key, meshError: null, stage: null });
  log.info("world mesh done", { worldRowId: id, bytes: glb.data.length });
}

// ── Avvio del server ─────────────────────────────────────────

/** I lavori "processing" di un processo ormai morto: falliti e rimborsati. */
export async function sweepStaleWorldJobs(): Promise<void> {
  try {
    // returning legge i valori dopo l'update: i crediti pagati si prendono
    // dalla riga com'era prima (sottoquery con lock)
    const scenes = (await getDb().execute(sql`
      update worlds w set status = 'failed', error = 'Generazione interrotta: il server è stato riavviato',
        stage = 'Interrotta · crediti restituiti', credits_paid = 0
      from (select id, credits_paid from worlds where status = 'processing' for update) old
      where w.id = old.id
      returning w.id, w.user_id, old.credits_paid as paid`)) as unknown as { id: number; user_id: string; paid: number }[];
    const meshes = (await getDb().execute(sql`
      update worlds w set mesh_status = 'failed', mesh_error = 'Interrotta: il server è stato riavviato', mesh_credits_paid = 0
      from (select id, mesh_credits_paid from worlds where mesh_status = 'processing' for update) old
      where w.id = old.id
      returning w.id, w.user_id, old.mesh_credits_paid as paid`)) as unknown as { id: number; user_id: string; paid: number }[];
    for (const r of [...scenes, ...meshes]) {
      if (Number(r.paid) > 0) await addCredits(r.user_id, Number(r.paid), "rimborso_riavvio", null, null).catch(() => undefined);
    }
    if (scenes.length || meshes.length) log.info("scene interrotte rimborsate", { scenes: scenes.length, meshes: meshes.length });
  } catch (err) {
    log.error("controllo scene interrotte non riuscito", { error: err instanceof Error ? err.message : String(err) });
  }
}
