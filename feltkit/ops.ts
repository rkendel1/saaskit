/**
 * The business's operations console: revenue, customers, invoices, refunds, provider events,
 * reconciliation, anomalies, custom agreements and catalog migrations. Operators only.
 */
import { fail, s } from "@feltdb/feltkit";
import { accounts, agentSpend, app, audit, catalogVersions, checkouts, invoices, paymentAttempts, providerEvents, refunds, subscriptions, usageCounters, usageEvents } from "./app.js";
import { planOf, priceOf, type Catalog } from "./_catalog.js";
import { catalogAt, commercialState, latestPublished, principalOf } from "./_commerce.js";
import { periodAmount, type SubscriptionState } from "./_engine.js";

const paying: SubscriptionState[] = ["active", "past_due", "canceled"];

export const overview = app.query({
  access: "ops.read",
  handler: async (ctx) => {
    const subs = await ctx.db.find(subscriptions, {});
    const catalogs = new Map<number, Catalog>();
    const cat = async (v: number) => catalogs.get(v) ?? catalogs.set(v, await catalogAt(ctx, v)).get(v)!;
    let mrr = 0;
    const byPlan: Record<string, { accounts: number; mrr: number }> = {};
    const byStatus: Record<string, number> = {};
    for (const sub of subs) {
      byStatus[sub.status] = (byStatus[sub.status] ?? 0) + 1;
      const plan = planOf(await cat(sub.catalogVersion), sub.planKey);
      const price = plan && priceOf(plan, sub.priceKey);
      const monthly = price && paying.includes(sub.status as SubscriptionState) && !(sub.status === "canceled") ? periodAmount(price, sub.seats) / (price.interval === "year" ? 12 : 1) : 0;
      mrr += monthly;
      const row = (byPlan[sub.planKey] ??= { accounts: 0, mrr: 0 });
      row.accounts += 1;
      row.mrr += monthly;
    }
    const allInvoices = await ctx.db.find(invoices, {});
    const now = Date.now();
    const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
    const paid = allInvoices.filter((i) => i.status === "paid" && i.total > 0);
    const revenueByMonth = new Map<string, number>();
    for (const i of paid) {
      const k = new Date(i.paidAt ?? i.createdAt).toISOString().slice(0, 7);
      revenueByMonth.set(k, (revenueByMonth.get(k) ?? 0) + i.amountPaid - i.amountRefunded);
    }
    const overageRevenue = paid.flatMap((i) => i.lines).filter((l) => l.kind === "overage").reduce((a, l) => a + l.amount, 0);
    const events = await ctx.db.find(providerEvents, {});
    const counters = await ctx.db.find(usageCounters, {});
    const usageByMeter: Record<string, number> = {};
    for (const c of counters) usageByMeter[c.meter] = (usageByMeter[c.meter] ?? 0) + c.used;
    const agentTotal = (await ctx.db.find(agentSpend, {})).reduce((a, r) => a + r.spent, 0);
    const current = await latestPublished(ctx);
    return {
      mrr: Math.round(mrr), arr: Math.round(mrr * 12), accounts: subs.length, byPlan, byStatus,
      revenueThisMonth: paid.filter((i) => (i.paidAt ?? 0) >= monthStart).reduce((a, i) => a + i.amountPaid - i.amountRefunded, 0),
      revenueByMonth: [...revenueByMonth.entries()].sort().map(([month, amount]) => ({ month, amount })),
      overageRevenue, refunded: paid.reduce((a, i) => a + i.amountRefunded, 0),
      openInvoices: allInvoices.filter((i) => i.status === "open").length, openAmount: allInvoices.filter((i) => i.status === "open").reduce((a, i) => a + i.total, 0),
      providerEvents: { total: events.length, failed: events.filter((e) => e.outcome === "failed").length, unmatched: events.filter((e) => e.outcome === "unmatched").length },
      usageByMeter, agentSpend: agentTotal, catalogVersion: current?.version ?? null, currency: (current?.document as Catalog | undefined)?.currency ?? "usd",
    };
  },
});

