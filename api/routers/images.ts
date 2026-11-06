import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { authedQuery, createRouter, publicQuery } from "../middleware";
import { addCredits, isAdmin, spendCredits } from "../lib/credits";
import { generateImages, imageGenEnabled } from "../lib/imageGen";
import { IMAGE_STYLES, imageCreditCost } from "@contracts/billing";

export const imagesRouter = createRouter({
  status: publicQuery.query(() => ({ enabled: imageGenEnabled() })),

  /** Immagini da testo da usare come foto frontale. Crediti restituiti per le immagini fallite. */
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
      return { images: out.images, failed: out.failed };
    }),
});
