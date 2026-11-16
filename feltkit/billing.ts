/**
 * The customer's billing: what they have, what changes would cost, and the changes themselves.
 * Every function acts on the caller's own workspace account (never an argument). Prices, totals and
 * entitlements are computed here from the published catalog; nothing a client sends is trusted for them.
 */
import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { accounts, app, audit, checkouts, invoices, refunds, subscriptions, usageCounters } from "./app.js";
import { planOf, priceOf, type Catalog, type Price } from "./_catalog.js";
import { accruedOverageLines, callerAccountId, catalogAt, commercialState, createInvoice, ensureAccount, getAccount, markOverageBilled, notify, principalOf, releaseOverageBilled, requirePublished, requireSubscription, subscriptionLine, type Line } from "./_commerce.js";
import { addInterval, DAY, periodAmount, periodKey, prorate, unbilledOverage, type SubscriptionState } from "./_engine.js";
import { applyPayment, openCheckout, requestCharge } from "./_payments.js";
import { expireToDefault, purchaseAddonFor } from "./_lifecycle.js";

const returnUrl = s.string({ minLength: 8, maxLength: 500 });
function checkReturnUrl(url: string) {
  if (!/^https?:\/\/[^\s]+$/.test(url)) fail("INVALID_ARGUMENT", "returnUrl must be an absolute http(s) URL.");
}

async function ownerOf(ctx: MutationCtx) {
  const members = await ctx.tenancy.members();
  return members.find((m) => m.role === "owner")?.principalId ?? principalOf(ctx).id;
}

/** Make sure this workspace has a billing account (first visit). Idempotent. */
export const open = app.mutation({
  access: "billing.read",
  returns: s.object({ accountId: s.string(), created: s.boolean() }),
  handler: async (ctx) => {
    const tenant = app.requireTenant(ctx);
    const { created } = await ensureAccount(ctx, tenant.id, tenant.name, await ownerOf(ctx));
    return { accountId: tenant.id, created };
  },
});

function monthly(price: Price, seats: number) {
  return periodAmount(price, seats) / (price.interval === "year" ? 12 : 1);
}

