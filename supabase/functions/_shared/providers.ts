// Provider adapter: POS code only talks to this interface.
// Swap MockProvider -> ZeptoProvider / AzupayProvider later without touching POS.

export interface CreateIntentInput {
  intentId: string;
  amountCents: number;
  description: string;
  expiresAt: Date;
}

export interface CreateIntentResult {
  providerRef: string;
  payid: string;
  qrPayload: string;
}

export interface ParsedWebhook {
  eventId: string;
  providerRef: string;
  paidCents: number;
  payerName?: string;
}

export interface PayIdProvider {
  name: string;
  createIntent(input: CreateIntentInput): Promise<CreateIntentResult>;
  /** return null when signature is invalid */
  verifyAndParse(req: Request, rawBody: string): Promise<ParsedWebhook | null>;
  cancel(providerRef: string): Promise<void>;
}

// ---------- helpers ----------
const enc = new TextEncoder();

export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

// ---------- Mock provider (behaves like a real one) ----------
export class MockProvider implements PayIdProvider {
  name = "mock";

  async createIntent(i: CreateIntentInput): Promise<CreateIntentResult> {
    const short = i.intentId.replace(/-/g, "").slice(0, 10);
    const payid = `${short}@${Deno.env.get("MOCK_PAYID_DOMAIN") ?? "pay.hpthai.com.au"}`;
    const bankUrl = env("MOCK_BANK_URL"); // e.g. https://your-demo.vercel.app/demo.html?view=bank
    const api = `${env("SUPABASE_URL")}/functions/v1`;
    const q = new URLSearchParams({
      payid,
      amount: String(i.amountCents),
      desc: i.description,
      api,
    });
    const qrPayload = `${bankUrl}${bankUrl.includes("?") ? "&" : "?"}${q}`;
    return { providerRef: `mock_${i.intentId}`, payid, qrPayload };
  }

  async verifyAndParse(req: Request, rawBody: string): Promise<ParsedWebhook | null> {
    const sig = req.headers.get("x-mock-signature") ?? "";
    const expected = await hmacHex(env("MOCK_WEBHOOK_SECRET"), rawBody);
    if (!safeEqual(sig, expected)) return null;
    const b = JSON.parse(rawBody);
    return {
      eventId: String(b.event_id),
      providerRef: String(b.provider_ref),
      paidCents: Number(b.paid_cents),
      payerName: b.payer_name ? String(b.payer_name) : undefined,
    };
  }

  async cancel(_ref: string): Promise<void> {
    // real providers: deregister the PayID so it can't receive money
  }
}

// ---------- Real provider placeholder ----------
export class ZeptoProvider implements PayIdProvider {
  name = "zepto";
  createIntent(): Promise<CreateIntentResult> {
    throw new Error("Zepto not configured yet — fill in after sandbox signup");
  }
  verifyAndParse(): Promise<ParsedWebhook | null> {
    throw new Error("Zepto not configured yet");
  }
  cancel(): Promise<void> {
    throw new Error("Zepto not configured yet");
  }
}

export function getProvider(name?: string | null): PayIdProvider {
  const n = name ?? Deno.env.get("PAYID_PROVIDER") ?? "mock";
  if (n === "mock") return new MockProvider();
  if (n === "zepto") return new ZeptoProvider();
  throw new Error(`Unknown provider ${n}`);
}
