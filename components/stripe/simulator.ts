/**
 * A deterministic stand-in for Stripe's test mode, for development and tests: no network, no money.
 *
 * It speaks the subset of Stripe's HTTP API the engine uses — form-encoded requests, Idempotency-Key,
 * Stripe's response shapes and error format — and delivers events signed exactly as Stripe signs them
 * (`Stripe-Signature: t=…,v1=…`). So the production client (`stripe.ts`) and the production webhook
 * verifier run unchanged against it. It also serves a hosted-checkout page.
 *
 * It is a fake external system: its own state is in memory and is lost on restart, as a provider's
 * state would be unreachable. The engine's state never lives here.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { signStripePayload } from "./stripe.js";

type Obj = Record<string, any>;
export type Deliver = (rawBody: string, signature: string) => Promise<number>;

/** Stripe test payment methods the simulator understands. */
export const TEST_CARDS: Record<string, { brand: string; last4: string; declines: boolean }> = {
  pm_card_visa: { brand: "visa", last4: "4242", declines: false },
  pm_card_mastercard: { brand: "mastercard", last4: "4444", declines: false },
  pm_card_chargeDeclined: { brand: "visa", last4: "0002", declines: true },
};

export function parseForm(body: string): Obj {
  const out: Obj = {};
  for (const pair of body.split("&").filter(Boolean)) {
    const [rawKey, rawValue = ""] = pair.split("=");
    const key = decodeURIComponent(rawKey!);
    const value = decodeURIComponent(rawValue.replace(/\+/g, " "));
    const path = key.replace(/\]/g, "").split("[");
    let node: Obj = out;
    path.forEach((segment, i) => {
      if (i === path.length - 1) node[segment] = value;
      else node = node[segment] ??= {};
    });
  }
  return out;
}

export interface SimulatorOptions {
  /** Signs events with this secret (the engine's stripe-webhook-secret). */
  webhookSecret: string;
  /** Where events go: the engine's webhook endpoint, as a function (in-process) taking raw body + signature. */
  deliver: Deliver;
  /** Deliver the events of one action in reverse order (out-of-order testing). */
  reverseOrder?: boolean;
  /** Retries for a delivery answered with a non-2xx status. */
  maxDeliveryAttempts?: number;
  publicUrl?: string;
  clock?: () => number;
}

export class StripeSimulator {
  readonly customers = new Map<string, Obj>();
  readonly sessions = new Map<string, Obj>();
  readonly intents = new Map<string, Obj>();
  readonly refunds = new Map<string, Obj>();
  readonly events: Obj[] = [];
  readonly deliveries: Array<{ eventId: string; type: string; status: number; attempt: number }> = [];
  private readonly idempotent = new Map<string, { status: number; body: Obj }>();
  private server: Server | null = null;
  private pending = new Set<Promise<unknown>>();
  url = "";
  readonly secretKey = `sk_test_sim_${randomBytes(8).toString("hex")}`;
  /** Customer → its card's behavior override ("decline" makes off-session charges fail). */
  readonly behavior = new Map<string, "ok" | "decline">();
  private seq = 0;

  constructor(private readonly options: SimulatorOptions) {}