export const accountList = app.query({
  access: "ops.read",
  handler: async (ctx) => {
    const list = await ctx.db.find(accounts, {}, { orderBy: [{ field: "createdAt", direction: "desc" }] });
    const subs = await ctx.db.find(subscriptions, {});
    const open = await ctx.db.find(invoices, { status: "open" });
    return list.map((a) => {
      const sub = subs.find((s) => s.accountId === a.accountId);
      return { accountId: a.accountId, name: a.name, ownerId: a.ownerId, createdAt: a.createdAt, status: a.status, plan: sub?.planKey ?? null, subscriptionStatus: sub?.status ?? null, catalogVersion: sub?.catalogVersion ?? null, seats: sub?.seats ?? 0, periodEnd: sub?.currentPeriodEnd ?? null, paymentMethod: a.paymentMethod ? `${a.paymentMethod.brand} ${a.paymentMethod.last4}` : null, openInvoices: open.filter((i) => i.accountId === a.accountId).length };
    });
  },
});

/** One customer, completely: why they have what they have, what they used, what they paid. */
export const accountDetail = app.query({
  access: "ops.read",
  args: { accountId: s.string() },
  handler: async (ctx, { accountId }) => {
    const [account] = await ctx.db.find(accounts, { accountId }, { limit: 1 });
    if (!account) fail("NOT_FOUND", "No such account.");
    const state = await commercialState(ctx, accountId);
    const counters = await ctx.db.find(usageCounters, { accountId, periodKey: state.periodKey });
    const history = [...(await audit.history(ctx, "subscription", accountId)), ...(await audit.history(ctx, "account", accountId)), ...(await audit.history(ctx, "entitlement", accountId))].sort((a, b) => b.at - a.at);
    return {
      account: { ...account, paymentMethod: account.paymentMethod ?? null },
      subscription: state.sub,
      effectivePlan: state.plan.key,
      entitlements: state.entitlements.map((e) => ({ key: e.key, name: e.name, type: e.type, value: e.value, planValue: e.planValue, sources: e.sources, used: e.meter ? counters.find((c) => c.meter === e.meter)?.used ?? 0 : null })),
      invoices: (await ctx.db.find(invoices, { accountId }, { orderBy: [{ field: "createdAt", direction: "desc" }] })),
      payments: await ctx.db.find(paymentAttempts, { accountId }),
      refunds: await ctx.db.find(refunds, { accountId }),
      events: await ctx.db.find(providerEvents, { accountId }, { orderBy: [{ field: "receivedAt", direction: "desc" }], limit: 50 }),
      usage: (await ctx.db.find(usageEvents, { accountId }, { orderBy: [{ field: "recordedAt", direction: "desc" }], limit: 50 })),
      history: history.slice(0, 200),
    };
  },
});

export const invoiceList = app.query({
  access: "ops.read",
  args: { status: s.optional(s.enum(["draft", "open", "paid", "void", "uncollectible"])) },
  handler: async (ctx, { status }) => {
    const rows = await ctx.db.find(invoices, status ? { status } : {}, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 500 });
    return rows.map((i) => ({ id: i.id, number: i.number, accountId: i.accountId, kind: i.kind, status: i.status, total: i.total, amountPaid: i.amountPaid, amountRefunded: i.amountRefunded, currency: i.currency, createdAt: i.createdAt, paidAt: i.paidAt ?? null, attempts: i.attempts, lastFailure: i.lastFailure ?? null, lines: i.lines }));
  },
});

/** Webhook monitoring: every verified provider event and what it did. */
export const events = app.query({
  access: "ops.read",
  args: { outcome: s.optional(s.enum(["applied", "ignored", "stale", "unmatched", "failed"])) },
  handler: async (ctx, { outcome }) => (await ctx.db.find(providerEvents, outcome ? { outcome } : {}, { orderBy: [{ field: "receivedAt", direction: "desc" }], limit: 300 })),
});

