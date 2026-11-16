/**
 * Functions only the payments component (principal payments-gateway) may call.
 *
 * `ingest` applies one verified provider event exactly once. Its first write is the event's own
 * record, unique on (provider, eventId), in the same transaction as everything the event changes:
 * a redelivered event finds its record and changes nothing; two concurrent deliveries conflict and
 * the loser finds the record on retry. Events arriving out of order are judged against the current
 * state (an invoice already paid ignores a late failure), never applied blindly.
 */
import { s, type MutationCtx } from "@feltdb/feltkit";
import { accounts, app, audit, checkouts, invoices, paymentAttempts, providerEvents, refunds } from "./app.js";
import { applyFailure, applyPayment, requestCharge } from "./_payments.js";

const eventSchema = s.object({
  provider: s.string(),
  eventId: s.string({ minLength: 1 }),
  type: s.enum(["checkout.completed", "payment.succeeded", "payment.failed", "refund.succeeded", "refund.failed", "payment_method.updated", "ignored"]),
  providerType: s.string(),
  created: s.number(),
  accountId: s.optional(s.string()),
  invoiceId: s.optional(s.string()),
  checkoutId: s.optional(s.string()),
  refundId: s.optional(s.string()),
  paymentRef: s.optional(s.string()),
  refundRef: s.optional(s.string()),
  checkoutRef: s.optional(s.string()),
  customerRef: s.optional(s.string()),
  amount: s.optional(s.number()),
  currency: s.optional(s.string()),
  failureReason: s.optional(s.string()),
  mode: s.optional(s.enum(["payment", "setup"])),
  paymentMethod: s.optional(s.object({ ref: s.string(), brand: s.string(), last4: s.string(), expMonth: s.number(), expYear: s.number() })),
});

export const ingest = app.mutation({
  access: "payments.ingest",
  args: { event: eventSchema },
  returns: s.object({ outcome: s.string(), duplicate: s.boolean(), detail: s.string() }),
  handler: async (ctx, { event }) => {
    const e = event as Record<string, any>;
    const [seen] = await ctx.db.find(providerEvents, { provider: e.provider, eventId: e.eventId }, { limit: 1 });
    if (seen) return { outcome: seen.outcome, duplicate: true, detail: `already processed: ${seen.detail}` };
    const { outcome, detail, accountId, objectRef } = await apply(ctx, e);
    await ctx.db.insert(providerEvents, {
      provider: e.provider, eventId: e.eventId, type: e.providerType, providerCreatedAt: e.created, receivedAt: Date.now(), outcome, detail: detail.slice(0, 1000),
      ...(accountId ? { accountId } : {}), ...(objectRef ? { objectRef } : {}),
    });
    return { outcome, duplicate: false, detail };
  },
});

type Result = { outcome: "applied" | "ignored" | "stale" | "unmatched" | "failed"; detail: string; accountId?: string; objectRef?: string };

