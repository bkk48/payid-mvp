// Provider -> us. URL: /functions/v1/payid-webhook?provider=mock
// Verifies signature, then applies atomically (idempotent on event_id).

import { getProvider } from "../_shared/providers.ts";
import { admin, json } from "../_shared/util.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = new URL(req.url);
  let provider;
  try { provider = getProvider(url.searchParams.get("provider")); }
  catch { return json({ error: "unknown provider" }, 400); }

  const raw = await req.text();
  const parsed = await provider.verifyAndParse(req, raw).catch(() => null);
  if (!parsed) return json({ error: "bad signature" }, 401);

  const { data, error } = await admin().rpc("apply_payment", {
    p_provider: provider.name,
    p_event_id: parsed.eventId,
    p_provider_ref: parsed.providerRef,
    p_paid_cents: parsed.paidCents,
    p_payer_name: parsed.payerName ?? null,
    p_payload: JSON.parse(raw),
  });

  if (error) {
    console.error("apply_payment failed", error);
    return json({ error: "db" }, 500); // 500 -> provider retries later
  }
  if (data === "late_paid" || String(data).startsWith("already_")) {
    console.warn("NEEDS REFUND", parsed, data);
  }
  return json({ ok: true, result: data });
});
