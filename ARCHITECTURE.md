# Dynamic PayID MVP — Multi-Store Architecture

> One backend, many stores. Each store sees only its own payments.

## The mental model (Thai)

```
                    ┌─────────────────────────────┐
                    │   Supabase (คลาวด์)          │
                    │   project: pos-lite          │
                    │                              │
                    │  payment_intents  ── store_id ──→ ร้าน Vermont
                    │  payment_events   ── store_id ──→ ร้าน Hampton Park
                    │  (ตารางเดียว แยกด้วย store_id)     ร้านที่ 3, 4, 5...
                    └──────────┬──────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
        ┌─────▼─────┐    ┌─────▼─────┐    ┌─────▼─────┐
        │ POS ร้าน 1 │    │ POS ร้าน 2 │    │ POS ร้าน 3 │
        │ Vermont    │    │ Hampton Pk │    │ อนาคต      │
        └───────────┘    └───────────┘    └───────────┘
```

- **Database อยู่ที่เดียว** (Supabase คลาวด์) — ไม่ได้เก็บแยกที่ร้านแต่ละบ่ะ
- ทุกร้าน **ดึง/ส่งมาจาก Supabase เดียวกัน** แต่แยกด้วย `store_id`
- ร้านไหนขาย บิลจะผูก `store_id` ของร้านนั้น — ร้านอื่นมองไม่เห็นบิลร้านนี้ (RLS policy กันไว้)
- POS ที่ร้านต้องมีแค่ **อินเทอร์เน็ต** + ค่าตั้ง 4 ตัว:
  - `SUPABASE_URL` (เดียวกันทุกร้าน)
  - `SUPABASE_ANON_KEY` (เดียวกันทุกร้าน)
  - `POS_API_KEY` (เดียวกัน หรือแยกต่อร้านเมื่อขึ้นจริง)
  - `store_id` (**ต่างกัน** — นี่คือตัวแยกร้าน เช่น `vermont` / `hampton-park`)

## Why one database, not one-per-store

| แยก DB ต่อร้าน | DB เดียว + store_id (ใช้ตัวนี้) |
|---|---|
| ต้อง deploy หลาย project | deploy ครั้งเดียว |
| รวมยอดข้ามร้านยาก | query รวมได้ทันที (owner view) |
| webhook provider ต้อง route หลายที่ | webhook เข้าที่เดียว |
| จ่าย Supabase หลายใบ | ใบเดียว (free tier พอสำหรับ MVP) |

**กติกาแยกข้อมูล:** ทุก query ต้องมี `store_id` อยู่ใน row เสมอ + RLS policies อ่านตาม store_id (demo policies เปิด anon read เฉพาะช่วง demo — ปิดก่อน live)

## What lives where

| Component | ที่อยู่ | รันที่ไหน |
|---|---|---|
| DB tables (`payment_intents`, `payment_events`) | Supabase pos-lite | คลาวด์ |
| Edge Functions (`payid-intents`, `payid-webhook`, `mock-provider`) | Supabase pos-lite | คลาวด์ |
| `demo/demo.html` POS screen | static host (Vercel) หรือเปิดไฟล์ตรง | iPad/คอมที่ร้าน |
| Mock Bank screen | URL เดียวกับ demo.html `?view=bank` | มือถือลูกค้า (demo) |
| Provider (mock → Zepto/Azupay/Monoova) | `supabase/functions/_shared/providers.ts` | คลาวด์ |

## Store onboarding checklist (ร้านใหม่ 1 บ่ะ)

1. เพิ่ม row ในตาราง `locations` ของ pos-lite (มีอยู่แล้ว) → ได้ `store_id`
2. POS ที่ร้านตั้งค่า 4 ตัวด้านบน (store_id ของร้านนั้น)
3. จบ — ไม่มีการติดตั้งอื่น

## Swap to real provider

`PAYID_PROVIDER=mock` → `zepto` (เติม `ZeptoProvider` ใน `_shared/providers.ts`) — โค้ด POS ที่ร้านไม่เปลี่ยนแม้บรรทัดเดียว

## Files

- `supabase/migrations/20261107000000_payid.sql` — tables, atomic `apply_payment`, auto-expire, realtime
- `supabase/migrations/demo_only_policies.sql` — anon read for demo (**drop before live**)
- `supabase/functions/payid-intents` — POS create/cancel (auth: `x-pos-key`)
- `supabase/functions/payid-webhook` — provider → us (HMAC verified, idempotent)
- `supabase/functions/mock-provider` — fake bank + provider, fires signed webhook
- `supabase/functions/_shared/providers.ts` — provider adapter (Mock, Zepto stub)
- `demo/demo.html` — POS (`?view=pos`) + Mock Bank (`?view=bank`)
