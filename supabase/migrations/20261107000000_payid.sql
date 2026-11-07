-- Dynamic PayID: payment intents + raw webhook events
-- Run once (supabase db push, or paste into SQL editor)

do $$ begin
  create type payment_status as enum (
    'created',    -- row made, provider not called yet
    'awaiting',   -- PayID issued, waiting for money
    'paid',       -- correct amount received in time
    'mismatch',   -- money received but wrong amount -> staff decide
    'expired',    -- nobody paid before expires_at
    'cancelled',  -- staff cancelled (switched to cash/card)
    'late_paid',  -- money arrived after expiry/cancel -> REFUND
    'refunded'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.payment_intents (
  id            uuid primary key default gen_random_uuid(),
  order_id      text not null,
  store_id      text not null,
  amount_cents  integer not null check (amount_cents > 0),
  paid_cents    integer,
  provider      text not null,
  provider_ref  text,
  payid         text,
  qr_payload    text,
  status        payment_status not null default 'created',
  payer_name    text,
  expires_at    timestamptz not null,
  paid_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists payment_intents_provider_ref_uq
  on public.payment_intents (provider, provider_ref);

-- only one open PayID per order at a time
create unique index if not exists payment_intents_one_open_per_order
  on public.payment_intents (order_id)
  where status in ('created', 'awaiting');

create index if not exists payment_intents_payid_idx on public.payment_intents (payid);

create table if not exists public.payment_events (
  id          bigserial primary key,
  provider    text not null,
  event_id    text not null,
  intent_id   uuid references public.payment_intents(id),
  result      text,
  payload     jsonb not null,
  received_at timestamptz not null default now(),
  unique (provider, event_id)            -- webhook idempotency
);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists payment_intents_touch on public.payment_intents;
create trigger payment_intents_touch before update on public.payment_intents
  for each row execute function public.touch_updated_at();

-- Atomic webhook apply. Called only by the webhook function (service role).
create or replace function public.apply_payment(
  p_provider text, p_event_id text, p_provider_ref text,
  p_paid_cents integer, p_payer_name text, p_payload jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v public.payment_intents;
  v_result text;
begin
  insert into payment_events (provider, event_id, payload)
  values (p_provider, p_event_id, p_payload)
  on conflict (provider, event_id) do nothing;
  if not found then
    return 'duplicate';
  end if;

  select * into v from payment_intents
   where provider = p_provider and provider_ref = p_provider_ref
   for update;

  if v.id is null then
    v_result := 'unknown_intent';
  elsif v.status = 'awaiting' and v.expires_at >= now() then
    v_result := case when p_paid_cents = v.amount_cents then 'paid' else 'mismatch' end;
    update payment_intents
       set status = v_result::payment_status, paid_cents = p_paid_cents,
           payer_name = p_payer_name, paid_at = now()
     where id = v.id;
  elsif v.status in ('awaiting', 'expired', 'cancelled') then
    v_result := 'late_paid';
    update payment_intents
       set status = 'late_paid', paid_cents = p_paid_cents,
           payer_name = p_payer_name, paid_at = now()
     where id = v.id;
  else
    v_result := 'already_' || v.status::text;   -- e.g. double payment -> refund manually
  end if;

  update payment_events set intent_id = v.id, result = v_result
   where provider = p_provider and event_id = p_event_id;

  return v_result;
end $$;

revoke all on function public.apply_payment(text, text, text, integer, text, jsonb) from public, anon, authenticated;

create or replace function public.expire_payment_intents() returns integer
language sql security definer set search_path = public as $$
  with x as (
    update payment_intents set status = 'expired'
     where status = 'awaiting' and expires_at < now()
    returning 1
  ) select count(*)::int from x;
$$;

alter table public.payment_intents enable row level security;
alter table public.payment_events  enable row level security;

-- staff devices (logged-in) can read intents; writes go through edge functions only
drop policy if exists payment_intents_read_auth on public.payment_intents;
create policy payment_intents_read_auth on public.payment_intents
  for select to authenticated using (true);

-- realtime push to POS
do $$ begin
  alter publication supabase_realtime add table public.payment_intents;
exception when duplicate_object then null; end $$;

-- auto-expire every minute (needs pg_cron extension enabled in Dashboard > Database > Extensions)
-- select cron.schedule('expire-payid', '* * * * *', $$select public.expire_payment_intents()$$);
