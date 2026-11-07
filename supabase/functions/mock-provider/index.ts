// Fake bank + fake provider. Bank page calls this, it "moves the money"
// and fires a signed webhook exactly like a real provider would.
// POST { payid, paid_cents, payer_name? }
// Disable in production: set MOCK_ENABLED=false

import { hmacHex } from "../_shared/providers.ts";
import { admin, cors, json } from "../_shared/util.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (Deno.env.get("MOCK_ENABLED") === "false") return json({ error: "mock disabled" }, 403);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const b = await req.json().catch(() => ({}));
  const payid = String(b.payid ?? "");
  const paid_cents = Number(b.paid_cents);
  if (!payid || !Number.isInteger(paid_cents) || paid_cents <= 0) {
    return json({ error: "payid and paid_cents required" }, 400);
  }

  const { data: intent } = await admin().from("payment_intents")
    .select("provider_ref").eq("payid", payid).eq("provider", "mock").maybeSingle();
  // real NPP: unknown PayID = bank says "PayID not found"
  if (!intent) return json({ error: "PayID not found" }, 404);

  // simulate NPP latency
  await new Promise((r) => setTimeout(r, 800 + Math.random() * 1500));

  const event = {
    event_id: crypto.randomUUID(),
    type: "payid_payment.received",
    provider_ref: intent.provider_ref,
    paid_cents,
    payer_name: String(b.payer_name ?? "TEST CUSTOMER").slice(0, 40),
    received_at: new Date().toISOString(),
  };
  const raw = JSON.stringify(event);
  const sig = await hmacHex(Deno.env.get("MOCK_WEBHOOK_SECRET")!, raw);

  const res = await fetch(
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/payid-webhook?provider=mock`,
    { method: "POST", headers: { "Content-Type": "application/json", "x-mock-signature": sig }, body: raw },
  );
  const out = await res.json().catch(() => ({}));
  return json({ bank: "sent", webhook_status: res.status, webhook: out });
});