/** What changing to (plan, price, seats) means right now: kind, timing and the exact lines that would be billed. */
async function quoteFor(ctx: QueryCtx | MutationCtx, accountId: string, planKey: string, priceKey: string, seats: number, couponCode?: string) {
  const sub = await requireSubscription(ctx, accountId);
  const published = await requirePublished(ctx);
  const target = published.document as Catalog;
  const plan = planOf(target, planKey);
  if (!plan || plan.status !== "active" || plan.visibility !== "public") fail("NOT_FOUND", `Plan "${planKey}" is not offered.`);
  const price = priceOf(plan, priceKey);
  if (!price) fail("NOT_FOUND", `Plan "${planKey}" has no price "${priceKey}".`);
  if (!Number.isInteger(seats) || seats < 1 || seats > 10_000) fail("INVALID_ARGUMENT", "Seats must be between 1 and 10000.");
  const currentCatalog = await catalogAt(ctx, sub.catalogVersion);
  const currentPlan = planOf(currentCatalog, sub.planKey)!;
  const currentPrice = priceOf(currentPlan, sub.priceKey)!;
  const now = Date.now();
  const onFreeOrLapsed = currentPlan.isDefault || sub.status === "suspended" || sub.status === "expired";
  let percentOff: number | undefined;
  if (couponCode) {
    const coupon = target.coupons.find((c) => c.code.toUpperCase() === couponCode.toUpperCase() && c.active);
    if (!coupon || (coupon.plans.length && !coupon.plans.includes(plan.key))) fail("INVALID_ARGUMENT", `Coupon "${couponCode}" does not apply to ${plan.name}.`);
    if (!onFreeOrLapsed) fail("FAILED_PRECONDITION", "Coupons apply to new subscriptions only.");
    percentOff = coupon.percentOff;
  }
  const same = plan.key === sub.planKey && price.key === sub.priceKey && seats === sub.seats && published.version === sub.catalogVersion;
  if (same && !onFreeOrLapsed) return { kind: "same" as const, effective: "now" as const, plan, price, lines: [] as Line[], total: 0, catalogVersion: published.version, percentOff, periodEnd: sub.currentPeriodEnd };
  if (plan.isDefault) {
    // Moving to the free plan is a downgrade governed by the current plan's policy.
    return { kind: "downgrade" as const, effective: currentPlan.downgrade === "immediate" ? ("now" as const) : ("period_end" as const), plan, price, lines: [] as Line[], total: 0, catalogVersion: published.version, percentOff, periodEnd: sub.currentPeriodEnd };
  }
  if (onFreeOrLapsed) {
    const end = addInterval(now, price.interval);
    const lines = [subscriptionLine(plan, price, seats, now, end)];
    const discount = percentOff ? Math.floor((lines[0]!.amount * percentOff) / 100) : 0;
    return { kind: "new" as const, effective: "now" as const, plan, price, lines, total: lines[0]!.amount - discount, catalogVersion: published.version, percentOff, periodEnd: end };
  }
  if (price.interval !== currentPrice.interval && monthly(price, seats) <= monthly(currentPrice, sub.seats)) {
    // Interval changes take effect at renewal: no mixed-interval proration.
    return { kind: "downgrade" as const, effective: "period_end" as const, plan, price, lines: [] as Line[], total: 0, catalogVersion: published.version, percentOff, periodEnd: sub.currentPeriodEnd };
  }
  const higher = plan.rank > currentPlan.rank || (plan.rank === currentPlan.rank && monthly(price, seats) > monthly(currentPrice, sub.seats));
  if (!higher) return { kind: "downgrade" as const, effective: currentPlan.downgrade === "immediate" ? ("now" as const) : ("period_end" as const), plan, price, lines: [] as Line[], total: 0, catalogVersion: published.version, percentOff, periodEnd: sub.currentPeriodEnd };
  if (price.interval !== currentPrice.interval) {
    // An upgrade that also changes interval starts a new period now, crediting the unused old one.
    const p = prorate(periodAmount(currentPrice, sub.seats), 0, sub.currentPeriodStart, sub.currentPeriodEnd, now);
    const end = addInterval(now, price.interval);
    const lines: Line[] = [{ kind: "proration_credit", description: `Unused time on ${currentPlan.name}`, quantity: 1, unitAmount: -p.credit, amount: -p.credit }, subscriptionLine(plan, price, seats, now, end), ...(await accruedOverageLines(ctx, accountId))];
    return { kind: "upgrade" as const, effective: "now" as const, plan, price, lines, total: Math.max(lines.reduce((a, l) => a + l.amount, 0), 0), catalogVersion: published.version, percentOff, periodEnd: end, restartPeriod: true };
  }
  const p = prorate(periodAmount(currentPrice, sub.seats), periodAmount(price, seats), sub.currentPeriodStart, sub.currentPeriodEnd, now);
  const lines: Line[] = [
    { kind: "proration_credit", description: `Unused time on ${currentPlan.name}${currentPrice.model === "per_seat" ? ` (${sub.seats} seats)` : ""}`, quantity: 1, unitAmount: -p.credit, amount: -p.credit, periodStart: now, periodEnd: sub.currentPeriodEnd },
    { kind: "proration_charge", description: `Remaining time on ${plan.name}${price.model === "per_seat" ? ` (${seats} seats)` : ""}`, quantity: 1, unitAmount: p.charge, amount: p.charge, periodStart: now, periodEnd: sub.currentPeriodEnd },
  ];
  lines.push(...(await accruedOverageLines(ctx, accountId)));
  return { kind: "upgrade" as const, effective: "now" as const, plan, price, lines, total: Math.max(lines.reduce((a, l) => a + l.amount, 0), 0), catalogVersion: published.version, percentOff, periodEnd: sub.currentPeriodEnd };
}

