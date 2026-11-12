// Provider adapter (supabase/functions/_shared/providers.ts), run with Deno:
//   deno test --allow-env tests/functions/
// No network: only the signing / parsing / provider-choice logic.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { getProvider, hmacHex, MockProvider, safeEqual, ZeptoProvider } from "../../supabase/functions/_shared/providers.ts";

Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
Deno.env.set("MOCK_BANK_URL", "https://demo.example/demo.html?view=bank");
Deno.env.set("MOCK_WEBHOOK_SECRET", "test-secret-not-real");

const event = { event_id: "ev-1", provider_ref: "mock_abc", paid_cents: 2250, payer_name: "TEST CUSTOMER" };
const raw = JSON.stringify(event);
const req = (sig?: string) => new Request("https://x/payid-webhook?provider=mock", {
  method: "POST", body: raw, headers: sig ? { "x-mock-signature": sig } : {},
});

Deno.test("mock: createIntent gives a one-time PayID and a QR that opens the mock bank", async () => {
  const r = await new MockProvider().createIntent({
    intentId: "1234abcd-0000-4000-8000-000000000000", amountCents: 2250, description: "Order 1", expiresAt: new Date(),
  });
  assertEquals(r.providerRef, "mock_1234abcd-0000-4000-8000-000000000000");
  assert(/^[0-9a-f]{10}@/.test(r.payid), r.payid);
  const qr = new URL(r.qrPayload);
  assertEquals([qr.searchParams.get("view"), qr.searchParams.get("payid"), qr.searchParams.get("amount")], ["bank", r.payid, "2250"]);
});

Deno.test("mock: webhook with the right signature is accepted and parsed", async () => {
  const sig = await hmacHex("test-secret-not-real", raw);
  const p = await new MockProvider().verifyAndParse(req(sig), raw);
  assertEquals(p, { eventId: "ev-1", providerRef: "mock_abc", paidCents: 2250, payerName: "TEST CUSTOMER" });
});

Deno.test("mock: wrong signature is refused", async () => {
  const sig = await hmacHex("someone-elses-secret", raw);
  assertEquals(await new MockProvider().verifyAndParse(req(sig), raw), null);
});

Deno.test("mock: missing signature is refused", async () => {
  assertEquals(await new MockProvider().verifyAndParse(req(), raw), null);
});

Deno.test("mock: body changed after signing (amount edited) is refused", async () => {
  const sig = await hmacHex("test-secret-not-real", raw);
  const tampered = raw.replace("2250", "9999");
  assertEquals(await new MockProvider().verifyAndParse(req(sig), tampered), null);
});

Deno.test("safeEqual: same / different / different length", () => {
  assertEquals([safeEqual("abc", "abc"), safeEqual("abc", "abd"), safeEqual("abc", "abcd")], [true, false, false]);
});

Deno.test("provider choice: mock by default, unknown name refused", () => {
  Deno.env.delete("PAYID_PROVIDER");
  assertEquals(getProvider().name, "mock");
  assertThrows(() => getProvider("not-a-bank"));
});

Deno.test("real provider (Zepto) is not wired yet: every call fails loudly, never silently 'paid'", async () => {
  // It throws straight away (not a rejected promise). The webhook's .catch()
  // does not catch that, so the webhook answers 500 and the provider retries:
  // loud, never "paid".
  const z = new ZeptoProvider();
  assertThrows(() => z.createIntent());
  assertThrows(() => z.verifyAndParse());
});
