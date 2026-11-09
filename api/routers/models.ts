import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, like } from "drizzle-orm";
import { authedQuery, createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { images as imagesTable, models } from "../../db/schema";
import { storage } from "../lib/storage";
import { buildGlb, buildMesh } from "../lib/glb";
import { canStartAiJob, startAiJob, startRigJob } from "../aiJob";
import { rigAvailable } from "../ai3d/rig";
import { MAX_ANIMATIONS, RIG_SPECS, rigCreditCost } from "@contracts/rig";
import { addCredits, isAdmin, spendCredits } from "../lib/credits";
import { creditCost, MAX_JOBS_PER_USER } from "@contracts/billing";
import { count } from "drizzle-orm";
import {
  QUALITIES,
  TARGETS,
  VIEWS,
  availableProviders,
  canGenerate,
  providerLabel,
  type InputImage,
} from "../ai3d";

function sniffImage(buf: Buffer): "image/png" | "image/jpeg" | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  return null;
}

const generateInput = z.object({
  name: z.string().trim().min(1, "Dai un nome al modello").max(80),
  mode: z.enum(["rilievo", "sfera", "cilindro", "torno"]),
  width: z.number().int().min(16).max(320),
  height: z.number().int().min(16).max(320),
  heights: z.array(z.number().min(0).max(1)).max(320 * 320),
  depth: z.number().min(0).max(1),
  invert: z.boolean(),
  cutBackground: z.boolean().default(false),
  mask: z.array(z.number().int().min(0).max(1)).max(320 * 320).optional(),
  /** rilievo+maschera: chiude il volume con il guscio posteriore speculare */
  solid: z.boolean().default(false),
  textureBase64: z.string().max(6_000_000),
});

async function withUrls<
  T extends { glbKey: string; photoKey: string; status: string; previewKey?: string | null; provider?: string | null },
>(rows: T[]) {
  if (rows.length === 0)
    return [] as (T & { glbUrl: string | null; photoUrl: string | null; previewUrl: string | null; providerLabel: string | null })[];
  // URL firmati di Supabase Storage (validi 1 ora; la galleria si aggiorna
  // prima). Lo storage di Supabase risponde con CORS aperto, quindi anche i GLB
  // si caricano direttamente. I record AI in lavorazione non hanno ancora un GLB.
  const { urls } = await storage.getPresignedUrls({
    keys: [
      ...new Set(
        rows.flatMap((r) => [
          r.photoKey,
          ...(r.previewKey ? [r.previewKey] : []),
          ...(r.status === "ready" && r.glbKey ? [r.glbKey] : []),
        ]),
      ),
    ],
  });
  const map = new Map(urls.map((u) => [u.key, u.url]));
  return rows.map((r) => ({
    ...r,
    glbUrl: r.status === "ready" && r.glbKey ? (map.get(r.glbKey) ?? null) : null,
    photoUrl: map.get(r.photoKey) ?? null,
    previewUrl: r.previewKey ? (map.get(r.previewKey) ?? null) : null,
    providerLabel: r.provider ? providerLabel(r.provider) : null,
  }));
}

