// Saldo e movimenti dei crediti. Le operazioni passano dalle funzioni SQL
// (supabase/migrations/0002_credits.sql), atomiche e con registro.
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import { SIGNUP_BONUS } from "@contracts/billing";

/** Account amministratori (ADMIN_EMAILS, separati da virgola): generano senza scalare crediti. */
export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = (process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}

export interface CreditAccount {
  plan: string;
  planStatus: string;
  planBalance: number;
  extraBalance: number;
  balance: number;
  periodEnd: string | null;
  stripeCustomerId: string | null;
}

type Row = Record<string, unknown>;

function toAccount(r: Row | undefined): CreditAccount {
  const planBalance = Number(r?.plan_balance ?? 0);
  const extraBalance = Number(r?.extra_balance ?? 0);
  return {
    plan: String(r?.plan ?? "free"),
    planStatus: String(r?.plan_status ?? "none"),
    planBalance,
    extraBalance,
    balance: planBalance + extraBalance,
    periodEnd: r?.period_end ? new Date(r.period_end as string).toISOString() : null,
    stripeCustomerId: (r?.stripe_customer_id as string | null) ?? null,
  };
}

/** Crea il conto al primo accesso, con il bonus di benvenuto (una volta sola). */
export async function ensureAccount(userId: string): Promise<CreditAccount> {
  const rows = (await getDb().execute(sql`select * from credits_ensure_account(${userId}::uuid, ${SIGNUP_BONUS})`)) as unknown as Row[];
  return toAccount(rows[0]);
}

/** Scala i crediti o lancia PAYMENT_REQUIRED se il saldo non basta. */
export async function spendCredits(userId: string, amount: number, reason: string): Promise<CreditAccount> {
  await ensureAccount(userId);
  const rows = (await getDb().execute(
    sql`select * from credits_spend(${userId}::uuid, ${amount}, ${reason}, null)`,
  )) as unknown as Row[];
  if (!rows[0] || rows[0].user_id === null) {
    throw new TRPCError({
      code: "PAYMENT_REQUIRED",
      message: `Crediti insufficienti: servono ${amount} crediti. Ricarica o scegli un piano.`,
    });
  }
  return toAccount(rows[0]);
}

/** Accredito (rimborso, ricarica). Con eventId è idempotente: false se già fatto. */
export async function addCredits(userId: string, amount: number, reason: string, modelId: number | null, eventId: string | null): Promise<boolean> {
  const rows = (await getDb().execute(
    sql`select credits_add(${userId}::uuid, ${amount}, ${reason}, ${modelId}, ${eventId}) as ok`,
  )) as unknown as Row[];
  return Boolean(rows[0]?.ok);
}

export async function renewPlan(userId: string, plan: string, credits: number, periodEnd: Date | null, eventId: string): Promise<boolean> {
  const rows = (await getDb().execute(
    sql`select credits_renew_plan(${userId}::uuid, ${plan}, ${credits}, ${periodEnd ? periodEnd.toISOString() : null}::timestamptz, ${eventId}) as ok`,
  )) as unknown as Row[];
  return Boolean(rows[0]?.ok);
}

export async function setStripeCustomer(userId: string, customerId: string, subscriptionId: string | null): Promise<void> {
  await getDb().execute(sql`
    insert into credit_accounts (user_id, stripe_customer_id, stripe_subscription_id)
    values (${userId}::uuid, ${customerId}, ${subscriptionId})
    on conflict (user_id) do update set
      stripe_customer_id = excluded.stripe_customer_id,
      stripe_subscription_id = coalesce(excluded.stripe_subscription_id, credit_accounts.stripe_subscription_id),
      updated_at = now()`);
}

export async function setPlanStatus(userId: string, plan: string, status: string, clearPlanCredits: boolean): Promise<void> {
  await getDb().execute(sql`
    update credit_accounts set plan = ${plan}, plan_status = ${status},
      plan_balance = case when ${clearPlanCredits} then 0 else plan_balance end,
      updated_at = now()
    where user_id = ${userId}::uuid`);
}

export async function userByCustomer(customerId: string): Promise<string | null> {
  const rows = (await getDb().execute(
    sql`select user_id from credit_accounts where stripe_customer_id = ${customerId} limit 1`,
  )) as unknown as Row[];
  return (rows[0]?.user_id as string | undefined) ?? null;
}
