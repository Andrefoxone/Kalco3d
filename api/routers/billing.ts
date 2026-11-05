import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { authedQuery, createRouter, publicQuery } from "../middleware";
import { ensureAccount, isAdmin } from "../lib/credits";
import { billingEnabled, createCheckout, createPortal, priceId } from "../lib/billing";
import { PACK, PLAN_IDS, PLANS } from "@contracts/billing";

function returnUrl(req: Request): string {
  const base = process.env.APP_URL || new URL(req.url).origin;
  return base.replace(/\/$/, "") + "/";
}

export const billingRouter = createRouter({
  /** Piani in vendita (quelli con un prezzo Stripe configurato). */
  plans: publicQuery.query(() => ({
    enabled: billingEnabled(),
    plans: PLANS.map((p) => ({ ...p, available: Boolean(priceId(p.id)) })),
    pack: { ...PACK, available: Boolean(priceId("pack")) },
  })),

  /** Saldo dell'utente; al primo accesso crea il conto con il bonus di benvenuto. */
  account: authedQuery.query(async ({ ctx }) => ({ ...(await ensureAccount(ctx.user.id)), admin: isAdmin(ctx.user.email) })),

  checkout: authedQuery
    .input(z.object({ item: z.enum([...PLAN_IDS, "pack"]) }))
    .mutation(async ({ input, ctx }) => {
      if (!billingEnabled() || !priceId(input.item)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "I pagamenti non sono ancora attivi" });
      }
      const acc = await ensureAccount(ctx.user.id);
      if (input.item !== "pack" && acc.planStatus === "active") {
        throw new TRPCError({ code: "CONFLICT", message: "Hai già un abbonamento: cambialo dalla gestione abbonamento" });
      }
      const url = await createCheckout({
        userId: ctx.user.id,
        email: ctx.user.email,
        customerId: acc.stripeCustomerId,
        item: input.item,
        returnUrl: returnUrl(ctx.req),
      });
      return { url };
    }),

  portal: authedQuery.mutation(async ({ ctx }) => {
    const acc = await ensureAccount(ctx.user.id);
    if (!acc.stripeCustomerId) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Non hai ancora un abbonamento" });
    }
    return { url: await createPortal(acc.stripeCustomerId, returnUrl(ctx.req)) };
  }),
});