const quoteShape = s.object({
  kind: s.enum(["new", "upgrade", "downgrade", "same"]),
  effective: s.enum(["now", "period_end"]),
  planKey: s.string(),
  priceKey: s.string(),
  lines: s.array(s.object({ kind: s.string(), description: s.string(), amount: s.integer() })),
  total: s.integer(),
  currency: s.string(),
  effectiveAt: s.number(),
});

export const quote = app.query({
  access: "billing.read",
  args: { planKey: s.string(), priceKey: s.string(), seats: s.optional(s.integer({ minimum: 1 })), coupon: s.optional(s.string()) },
  returns: quoteShape,
  capability: { name: "billing.quote", description: "What changing to a plan would cost now and when it takes effect. Prices come from the published catalog." },
  handler: async (ctx, { planKey, priceKey, seats, coupon }) => {
    const accountId = callerAccountId(ctx);
    const q = await quoteFor(ctx, accountId, planKey, priceKey, seats ?? 1, coupon);
    return { kind: q.kind, effective: q.effective, planKey, priceKey, lines: q.lines.map((l) => ({ kind: l.kind, description: l.description, amount: l.amount })), total: q.total, currency: q.price.currency, effectiveAt: q.effective === "now" ? Date.now() : q.periodEnd };
  },
});

/**
 * Change plan. New and upgraded subscriptions take effect when their invoice is verifiably paid
 * (saved card: charged off-session; otherwise a hosted checkout). Downgrades follow the current
 * plan's policy (now, or at the end of the period).
 */
