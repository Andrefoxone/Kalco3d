// Stripe: checkout (abbonamenti e ricarica), portale cliente e webhook.
// I crediti si accreditano SOLO dai webhook firmati, mai dal ritorno del browser.
import Stripe from "stripe";
import { PACK, PLANS, planById, type PlanId } from "@contracts/billing";
import { log } from "./logger";
import { addCredits, renewPlan, setPlanStatus, setStripeCustomer, userByCustomer } from "./credits";

let client: Stripe | null | undefined;

export function stripe(): Stripe | null {
  if (client === undefined) {
    const key = process.env.STRIPE_SECRET_KEY;
    client = key ? new Stripe(key) : null;
  }
  return client;
}

export function billingEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

const PRICE_ENV: Record<PlanId | "pack", string> = {
  maker: "STRIPE_PRICE_MAKER",
  pro: "STRIPE_PRICE_PRO",
  studio: "STRIPE_PRICE_STUDIO",
  pack: "STRIPE_PRICE_PACK",
};

export function priceId(item: PlanId | "pack"): string | null {
  return process.env[PRICE_ENV[item]] || null;
}

/** Price Stripe → piano (per i rinnovi e i cambi di piano). */
export function planByPrice(price: string | null | undefined): PlanId | null {
  if (!price) return null;
  for (const p of PLANS) if (priceId(p.id) === price) return p.id;
  return null;
}

export async function createCheckout(opts: {
  userId: string;
  email: string | null;
  customerId: string | null;
  item: PlanId | "pack";
  returnUrl: string;
}): Promise<string> {
  const s = stripe();
  const price = priceId(opts.item);
  if (!s || !price) throw new Error("Pagamenti non ancora configurati");
  const isPack = opts.item === "pack";
  const session = await s.checkout.sessions.create({
    mode: isPack ? "payment" : "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: opts.userId,
    ...(opts.customerId ? { customer: opts.customerId } : { customer_email: opts.email ?? undefined }),
    ...(isPack ? { customer_creation: opts.customerId ? undefined : "always" } : {}),
    metadata: { userId: opts.userId, item: opts.item },
    ...(isPack ? {} : { subscription_data: { metadata: { userId: opts.userId, plan: opts.item } } }),
    allow_promotion_codes: true,
    automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX === "1" },
    success_url: `${opts.returnUrl}?pagamento=ok`,
    cancel_url: `${opts.returnUrl}?pagamento=annullato`,
    locale: "it",
  });
  if (!session.url) throw new Error("Stripe non ha restituito la pagina di pagamento");
  return session.url;
}

export async function createPortal(customerId: string, returnUrl: string): Promise<string> {
  const s = stripe();
  if (!s) throw new Error("Pagamenti non ancora configurati");
  const portal = await s.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl, locale: "it" });
  return portal.url;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown> & { [k: string]: unknown };

function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as Loose).id === "string") return (v as Loose).id as string;
  return null;
}

/** Verifica la firma e restituisce l'evento; lancia se non valida. */
export function verifyWebhook(rawBody: string, signature: string | null | undefined): Stripe.Event {
  const s = stripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s || !secret) throw new Error("webhook non configurato");
  if (!signature) throw new Error("firma mancante");
  return s.webhooks.constructEvent(rawBody, signature, secret);
}

/** Abbonamento → utente, piano e fine periodo (campi spostati tra versioni dell'API: si leggono entrambi). */
async function subscriptionInfo(subId: string): Promise<{ userId: string | null; plan: PlanId | null; periodEnd: Date | null; customer: string | null; status: string }> {
  const s = stripe()!;
  const sub = (await s.subscriptions.retrieve(subId)) as unknown as Loose;
  const items = ((sub.items as Loose)?.data as Loose[]) ?? [];
  const item = items[0] ?? {};
  const price = str(item.price);
  const end = (item.current_period_end ?? sub.current_period_end) as number | undefined;
  const meta = (sub.metadata as Record<string, string>) ?? {};
  const customer = str(sub.customer);
  return {
    userId: meta.userId ?? (customer ? await userByCustomer(customer) : null),
    plan: planByPrice(price) ?? ((meta.plan as PlanId) || null),
    periodEnd: end ? new Date(end * 1000) : null,
    customer,
    status: String(sub.status ?? "active"),
  };
}

export async function handleStripeEvent(event: Stripe.Event): Promise<string> {
  const obj = event.data.object as unknown as Loose;
  switch (event.type) {
    case "checkout.session.completed": {
      const meta = (obj.metadata as Record<string, string>) ?? {};
      const userId = meta.userId ?? (obj.client_reference_id as string | null);
      const customer = str(obj.customer);
      if (!userId) return "sessione senza utente";
      if (customer) await setStripeCustomer(userId, customer, str(obj.subscription));
      if (meta.item === "pack" && obj.payment_status === "paid") {
        const ok = await addCredits(userId, PACK.credits, "ricarica", null, event.id);
        return ok ? `ricarica +${PACK.credits}` : "ricarica già accreditata";
      }
      return "cliente collegato";
    }
    case "invoice.paid": {
      const parent = (obj.parent as Loose | undefined)?.subscription_details as Loose | undefined;
      const subId = str(parent?.subscription) ?? str(obj.subscription);
      if (!subId) return "fattura senza abbonamento";
      const info = await subscriptionInfo(subId);
      if (!info.userId || !info.plan) return "abbonamento non riconosciuto";
      const plan = planById(info.plan)!;
      if (info.customer) await setStripeCustomer(info.userId, info.customer, subId);
      const ok = await renewPlan(info.userId, plan.id, plan.credits, info.periodEnd, event.id);
      return ok ? `piano ${plan.id}: ${plan.credits} crediti` : "rinnovo già accreditato";
    }
    case "customer.subscription.updated": {
      const info = await subscriptionInfo(String(obj.id));
      if (!info.userId) return "abbonamento senza utente";
      // il cambio di piano accredita i nuovi crediti con la fattura (invoice.paid)
      await setPlanStatus(info.userId, info.plan ?? "free", info.status, false);
      return `stato ${info.status}`;
    }
    case "customer.subscription.deleted": {
      const customer = str(obj.customer);
      const meta = (obj.metadata as Record<string, string>) ?? {};
      const userId = meta.userId ?? (customer ? await userByCustomer(customer) : null);
      if (!userId) return "abbonamento senza utente";
      // i crediti del piano finiscono con l'abbonamento; restano quelli delle ricariche
      await setPlanStatus(userId, "free", "canceled", true);
      return "abbonamento chiuso";
    }
    default:
      return "ignorato";
  }
}

export async function processWebhook(rawBody: string, signature: string | null | undefined): Promise<{ status: number; body: string }> {
  let event: Stripe.Event;
  try {
    event = verifyWebhook(rawBody, signature);
  } catch (err) {
    log.warn("webhook stripe rifiutato", { error: err instanceof Error ? err.message : String(err) });
    return { status: 400, body: "firma non valida" };
  }
  try {
    const result = await handleStripeEvent(event);
    log.info("webhook stripe", { type: event.type, id: event.id, result });
    return { status: 200, body: result };
  } catch (err) {
    // 500 = Stripe riprova più tardi; gli accrediti sono idempotenti sull'id dell'evento
    log.error("webhook stripe fallito", { type: event.type, id: event.id, error: err instanceof Error ? err.message : String(err) });
    return { status: 500, body: "errore temporaneo" };
  }
}