  private now() {
    return (this.options.clock ?? Date.now)();
  }
  private id(prefix: string) {
    this.seq += 1;
    return `${prefix}_sim${String(this.seq).padStart(6, "0")}${randomBytes(3).toString("hex")}`;
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const addr = this.server.address() as { port: number };
    this.url = `http://${host}:${addr.port}`;
    return this.url;
  }
  async close() {
    await this.settled();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
  /** Wait until every queued delivery (and its retries) has finished. */
  async settled() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────────────────────

  async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://sim");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const send = (status: number, body: Obj | string, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    try {
      if (url.pathname.startsWith("/v1/")) {
        if (req.headers.authorization !== `Bearer ${this.secretKey}`) return send(401, { error: { type: "invalid_request_error", message: "Invalid API Key provided." } });
        const key = req.headers["idempotency-key"] as string | undefined;
        const cacheKey = key ? `${req.method} ${url.pathname} ${key}` : undefined;
        if (cacheKey && this.idempotent.has(cacheKey)) {
          const hit = this.idempotent.get(cacheKey)!;
          return send(hit.status, hit.body);
        }
        const [status, body] = this.api(req.method ?? "GET", url.pathname, parseForm(raw));
        if (cacheKey) this.idempotent.set(cacheKey, { status, body });
        return send(status, body);
      }
      const checkout = url.pathname.match(/^\/checkout\/([^/]+)$/);
      if (checkout && req.method === "GET") return send(200, this.checkoutPage(checkout[1]!), "text/html; charset=utf-8");
      const complete = url.pathname.match(/^\/checkout\/([^/]+)\/complete$/);
      if (complete && req.method === "POST") {
        const form = parseForm(raw);
        const result = this.completeCheckout(complete[1]!, (form.card as string) ?? "pm_card_visa");
        res.writeHead(303, { location: result.redirect });
        return res.end();
      }
      return send(404, { error: { type: "invalid_request_error", message: `Unrecognized request URL (${req.method}: ${url.pathname}).` } });
    } catch (e) {
      return send(500, { error: { type: "api_error", message: (e as Error).message } });
    }
  }

  private api(method: string, path: string, body: Obj): [number, Obj] {
    const notFound = (what: string): [number, Obj] => [404, { error: { type: "invalid_request_error", code: "resource_missing", message: `No such ${what}` } }];
    if (method === "POST" && path === "/v1/customers") {
      const c = { id: this.id("cus"), object: "customer", name: body.name ?? null, email: body.email ?? null, metadata: body.metadata ?? {}, invoice_settings: { default_payment_method: null } };
      this.customers.set(c.id, c);
      return [200, c];
    }
    if (method === "POST" && path === "/v1/checkout/sessions") {
      if (!this.customers.has(body.customer)) return notFound("customer");
      const s = { id: this.id("cs_test"), object: "checkout.session", mode: body.mode, customer: body.customer, client_reference_id: body.client_reference_id ?? null, status: "open", payment_status: "unpaid", success_url: body.success_url, cancel_url: body.cancel_url, metadata: body.metadata ?? {}, amount_total: Number(body.line_items?.["0"]?.price_data?.unit_amount ?? 0), currency: body.line_items?.["0"]?.price_data?.currency ?? "usd", url: "", payment_intent: null as string | null, setup_intent: null as string | null, description: body.line_items?.["0"]?.price_data?.product_data?.name ?? "Set up a payment method", pi_metadata: body.payment_intent_data?.metadata ?? body.metadata ?? {} };
      s.url = `${this.options.publicUrl ?? this.url}/checkout/${s.id}`;
      this.sessions.set(s.id, s);
      return [200, s];
    }
    if (method === "POST" && path === "/v1/payment_intents") {
      const customer = this.customers.get(body.customer);
      if (!customer) return notFound("customer");
      const card = TEST_CARDS[body.payment_method];
      if (!card) return notFound("payment_method");
      const declines = card.declines || this.behavior.get(customer.id) === "decline";
      const pi: Obj = { id: this.id("pi"), object: "payment_intent", amount: Number(body.amount), amount_received: declines ? 0 : Number(body.amount), currency: body.currency, customer: customer.id, payment_method: body.payment_method, status: declines ? "requires_payment_method" : "succeeded", metadata: body.metadata ?? {}, last_payment_error: declines ? { code: "card_declined", message: "Your card was declined." } : null };
      this.intents.set(pi.id, pi);
      this.emit([{ type: declines ? "payment_intent.payment_failed" : "payment_intent.succeeded", object: pi }]);
      if (declines) return [402, { error: { type: "card_error", code: "card_declined", message: "Your card was declined.", payment_intent: pi } }];
      return [200, pi];
    }
    if (method === "POST" && path === "/v1/refunds") {
      const pi = this.intents.get(body.payment_intent);
      if (!pi || pi.status !== "succeeded") return notFound("payment_intent");
      const already = [...this.refunds.values()].filter((r) => r.payment_intent === pi.id && r.status === "succeeded").reduce((s, r) => s + r.amount, 0);
      const amount = Number(body.amount ?? pi.amount_received - already);
      if (amount + already > pi.amount_received) return [400, { error: { type: "invalid_request_error", code: "charge_already_refunded", message: "Refund amount exceeds the charge." } }];
      const r = { id: this.id("re"), object: "refund", amount, currency: pi.currency, payment_intent: pi.id, status: "succeeded", metadata: body.metadata ?? {} };
      this.refunds.set(r.id, r);
      this.emit([{ type: "refund.created", object: r }]);
      return [200, r];
    }
    const pm = path.match(/^\/v1\/payment_methods\/([^/]+)$/);
    if (method === "GET" && pm) {
      const card = TEST_CARDS[pm[1]!];
      return card ? [200, { id: pm[1], object: "payment_method", type: "card", card: { brand: card.brand, last4: card.last4, exp_month: 12, exp_year: new Date(this.now()).getUTCFullYear() + 3 } }] : notFound("payment_method");
    }
    const intent = path.match(/^\/v1\/payment_intents\/([^/]+)$/);
    if (method === "GET" && intent) return this.intents.has(intent[1]!) ? [200, this.intents.get(intent[1]!)!] : notFound("payment_intent");
    return [404, { error: { type: "invalid_request_error", message: `Unrecognized request URL (${method}: ${path}).` } }];
  }

  // ─── Hosted checkout ───────────────────────────────────────────────────────────────────────

  /** What a person does on the hosted page: pay (or save a card) with a test card. */
  completeCheckout(sessionId: string, card = "pm_card_visa"): { redirect: string; status: "complete" | "declined" } {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`No such checkout session ${sessionId}`);
    if (s.status !== "open") return { redirect: s.success_url, status: "complete" };
    const info = TEST_CARDS[card] ?? TEST_CARDS.pm_card_visa!;
    if (s.mode === "payment" && info.declines) {
      // Hosted checkout keeps the session open and asks for another card; no event is sent.
      return { redirect: `${this.options.publicUrl ?? this.url}/checkout/${s.id}?declined=1`, status: "declined" };
    }
    const customer = this.customers.get(s.customer)!;
    customer.invoice_settings.default_payment_method = card;
    s.status = "complete";
    const pmObj = { id: card, object: "payment_method", type: "card", customer: customer.id, card: { brand: info.brand, last4: info.last4, exp_month: 12, exp_year: new Date(this.now()).getUTCFullYear() + 3 } };
    const events: Array<{ type: string; object: Obj }> = [{ type: "payment_method.attached", object: pmObj }];
    if (s.mode === "payment") {
      const pi = { id: this.id("pi"), object: "payment_intent", amount: s.amount_total, amount_received: s.amount_total, currency: s.currency, customer: customer.id, payment_method: card, status: "succeeded", metadata: s.pi_metadata, last_payment_error: null };
      this.intents.set(pi.id, pi);
      s.payment_intent = pi.id;
      s.payment_status = "paid";
      events.push({ type: "checkout.session.completed", object: { ...s } }, { type: "payment_intent.succeeded", object: pi });
    } else {
      s.setup_intent = this.id("seti");
      s.payment_status = "no_payment_required";
      events.push({ type: "setup_intent.succeeded", object: { id: s.setup_intent, object: "setup_intent", customer: customer.id, payment_method: card, metadata: s.metadata } }, { type: "checkout.session.completed", object: { ...s } });
    }
    this.emit(events);
    return { redirect: s.success_url, status: "complete" };
  }

  private checkoutPage(id: string): string {
    const s = this.sessions.get(id);
    if (!s) return "<!doctype html><title>Not found</title><p>No such checkout session.</p>";
    const amount = s.mode === "payment" ? `${(s.amount_total / 100).toFixed(2)} ${String(s.currency).toUpperCase()}` : "No charge today";
    const esc = (v: string) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout (simulated Stripe test mode)</title>
<style>body{font:15px system-ui,sans-serif;background:#f6f7fb;color:#1a1d29;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;border-radius:14px;box-shadow:0 8px 30px #0002;padding:28px;width:min(420px,92vw)}h1{font-size:18px;margin:0 0 4px}.amt{font-size:30px;font-weight:700;margin:12px 0}.badge{display:inline-block;background:#fff3cd;color:#7a5b00;border-radius:999px;padding:2px 10px;font-size:12px}label{display:block;margin:10px 0;padding:10px;border:1px solid #dde;border-radius:8px;cursor:pointer}button{width:100%;padding:12px;border:0;border-radius:8px;background:#635bff;color:#fff;font-weight:600;font-size:15px;margin-top:12px;cursor:pointer}.err{color:#b00020}</style></head>
<body><main><span class="badge">Simulated Stripe · test mode · no real money</span><h1>${esc(s.description)}</h1><div class="amt">${esc(amount)}</div>
<form method="post" action="/checkout/${esc(id)}/complete">
<label><input type="radio" name="card" value="pm_card_visa" checked> Visa •••• 4242 (succeeds)</label>
<label><input type="radio" name="card" value="pm_card_mastercard"> Mastercard •••• 4444 (succeeds)</label>
<label><input type="radio" name="card" value="pm_card_chargeDeclined"> Visa •••• 0002 (declined)</label>
<button type="submit">${s.mode === "payment" ? "Pay" : "Save card"}</button></form>
<p><a href="${esc(s.cancel_url)}">Cancel and return</a></p></main></body></html>`;
  }

  // ─── Events ────────────────────────────────────────────────────────────────────────────────

  private emit(items: Array<{ type: string; object: Obj }>) {
    const events = items.map(({ type, object }) => ({ id: this.id("evt"), object: "event", type, created: Math.floor(this.now() / 1000), livemode: false, data: { object } }));
    this.events.push(...events);
    const ordered = this.options.reverseOrder ? [...events].reverse() : events;
    const run = (async () => {
      await Promise.resolve(); // after the API response, as Stripe does
      for (const e of ordered) await this.deliver(e);
    })();
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }

  /** Send one event (again): Stripe redelivers on failure and sometimes duplicates. */
  async deliver(event: Obj, attempt = 1): Promise<number> {
    const raw = JSON.stringify(event);
    let status = 0;
    try {
      status = await this.options.deliver(raw, signStripePayload(raw, this.options.webhookSecret, this.now()));
    } catch {
      status = 599;
    }
    this.deliveries.push({ eventId: event.id, type: event.type, status, attempt });
    if ((status < 200 || status >= 300) && attempt < (this.options.maxDeliveryAttempts ?? 3)) return this.deliver(event, attempt + 1);
    return status;
  }
  async redeliver(eventId: string) {
    const e = this.events.find((x) => x.id === eventId);
    if (!e) throw new Error(`No event ${eventId}`);
    return this.deliver(e);
  }
}