export const changePlan = app.mutation({
  access: "billing.manage",
  args: { planKey: s.string(), priceKey: s.string(), seats: s.optional(s.integer({ minimum: 1 })), coupon: s.optional(s.string()), returnUrl },
  returns: s.object({ kind: s.string(), effective: s.string(), invoiceId: s.optional(s.string()), checkoutId: s.optional(s.string()), charged: s.boolean() }),
  handler: async (ctx, args) => {
    checkReturnUrl(args.returnUrl);
    const accountId = callerAccountId(ctx);
    const who = principalOf(ctx).id;
    const sub = await requireSubscription(ctx, accountId);
    const account = (await getAccount(ctx, accountId))!;
    if (sub.pending) fail("FAILED_PRECONDITION", "A plan change is already waiting for payment. Complete or abandon it first.", { hint: "PENDING_CHANGE", invoiceId: sub.pending.invoiceId });
    if (sub.status === "canceled" && sub.cancelAtPeriodEnd) fail("FAILED_PRECONDITION", "This subscription is set to cancel. Resume it before changing plans.");
    const seats = args.seats ?? sub.seats;
    const q = await quoteFor(ctx, accountId, args.planKey, args.priceKey, seats, args.coupon);
    const now = Date.now();
    if (q.kind === "same") return { kind: "same", effective: "now", charged: false };

    if (q.kind === "downgrade") {
      const change = { kind: (q.plan.key === sub.planKey ? "interval" : "downgrade") as "interval" | "downgrade", planKey: q.plan.key, priceKey: q.price.key, catalogVersion: q.catalogVersion, seats, effectiveAt: sub.currentPeriodEnd, requestedBy: who };
      if (q.effective === "period_end") {
        await ctx.db.patch(subscriptions, sub.id, { scheduledChange: change, updatedAt: now });
        await audit.record(ctx, { subject: "subscription", id: accountId, type: "subscription.downgrade_scheduled", data: { from: sub.planKey, to: q.plan.key, effectiveAt: sub.currentPeriodEnd } });
        notify(ctx, account, "plan.downgraded", `Your plan changes to ${q.plan.name} on renewal`, { plan: q.plan.key, effectiveAt: sub.currentPeriodEnd }, `downgrade:${sub.currentPeriodEnd}:${q.plan.key}`);
        return { kind: "downgrade", effective: "period_end", charged: false };
      }
      const end = addInterval(now, q.price.interval);
      await ctx.db.patch(subscriptions, sub.id, { planKey: q.plan.key, priceKey: q.price.key, catalogVersion: q.catalogVersion, seats, status: "active", currentPeriodStart: now, currentPeriodEnd: end, scheduledChange: undefined, graceUntil: undefined, updatedAt: now });
      await audit.record(ctx, { subject: "subscription", id: accountId, type: "subscription.downgraded", data: { from: sub.planKey, to: q.plan.key, effective: "now", note: "no refund for unused time" } });
      notify(ctx, account, "plan.downgraded", `You are now on ${q.plan.name}`, { plan: q.plan.key }, `downgrade-now:${now}`);
      ctx.afterCommit.webhooks.emit("entitlements.changed", { accountId });
      return { kind: "downgrade", effective: "now", charged: false };
    }

    // new or upgrade: an invoice, paid before the change applies.
    const restart = "restartPeriod" in q && q.restartPeriod;
    const invoice = await createInvoice(ctx, {
      accountId, kind: q.kind === "new" ? "initial" : "upgrade", currency: q.price.currency, lines: q.lines, percentOff: q.percentOff, catalogVersion: q.catalogVersion,
      periodStart: now, periodEnd: q.periodEnd, purpose: { type: "subscription", requestedBy: who },
    });
    const pendingKind = q.kind === "new" || restart ? "new" : "upgrade";
    if (q.kind === "upgrade") await markOverageBilled(ctx, accountId, periodKey(sub.currentPeriodStart), q.lines, invoice.id, Boolean(restart));
    await ctx.db.patch(subscriptions, sub.id, {
      pending: { planKey: q.plan.key, priceKey: q.price.key, catalogVersion: q.catalogVersion, seats, invoiceId: invoice.id, kind: pendingKind }, updatedAt: now,
      ...(q.percentOff && args.coupon ? { coupon: { code: args.coupon.toUpperCase(), percentOff: q.percentOff, periodsLeft: (await requirePublished(ctx)).document.coupons.find((c: { code: string }) => c.code.toUpperCase() === args.coupon!.toUpperCase())!.periods } } : {}),
    });
    await audit.record(ctx, { subject: "subscription", id: accountId, type: q.kind === "new" ? "subscription.purchase_started" : "subscription.upgrade_started", data: { from: sub.planKey, to: q.plan.key, invoiceId: invoice.id, total: invoice.total } });
    if (invoice.status === "paid") {
      // Nothing to collect (fully credited): the change applies now.
      await applyPayment(ctx, invoice, 0, "none", "zero-total invoice");
      return { kind: q.kind, effective: "now", invoiceId: invoice.id, charged: false };
    }
    if (q.kind === "upgrade" && (await requestCharge(ctx, invoice, account))) return { kind: q.kind, effective: "on_payment", invoiceId: invoice.id, charged: true };
    const checkoutId = await openCheckout(ctx, account, { invoice, mode: "payment", description: `${q.plan.name} — ${invoice.number}`, returnUrl: args.returnUrl, createdBy: who });
    notify(ctx, account, "subscription.created", `Complete your ${q.plan.name} purchase`, { invoiceId: invoice.id, checkoutId }, `created:${invoice.id}`);
    return { kind: q.kind, effective: "on_payment", invoiceId: invoice.id, checkoutId, charged: false };
  },
});

/** Leave a purchase that is waiting for payment: its invoice is voided; nothing else changes. */
export const abandonPending = app.mutation({
  access: "billing.manage",
  handler: async (ctx) => {
    const accountId = callerAccountId(ctx);
    const sub = await requireSubscription(ctx, accountId);
    if (!sub.pending) return;
    const invoice = await ctx.db.get(invoices, sub.pending.invoiceId);
    if (invoice?.status === "paid") fail("FAILED_PRECONDITION", "That invoice is already paid; the change is being applied.");
    if (invoice) {
      await ctx.db.patch(invoices, invoice.id, { status: "void", voidedAt: Date.now(), nextAttemptAt: undefined });
      await releaseOverageBilled(ctx, invoice);
    }
    for (const c of await ctx.db.find(checkouts, { invoiceId: sub.pending.invoiceId })) if (c.state === "open" || c.state === "creating") await ctx.db.patch(checkouts, c.id, { state: "expired" });
    await ctx.db.patch(subscriptions, sub.id, { pending: undefined, ...(sub.planKey !== sub.pending.planKey && sub.coupon && invoice?.kind === "initial" ? { coupon: undefined } : {}), updatedAt: Date.now() });
    await audit.record(ctx, { subject: "subscription", id: accountId, type: "subscription.purchase_abandoned", data: { invoiceId: sub.pending.invoiceId } });
  },
});

