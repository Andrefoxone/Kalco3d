-- Crediti: due salvadanai. plan_balance si azzera e si ricarica a ogni rinnovo
-- dell'abbonamento; extra_balance (ricariche e bonus) non scade.
create table public.credit_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan varchar(16) not null default 'free',
  plan_status varchar(24) not null default 'none',
  plan_balance integer not null default 0 check (plan_balance >= 0),
  extra_balance integer not null default 0 check (extra_balance >= 0),
  period_end timestamptz,
  stripe_customer_id varchar(64) unique,
  stripe_subscription_id varchar(64),
  signup_bonus_at timestamptz,
  updated_at timestamptz not null default now()
);

-- registro di ogni movimento; stripe_event_id unico = un evento Stripe accredita una volta sola
create table public.credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  delta integer not null,
  reason varchar(32) not null,
  model_id bigint,
  stripe_event_id varchar(96) unique,
  created_at timestamptz not null default now()
);
create index credit_ledger_user_idx on public.credit_ledger (user_id, created_at desc);

alter table public.credit_accounts enable row level security;
alter table public.credit_ledger enable row level security;
create policy "lettura del proprio saldo" on public.credit_accounts
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "lettura dei propri movimenti" on public.credit_ledger
  for select to authenticated using ((select auth.uid()) = user_id);

-- Bonus di benvenuto, una sola volta per utente
create or replace function public.credits_ensure_account(p_user uuid, p_bonus integer)
returns public.credit_accounts language plpgsql security definer set search_path = public as $$
declare acc public.credit_accounts;
begin
  insert into credit_accounts (user_id) values (p_user) on conflict (user_id) do nothing;
  update credit_accounts
     set extra_balance = extra_balance + p_bonus, signup_bonus_at = now(), updated_at = now()
   where user_id = p_user and signup_bonus_at is null and p_bonus > 0
  returning * into acc;
  if found then
    insert into credit_ledger (user_id, delta, reason) values (p_user, p_bonus, 'bonus_iscrizione');
    return acc;
  end if;
  select * into acc from credit_accounts where user_id = p_user;
  return acc;
end $$;

-- Addebito atomico: prima i crediti del piano, poi quelli extra. Null se il saldo non basta.
create or replace function public.credits_spend(p_user uuid, p_amount integer, p_reason varchar, p_model bigint)
returns public.credit_accounts language plpgsql security definer set search_path = public as $$
declare acc public.credit_accounts; from_plan integer;
begin
  select * into acc from credit_accounts where user_id = p_user for update;
  if not found or acc.plan_balance + acc.extra_balance < p_amount then
    return null;
  end if;
  from_plan := least(acc.plan_balance, p_amount);
  update credit_accounts
     set plan_balance = plan_balance - from_plan,
         extra_balance = extra_balance - (p_amount - from_plan),
         updated_at = now()
   where user_id = p_user returning * into acc;
  insert into credit_ledger (user_id, delta, reason, model_id) values (p_user, -p_amount, p_reason, p_model);
  return acc;
end $$;

-- Accredito (rimborso, ricarica): va nei crediti extra. Con p_event idempotente.
create or replace function public.credits_add(p_user uuid, p_amount integer, p_reason varchar, p_model bigint, p_event varchar)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_event is not null and exists (select 1 from credit_ledger where stripe_event_id = p_event) then
    return false;
  end if;
  insert into credit_accounts (user_id) values (p_user) on conflict (user_id) do nothing;
  update credit_accounts set extra_balance = extra_balance + p_amount, updated_at = now() where user_id = p_user;
  insert into credit_ledger (user_id, delta, reason, model_id, stripe_event_id) values (p_user, p_amount, p_reason, p_model, p_event);
  return true;
end $$;

-- Rinnovo del piano: i crediti del piano ripartono da p_credits (quelli non usati scadono)
create or replace function public.credits_renew_plan(p_user uuid, p_plan varchar, p_credits integer, p_period_end timestamptz, p_event varchar)
returns boolean language plpgsql security definer set search_path = public as $$
declare old integer;
begin
  if p_event is not null and exists (select 1 from credit_ledger where stripe_event_id = p_event) then
    return false;
  end if;
  insert into credit_accounts (user_id) values (p_user) on conflict (user_id) do nothing;
  select plan_balance into old from credit_accounts where user_id = p_user for update;
  update credit_accounts
     set plan = p_plan, plan_status = 'active', plan_balance = p_credits, period_end = p_period_end, updated_at = now()
   where user_id = p_user;
  insert into credit_ledger (user_id, delta, reason, stripe_event_id) values (p_user, p_credits - coalesce(old, 0), 'rinnovo_' || p_plan, p_event);
  return true;
end $$;

-- solo il server (ruolo postgres/service_role) chiama queste funzioni
revoke execute on function public.credits_ensure_account(uuid, integer) from public, anon, authenticated;
revoke execute on function public.credits_spend(uuid, integer, varchar, bigint) from public, anon, authenticated;
revoke execute on function public.credits_add(uuid, integer, varchar, bigint, varchar) from public, anon, authenticated;
revoke execute on function public.credits_renew_plan(uuid, varchar, integer, timestamptz, varchar) from public, anon, authenticated;
