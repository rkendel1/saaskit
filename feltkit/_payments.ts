/**
 * Asking the provider to move money, and applying money that verifiably moved.
 *
 * Requests (checkout, charge, refund) are durable work for the payments component, recorded in the
 * requesting mutation's transaction: no request exists unless the change that needs it committed.
 * Outcomes are applied ONLY from verified provider events (payments:ingest) or a server-to-server
 * provider read during reconciliation — never from a browser.
 */
import type { MutationCtx } from "@feltdb/feltkit";
import { accounts, audit, checkouts, grants, invoices, paymentAttempts, subscriptions } from "./app.js";
import { catalogAt, notify, planPrice, releaseOverageBilled, type AccountDoc, type SubscriptionDoc } from "./_commerce.js";
import { addInterval, DAY, periodKey } from "./_engine.js";

type Invoice = NonNullable<typeof invoices.$doc>;

/** Dunning: days after the first failure at which a renewal is retried. */
export const RETRY_SCHEDULE_DAYS = [1, 3, 5];

/** Charge a saved payment method off-session. False when the account has none (a checkout is needed). */
export async function requestCharge(ctx: MutationCtx, invoice: { id: string; accountId: string; total: number; currency: string; number: string; attempts: number }, account: AccountDoc) {
  if (!account.paymentMethod || !account.providerCustomerRef) return false;
  const attempt = invoice.attempts + 1;
  await ctx.db.insert(paymentAttempts, { accountId: invoice.accountId, invoiceId: invoice.id, attempt, state: "requested", amount: invoice.total, requestedAt: Date.now(), via: "off_session" });
  await ctx.db.patch(invoices, invoice.id, { attempts: attempt, nextAttemptAt: undefined });
  ctx.afterCommit.work("payments", "invoice.charge", { invoiceId: invoice.id, accountId: invoice.accountId, attempt, amount: invoice.total, currency: invoice.currency, customerRef: account.providerCustomerRef, paymentMethodRef: account.paymentMethod.ref, description: `Invoice ${invoice.number}` });
  return true;
}

/** Open a hosted checkout (to pay an invoice, or to save a card). The URL arrives with the work result. */
export async function openCheckout(ctx: MutationCtx, account: AccountDoc, input: { invoice?: { id: string; total: number; currency: string; number: string }; mode: "payment" | "setup"; description: string; returnUrl: string; createdBy: string }) {
  const now = Date.now();
  const checkoutId = await ctx.db.insert(checkouts, { accountId: account.accountId, invoiceId: input.invoice?.id ?? "", state: "creating", createdAt: now, createdBy: input.createdBy });
  if (input.invoice) await ctx.db.insert(paymentAttempts, { accountId: account.accountId, invoiceId: input.invoice.id, attempt: 0, state: "requested", amount: input.invoice.total, requestedAt: now, via: "checkout" });
  ctx.afterCommit.work("payments", "checkout.create", {
    checkoutId, accountId: account.accountId, mode: input.mode, amount: input.invoice?.total ?? 0, currency: input.invoice?.currency ?? "usd", description: input.description,
    name: account.name, ...(account.billingEmail ? { email: account.billingEmail } : {}), ...(account.providerCustomerRef ? { customerRef: account.providerCustomerRef } : {}),
    ...(input.invoice ? { invoiceId: input.invoice.id } : {}), returnUrl: input.returnUrl,
  });
  return checkoutId;
}

/**
 * An invoice has been verifiably paid: mark it, and give the customer what it paid for.
 * `evidence` names the provider event (or reconciliation read) that proves it.
 */