/** A free trial of a paid plan, once per account. No card needed; access ends at trialEnd unless a card is on file. */
export const startTrial = app.mutation({
  access: "billing.manage",
  args: { planKey: s.string(), priceKey: s.string(), seats: s.optional(s.integer({ minimum: 1 })) },
  handler: async (ctx, { planKey, priceKey, seats }) => {
    const accountId = callerAccountId(ctx);
    const sub = await requireSubscription(ctx, accountId);
    const account = (await getAccount(ctx, accountId))!;
    const published = await requirePublished(ctx);
    const plan = planOf(published.document as Catalog, planKey);
    const price = plan && priceOf(plan, priceKey);
    if (!plan || !price || plan.visibility !== "public" || plan.status !== "active") fail("NOT_FOUND", "That plan is not offered.");
    if (!plan.trialDays) fail("FAILED_PRECONDITION", `${plan.name} has no trial.`);
    const currentPlan = planOf(await catalogAt(ctx, sub.catalogVersion), sub.planKey)!;
    if (!currentPlan.isDefault || sub.pending) fail("FAILED_PRECONDITION", "Trials are for accounts on the free plan.");
    const history = await audit.history(ctx, "subscription", accountId);
    if (history.some((h) => h.type === "subscription.trial_started")) fail("FAILED_PRECONDITION", "This workspace has already used its trial.", { hint: "TRIAL_USED" });
    const now = Date.now();
    const trialEnd = now + plan.trialDays * DAY;
    await ctx.db.patch(subscriptions, sub.id, { planKey, priceKey, catalogVersion: published.version, seats: seats ?? 1, status: "trialing", trialEnd, currentPeriodStart: now, currentPeriodEnd: trialEnd, cancelAtPeriodEnd: false, updatedAt: now });
    await audit.record(ctx, { subject: "subscription", id: accountId, type: "subscription.trial_started", data: { plan: planKey, trialEnd, transition: `${sub.status}→trialing` } });
    notify(ctx, account, "subscription.activated", `Your ${plan.trialDays}-day ${plan.name} trial has started`, { plan: planKey, trialEnd }, `trial:${accountId}`);
    ctx.afterCommit.webhooks.emit("entitlements.changed", { accountId });
    return { trialEnd };
  },
});

