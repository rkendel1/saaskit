/**
 * Stripe over its HTTP API (form-encoded, Idempotency-Key, Stripe-Signature webhooks).
 * The same client talks to api.stripe.com (test mode) or to the local simulator: only baseUrl differs.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { ProviderError, type CheckoutRequest, type ChargeRequest, type NormalizedEvent, type PaymentProvider } from "./provider.js";

/** Stripe's form encoding: nested objects as a[b][c]=v, arrays as a[0][b]=v. */
export function formEncode(value: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (item && typeof item === "object" ? out.push(...formEncode(item as Record<string, unknown>, `${key}[${i}]`)) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`)));
    else if (typeof v === "object") out.push(...formEncode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

/**
 * Verify a `Stripe-Signature` header: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`
 * (several v1 entries allowed during secret rotation), within `toleranceSec` of now.
 */
export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, nowMs = Date.now(), toleranceSec = 300): { ok: true; timestamp: number } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "missing Stripe-Signature header" };
  const parts = header.split(",").map((p) => p.trim().split("=", 2) as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length) return { ok: false, reason: "malformed Stripe-Signature header" };
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return { ok: false, reason: "timestamp outside the tolerance window" };
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  const match = sigs.some((s) => {
    const got = Buffer.from(s);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  return match ? { ok: true, timestamp: t } : { ok: false, reason: "signature does not match" };
}
export function signStripePayload(rawBody: string, secret: string, nowMs = Date.now()): string {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

type StripeObject = Record<string, any>;

/** Translate a Stripe event into the engine's vocabulary. Unknown types are kept as "ignored". */
export function normalizeStripeEvent(event: StripeObject): NormalizedEvent {
  const o: StripeObject = event?.data?.object ?? {};
  const meta: Record<string, string> = o.metadata ?? {};
  const base = { provider: "stripe", eventId: String(event.id), providerType: String(event.type), created: Number(event.created) * 1000, accountId: meta.accountId, invoiceId: meta.invoiceId, checkoutId: meta.checkoutId };
  switch (event.type) {
    case "checkout.session.completed":
      return { ...base, type: "checkout.completed", checkoutRef: o.id, customerRef: o.customer ?? undefined, mode: o.mode === "setup" ? "setup" : "payment", paymentRef: o.payment_intent ?? undefined, accountId: meta.accountId ?? o.client_reference_id };
    case "payment_intent.succeeded":
      return { ...base, type: "payment.succeeded", paymentRef: o.id, amount: Number(o.amount_received ?? o.amount), currency: String(o.currency), customerRef: o.customer ?? undefined, ...(typeof o.payment_method === "string" ? { paymentMethod: { ref: o.payment_method, brand: "", last4: "", expMonth: 0, expYear: 0 } } : {}) };
    case "payment_intent.payment_failed":
      return { ...base, type: "payment.failed", paymentRef: o.id, amount: Number(o.amount), currency: String(o.currency), customerRef: o.customer ?? undefined, failureReason: o.last_payment_error?.message ?? o.last_payment_error?.code ?? "payment failed" };
    case "refund.created":
    case "refund.updated":
      if (o.status === "succeeded") return { ...base, type: "refund.succeeded", refundRef: o.id, refundId: meta.refundId, paymentRef: o.payment_intent, amount: Number(o.amount), currency: String(o.currency) };
      if (o.status === "failed" || o.status === "canceled") return { ...base, type: "refund.failed", refundRef: o.id, refundId: meta.refundId, paymentRef: o.payment_intent, amount: Number(o.amount), failureReason: o.failure_reason ?? o.status };
      return { ...base, type: "ignored" };
    case "setup_intent.succeeded":
    case "payment_method.attached":
      return { ...base, type: "payment_method.updated", customerRef: o.customer ?? undefined, paymentMethod: o.object === "payment_method" ? cardOf(o) : { ref: String(o.payment_method), brand: "", last4: "", expMonth: 0, expYear: 0 } };
    default:
      return { ...base, type: "ignored" };
  }
}

function cardOf(pm: StripeObject): NonNullable<NormalizedEvent["paymentMethod"]> {
  return { ref: String(pm.id), brand: String(pm.card?.brand ?? "card"), last4: String(pm.card?.last4 ?? "????"), expMonth: Number(pm.card?.exp_month ?? 0), expYear: Number(pm.card?.exp_year ?? 0) };
}

export class StripeProvider implements PaymentProvider {
  readonly name = "stripe";
  constructor(private readonly secretKey: string, private readonly baseUrl = "https://api.stripe.com", readonly mode: "test" | "live" | "simulated" = secretKey.startsWith("sk_live_") ? "live" : "test", private readonly timeoutMs = 15_000) {}

  private async request(method: "GET" | "POST", path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<StripeObject> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.secretKey}`, "stripe-version": "2024-06-20" };
    if (body) headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { method, headers, ...(body ? { body: formEncode(body).join("&") } : {}), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      // Unreachable or timed out: with an idempotency key the same request is safe to repeat.
      throw new ProviderError(`Stripe unreachable: ${(e as Error).message}`, true);
    }
    const text = await response.text();
    let parsed: StripeObject = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ProviderError(`Stripe answered ${response.status} with a non-JSON body`, response.status >= 500);
    }
    if (!response.ok) {
      const err = parsed.error ?? {};
      throw new ProviderError(err.message ?? `Stripe answered ${response.status}`, response.status >= 500 || response.status === 429 || response.status === 409, response.status, err.code ?? err.type);
    }
    return parsed;
  }

  async ensureCustomer(input: { accountId: string; name: string; email?: string; idempotencyKey: string }) {
    const c = await this.request("POST", "/v1/customers", { name: input.name, email: input.email, metadata: { accountId: input.accountId } }, input.idempotencyKey);
    return { customerRef: String(c.id) };
  }

  async createCheckout(input: CheckoutRequest, idempotencyKey: string) {
    const metadata = { accountId: input.accountId, checkoutId: input.checkoutId, ...(input.invoiceId ? { invoiceId: input.invoiceId } : {}) };
    const body: Record<string, unknown> =
      input.mode === "payment"
        ? {
            mode: "payment", customer: input.customerRef, client_reference_id: input.accountId, success_url: input.successUrl, cancel_url: input.cancelUrl, metadata,
            line_items: [{ quantity: 1, price_data: { currency: input.currency, unit_amount: input.amount, product_data: { name: input.description } } }],
            payment_intent_data: { setup_future_usage: "off_session", metadata },
          }
        : { mode: "setup", customer: input.customerRef, client_reference_id: input.accountId, success_url: input.successUrl, cancel_url: input.cancelUrl, metadata, payment_method_types: ["card"], setup_intent_data: { metadata } };
    const s = await this.request("POST", "/v1/checkout/sessions", body, idempotencyKey);
    return { checkoutRef: String(s.id), url: String(s.url) };
  }

  async charge(input: ChargeRequest) {
    try {
      const pi = await this.request("POST", "/v1/payment_intents", {
        amount: input.amount, currency: input.currency, customer: input.customerRef, payment_method: input.paymentMethodRef, off_session: true, confirm: true, description: input.description,
        metadata: { accountId: input.accountId, invoiceId: input.invoiceId },
      }, input.idempotencyKey);
      return { paymentRef: String(pi.id), status: String(pi.status) };
    } catch (e) {
      // A card decline is a final answer for this attempt (the provider also emits payment_intent.payment_failed).
      if (e instanceof ProviderError && e.status === 402) return { paymentRef: "", status: `declined:${e.providerCode ?? "card_error"}` };
      throw e;
    }
  }

  async refund(input: { refundId: string; paymentRef: string; amount: number; idempotencyKey: string }) {
    const r = await this.request("POST", "/v1/refunds", { payment_intent: input.paymentRef, amount: input.amount, metadata: { refundId: input.refundId } }, input.idempotencyKey);
    return { refundRef: String(r.id), status: String(r.status) };
  }

  async paymentMethod(ref: string) {
    try {
      return cardOf(await this.request("GET", `/v1/payment_methods/${encodeURIComponent(ref)}`));
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
  }

  async paymentStatus(paymentRef: string) {
    const pi = await this.request("GET", `/v1/payment_intents/${encodeURIComponent(paymentRef)}`);
    const status = pi.status === "succeeded" ? "succeeded" : pi.status === "requires_payment_method" || pi.status === "canceled" ? "failed" : pi.status === "processing" ? "processing" : "unknown";
    return { status, amount: Number(pi.amount_received ?? pi.amount), currency: String(pi.currency), invoiceId: pi.metadata?.invoiceId } as const;
  }
}
