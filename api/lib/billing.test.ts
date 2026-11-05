import { beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

// contabilità finta: registra le chiamate al posto del database
const calls: unknown[][] = [];
vi.mock("./credits", () => ({
  addCredits: vi.fn(async (...a: unknown[]) => (calls.push(["add", ...a]), true)),
  renewPlan: vi.fn(async (...a: unknown[]) => (calls.push(["renew", ...a]), true)),
  setPlanStatus: vi.fn(async (...a: unknown[]) => void calls.push(["status", ...a])),
  setStripeCustomer: vi.fn(async (...a: unknown[]) => void calls.push(["customer", ...a])),
  userByCustomer: vi.fn(async () => "user-da-cliente"),
}));

process.env.STRIPE_SECRET_KEY = "sk_test_finta";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_segreto";
process.env.STRIPE_PRICE_PRO = "price_pro";
process.env.STRIPE_PRICE_PACK = "price_pack";

const { processWebhook, stripe } = await import("./billing");
const { creditCost } = await import("@contracts/billing");

function signed(event: object) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test_segreto" });
  return { payload, header };
}

beforeEach(() => {
  calls.length = 0;
});

describe("webhook Stripe", () => {
  it("rifiuta un evento con firma sbagliata e non accredita nulla", async () => {
    const { payload } = signed({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } });
    const bad = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_altro" });
    const r = await processWebhook(payload, bad);
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("ricarica pagata: +100 crediti con l'id dell'evento (idempotenza)", async () => {
    const { payload, header } = signed({
      id: "evt_pack",
      type: "checkout.session.completed",
      data: { object: { metadata: { userId: "u1", item: "pack" }, payment_status: "paid", customer: "cus_1", subscription: null } },
    });
    const r = await processWebhook(payload, header);
    expect(r.status).toBe(200);
    expect(calls).toContainEqual(["customer", "u1", "cus_1", null]);
    expect(calls).toContainEqual(["add", "u1", 100, "ricarica", null, "evt_pack"]);
  });

  it("fattura dell'abbonamento pagata: il piano riparte dai suoi crediti", async () => {
    const s = stripe()!;
    vi.spyOn(s.subscriptions, "retrieve").mockResolvedValue({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      metadata: { userId: "u1", plan: "pro" },
      items: { data: [{ price: { id: "price_pro" }, current_period_end: 1_800_000_000 }] },
    } as never);
    const { payload, header } = signed({
      id: "evt_inv",
      type: "invoice.paid",
      data: { object: { parent: { subscription_details: { subscription: "sub_1" } } } },
    });
    const r = await processWebhook(payload, header);
    expect(r.status).toBe(200);
    const renew = calls.find((c) => c[0] === "renew")!;
    expect(renew.slice(1, 4)).toEqual(["u1", "pro", 450]);
    expect((renew[4] as Date).getTime()).toBe(1_800_000_000_000);
    expect(renew[5]).toBe("evt_inv");
  });

  it("abbonamento cancellato: piano gratuito e crediti del piano azzerati", async () => {
    const { payload, header } = signed({
      id: "evt_del",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", customer: "cus_1", metadata: {} } },
    });
    await processWebhook(payload, header);
    expect(calls).toContainEqual(["status", "user-da-cliente", "free", "canceled", true]);
  });
});

describe("costo in crediti", () => {
  it("segue il listino", () => {
    expect(creditCost("bozza", "render")).toBe(5);
    expect(creditCost("standard", "ecommerce")).toBe(8);
    expect(creditCost("standard", "stampa")).toBe(5);
    expect(creditCost("pro", "gioco")).toBe(15);
  });
});