/** Cancel. The plan's policy decides whether access ends now or at the end of the paid period. */
export const cancel = app.mutation({
  access: "billing.manage",
  args: { reason: s.optional(s.string({ maxLength: 500 })) },
  returns: s.object({ status: s.string(), accessUntil: s.number() }),
  handler: async (ctx, { reason }) => {
    const accountId = callerAccountId(ctx);
    const sub = await requireSubscription(ctx, accountId);
    const account = (await getAccount(ctx, accountId))!;
    const catalog = await catalogAt(ctx, sub.catalogVersion);
    const plan = planOf(catalog, sub.planKey)!;
    if (plan.isDefault) fail("FAILED_PRECONDITION", "The free plan has nothing to cancel.");
    if (sub.status === "canceled") return { status: "canceled", accessUntil: sub.currentPeriodEnd };
    const now = Date.now();
    const immediate = plan.cancellation === "immediate" || sub.status === "trialing" || sub.status === "suspended";
    if (immediate) {
      await ctx.db.patch(subscriptions, sub.id, { status: "canceled", canceledAt: now, cancelReason: reason, cancelAtPeriodEnd: false, updatedAt: now });
      await audit.record(ctx, { subject: "subscription", id: accountId, type: "subscription.canceled", data: { reason: reason ?? null, effective: "now", transition: `${sub.status}→canceled` } });
      await expireToDefault(ctx, accountId, "canceled immediately");
      notify(ctx, account, "subscription.canceled", `Your ${plan.name} subscription has ended`, { plan: plan.key }, `cancel:${now}`);
      return { status: "expired", accessUntil: now };
    }
    await ctx.db.patch(subscriptions, sub.id, { status: "canceled", canceledAt: now, cancelReason: reason, cancelAtPeriodEnd: true, scheduledChange: undefined, updatedAt: now });
    await audit.record(ctx, { subject: "subscription", id: accountId, type: "subscription.canceled", data: { reason: reason ?? null, effective: "period_end", accessUntil: sub.currentPeriodEnd, transition: `${sub.status}→canceled` } });
    notify(ctx, account, "subscription.canceled", `${plan.name} is canceled; access continues until the end of the period`, { plan: plan.key, accessUntil: sub.currentPeriodEnd }, `cancel:${now}`);
    ctx.afterCommit.webhooks.emit("subscription.updated", { accountId, status: "canceled" });
    return { status: "canceled", accessUntil: sub.currentPeriodEnd };
  },
});

export const resume = app.mutation({
  access: "billing.manage",
  handler: async (ctx) => {
    const accountId = callerAccountId(ctx);
    const sub = await requireSubscription(ctx, accountId);
    if (sub.status !== "canceled" || !sub.cancelAtPeriodEnd) fail("FAILED_PRECONDITION", "Only a subscription set to cancel at period end can be resumed.");
    if (sub.currentPeriodEnd <= Date.now()) fail("FAILED_PRECONDITION", "The period has ended; subscribe again instead.");
    await ctx.db.patch(subscriptions, sub.id, { status: "active", cancelAtPeriodEnd: false, canceledAt: undefined, cancelReason: undefined, updatedAt: Date.now() });
    await audit.record(ctx, { subject: "subscription", id: accountId, type: "subscription.resumed", data: { transition: "canceled→active" } });
  },
});

export const cancelScheduledChange = app.mutation({
  access: "billing.manage",
  handler: async (ctx) => {
    const accountId = callerAccountId(ctx);
    const sub = await requireSubscription(ctx, accountId);
    if (!sub.scheduledChange) return;
    await ctx.db.patch(subscriptions, sub.id, { scheduledChange: undefined, updatedAt: Date.now() });
    await audit.record(ctx, { subject: "subscription", id: accountId, type: "subscription.scheduled_change_canceled", data: { was: sub.scheduledChange.planKey } });
  },
});

/** Buy extra capacity for this billing period. */
export const purchaseAddon = app.mutation({
  access: "billing.manage",
  args: { addonKey: s.string(), returnUrl },
  returns: s.object({ invoiceId: s.string(), charged: s.boolean(), checkoutId: s.optional(s.string()) }),
  handler: async (ctx, { addonKey, returnUrl: url }) => {
    checkReturnUrl(url);
    const accountId = callerAccountId(ctx);
    return purchaseAddonFor(ctx, accountId, addonKey, principalOf(ctx).id, url);
  },
});

/** Save or replace the card on file through the provider's hosted page. */
export const updatePaymentMethod = app.mutation({
  access: "billing.manage",
  args: { returnUrl },
  returns: s.object({ checkoutId: s.string() }),
  handler: async (ctx, { returnUrl: url }) => {
    checkReturnUrl(url);
    const accountId = callerAccountId(ctx);
    const account = (await getAccount(ctx, accountId)) ?? fail("FAILED_PRECONDITION", "Open billing first.");
    return { checkoutId: await openCheckout(ctx, account, { mode: "setup", description: "Update payment method", returnUrl: url, createdBy: principalOf(ctx).id }) };
  },
});

