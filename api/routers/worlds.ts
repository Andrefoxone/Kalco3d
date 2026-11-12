// Scene (ambienti 3D) con World Labs Marble: creazione da testo o da foto,
// elenco con URL firmati, mesh GLB su richiesta, eliminazione.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, isNull, or } from "drizzle-orm";
import { authedQuery, createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { worlds, type WorldRow } from "../../db/schema";
import { storage } from "../lib/storage";
import { addCredits, isAdmin, spendCredits } from "../lib/credits";
import { buildGenerateBody, marbleAvailable, MarbleError, type WorldInput } from "../worlds/marble";
import { canStartWorldJob, startMeshJob, startWorldJob } from "../worlds/job";
import {
  MAX_WORLD_JOBS_PER_USER,
  WORLD_MESH_CREDITS,
  WORLD_QUALITIES,
  WORLD_QUALITY_INFO,
  worldCreditCost,
} from "@contracts/worlds";

function sniffImage(buf: Buffer): "png" | "jpg" | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  return null;
}

function notConfigured(): TRPCError {
  return new TRPCError({ code: "PRECONDITION_FAILED", message: "Le scene non sono ancora attive su questo server (manca WORLDLABS_API_KEY)" });
}

async function withUrls(rows: WorldRow[]) {
  const keys = rows.flatMap((r) => [
    r.photoKey,
    r.thumbKey,
    r.panoKey,
    ...(r.status === "ready" ? [r.spzKey, r.colliderKey] : []),
    ...(r.meshStatus === "ready" ? [r.meshKey] : []),
  ]).filter((k): k is string => Boolean(k));
  const { urls } = keys.length ? await storage.getPresignedUrls({ keys: [...new Set(keys)] }) : { urls: [] };
  const map = new Map(urls.map((u) => [u.key, u.url]));
  const url = (k: string | null) => (k ? (map.get(k) ?? null) : null);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    source: r.source as "testo" | "foto",
    prompt: r.prompt,
    quality: r.quality,
    status: r.status as "ready" | "processing" | "failed",
    error: r.error,
    progress: r.progress,
    stage: r.stage,
    caption: r.caption,
    marbleUrl: r.marbleUrl,
    metricScale: r.metricScale,
    groundOffset: r.groundOffset,
    sizeBytes: r.sizeBytes,
    spzResolution: r.spzResolution,
    photoUrl: url(r.photoKey),
    thumbUrl: url(r.thumbKey),
    panoUrl: url(r.panoKey),
    spzUrl: r.status === "ready" ? url(r.spzKey) : null,
    colliderUrl: r.status === "ready" ? url(r.colliderKey) : null,
    meshStatus: r.meshStatus as "processing" | "ready" | "failed" | null,
    meshError: r.meshError,
    meshUrl: r.meshStatus === "ready" ? url(r.meshKey) : null,
    createdAt: r.createdAt,
  }));
}

export type WorldItem = Awaited<ReturnType<typeof withUrls>>[number];