async function apply(ctx: MutationCtx, e: Record<string, any>): Promise<Result> {
  const evidence = `${e.provider}:${e.eventId}`;
  switch (e.type) {
    case "payment.succeeded":
    case "payment.failed": {
      if (!e.invoiceId) return { outcome: "unmatched", detail: "payment without an invoice reference", objectRef: e.paymentRef };
      const invoice = await ctx.db.get(invoices, e.invoiceId);
      if (!invoice) return { outcome: "unmatched", detail: `no invoice ${e.invoiceId}`, objectRef: e.paymentRef };
      if (e.accountId && e.accountId !== invoice.accountId) return { outcome: "failed", detail: `ANOMALY: event names account ${e.accountId}, invoice belongs to ${invoice.accountId}`, accountId: invoice.accountId, objectRef: e.paymentRef };
      if (e.type === "payment.succeeded") {
        if (invoice.status === "paid") {
          const same = invoice.providerPaymentRef === e.paymentRef;
          return { outcome: same ? "ignored" : "failed", detail: same ? "invoice already paid by this payment" : `ANOMALY: invoice ${invoice.number} already paid by ${invoice.providerPaymentRef}; second payment ${e.paymentRef} needs a refund`, accountId: invoice.accountId, objectRef: e.paymentRef };
        }
        if (invoice.status !== "open") return { outcome: "failed", detail: `ANOMALY: payment for a ${invoice.status} invoice ${invoice.number}`, accountId: invoice.accountId, objectRef: e.paymentRef };
        if (e.amount !== invoice.total || String(e.currency).toLowerCase() !== invoice.currency) {
          await audit.record(ctx, { subject: "invoice", id: invoice.id, type: "invoice.payment_mismatch", data: { expected: invoice.total, got: e.amount, currency: e.currency, evidence } });
          return { outcome: "failed", detail: `ANOMALY: paid ${e.amount} ${e.currency}, invoice is ${invoice.total} ${invoice.currency}; nothing granted`, accountId: invoice.accountId, objectRef: e.paymentRef };
        }
        if (e.paymentMethod?.brand) await savePaymentMethod(ctx, invoice.accountId, e.customerRef, e.paymentMethod);
        const detail = await applyPayment(ctx, invoice, e.amount, e.paymentRef, evidence);
        return { outcome: "applied", detail, accountId: invoice.accountId, objectRef: e.paymentRef };
      }
      if (invoice.status !== "open") return { outcome: "stale", detail: `failure for invoice already ${invoice.status}`, accountId: invoice.accountId, objectRef: e.paymentRef };
      const detail = await applyFailure(ctx, invoice, e.failureReason ?? "payment failed", evidence);
      return { outcome: "applied", detail, accountId: invoice.accountId, objectRef: e.paymentRef };
    }
    case "checkout.completed": {
      const checkout = e.checkoutId ? await ctx.db.get(checkouts, e.checkoutId) : null;
      if (!checkout) return { outcome: "unmatched", detail: "no matching checkout", objectRef: e.checkoutRef };
      if (checkout.state === "completed") return { outcome: "ignored", detail: "checkout already completed", accountId: checkout.accountId };
      await ctx.db.patch(checkouts, checkout.id, { state: "completed", ...(e.checkoutRef ? { providerRef: e.checkoutRef } : {}) });
      if (e.customerRef) await savePaymentMethod(ctx, checkout.accountId, e.customerRef, undefined);
      // Payment, if any, is applied by its own payment event: completing checkout grants nothing by itself.
      return { outcome: "applied", detail: `checkout completed (${e.mode})`, accountId: checkout.accountId, objectRef: e.checkoutRef };
    }
    case "payment_method.updated": {
      const accountId = await accountFor(ctx, e.accountId, e.customerRef);
      if (!accountId || !e.paymentMethod) return { outcome: "unmatched", detail: "payment method for an unknown customer" };
      await savePaymentMethod(ctx, accountId, e.customerRef, e.paymentMethod);
      // A past-due invoice is retried as soon as a new card is on file.
      const [account] = await ctx.db.find(accounts, { accountId }, { limit: 1 });
      const open = (await ctx.db.find(invoices, { accountId, status: "open" })).filter((i) => i.kind === "renewal");
      for (const inv of open) if (account) await requestCharge(ctx, inv, account);
      return { outcome: "applied", detail: `payment method ${e.paymentMethod.brand} ${e.paymentMethod.last4}${open.length ? `; retrying ${open.length} invoice(s)` : ""}`, accountId };
    }
    case "refund.succeeded":
    case "refund.failed": {
      const refund = e.refundId ? await ctx.db.get(refunds, e.refundId) : null;
      if (!refund) return { outcome: "unmatched", detail: "refund not initiated here", objectRef: e.refundRef };
      if (refund.state !== "requested") return { outcome: "ignored", detail: `refund already ${refund.state}`, accountId: refund.accountId };
      const now = Date.now();
      await ctx.db.patch(refunds, refund.id, { state: e.type === "refund.succeeded" ? "succeeded" : "failed", providerRef: e.refundRef, settledAt: now });
      if (e.type === "refund.succeeded") {
        const invoice = (await ctx.db.get(invoices, refund.invoiceId))!;
        await ctx.db.patch(invoices, invoice.id, { amountRefunded: invoice.amountRefunded + refund.amount });
        const [account] = await ctx.db.find(accounts, { accountId: refund.accountId }, { limit: 1 });
        if (account) ctx.afterCommit.notifications.send({ recipient: account.ownerId, type: "refund.issued", title: `Refund of ${(refund.amount / 100).toFixed(2)} ${invoice.currency.toUpperCase()} issued`, data: { invoiceId: invoice.id, amount: refund.amount }, idempotencyKey: `refund:${refund.id}` });
      }
      await audit.record(ctx, { subject: "invoice", id: refund.invoiceId, type: e.type === "refund.succeeded" ? "invoice.refunded" : "invoice.refund_failed", data: { amount: refund.amount, refundId: refund.id, evidence } });
      return { outcome: "applied", detail: `refund ${e.type === "refund.succeeded" ? "succeeded" : "failed"}`, accountId: refund.accountId, objectRef: e.refundRef };
    }
    default:
      return { outcome: "ignored", detail: `provider event ${e.providerType} is not used`, objectRef: e.eventId };
  }
}

async function accountFor(ctx: MutationCtx, accountId: string | undefined, customerRef: string | undefined) {
  if (accountId) return accountId;
  if (!customerRef) return null;
  const [a] = await ctx.db.find(accounts, { providerCustomerRef: customerRef }, { limit: 1 });
  return a?.accountId ?? null;
}

