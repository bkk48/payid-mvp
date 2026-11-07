// POS -> create / cancel a dynamic PayID for one bill.
// Auth: x-pos-key header must equal POS_API_KEY secret.
//
// POST { action: "create", order_id, store_id, amount_cents, description? }
// POST { action: "cancel", intent_id }

import { getProvider } from "../_shared/providers.ts";
import { admin, cors, json } from "../_shared/util.ts";

const TTL_MIN = Number(Deno.env.get("PAYID_TTL_MINUTES") ?? "15");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const key = req.headers.get("x-pos-key");
  if (!key || key !== Deno.env.get("POS_API_KEY")) return json({ error: "unauthorised" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const db = admin();
  const provider = getProvider();

  if (body.action === "create") {
    const order_id = String(body.order_id ?? "");
    const store_id = String(body.store_id ?? "");
    const amount_cents = Number(body.amount_cents);
    if (!order_id || !store_id || !Number.isInteger(amount_cents) || amount_cents <= 0) {
      return json({ error: "order_id, store_id, amount_cents (int > 0) required" }, 400);
    }

    // re-use an open intent for the same order + amount (staff pressed twice)
    const { data: open } = await db.from("payment_intents").select("*")
      .eq("order_id", order_id).in("status", ["created", "awaiting"]).maybeSingle();
    if (open) {
      if (open.amount_cents === amount_cents && new Date(open.expires_at) > new Date()) {
        return json(open);
      }
      await provider.cancel(open.provider_ref).catch(() => {});
      await db.from("payment_intents").update({ status: "cancelled" }).eq("id", open.id);
    }

    const expiresAt = new Date(Date.now() + TTL_MIN * 60_000);
    const { data: row, error } = await db.from("payment_intents").insert({
      order_id, store_id, amount_cents, provider: provider.name,
      status: "created", expires_at: expiresAt.toISOString(),
    }).select().single();
    if (error) return json({ error: error.message }, 500);

    try {
      const r = await provider.createIntent({
        intentId: row.id, amountCents: amount_cents,
        description: String(body.description ?? `Order ${order_id}`).slice(0, 35),
        expiresAt,
      });
      const { data: updated, error: e2 } = await db.from("payment_intents").update({
        provider_ref: r.providerRef, payid: r.payid, qr_payload: r.qrPayload, status: "awaiting",
      }).eq("id", row.id).select().single();
      if (e2) throw e2;
      return json(updated);
    } catch (e) {
      await db.from("payment_intents").update({ status: "cancelled" }).eq("id", row.id);
      return json({ error: `provider: ${(e as Error).message}` }, 502);
    }
  }

  if (body.action === "cancel") {
    const id = String(body.intent_id ?? "");
    const { data: row } = await db.from("payment_intents").select("*").eq("id", id).maybeSingle();
    if (!row) return json({ error: "not found" }, 404);
    if (row.status !== "awaiting" && row.status !== "created") {
      return json({ error: `cannot cancel, status=${row.status}` }, 409);
    }
    await provider.cancel(row.provider_ref).catch(() => {});
    const { data: updated } = await db.from("payment_intents")
      .update({ status: "cancelled" }).eq("id", id).in("status", ["awaiting", "created"])
      .select().maybeSingle();
    // if a payment landed between read and update, return the real state
    if (!updated) {
      const { data: now } = await db.from("payment_intents").select("*").eq("id", id).single();
      return json(now);
    }
    return json(updated);
  }

  return json({ error: "unknown action" }, 400);
});
