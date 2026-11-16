/**
 * The payments component: the only code that talks to the payment provider.
 *
 *   Inbound   POST /stripe/webhook   Stripe-signed events → verified here → payments:ingest (as payments-gateway)
 *   Outbound  durable work recorded by mutations (ctx.afterCommit.work("payments", kind, input)):
 *             checkout.create, invoice.charge, refund.create → provider API → payments:workResult
 *   Clock     lifecycle:due + lifecycle:advance per account, every GATEWAY_CLOCK_MS (renewals, trials, grace, dunning, reservations)
 *
 * Provider selection, in order:
 *   - credential stripe-secret-key = sk_test_…  → Stripe test mode (api.stripe.com, or STRIPE_API_BASE)
 *   - credential = sk_live_…                     → refused unless STRIPE_ALLOW_LIVE=1
 *   - no key, outside production                 → the local simulator (components/stripe/simulator.ts)
 *   - no key in production                       → unconfigured (health says so; nothing is charged)
 *
 * The component never decides money or access. It verifies, translates and reports; the engine decides.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineComponent, type ComponentContext, type ComponentHealth, type ComponentWorkItem } from "@feltdb/feltkit/server";
import { ProviderError, type NormalizedEvent, type PaymentProvider } from "./stripe/provider.js";
import { normalizeStripeEvent, StripeProvider, verifyStripeSignature } from "./stripe/stripe.js";
import { StripeSimulator } from "./stripe/simulator.js";

const WORK_MS = Number(process.env.GATEWAY_WORK_MS ?? 500);
const CLOCK_MS = Number(process.env.GATEWAY_CLOCK_MS ?? 30_000);

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default defineComponent(async (ctx: ComponentContext) => {
  let provider: PaymentProvider | null = null;
  let webhookSecret: string | null = null;
  let simulator: StripeSimulator | null = null;
  let problem: string | null = null;
  const stats = { received: 0, verified: 0, rejected: 0, applied: 0, duplicates: 0, workDone: 0, workRetried: 0, workFailed: 0, lastClock: 0, lastClockError: "" };

  const secret = await ctx.credential("stripe-secret-key");
  if (secret) {
    if (secret.startsWith("sk_live_") && process.env.STRIPE_ALLOW_LIVE !== "1") problem = "A live Stripe key is configured; this deployment refuses live keys unless STRIPE_ALLOW_LIVE=1.";
    else {
      provider = new StripeProvider(secret, process.env.STRIPE_API_BASE ?? "https://api.stripe.com");
      webhookSecret = await ctx.credential("stripe-webhook-secret");
      if (!webhookSecret) problem = "stripe-webhook-secret is not set: provider events cannot be verified, so none are accepted.";
    }
  } else if (!ctx.environment.production) {
    webhookSecret = ctx.derive("stripe-simulator-webhook");
    simulator = new StripeSimulator({ webhookSecret, deliver: async (raw, sig) => (await receive(raw, sig)).status, reverseOrder: process.env.STRIPE_SIM_REVERSE === "1" });
    await simulator.listen(Number(process.env.STRIPE_SIM_PORT ?? 0));
    provider = new StripeProvider(simulator.secretKey, simulator.url, "simulated");
    ctx.log.info(`Stripe simulator (test mode, no real money) at ${simulator.url}`);
  } else {
    problem = "No payment provider is configured (FELTKIT_CREDENTIAL_STRIPE_SECRET_KEY, FELTKIT_CREDENTIAL_STRIPE_WEBHOOK_SECRET).";
  }

  /** Verify, translate and hand one provider event to the engine. Returns the HTTP status for the sender. */
  async function receive(raw: string, signature: string | undefined): Promise<{ status: number; body: Record<string, unknown> }> {
    stats.received += 1;
    if (!webhookSecret) return { status: 503, body: { error: "webhooks not configured" } };
    const verified = verifyStripeSignature(raw, signature, webhookSecret);
    if (!verified.ok) {
      stats.rejected += 1;
      ctx.log.warn(`rejected webhook: ${verified.reason}`);
      return { status: 400, body: { error: verified.reason } };
    }
    stats.verified += 1;
    let event: NormalizedEvent;
    try {
      event = normalizeStripeEvent(JSON.parse(raw));
    } catch {
      return { status: 400, body: { error: "not a Stripe event" } };
    }
    try {
      if (event.paymentMethod && !event.paymentMethod.brand && provider) {
        // Card details come from the provider's API (server-to-server), never from the event sender.
        event.paymentMethod = (await provider.paymentMethod(event.paymentMethod.ref)) ?? event.paymentMethod;
      }
      const result = await ctx.call<{ outcome: string; duplicate: boolean }>("payments:ingest", { event: clean(event) });
      if (result.duplicate) stats.duplicates += 1;
      else stats.applied += 1;
      return { status: 200, body: { received: true, ...result } };
    } catch (e) {
      ctx.log.error(`ingest failed for ${event.eventId}: ${(e as Error).message}`);
      return { status: 500, body: { error: "processing failed; retry" } };
    }
  }

  async function perform(item: ComponentWorkItem, p: PaymentProvider) {
    const input = item.input as Record<string, any>;
    switch (item.kind) {
      case "checkout.create": {
        const customerRef = input.customerRef ?? (await p.ensureCustomer({ accountId: input.accountId, name: input.name, email: input.email, idempotencyKey: `customer:${input.accountId}` })).customerRef;
        const base = String(input.returnUrl ?? "http://localhost:3000/");
        const session = await p.createCheckout({ checkoutId: input.checkoutId, accountId: input.accountId, invoiceId: input.invoiceId, mode: input.mode, amount: input.amount, currency: input.currency, description: input.description, customerRef, successUrl: `${base}?checkout=${input.checkoutId}&result=success`, cancelUrl: `${base}?checkout=${input.checkoutId}&result=cancel` }, `checkout:${input.checkoutId}`);
        await ctx.call("payments:workResult", { result: { kind: "checkout.created", checkoutId: input.checkoutId, customerRef, checkoutRef: session.checkoutRef, url: session.url } });
        return { checkoutRef: session.checkoutRef };
      }
      case "invoice.charge": {
        const r = await p.charge({ invoiceId: input.invoiceId, accountId: input.accountId, amount: input.amount, currency: input.currency, customerRef: input.customerRef, paymentMethodRef: input.paymentMethodRef, idempotencyKey: `charge:${input.invoiceId}:${input.attempt}`, description: input.description });
        await ctx.call("payments:workResult", { result: { kind: "charge.requested", invoiceId: input.invoiceId, attempt: input.attempt, paymentRef: r.paymentRef, status: r.status } });
        return { paymentRef: r.paymentRef, status: r.status };
      }
      case "refund.create": {
        const r = await p.refund({ refundId: input.refundId, paymentRef: input.paymentRef, amount: input.amount, idempotencyKey: `refund:${input.refundId}` });
        await ctx.call("payments:workResult", { result: { kind: "refund.requested", refundId: input.refundId, refundRef: r.refundRef, status: r.status } });
        return { refundRef: r.refundRef };
      }
      case "payment.reconcile": {
        const r = await p.paymentStatus(input.paymentRef);
        await ctx.call("payments:workResult", { result: { kind: "payment.observed", invoiceId: input.invoiceId, paymentRef: input.paymentRef, status: r.status, amount: r.amount ?? 0, currency: r.currency ?? "" } });
        return r;
      }
      default:
        throw new ProviderError(`Unknown work kind ${item.kind}`, false);
    }
  }

  let working = false;
  async function workOnce() {
    if (working || !provider) return;
    working = true;
    try {
      for (const item of await ctx.work.claim({ limit: 10, leaseMs: 60_000 })) {
        try {
          const receipt = await perform(item, provider);
          await ctx.work.finish(item, { outcome: "done", receipt: receipt as Record<string, unknown> });
          stats.workDone += 1;
        } catch (e) {
          const err = e as Error & { retryable?: boolean; code?: string };
          if (err instanceof ProviderError && !err.retryable) {
            stats.workFailed += 1;
            await ctx.call("payments:workResult", { result: { kind: "failed", work: item.kind, input: item.input, error: err.message } }).catch(() => {});
            await ctx.work.finish(item, { outcome: "failed", error: { code: err.providerCode ?? "PROVIDER_REJECTED", message: err.message } });
          } else {
            stats.workRetried += 1;
            await ctx.work.finish(item, { outcome: "retry", error: { code: err.code ?? "PROVIDER_UNAVAILABLE", message: err.message }, retryInMs: 2_000 * item.attempt });
          }
        }
      }
    } catch (e) {
      ctx.log.error(`work loop: ${(e as Error).message}`);
    } finally {
      working = false;
    }
  }
  async function clock() {
    try {
      for (const accountId of await ctx.call<string[]>("lifecycle:due", {})) {
        try {
          await ctx.call("lifecycle:advance", { accountId });
        } catch (e) {
          ctx.log.warn(`lifecycle ${accountId}: ${(e as Error).message}`);
        }
      }
      stats.lastClock = Date.now();
      stats.lastClockError = "";
    } catch (e) {
      stats.lastClockError = (e as Error).message;
    }
  }
  const timers = [setInterval(() => void workOnce(), WORK_MS), setInterval(() => void clock(), CLOCK_MS)];
  for (const t of timers) t.unref?.();

  return {
    async request(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url ?? "/", "http://local");
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && url.pathname === "/stripe/webhook") {
        let raw: string;
        try {
          raw = await readBody(req);
        } catch {
          return json(413, { error: "too large" });
        }
        const r = await receive(raw, req.headers["stripe-signature"] as string | undefined);
        return json(r.status, r.body);
      }
      if (req.method === "GET" && url.pathname === "/stripe/status") {
        return json(200, { provider: provider?.name ?? null, mode: provider?.mode ?? null, simulator: simulator?.url ?? null, problem, stats });
      }
      // Development-only controls of the simulator (a fake external system), for demos and tests.
      if (simulator && url.pathname.startsWith("/stripe/sim/")) {
        const behavior = url.pathname.match(/^\/stripe\/sim\/customers\/([^/]+)\/behavior$/);
        if (req.method === "POST" && behavior) {
          const body = JSON.parse((await readBody(req)) || "{}");
          simulator.behavior.set(behavior[1]!, body.card === "decline" ? "decline" : "ok");
          return json(200, { ok: true });
        }
        const redeliver = url.pathname.match(/^\/stripe\/sim\/events\/([^/]+)\/redeliver$/);
        if (req.method === "POST" && redeliver) return json(200, { status: await simulator.redeliver(redeliver[1]!) });
        if (req.method === "POST" && url.pathname === "/stripe/sim/settle") {
          await workOnce();
          await simulator.settled();
          return json(200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/stripe/sim/tick") {
          await workOnce();
          await simulator.settled();
          await clock();
          return json(200, { ok: true, clockError: stats.lastClockError || null });
        }
        if (req.method === "GET" && url.pathname === "/stripe/sim/events") return json(200, { events: simulator.events.map((e) => ({ id: e.id, type: e.type })), deliveries: simulator.deliveries });
        const checkout = url.pathname.match(/^\/stripe\/sim\/checkout\/([^/]+)\/complete$/);
        if (req.method === "POST" && checkout) {
          const body = JSON.parse((await readBody(req)) || "{}");
          const r = simulator.completeCheckout(checkout[1]!, body.card ?? "pm_card_visa");
          await simulator.settled();
          return json(200, r);
        }
      }
      return json(404, { error: "not found" });
    },
    health(): ComponentHealth {
      if (problem) return { state: "unconfigured", detail: problem };
      return {
        state: "ready",
        detail: `${provider!.name} (${provider!.mode})`,
        checks: { webhooks: { state: webhookSecret ? "ready" : "unconfigured" }, clock: { state: stats.lastClockError ? "degraded" : "ready", ...(stats.lastClockError ? { detail: stats.lastClockError } : {}) } },
      };
    },
    async close() {
      for (const t of timers) clearInterval(t);
      await simulator?.close();
    },
  };
});

/** Drop undefined fields: the engine's argument schema refuses unknown or undefined values. */
function clean<T extends object>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