async function checkUserJobs(userId: string, admin: boolean) {
  const max = admin ? MAX_WORLD_JOBS_PER_USER * 2 : MAX_WORLD_JOBS_PER_USER;
  const [r] = await getDb()
    .select({ n: count() })
    .from(worlds)
    .where(and(eq(worlds.userId, userId), eq(worlds.status, "processing")));
  if ((r?.n ?? 0) >= max) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Hai già ${max} scene in lavorazione: aspetta che finisca una` });
  }
}

async function own(id: number, userId: string): Promise<WorldRow> {
  const row = await getDb().query.worlds.findFirst({ where: and(eq(worlds.id, id), eq(worlds.userId, userId)) });
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Scena non trovata" });
  return row;
}

export const worldsRouter = createRouter({
  status: publicQuery.query(() => ({
    enabled: marbleAvailable(),
    qualities: WORLD_QUALITIES.map((q) => WORLD_QUALITY_INFO[q]),
    meshCredits: WORLD_MESH_CREDITS,
  })),

  list: authedQuery.query(async ({ ctx }) => {
    const rows = await getDb()
      .select()
      .from(worlds)
      .where(eq(worlds.userId, ctx.user.id))
      .orderBy(desc(worlds.createdAt))
      .limit(60);
    return withUrls(rows);
  }),

  generate: authedQuery
    .input(
      z
        .object({
          name: z.string().trim().min(1, "Dai un nome alla scena").max(80),
          quality: z.enum(WORLD_QUALITIES).default("standard"),
          text: z.string().trim().max(2000).optional(),
          /** foto in base64 (senza prefisso data:) */
          photoBase64: z.string().max(14_000_000).optional(),
        })
        .refine((v) => Boolean(v.photoBase64) || (v.text?.length ?? 0) >= 3, {
          message: "Carica una foto o descrivi la scena con qualche parola",
        }),
    )
    .mutation(async ({ input, ctx }) => {
      if (!marbleAvailable()) throw notConfigured();
      let wInput: WorldInput;
      let photo: { data: Buffer; ext: "png" | "jpg" } | null = null;
      if (input.photoBase64) {
        const data = Buffer.from(input.photoBase64, "base64");
        const ext = sniffImage(data);
        if (!ext) throw new TRPCError({ code: "BAD_REQUEST", message: "La foto deve essere PNG o JPEG" });
        photo = { data, ext };
        wInput = { kind: "foto", image: data, ext, text: input.text };
      } else {
        wInput = { kind: "testo", text: input.text ?? "" };
      }
      if (!canStartWorldJob()) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Altre scene sono in lavorazione: riprova tra qualche minuto" });
      }
      const admin = isAdmin(ctx.user.email);
      await checkUserJobs(ctx.user.id, admin);
      const safeName = input.name.replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, 80) || "scena";
      let body: Record<string, unknown>;
      try {
        body = buildGenerateBody(wInput, input.quality, safeName);
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof MarbleError ? err.message : "Richiesta non valida" });
      }

      const cost = admin ? 0 : worldCreditCost(input.quality);
      if (cost > 0) await spendCredits(ctx.user.id, cost, "scena");
      try {
        let photoKey: string | null = null;
        if (photo) {
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
          const saved = await storage.uploadFile({
            fileContent: new Uint8Array(photo.data),
            fileName: `${ctx.user.id}/scene/${stamp}-${safeName}-foto.${photo.ext}`,
            contentType: photo.ext === "png" ? "image/png" : "image/jpeg",
          });
          photoKey = saved.key;
        }
        const [row] = await getDb()
          .insert(worlds)
          .values({
            userId: ctx.user.id,
            name: safeName,
            source: photo ? "foto" : "testo",
            prompt: input.text?.slice(0, 2000) || null,
            photoKey,
            quality: input.quality,
            status: "processing",
            progress: 0,
            stage: "In coda",
            creditsPaid: cost,
          })
          .returning();
        if (!row) throw new Error("scena non salvata");
        startWorldJob(row.id, body, ctx.user.id, cost);
        const [item] = await withUrls([row]);
        return item;
      } catch (err) {
        if (cost > 0) await addCredits(ctx.user.id, cost, "rimborso_avvio", null, null).catch(() => undefined);
        throw err;
      }
    }),

  /** Mesh GLB texturizzata della scena (per Blender, Unreal, Rhino…). */
  exportMesh: authedQuery.input(z.object({ id: z.number().int() })).mutation(async ({ input, ctx }) => {
    if (!marbleAvailable()) throw notConfigured();
    const row = await own(input.id, ctx.user.id);
    if (row.status !== "ready" || !row.worldId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "La scena non è ancora pronta" });
    }
    if (row.meshStatus === "processing") throw new TRPCError({ code: "BAD_REQUEST", message: "La mesh è già in preparazione" });
    if (row.meshStatus === "ready" && row.meshKey) throw new TRPCError({ code: "BAD_REQUEST", message: "La mesh è già pronta" });
    if (!canStartWorldJob()) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Altre scene sono in lavorazione: riprova tra qualche minuto" });
    }
    const cost = isAdmin(ctx.user.email) ? 0 : WORLD_MESH_CREDITS;
    if (cost > 0) await spendCredits(ctx.user.id, cost, "mesh_scena");
    // aggiornamento condizionato: due clic ravvicinati non avviano due export
    const claimed = await getDb()
      .update(worlds)
      .set({ meshStatus: "processing", meshError: null, meshCreditsPaid: cost })
      .where(and(eq(worlds.id, row.id), eq(worlds.status, "ready"), or(isNull(worlds.meshStatus), eq(worlds.meshStatus, "failed"))))
      .returning({ id: worlds.id, meshStatus: worlds.meshStatus });
    if (!claimed.length) {
      if (cost > 0) await addCredits(ctx.user.id, cost, "rimborso_avvio", null, null).catch(() => undefined);
      throw new TRPCError({ code: "CONFLICT", message: "La scena è cambiata: ricarica la pagina" });
    }
    startMeshJob(row.id, row.worldId, ctx.user.id, cost);
    return { ok: true };
  }),

  /** URL di download con nome file leggibile. */
  download: authedQuery
    .input(z.object({ id: z.number().int(), file: z.enum(["spz", "mesh", "collider", "pano"]) }))
    .query(async ({ input, ctx }) => {
      const row = await own(input.id, ctx.user.id);
      const key = { spz: row.spzKey, mesh: row.meshKey, collider: row.colliderKey, pano: row.panoKey }[input.file];
      if (!key || row.status !== "ready" || (input.file === "mesh" && row.meshStatus !== "ready")) {
        throw new TRPCError({ code: "NOT_FOUND", message: "File non disponibile" });
      }
      const ext = key.split(".").pop() ?? "bin";
      const suffix = { spz: "", mesh: "-mesh", collider: "-collisione", pano: "-panorama" }[input.file];
      const name = `${row.name}${suffix}.${ext}`;
      const { url } = await storage.getPresignedUrl({ key, download: name });
      return { url, name };
    }),

  remove: authedQuery.input(z.object({ id: z.number().int() })).mutation(async ({ input, ctx }) => {
    const row = await own(input.id, ctx.user.id);
    if (row.status === "processing" || row.meshStatus === "processing") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "La scena è in lavorazione: eliminala quando ha finito" });
    }
    await getDb().delete(worlds).where(eq(worlds.id, row.id));
    await storage
      .deleteFiles([row.photoKey, row.spzKey, row.colliderKey, row.panoKey, row.thumbKey, row.meshKey].filter((k): k is string => Boolean(k)))
      .catch(() => undefined);
    return { ok: true };
  }),
});