/** Try an open invoice again now, with the card on file. */
export const retryPayment = app.mutation({
  access: "billing.manage",
  args: { invoiceId: s.string() },
  returns: s.object({ charged: s.boolean() }),
  handler: async (ctx, { invoiceId }) => {
    const accountId = callerAccountId(ctx);
    const invoice = await ctx.db.get(invoices, invoiceId);
    if (!invoice || invoice.accountId !== accountId) fail("NOT_FOUND", "No such invoice.");
    if (invoice.status !== "open") fail("FAILED_PRECONDITION", `Invoice ${invoice.number} is ${invoice.status}.`);
    const account = (await getAccount(ctx, accountId))!;
    const charged = await requestCharge(ctx, invoice, account);
    if (!charged) fail("FAILED_PRECONDITION", "No card on file. Update the payment method first.", { hint: "NO_PAYMENT_METHOD" });
    return { charged };
  },
});

export const setBillingEmail = app.mutation({
  access: "billing.manage",
  args: { email: s.string({ minLength: 3, maxLength: 320 }) },
  handler: async (ctx, { email }) => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail("INVALID_ARGUMENT", "That is not an e-mail address.");
    const account = (await getAccount(ctx, callerAccountId(ctx))) ?? fail("FAILED_PRECONDITION", "Open billing first.");
    await ctx.db.patch(accounts, account.id, { billingEmail: email });
  },
});

// ─── Reads ───────────────────────────────────────────────────────────────────────────────────

/** Everything the billing page shows, computed server-side. */
export const summary = app.query({
  access: "billing.read",
  handler: async (ctx) => {
    const accountId = callerAccountId(ctx);
    const account = await getAccount(ctx, accountId);
    if (!account) return null;
    const state = await commercialState(ctx, accountId);
    const { sub, catalog, plan } = state;
    const subPlan = planOf(catalog, sub.planKey)!;
    const price = priceOf(subPlan, sub.priceKey)!;
    const counters = await ctx.db.find(usageCounters, { accountId, periodKey: state.periodKey });
    const usage = state.entitlements.filter((e) => e.type === "allowance").map((e) => {
      const c = counters.find((x) => x.meter === e.meter);
      const used = c?.used ?? 0;
      const over = c?.invoicedAt ? { units: 0, amount: 0 } : unbilledOverage(e.value as number | null, used, c?.billedUnits ?? 0, e.overage);
      return { feature: e.key, name: e.name, meter: e.meter!, unit: e.unit ?? "", allowance: e.value as number | null, used, reserved: c?.reserved ?? 0, overageUnits: over.units, overageAmount: over.amount, policy: e.overage?.policy ?? "block" };
    });
    const overage = usage.reduce((a, u) => a + u.overageAmount, 0);
    const willRenew = !plan.isDefault && sub.status !== "canceled" && sub.status !== "suspended";
    const next = sub.scheduledChange ? (() => {
      const c = sub.scheduledChange!;
      return { planKey: c.planKey, priceKey: c.priceKey, catalogVersion: c.catalogVersion, seats: c.seats };
    })() : { planKey: sub.planKey, priceKey: sub.priceKey, catalogVersion: sub.catalogVersion, seats: sub.seats };
    let nextAmount = 0;
    try {
      const nextCatalog = await catalogAt(ctx, next.catalogVersion);
      const np = planOf(nextCatalog, next.planKey);
      const npr = np && priceOf(np, next.priceKey);
      nextAmount = npr ? periodAmount(npr, next.seats) : 0;
    } catch {
      nextAmount = 0;
    }
    const discount = sub.coupon && sub.coupon.periodsLeft > 0 ? Math.floor((nextAmount * sub.coupon.percentOff) / 100) : 0;
    const openInvoices = await ctx.db.find(invoices, { accountId, status: "open" });
    const pendingCheckout = sub.pending ? (await ctx.db.find(checkouts, { invoiceId: sub.pending.invoiceId })).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null : null;
    const members = (await ctx.tenancy.members()).filter((m) => m.type !== "agent").length;
    return {
      account: { accountId, name: account.name, billingEmail: account.billingEmail ?? null, paymentMethod: account.paymentMethod ?? null, hasCustomer: Boolean(account.providerCustomerRef) },
      subscription: {
        status: sub.status as SubscriptionState, planKey: sub.planKey, planName: subPlan.name, priceKey: sub.priceKey, interval: price.interval, model: price.model, unitAmount: price.unitAmount, currency: price.currency,
        seats: sub.seats, catalogVersion: sub.catalogVersion, currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd, trialEnd: sub.trialEnd ?? null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd, graceUntil: sub.graceUntil ?? null, scheduledChange: sub.scheduledChange ?? null, pending: sub.pending ?? null, coupon: sub.coupon ?? null,
      },
      effectivePlan: { key: plan.key, name: plan.name, onDefault: state.onDefault },
      entitlements: state.entitlements.map((e) => ({ key: e.key, name: e.name, type: e.type, unit: e.unit ?? "", value: e.value, planValue: e.planValue, sources: e.sources })),
      usage,
      upcoming: willRenew ? { at: sub.currentPeriodEnd, subscription: nextAmount - discount, overage, total: nextAmount - discount + overage, currency: price.currency, discount } : null,
      openInvoices: openInvoices.map((i) => ({ id: i.id, number: i.number, total: i.total, attempts: i.attempts, nextAttemptAt: i.nextAttemptAt ?? null, lastFailure: i.lastFailure ?? null })),
      pendingCheckout: pendingCheckout ? { id: pendingCheckout.id, state: pendingCheckout.state, url: pendingCheckout.url ?? null } : null,
      seats: { members, purchased: sub.seats },
      catalogCurrent: (await requirePublished(ctx)).version,
    };
  },
});