/** Refund part or all of a paid invoice. The provider confirms it with a verified event. */
export const refund = app.mutation({
  access: "ops.refund",
  args: { invoiceId: s.string(), amount: s.integer({ minimum: 1 }), reason: s.string({ minLength: 3, maxLength: 500 }) },
  returns: s.string(),
  handler: async (ctx, { invoiceId, amount, reason }) => {
    const invoice = await ctx.db.get(invoices, invoiceId);
    if (!invoice) fail("NOT_FOUND", "No such invoice.");
    if (invoice.status !== "paid" || !invoice.providerPaymentRef || invoice.providerPaymentRef === "none") fail("FAILED_PRECONDITION", "Only a paid invoice with a provider payment can be refunded.");
    const inFlight = (await ctx.db.find(refunds, { invoiceId })).filter((r) => r.state !== "failed").reduce((a, r) => a + r.amount, 0);
    if (amount + inFlight > invoice.amountPaid) fail("FAILED_PRECONDITION", `At most ${invoice.amountPaid - inFlight} can still be refunded.`);
    const id = await ctx.db.insert(refunds, { accountId: invoice.accountId, invoiceId, amount, reason, state: "requested", requestedBy: principalOf(ctx).id, requestedAt: Date.now() });
    await audit.record(ctx, { subject: "invoice", id: invoiceId, type: "invoice.refund_requested", data: { amount, reason, refundId: id } });
    ctx.afterCommit.work("payments", "refund.create", { refundId: id, paymentRef: invoice.providerPaymentRef, amount });
    return id;
  },
});

/** Ask the provider what really happened to an invoice's payments; apply anything the events missed. */
export const reconcile = app.mutation({
  access: "ops.reconcile",
  args: { invoiceId: s.string() },
  returns: s.integer(),
  handler: async (ctx, { invoiceId }) => {
    const attempts = (await ctx.db.find(paymentAttempts, { invoiceId })).filter((a) => a.providerRef);
    for (const a of attempts) ctx.afterCommit.work("payments", "payment.reconcile", { invoiceId, paymentRef: a.providerRef });
    await audit.record(ctx, { subject: "invoice", id: invoiceId, type: "invoice.reconcile_requested", data: { attempts: attempts.length } });
    return attempts.length;
  },
});

/** Things a person should look at. */
export const anomalies = app.query({
  access: "ops.read",
  handler: async (ctx) => {
    const now = Date.now();
    const out: Array<{ kind: string; severity: "high" | "medium" | "low"; detail: string; accountId?: string; ref?: string }> = [];
    for (const e of await ctx.db.find(providerEvents, { outcome: "failed" })) out.push({ kind: "provider_event_failed", severity: "high", detail: e.detail, accountId: e.accountId, ref: e.eventId });
    for (const e of await ctx.db.find(providerEvents, { outcome: "unmatched" })) out.push({ kind: "provider_event_unmatched", severity: "medium", detail: `${e.type}: ${e.detail}`, ref: e.eventId });
    for (const c of await ctx.db.find(checkouts, { state: "creating" })) if (now - c.createdAt > 5 * 60_000) out.push({ kind: "checkout_stuck", severity: "medium", detail: "Checkout not created by the provider after 5 minutes", accountId: c.accountId, ref: c.id });
    for (const i of await ctx.db.find(invoices, { status: "open" })) if (i.attempts >= 3) out.push({ kind: "dunning_exhausting", severity: "high", detail: `${i.number}: ${i.attempts} failed attempts (${i.lastFailure ?? ""})`, accountId: i.accountId, ref: i.id });
    for (const a of await ctx.db.find(paymentAttempts, { state: "requested" })) if (now - a.requestedAt > 30 * 60_000 && a.via === "off_session") out.push({ kind: "payment_unsettled", severity: "medium", detail: `Charge requested ${Math.round((now - a.requestedAt) / 60_000)} min ago with no provider outcome; reconcile`, accountId: a.accountId, ref: a.invoiceId });
    for (const sub of await ctx.db.find(subscriptions, { status: "suspended" })) out.push({ kind: "suspended", severity: "low", detail: `Suspended on ${sub.planKey}`, accountId: sub.accountId });
    return out;
  },
});

