# Dynamic PayID MVP (mock provider)

Full flow without any real provider:
POS → create one-time PayID → customer "pays" in Mock Bank → signed webhook → POS shows PAID (realtime).
Swap `PAYID_PROVIDER=mock` → real provider later; POS code stays the same.

## Files
- `supabase/migrations/20261107000000_payid.sql` — tables, atomic `apply_payment`, auto-expire, realtime
- `supabase/migrations/demo_only_policies.sql` — anon read for demo page (**drop before live**)
- `supabase/functions/payid-intents` — POS create/cancel (auth: `x-pos-key`)
- `supabase/functions/payid-webhook` — provider → us (signature verified, idempotent)
- `supabase/functions/mock-provider` — fake bank + provider, fires signed webhook
- `supabase/functions/_shared/providers.ts` — provider adapter (Mock, Zepto stub)
- `demo/demo.html` — POS screen (`?view=pos`) + Mock Bank (`?view=bank`)

## Setup (~15 min)
1. Use a **test** Supabase project (not pos-lite live).
2. SQL editor: run `20261107000000_payid.sql`, then `demo_only_policies.sql`.
3. Dashboard → Database → Extensions → enable `pg_cron`, then run the commented `cron.schedule` line at the bottom of the migration.
4. Host `demo/demo.html` (drag folder into Vercel, or any static host). Note its URL.
5. Secrets:
   ```
   supabase secrets set \
     POS_API_KEY=$(openssl rand -hex 24) \
     MOCK_WEBHOOK_SECRET=$(openssl rand -hex 32) \
     MOCK_BANK_URL="https://YOUR-DEMO.vercel.app/demo.html?view=bank" \
     PAYID_PROVIDER=mock \
     PAYID_TTL_MINUTES=15
   ```
6. Deploy (own auth, so skip JWT check):
   ```
   supabase functions deploy payid-intents --no-verify-jwt
   supabase functions deploy payid-webhook --no-verify-jwt
   supabase functions deploy mock-provider --no-verify-jwt
   ```
7. Open `demo.html` on iPad (POS) → fill Supabase URL, anon key, POS_API_KEY → **Show PayID** → scan QR with phone → **Pay with Face ID**.

## Test checklist
| Test | Expect |
|---|---|
| Pay correct amount | PAID ✓ within ~2s |
| Change amount in bank | WRONG AMOUNT (staff decide) |
| Wait past 15 min, then pay | EXPIRED, then LATE PAYMENT → REFUND |
| Cancel, then pay | LATE PAYMENT → REFUND |
| Press Show PayID twice same order | same PayID re-used |
| Turn off wifi on POS mid-wait, pay, reconnect | PAID appears via 5s poll |
| Replay same webhook | `duplicate`, no double count |

## Hook into your POS
- Checkout "PayID" button → `POST /functions/v1/payid-intents {action:"create", order_id, store_id, amount_cents}` with `x-pos-key`.
- Show `payid` + QR of `qr_payload` on customer screen.
- Subscribe realtime on `payment_intents` id; `paid` → close bill. Kitchen flow stays separate (paid ≠ kitchen start).
- Store server: subscribe from cloud; webhook always lands in cloud, never in the shop.

## Known limits before going live
- Real Australian bank apps don't all scan a PayID QR; customers often type/copy the PayID. Show it in big text.
- Mock = no real money. Real provider needed for live: fill `ZeptoProvider` (or Azupay/Monoova) in `providers.ts`.
- Drop `demo_only_policies.sql` policy and use staff-auth reads before production.
- `late_paid` / `already_*` = refund needed; currently only logged (`NEEDS REFUND` in function logs).