export async function applyPayment(ctx: MutationCtx, invoice: Invoice, amount: number, paymentRef: string, evidence: string) {
  const now = Date.now();
  await ctx.db.patch(invoices, invoice.id, { status: "paid", amountPaid: amount, paidAt: now, providerPaymentRef: paymentRef, nextAttemptAt: undefined, lastFailure: undefined });
  const attempts = await ctx.db.find(paymentAttempts, { invoiceId: invoice.id });
  const open = attempts.filter((a) => a.state === "requested" || a.state === "unknown").sort((a, b) => b.attempt - a.attempt)[0];
  if (open) await ctx.db.patch(paymentAttempts, open.id, { state: "succeeded", providerRef: paymentRef, settledAt: now });
  await audit.record(ctx, { subject: "invoice", id: invoice.id, type: "invoice.paid", data: { amount, paymentRef, evidence } });
  const [account] = await ctx.db.find(accounts, { accountId: invoice.accountId }, { limit: 1 });
  const [sub] = await ctx.db.find(subscriptions, { accountId: invoice.accountId }, { limit: 1 });
  if (!account || !sub) return "invoice paid; no account";
  notify(ctx, account, "payment.succeeded", `Payment of ${(amount / 100).toFixed(2)} ${String(invoice.currency).toUpperCase()} received`, { invoiceId: invoice.id, number: invoice.number, amount }, `paid:${invoice.id}`);
  ctx.afterCommit.webhooks.emit("invoice.paid", { accountId: invoice.accountId, invoiceId: invoice.id, amount });

  if (invoice.purpose.type === "addon") {
    const catalog = await catalogAt(ctx, sub.catalogVersion);
    const addon = catalog.addons.find((a: { key: string }) => a.key === invoice.purpose.addonKey);
    if (!addon) return "invoice paid; add-on no longer in catalog";
    for (const [feature, qty] of Object.entries(addon.grants)) {
      await ctx.db.insert(grants, { accountId: invoice.accountId, feature, kind: "addon", value: qty, periodKey: periodKey(sub.currentPeriodStart), reason: `Purchased ${addon.name}`, source: invoice.id, createdBy: invoice.purpose.requestedBy, createdAt: now });
    }
    await audit.record(ctx, { subject: "entitlement", id: invoice.accountId, type: "addon.granted", data: { addon: addon.key, invoiceId: invoice.id } });
    ctx.afterCommit.webhooks.emit("entitlements.changed", { accountId: invoice.accountId });
    return `add-on ${addon.key} granted`;
  }

  // A subscription invoice: first purchase, upgrade, or renewal.
  if (sub.pending && sub.pending.invoiceId === invoice.id) {
    const p = sub.pending;
    const catalog = await catalogAt(ctx, p.catalogVersion);
    const { plan, price } = planPrice(catalog, p.planKey, p.priceKey);
    const fresh = p.kind === "new";
    const start = fresh ? now : sub.currentPeriodStart;
    const end = fresh ? addInterval(now, price.interval) : sub.currentPeriodEnd;
    const from = sub.planKey;
    await ctx.db.patch(subscriptions, sub.id, {
      planKey: p.planKey, priceKey: p.priceKey, catalogVersion: p.catalogVersion, seats: p.seats, status: "active", currentPeriodStart: start, currentPeriodEnd: end,
      pending: undefined, scheduledChange: undefined, cancelAtPeriodEnd: false, canceledAt: undefined, graceUntil: undefined, trialEnd: undefined, updatedAt: now,
      ...(sub.coupon ? { coupon: { ...sub.coupon, periodsLeft: Math.max(sub.coupon.periodsLeft - 1, 0) } } : {}),
    });
    await audit.record(ctx, { subject: "subscription", id: invoice.accountId, type: fresh ? "subscription.activated" : "subscription.upgraded", data: { from, to: plan.key, price: price.key, catalogVersion: p.catalogVersion, seats: p.seats, invoiceId: invoice.id, evidence, transition: `${sub.status}→active` } });
    notify(ctx, account, fresh ? "subscription.activated" : "plan.upgraded", fresh ? `Welcome to ${plan.name}` : `You are now on ${plan.name}`, { plan: plan.key, from }, `${fresh ? "activated" : "upgraded"}:${invoice.id}`);
    ctx.afterCommit.webhooks.emit("subscription.updated", { accountId: invoice.accountId, plan: plan.key, status: "active" });
    ctx.afterCommit.webhooks.emit("entitlements.changed", { accountId: invoice.accountId });
    return `subscription ${fresh ? "activated" : "upgraded"} to ${plan.key}`;
  }
  if (invoice.kind === "renewal" && (sub.status === "past_due" || sub.status === "suspended" || sub.status === "active")) {
    if (sub.status !== "active") {
      await ctx.db.patch(subscriptions, sub.id, { status: "active", graceUntil: undefined, updatedAt: now });
      await audit.record(ctx, { subject: "subscription", id: invoice.accountId, type: "subscription.recovered", data: { invoiceId: invoice.id, transition: `${sub.status}→active`, evidence } });
      ctx.afterCommit.webhooks.emit("subscription.updated", { accountId: invoice.accountId, status: "active" });
    }
    return "renewal paid";
  }
  return "invoice paid";
}