async function checkUserJobs(userId: string, admin = false) {
  const max = admin ? MAX_JOBS_PER_USER * 2 : MAX_JOBS_PER_USER;
  const [r] = await getDb()
    .select({ n: count() })
    .from(models)
    .where(and(eq(models.userId, userId), eq(models.status, "processing")));
  if ((r?.n ?? 0) >= max) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Hai già ${max} generazioni in corso: aspetta che finisca una`,
    });
  }
}

/** Scala i crediti, esegue start(); se l'avvio fallisce restituisce i crediti. */
async function withCharge<T>(userId: string, cost: number, start: () => Promise<T>): Promise<T> {
  if (cost <= 0) return start();
  await spendCredits(userId, cost, "generazione");
  try {
    return await start();
  } catch (err) {
    await addCredits(userId, cost, "rimborso_avvio", null, null).catch(() => undefined);
    throw err;
  }
}

export const modelsRouter = createRouter({
  generate: authedQuery.input(generateInput).mutation(async ({ input, ctx }) => {
    if (input.heights.length !== input.width * input.height) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "La mappa di profondità non corrisponde alle dimensioni dichiarate",
      });
    }
    if (input.mask && input.mask.length !== input.width * input.height) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "La sagoma non corrisponde alle dimensioni dichiarate",
      });
    }
    if (input.mode === "torno" && !input.mask) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "La modalità torno richiede il ritaglio dello sfondo",
      });
    }
    const tex = Buffer.from(input.textureBase64, "base64");
    const isPng =
      tex.length > 8 && tex[0] === 0x89 && tex[1] === 0x50 && tex[2] === 0x4e && tex[3] === 0x47;
    const isJpg = tex.length > 2 && tex[0] === 0xff && tex[1] === 0xd8;
    if (!isPng && !isJpg) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Texture non valida" });
    }
    const mesh = buildMesh({
      mode: input.mode,
      width: input.width,
      height: input.height,
      heights: Float32Array.from(input.heights),
      depth: input.depth,
      invert: input.invert,
      mask: input.mask ? Uint8Array.from(input.mask) : undefined,
      solid: input.solid,
    });
    if (mesh.triangleCount === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Il ritaglio ha eliminato tutto il soggetto: alza la tolleranza o disattiva il ritaglio sfondo",
      });
    }
    const glb = buildGlb(mesh, tex, {
      mimeType: isPng ? "image/png" : "image/jpeg",
      // torno escluso: parete interna e bordo campionano vicino al bordo della
      // sagoma, e l'alpha cutout bucherebbe la superficie
      alphaMask: input.cutBackground && isPng && input.mode !== "torno",
    });

    const safeName =
      input.name.replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, 80) || "modello";
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const [glbSaved, photoSaved] = await Promise.all([
      storage.uploadFile({
        fileContent: new Uint8Array(glb),
        fileName: `${ctx.user.id}/modelli/${stamp}-${safeName}.glb`,
        contentType: "model/gltf-binary",
      }),
      storage.uploadFile({
        fileContent: new Uint8Array(tex),
        fileName: `${ctx.user.id}/foto/${stamp}-${safeName}.${isPng ? "png" : "jpg"}`,
        contentType: isPng ? "image/png" : "image/jpeg",
      }),
    ]);

    const inserted = await getDb().insert(models).values({
      userId: ctx.user.id,
      name: safeName,
      mode: input.mode,
      glbKey: glbSaved.key,
      photoKey: photoSaved.key,
      vertices: mesh.vertexCount,
      triangles: mesh.triangleCount,
      sizeBytes: glb.length,
    }).returning({ id: models.id });
    const id = inserted[0]?.id;
    const row = await getDb().query.models.findFirst({ where: eq(models.id, id) });
    if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [withUrl] = await withUrls([row]);
    return withUrl;
  }),

  list: authedQuery.query(async ({ ctx }) => {
    const rows = await getDb()
      .select()
      .from(models)
      .where(eq(models.userId, ctx.user.id))
      .orderBy(desc(models.createdAt))
      .limit(60);
    return withUrls(rows);
  }),

  /** Quali motori sono configurati: l'interfaccia lo usa per i messaggi. */
  aiStatus: publicQuery.query(() => {
    const ids = [...availableProviders()];
    return {
      providers: ids.map((id) => ({ id, label: providerLabel(id) })),
      canSingle: canGenerate(1),
      canMulti: canGenerate(2),
      canRig: rigAvailable(),
    };
  }),

  // Generazione AI multi-motore: crea subito il record "processing" e lavora
  // in background; il frontend interroga `list` per avanzamento e stato.
  generateAi: authedQuery
    .input(
      z.object({
        name: z.string().trim().min(1, "Dai un nome al modello").max(80),
        photos: z
          .array(z.object({ view: z.enum(VIEWS), base64: z.string().max(12_000_000) }))
          .min(1)
          .max(4),
        quality: z.enum(QUALITIES).default("standard"),
        target: z.enum(TARGETS).default("ecommerce"),
        /** la foto frontale viene già dalla galleria Foto: non duplicarla */
        imageId: z.number().int().nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const seen = new Set<string>();
      const images: InputImage[] = [];
      for (const p of input.photos) {
        if (seen.has(p.view)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Ogni vista può avere una sola foto" });
        }
        seen.add(p.view);
        const data = Buffer.from(p.base64, "base64");
        const mime = sniffImage(data);
        if (!mime) throw new TRPCError({ code: "BAD_REQUEST", message: "Le foto devono essere PNG o JPEG" });
        images.push({ view: p.view, data, mime });
      }
      if (!seen.has("front")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Serve almeno la foto frontale" });
      }
      if (!canGenerate(images.length)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Nessun motore 3D configurato sul server: aggiungi una chiave API",
        });
      }
      if (!canStartAiJob()) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Altre generazioni AI sono in corso: riprova tra qualche minuto",
        });
      }
      const admin = isAdmin(ctx.user.email);
      await checkUserJobs(ctx.user.id, admin);
      const cost = admin ? 0 : creditCost(input.quality, input.target);
      return withCharge(ctx.user.id, cost, async () => {
      const safeName =
        input.name.replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, 80) || "modello";
      const front = images.find((i) => i.view === "front")!;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const savedPhoto = await storage.uploadFile({
        fileContent: new Uint8Array(front.data),
        fileName: `${ctx.user.id}/foto/${stamp}-${safeName}.${front.mime === "image/png" ? "png" : "jpg"}`,
        contentType: front.mime,
      });
      const inserted = await getDb()
        .insert(models)
        .values({
          userId: ctx.user.id,
          name: safeName,
          mode: "ai",
          glbKey: "",
          photoKey: savedPhoto.key,
          vertices: 0,
          triangles: 0,
          sizeBytes: 0,
          status: "processing",
          quality: input.quality,
          target: input.target,
          views: images.length,
          progress: 0,
          stage: "In coda",
        })
        .returning({ id: models.id });
      const id = inserted[0]?.id;
      if (!input.imageId) {
        await getDb()
          .insert(imagesTable)
          .values({ userId: ctx.user.id, source: "foto", name: safeName, path: savedPhoto.key })
          .catch(() => undefined);
      }
      startAiJob(id, { images, quality: input.quality, target: input.target }, `${ctx.user.id}/${safeName}`, cost > 0 ? { userId: ctx.user.id, cost } : undefined);
      const row = await getDb().query.models.findFirst({ where: eq(models.id, id) });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [withUrl] = await withUrls([row]);
      return withUrl;
      });
    }),

  // Variante di forma via AI: riusa la foto originale del modello e lancia una
  // nuova generazione (i motori sono non deterministici → interpretazioni diverse).
  generateVariant: authedQuery
    .input(
      z.object({
        id: z.number().int(),
        quality: z.enum(QUALITIES).optional(),
        target: z.enum(TARGETS).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const parent = await getDb().query.models.findFirst({
        where: and(eq(models.id, input.id), eq(models.userId, ctx.user.id)),
      });
      if (!parent) throw new TRPCError({ code: "NOT_FOUND", message: "Modello non trovato" });
      if (!parent.photoKey) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Questo modello non ha una foto di origine da cui generare",
        });
      }
      if (!canGenerate(1)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Nessun motore 3D configurato sul server: aggiungi una chiave API",
        });
      }
      if (!canStartAiJob()) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Altre generazioni AI sono in corso: riprova tra qualche minuto",
        });
      }
      let data: Buffer;
      try {
        data = Buffer.from(await storage.readFile({ fileKey: parent.photoKey }));
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "La foto di origine non è raggiungibile dallo storage",
        });
      }
      const mime = sniffImage(data);
      if (!mime) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "La foto di origine non è un'immagine leggibile",
        });
      }
      const quality = QUALITIES.includes(parent.quality as (typeof QUALITIES)[number])
        ? (parent.quality as (typeof QUALITIES)[number])
        : "standard";
      const target = TARGETS.includes(parent.target as (typeof TARGETS)[number])
        ? (parent.target as (typeof TARGETS)[number])
        : "ecommerce";
      const admin = isAdmin(ctx.user.email);
      await checkUserJobs(ctx.user.id, admin);
      const cost = admin ? 0 : creditCost(input.quality ?? quality, input.target ?? target);
      return withCharge(ctx.user.id, cost, async () => {
      const base = parent.name.replace(/\s*—\s*variante.*$/i, "").trim().slice(0, 56) || "modello";
      const siblings = await getDb()
        .select({ id: models.id })
        .from(models)
        .where(and(eq(models.userId, ctx.user.id), like(models.name, `${base} — variante%`)));
      const name = `${base} — variante ${siblings.length + 1}`.slice(0, 80);
      const inserted = await getDb()
        .insert(models)
        .values({
          userId: ctx.user.id,
          name,
          mode: "ai",
          glbKey: "",
          photoKey: parent.photoKey,
          vertices: 0,
          triangles: 0,
          sizeBytes: 0,
          status: "processing",
          quality: input.quality ?? quality,
          target: input.target ?? target,
          views: 1,
          progress: 0,
          stage: "In coda",
        })
        .returning({ id: models.id });
      const id = inserted[0]?.id;
      startAiJob(
        id,
        {
          images: [{ view: "front", data, mime }],
          quality: input.quality ?? quality,
          target: input.target ?? target,
        },
        `${ctx.user.id}/${name.replace(/[^\p{L}\p{N} _.'-]/gu, "")}`,
        cost > 0 ? { userId: ctx.user.id, cost } : undefined,
      );
      const row = await getDb().query.models.findFirst({ where: eq(models.id, id) });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [withUrl] = await withUrls([row]);
      return withUrl;
      });
    }),

  download: authedQuery
    .input(z.object({ id: z.number().int(), format: z.enum(["glb", "fbx"]).default("glb") }))
    .query(async ({ input, ctx }) => {
      const row = await getDb().query.models.findFirst({
        where: and(eq(models.id, input.id), eq(models.userId, ctx.user.id)),
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Modello non trovato" });
      if (input.format === "fbx") {
        if (row.status !== "ready" || !row.fbxKey) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Questo modello non ha una copia FBX" });
        }
        const { url } = await storage.getPresignedUrl({ key: row.fbxKey, download: true });
        return { url, name: `${row.name}.fbx` };
      }
      const { url } = await storage.getPresignedUrl({ key: row.glbKey, download: true });
      return { url, name: `${row.name}.glb` };
    }),

  // Auto-rigging: scheletro + animazioni su un modello pronto. Crea un nuovo
  // modello "rig" (l'originale resta com'è) e lavora in background.
  rig: authedQuery
    .input(
      z.object({
        id: z.number().int(),
        animations: z.array(z.string().max(48)).max(MAX_ANIMATIONS),
        spec: z.enum(RIG_SPECS.map((s) => s.id) as [string, ...string[]]).default("tripo"),
        fbx: z.boolean().default(true),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const parent = await getDb().query.models.findFirst({
        where: and(eq(models.id, input.id), eq(models.userId, ctx.user.id)),
      });
      if (!parent) throw new TRPCError({ code: "NOT_FOUND", message: "Modello non trovato" });
      if (parent.status !== "ready" || !parent.glbKey) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Il modello non è ancora pronto" });
      }
      if (parent.mode === "rig") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Questo modello è già animato: parti dall'originale" });
      }
      if (!rigAvailable()) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Animazione non disponibile: manca la chiave Tripo sul server" });
      }
      if (!canStartAiJob()) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Altre generazioni AI sono in corso: riprova tra qualche minuto" });
      }
      const admin = isAdmin(ctx.user.email);
      await checkUserJobs(ctx.user.id, admin);
      const cost = admin ? 0 : rigCreditCost(input.fbx);
      return withCharge(ctx.user.id, cost, async () => {
        // URL firmato valido abbastanza a lungo per i tre passaggi del motore
        const { url: modelUrl } = await storage.getPresignedUrl({ key: parent.glbKey });
        const base = parent.name.replace(/\s*—\s*animato.*$/i, "").trim().slice(0, 64) || "modello";
        const name = `${base} — animato`.slice(0, 80);
        const inserted = await getDb()
          .insert(models)
          .values({
            userId: ctx.user.id,
            name,
            mode: "rig",
            glbKey: "",
            photoKey: parent.photoKey,
            previewKey: parent.previewKey,
            parentId: parent.id,
            // segnaposto finché lavora: serve per rimborsare il prezzo giusto se il server si riavvia
            fbxKey: input.fbx ? "fbx" : null,
            quality: parent.quality,
            target: parent.target,
            views: parent.views,
            status: "processing",
            progress: 0,
            stage: "In coda",
          })
          .returning({ id: models.id });
        const id = inserted[0]?.id;
        startRigJob(
          id,
          { modelUrl, animations: input.animations, spec: input.spec as (typeof RIG_SPECS)[number]["id"], fbx: input.fbx },
          `${ctx.user.id}/${name.replace(/[^\p{L}\p{N} _.'-]/gu, "")}`,
          cost > 0 ? { userId: ctx.user.id, cost } : undefined,
        );
        const row = await getDb().query.models.findFirst({ where: eq(models.id, id) });
        if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const [withUrl] = await withUrls([row]);
        return withUrl;
      });
    }),

  // Importa un file CAD (DWG/DXF/STEP/IGES/STL/OBJ/PLY) già convertito in GLB
  // dal browser: salviamo il GLB e l'anteprima renderizzata dal viewport.
  importCad: authedQuery
    .input(
      z.object({
        name: z.string().trim().min(1, "Dai un nome al modello").max(80),
        sourceFormat: z.enum(["dwg", "dxf", "step", "iges", "stl", "obj", "ply"]),
        glbBase64: z.string().max(20_000_000),
        previewPngBase64: z.string().max(4_000_000),
        vertices: z.number().int().min(0),
        triangles: z.number().int().min(0),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const glb = Buffer.from(input.glbBase64, "base64");
      if (glb.length < 20 || glb.readUInt32LE(0) !== 0x46546c67) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "File GLB non valido" });
      }
      const png = Buffer.from(input.previewPngBase64, "base64");
      if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Anteprima PNG non valida" });
      }
      const safeName =
        input.name.replace(/[^\p{L}\p{N} _.'()-]/gu, "").trim().slice(0, 80) || "modello cad";
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const [savedGlb, savedPng] = await Promise.all([
        storage.uploadFile({
          fileContent: new Uint8Array(glb),
          fileName: `${ctx.user.id}/modelli/${stamp}-${safeName}.glb`,
          contentType: "model/gltf-binary",
        }),
        storage.uploadFile({
          fileContent: new Uint8Array(png),
          fileName: `${ctx.user.id}/anteprime/${stamp}-${safeName}.png`,
          contentType: "image/png",
        }),
      ]);
      const inserted = await getDb()
        .insert(models)
        .values({
          userId: ctx.user.id,
          name: safeName,
          mode: "cad",
          glbKey: savedGlb.key,
          photoKey: savedPng.key,
          previewKey: savedPng.key,
          vertices: input.vertices,
          triangles: input.triangles,
          sizeBytes: glb.length,
          status: "ready",
          views: 1,
          progress: 100,
        })
        .returning({ id: models.id });
      const row = await getDb().query.models.findFirst({
        where: eq(models.id, inserted[0]?.id),
      });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [withUrl] = await withUrls([row]);
      return withUrl;
    }),

  // Salva una versione modificata (scultura/materiale) esportata dal browser
  saveEdited: authedQuery
    .input(
      z.object({
        name: z.string().trim().min(1).max(80),
        parentId: z.number().int(),
        glbBase64: z.string().max(14_000_000),
        vertices: z.number().int().min(0),
        triangles: z.number().int().min(0),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const parent = await getDb().query.models.findFirst({
        where: and(eq(models.id, input.parentId), eq(models.userId, ctx.user.id)),
      });
      if (!parent) throw new TRPCError({ code: "NOT_FOUND", message: "Modello origine non trovato" });
      const glb = Buffer.from(input.glbBase64, "base64");
      if (glb.length < 20 || glb.readUInt32LE(0) !== 0x46546c67) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "File GLB non valido" });
      }
      const safeName =
        input.name.replace(/[^\p{L}\p{N} _.'()-]/gu, "").trim().slice(0, 80) || "modifica";
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const saved = await storage.uploadFile({
        fileContent: new Uint8Array(glb),
        fileName: `${ctx.user.id}/modelli/${stamp}-${safeName}.glb`,
        contentType: "model/gltf-binary",
      });
      const inserted = await getDb()
        .insert(models)
        .values({
          userId: ctx.user.id,
          name: safeName,
          mode: parent.mode,
          glbKey: saved.key,
          photoKey: parent.photoKey,
          quality: parent.quality,
          target: parent.target,
          provider: parent.provider,
          views: parent.views,
          vertices: input.vertices,
          triangles: input.triangles,
          sizeBytes: glb.length,
        })
        .returning({ id: models.id });
      const row = await getDb().query.models.findFirst({
        where: eq(models.id, inserted[0]?.id),
      });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [withUrl] = await withUrls([row]);
      return withUrl;
    }),
});
