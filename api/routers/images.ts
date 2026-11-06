import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, lt } from "drizzle-orm";
import { authedQuery, createRouter, publicQuery } from "../middleware";
import { addCredits, isAdmin, spendCredits } from "../lib/credits";
import { generateImages, imageGenEnabled } from "../lib/imageGen";
import { storage } from "../lib/storage";
import { getDb } from "../queries/connection";
import { images, models } from "../../db/schema";
import { IMAGE_STYLES, imageCreditCost } from "@contracts/billing";

const PAGE = 60;

function decodeDataUrl(dataUrl: string): { data: Uint8Array; mime: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error("immagine non valida");
  return { mime: m[1], data: new Uint8Array(Buffer.from(m[2], "base64")) };
}

export const imagesRouter = createRouter({
  status: publicQuery.query(() => ({ enabled: imageGenEnabled() })),

  /** Galleria Foto, dalla più recente; cursor = id dell'ultima ricevuta. */
  list: authedQuery
    .input(z.object({ cursor: z.number().int().nullish(), source: z.enum(["tutte", "ai", "foto"]).default("tutte") }).optional())
    .query(async ({ input, ctx }) => {
      const where = [eq(images.userId, ctx.user.id)];
      if (input?.cursor) where.push(lt(images.id, input.cursor));
      if (input?.source && input.source !== "tutte") where.push(eq(images.source, input.source));
      const rows = await getDb()
        .select()
        .from(images)
        .where(and(...where))
        .orderBy(desc(images.id))
        .limit(PAGE + 1);
      const page = rows.slice(0, PAGE);
      const { urls } = await storage.getPresignedUrls({ keys: page.map((r) => r.path) });
      const map = new Map(urls.map((u) => [u.key, u.url]));
      return {
        items: page.map((r) => ({
          id: r.id,
          source: r.source as "ai" | "foto",
          name: r.name,
          prompt: r.prompt,
          style: r.style,
          url: map.get(r.path) ?? null,
          createdAt: r.createdAt,
        })),
        nextCursor: rows.length > PAGE ? page[page.length - 1].id : null,
      };
    }),

  /** Toglie dalla galleria; il file si cancella solo se nessun modello lo usa. */
  remove: authedQuery.input(z.object({ id: z.number().int() })).mutation(async ({ input, ctx }) => {
    const row = await getDb().query.images.findFirst({ where: and(eq(images.id, input.id), eq(images.userId, ctx.user.id)) });
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Immagine non trovata" });
    await getDb().delete(images).where(eq(images.id, row.id));
    const used = await getDb().query.models.findFirst({ where: eq(models.photoKey, row.path) });
    if (!used) await storage.deleteFiles([row.path]).catch(() => undefined);
    return { ok: true };
  }),

  /** Immagini da testo da usare come foto frontale; salvate nella galleria Foto. */
  generate: authedQuery
    .input(
      z.object({
        prompt: z.string().trim().min(3, "Descrivi l'oggetto con qualche parola").max(600),
        style: z.enum(IMAGE_STYLES),
        forPrint: z.boolean(),
        count: z.number().int().min(1).max(4),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (!imageGenEnabled()) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "La creazione di immagini non è ancora attiva su questo server" });
      }
      const cost = isAdmin(ctx.user.email) ? 0 : imageCreditCost(input.count);
      if (cost > 0) await spendCredits(ctx.user.id, cost, "immagini");
      const out = await generateImages(input.prompt, input.style, input.forPrint, input.count).catch((err: unknown) => ({
        images: [],
        failed: input.count,
        lastError: err instanceof Error ? err.message : String(err),
      }));
      if (cost > 0 && out.failed > 0) {
        // rimborso proporzionale; tutto se nessuna immagine è riuscita
        const refund = out.images.length === 0 ? cost : cost - imageCreditCost(out.images.length);
        if (refund > 0) await addCredits(ctx.user.id, refund, "rimborso_immagini", null, null).catch(() => undefined);
      }
      if (out.images.length === 0) {
        const blocked = /safety|nsfw|content/i.test(out.lastError ?? "");
        throw new TRPCError({
          code: blocked ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR",
          message: blocked
            ? "La descrizione è stata bloccata dal filtro dei contenuti: prova a riformularla. Crediti restituiti."
            : "Il servizio immagini non ha risposto: riprova tra poco. Crediti restituiti.",
        });
      }
      // salvataggio nella galleria Foto (se fallisce, l'utente ha comunque le immagini)
      const name = input.prompt.replace(/\s+/g, " ").slice(0, 120);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const saved = await Promise.all(
        out.images.map(async (img, i) => {
          try {
            const { data, mime } = decodeDataUrl(img.dataUrl);
            const { key } = await storage.uploadFile({
              fileContent: data,
              fileName: `${ctx.user.id}/immagini/${stamp}-${i + 1}.${mime === "image/png" ? "png" : "jpg"}`,
              contentType: mime,
            });
            const [row] = await getDb()
              .insert(images)
              .values({ userId: ctx.user.id, source: "ai", name, prompt: input.prompt, style: input.style, path: key })
              .returning({ id: images.id });
            return { id: row?.id ?? null, dataUrl: img.dataUrl };
          } catch {
            return { id: null, dataUrl: img.dataUrl };
          }
        }),
      );
      return { images: saved, failed: out.failed };
    }),
});