/** A payment attempt verifiably failed. Renewals enter dunning; first purchases simply stay unpaid. */
export async function applyFailure(ctx: MutationCtx, invoice: Invoice, reason: string, evidence: string) {
  const now = Date.now();
  const attempts = await ctx.db.find(paymentAttempts, { invoiceId: invoice.id });
  const open = attempts.filter((a) => a.state === "requested" || a.state === "unknown").sort((a, b) => b.attempt - a.attempt)[0];
  if (open) await ctx.db.patch(paymentAttempts, open.id, { state: "failed", failureReason: reason, settledAt: now });
  const retryDay = RETRY_SCHEDULE_DAYS[invoice.attempts - 1];
  // Dunning and grace count from when the money was due, not from when the provider's event arrived.
  const due = Math.max(now, invoice.periodStart);
  await ctx.db.patch(invoices, invoice.id, { lastFailure: reason, ...(retryDay !== undefined ? { nextAttemptAt: due + retryDay * DAY } : { nextAttemptAt: undefined }) });
  await audit.record(ctx, { subject: "invoice", id: invoice.id, type: "invoice.payment_failed", data: { reason, attempt: invoice.attempts, evidence, nextRetryDays: retryDay ?? null } });
  const [account] = await ctx.db.find(accounts, { accountId: invoice.accountId }, { limit: 1 });
  const [sub] = await ctx.db.find(subscriptions, { accountId: invoice.accountId }, { limit: 1 });
  if (!account || !sub) return "failure recorded";
  notify(ctx, account, "payment.failed", `We could not collect payment for ${invoice.number}`, { invoiceId: invoice.id, reason, nextAttemptAt: retryDay !== undefined ? due + retryDay * DAY : null }, `failed:${invoice.id}:${invoice.attempts}`);
  ctx.afterCommit.webhooks.emit("invoice.payment_failed", { accountId: invoice.accountId, invoiceId: invoice.id, reason });
  if (invoice.kind === "renewal" && (sub.status === "active" || sub.status === "trialing")) {
    const catalog = await catalogAt(ctx, sub.catalogVersion);
    const { plan } = planPrice(catalog, sub.planKey, sub.priceKey);
    const graceUntil = due + plan.graceDays * DAY;
    await ctx.db.patch(subscriptions, sub.id, { status: "past_due", graceUntil, updatedAt: now });
    await audit.record(ctx, { subject: "subscription", id: invoice.accountId, type: "subscription.past_due", data: { invoiceId: invoice.id, graceUntil, transition: `${sub.status}→past_due` } });
    ctx.afterCommit.webhooks.emit("subscription.updated", { accountId: invoice.accountId, status: "past_due" });
    return "subscription past due";
  }
  if (sub.pending?.invoiceId === invoice.id && sub.pending.kind === "upgrade") {
    // An off-session upgrade charge failed: the upgrade does not happen and its invoice is void.
    await ctx.db.patch(subscriptions, sub.id, { pending: undefined, updatedAt: now });
    await ctx.db.patch(invoices, invoice.id, { status: "void", voidedAt: now, nextAttemptAt: undefined });
    await releaseOverageBilled(ctx, invoice);
    await audit.record(ctx, { subject: "subscription", id: invoice.accountId, type: "subscription.upgrade_failed", data: { invoiceId: invoice.id, reason } });
    return "upgrade abandoned";
  }
  return "failure recorded";
}

export type { SubscriptionDoc };