async function savePaymentMethod(ctx: MutationCtx, accountId: string, customerRef: string | undefined, pm: { ref: string; brand: string; last4: string; expMonth: number; expYear: number } | undefined) {
  const [account] = await ctx.db.find(accounts, { accountId }, { limit: 1 });
  if (!account) return;
  if (customerRef && account.providerCustomerRef && account.providerCustomerRef !== customerRef) {
    // Recorded, never thrown: a refusal here would make the provider redeliver forever.
    await audit.record(ctx, { subject: "account", id: accountId, type: "account.customer_mismatch", data: { known: account.providerCustomerRef, event: customerRef } });
    return;
  }
  const patch: Record<string, unknown> = {};
  if (customerRef && !account.providerCustomerRef) patch.providerCustomerRef = customerRef;
  if (pm?.brand && account.paymentMethod?.ref !== pm.ref) patch.paymentMethod = pm;
  if (Object.keys(patch).length) {
    await ctx.db.patch(accounts, account.id, patch);
    if (patch.paymentMethod) await audit.record(ctx, { subject: "account", id: accountId, type: "account.payment_method_updated", data: { brand: pm!.brand, last4: pm!.last4 } });
  }
}

/** What the component learned doing provider work (references and URLs; never an outcome of money). */
export const workResult = app.mutation({
  access: "payments.settle",
  args: {
    result: s.object({
      kind: s.enum(["checkout.created", "charge.requested", "refund.requested", "payment.observed", "failed"]),
      checkoutId: s.optional(s.string()), customerRef: s.optional(s.string()), checkoutRef: s.optional(s.string()), url: s.optional(s.string()),
      invoiceId: s.optional(s.string()), attempt: s.optional(s.integer()), paymentRef: s.optional(s.string()), status: s.optional(s.string()),
      refundId: s.optional(s.string()), refundRef: s.optional(s.string()), amount: s.optional(s.number()), currency: s.optional(s.string()),
      work: s.optional(s.string()), input: s.optional(s.record(s.unknown())), error: s.optional(s.string()),
    }),
  },
  handler: async (ctx, { result: r }) => {
    switch (r.kind) {
      case "checkout.created": {
        const c = await ctx.db.get(checkouts, r.checkoutId!);
        if (!c) return;
        if (c.state === "creating") await ctx.db.patch(checkouts, c.id, { state: "open", url: r.url, providerRef: r.checkoutRef });
        const [account] = await ctx.db.find(accounts, { accountId: c.accountId }, { limit: 1 });
        if (account && !account.providerCustomerRef && r.customerRef) await ctx.db.patch(accounts, account.id, { providerCustomerRef: r.customerRef });
        return;
      }
      case "charge.requested": {
        const [a] = (await ctx.db.find(paymentAttempts, { invoiceId: r.invoiceId! })).filter((x) => x.attempt === r.attempt);
        if (a && a.state === "requested" && r.paymentRef) await ctx.db.patch(paymentAttempts, a.id, { providerRef: r.paymentRef });
        return;
      }
      case "refund.requested": {
        const ref = await ctx.db.get(refunds, r.refundId!);
        if (ref && !ref.providerRef) await ctx.db.patch(refunds, ref.id, { providerRef: r.refundRef });
        return;
      }
      case "payment.observed": {
        // Reconciliation: a server-to-server provider read. Applies only what the event stream missed.
        const invoice = r.invoiceId ? await ctx.db.get(invoices, r.invoiceId) : null;
        if (!invoice) return;
        if (r.status === "succeeded" && invoice.status === "open" && r.amount === invoice.total) await applyPayment(ctx, invoice, r.amount!, r.paymentRef!, `reconciliation:${r.paymentRef}`);
        await audit.record(ctx, { subject: "invoice", id: invoice.id, type: "invoice.reconciled", data: { providerStatus: r.status, localStatus: invoice.status, paymentRef: r.paymentRef } });
        return;
      }
      case "failed": {
        const input = (r.input ?? {}) as Record<string, string>;
        if (r.work === "checkout.create" && input.checkoutId) {
          const c = await ctx.db.get(checkouts, input.checkoutId);
          if (c && c.state === "creating") await ctx.db.patch(checkouts, c.id, { state: "failed", error: r.error });
        }
        if (r.work === "refund.create" && input.refundId) {
          const ref = await ctx.db.get(refunds, input.refundId);
          if (ref && ref.state === "requested") await ctx.db.patch(refunds, ref.id, { state: "failed", settledAt: Date.now() });
        }
        if (r.work === "invoice.charge" && input.invoiceId) {
          const invoice = await ctx.db.get(invoices, input.invoiceId);
          if (invoice && invoice.status === "open") await applyFailure(ctx, invoice, `provider refused the charge: ${r.error}`, `work:${r.work}`);
        }
        await audit.record(ctx, { subject: "invoice", id: input.invoiceId ?? input.checkoutId ?? input.refundId ?? "unknown", type: "provider.work_failed", data: { work: r.work ?? "", error: r.error ?? "" } });
        return;
      }
    }
  },
});