export const invoiceList = app.query({
  access: "billing.read",
  handler: async (ctx) => {
    const accountId = callerAccountId(ctx);
    const all = await ctx.db.find(invoices, { accountId }, { orderBy: [{ field: "createdAt", direction: "desc" }] });
    return all.filter((i) => i.status !== "draft").map((i) => ({ id: i.id, number: i.number, kind: i.kind, status: i.status, total: i.total, amountPaid: i.amountPaid, amountRefunded: i.amountRefunded, currency: i.currency, createdAt: i.createdAt, paidAt: i.paidAt ?? null, lines: i.lines, periodStart: i.periodStart, periodEnd: i.periodEnd, lastFailure: i.lastFailure ?? null }));
  },
});

export const checkout = app.query({
  access: "billing.read",
  args: { checkoutId: s.string() },
  handler: async (ctx, { checkoutId }) => {
    const c = await ctx.db.get(checkouts, checkoutId);
    if (!c || c.accountId !== callerAccountId(ctx)) return null;
    return { id: c.id, state: c.state, url: c.url ?? null, invoiceId: c.invoiceId || null, error: c.error ?? null };
  },
});

export const refundList = app.query({
  access: "billing.read",
  handler: async (ctx) => {
    const accountId = callerAccountId(ctx);
    return (await ctx.db.find(refunds, { accountId })).map((r) => ({ id: r.id, invoiceId: r.invoiceId, amount: r.amount, state: r.state, reason: r.reason, requestedAt: r.requestedAt }));
  },
});

/** The account's commercial history: every recorded decision about its subscription and invoices. */
export const history = app.query({
  access: "billing.read",
  handler: async (ctx) => {
    const accountId = callerAccountId(ctx);
    const events = [...(await audit.history(ctx, "subscription", accountId)), ...(await audit.history(ctx, "account", accountId)), ...(await audit.history(ctx, "entitlement", accountId))];
    return events.sort((a, b) => b.at - a.at).slice(0, 200).map((e) => ({ id: e.id, type: e.type, actor: e.actor, actorType: e.actorType, at: e.at, data: e.data ?? null }));
  },
});