/** A custom (e.g. enterprise) agreement: assign any plan, including private ones, without checkout. */
export const assignPlan = app.mutation({
  access: "ops.subscriptions",
  args: { accountId: s.string(), planKey: s.string(), priceKey: s.string(), seats: s.integer({ minimum: 1 }), reason: s.string({ minLength: 3, maxLength: 500 }), periodEnd: s.number() },
  handler: async (ctx, a) => {
    const [sub] = await ctx.db.find(subscriptions, { accountId: a.accountId }, { limit: 1 });
    if (!sub) fail("NOT_FOUND", "No such account.");
    const published = await latestPublished(ctx) ?? fail("FAILED_PRECONDITION", "Nothing is published.");
    const plan = planOf(published.document as Catalog, a.planKey) ?? fail("NOT_FOUND", "No such plan.");
    if (!priceOf(plan, a.priceKey)) fail("NOT_FOUND", "No such price.");
    if (a.periodEnd <= Date.now()) fail("INVALID_ARGUMENT", "periodEnd must be in the future.");
    const now = Date.now();
    await ctx.db.patch(subscriptions, sub.id, { planKey: a.planKey, priceKey: a.priceKey, catalogVersion: published.version, seats: a.seats, status: "active", currentPeriodStart: now, currentPeriodEnd: a.periodEnd, pending: undefined, scheduledChange: undefined, cancelAtPeriodEnd: false, canceledAt: undefined, graceUntil: undefined, trialEnd: undefined, updatedAt: now });
    await audit.record(ctx, { subject: "subscription", id: a.accountId, type: "subscription.assigned", data: { plan: a.planKey, price: a.priceKey, seats: a.seats, reason: a.reason, periodEnd: a.periodEnd, transition: `${sub.status}→active` } });
    ctx.afterCommit.webhooks.emit("entitlements.changed", { accountId: a.accountId });
  },
});

/** Move every subscription on an older catalog version to the newest one at its next renewal. */
export const scheduleMigration = app.mutation({
  access: "ops.subscriptions",
  args: { fromVersion: s.integer() },
  returns: s.object({ scheduled: s.integer(), skipped: s.array(s.string()) }),
  handler: async (ctx, { fromVersion }) => {
    const newest = await latestPublished(ctx) ?? fail("FAILED_PRECONDITION", "Nothing is published.");
    if (newest.version <= fromVersion) fail("FAILED_PRECONDITION", "There is no newer version to migrate to.");
    const doc = newest.document as Catalog;
    let scheduled = 0;
    const skipped: string[] = [];
    for (const sub of await ctx.db.find(subscriptions, { catalogVersion: fromVersion })) {
      const plan = planOf(doc, sub.planKey);
      if (!plan || !priceOf(plan, sub.priceKey) || plan.status !== "active") { skipped.push(`${sub.accountId}: ${sub.planKey}/${sub.priceKey} not in v${newest.version}`); continue; }
      if (sub.scheduledChange || sub.pending) { skipped.push(`${sub.accountId}: has a pending change`); continue; }
      await ctx.db.patch(subscriptions, sub.id, { scheduledChange: { kind: "migration", planKey: sub.planKey, priceKey: sub.priceKey, catalogVersion: newest.version, seats: sub.seats, effectiveAt: sub.currentPeriodEnd, requestedBy: principalOf(ctx).id }, updatedAt: Date.now() });
      await audit.record(ctx, { subject: "subscription", id: sub.accountId, type: "subscription.migration_scheduled", data: { from: fromVersion, to: newest.version, at: sub.currentPeriodEnd } });
      scheduled += 1;
    }
    return { scheduled, skipped };
  },
});

/** The audit trail for any subject. */
export const auditTrail = app.query({
  access: "ops.read",
  args: { subject: s.enum(["account", "catalog", "subscription", "invoice", "usage", "agent", "entitlement"]), id: s.string() },
  handler: async (ctx, { subject, id }) => audit.history(ctx, subject, id),
});

export const recentAudit = app.query({
  access: "ops.read",
  args: { limit: s.optional(s.integer({ minimum: 1, maximum: 500 })) },
  handler: async (ctx, { limit }) => ctx.db.find(audit, {}, { orderBy: [{ field: "at", direction: "desc" }], limit: limit ?? 100 }),
});

export const catalogAdoption = app.query({
  access: "ops.read",
  handler: async (ctx) => {
    const subs = await ctx.db.find(subscriptions, {});
    const versions = await ctx.db.find(catalogVersions, {}, { orderBy: [{ field: "version", direction: "desc" }] });
    return versions.filter((v) => v.state !== "draft").map((v) => ({ version: v.version, label: v.label, accounts: subs.filter((s) => s.catalogVersion === v.version).length }));
  },
});
