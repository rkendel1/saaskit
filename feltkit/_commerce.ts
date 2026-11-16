/**
 * Commercial state access shared by every module: which account a call acts for, the catalog a
 * subscription was sold under, the account's effective entitlements, invoices and notifications.
 *
 * The account of a customer call is ALWAYS the session's workspace (`app.requireTenant`), never an
 * argument. Only operator functions and the payments gateway name accounts explicitly.
 */
import { fail } from "@feltdb/feltkit";
import type { MutationCtx, QueryCtx } from "@feltdb/feltkit";
import { accounts, app, audit, catalogVersions, grants, INVOICE_SEQUENCE, invoices, subscriptions, usageCounters } from "./app.js";
import { defaultPlan, planOf, priceOf, type Catalog, type Plan, type Price } from "./_catalog.js";
import { addInterval, applyDiscount, effectiveEntitlements, periodAmount, periodKey, unbilledOverage, type GrantInput, type SubscriptionState } from "./_engine.js";

type Ctx = QueryCtx | MutationCtx;
export type SubscriptionDoc = NonNullable<Awaited<ReturnType<typeof getSubscription>>>;
export type AccountDoc = NonNullable<Awaited<ReturnType<typeof getAccount>>>;

/** The workspace the caller works in: the only account a customer function may touch. */
export function callerAccountId(ctx: Ctx): string {
  return app.requireTenant(ctx).id;
}

export function principalOf(ctx: Ctx) {
  const p = ctx.auth.requirePrincipal();
  return { id: p.id, type: p.type as string };
}

// ─── Catalog ─────────────────────────────────────────────────────────────────────────────────

export async function latestPublished(ctx: Ctx) {
  const now = Date.now();
  const published = await ctx.db.find(catalogVersions, { state: "published" }, { orderBy: [{ field: "version", direction: "desc" }] });
  return published.find((v) => (v.effectiveAt ?? v.publishedAt ?? 0) <= now) ?? null;
}
export async function requirePublished(ctx: Ctx) {
  const v = await latestPublished(ctx);
  if (!v) fail("FAILED_PRECONDITION", "No commercial catalog is published yet. An operator must publish one (Catalog → Publish).");
  return v;
}
/** A published (or archived) version's document. Never a draft. */
export async function catalogAt(ctx: Ctx, version: number): Promise<Catalog> {
  const [v] = await ctx.db.find(catalogVersions, { version }, { limit: 1 });
  if (!v || v.state === "draft") fail("NOT_FOUND", `Catalog version ${version} is not published.`);
  return v.document as Catalog;
}

// ─── Accounts ────────────────────────────────────────────────────────────────────────────────

export async function getAccount(ctx: Ctx, accountId: string) {
  const [a] = await ctx.db.find(accounts, { accountId }, { limit: 1 });
  return a ?? null;
}
export async function getSubscription(ctx: Ctx, accountId: string) {
  const [sub] = await ctx.db.find(subscriptions, { accountId }, { limit: 1 });
  return sub ?? null;
}
export async function requireSubscription(ctx: Ctx, accountId: string) {
  const sub = await getSubscription(ctx, accountId);
  if (!sub) fail("FAILED_PRECONDITION", "This workspace has no billing account yet.", { hint: "ACCOUNT_NOT_PROVISIONED" });
  return sub;
}

/**
 * Create the account and its default-plan subscription the first time a workspace is seen.
 * Idempotent: a concurrent first call conflicts on the unique accountId and is retried.
 */
export async function ensureAccount(ctx: MutationCtx, accountId: string, name: string, ownerId: string) {
  const existing = await getAccount(ctx, accountId);
  if (existing) return { account: existing, subscription: (await getSubscription(ctx, accountId))!, created: false };
  const published = await requirePublished(ctx);
  const catalog = published.document as Catalog;
  const plan = defaultPlan(catalog);
  const price = plan.prices[0]!;
  const now = Date.now();
  const id = await ctx.db.insert(accounts, { accountId, name, ownerId, status: "active", createdAt: now });
  const subId = await ctx.db.insert(subscriptions, {
    accountId, planKey: plan.key, priceKey: price.key, catalogVersion: published.version, status: "active", seats: 1,
    currentPeriodStart: now, currentPeriodEnd: addInterval(now, price.interval), cancelAtPeriodEnd: false, createdAt: now, updatedAt: now,
  });
  await audit.record(ctx, { subject: "account", id: accountId, type: "account.created", data: { name, ownerId, plan: plan.key, catalogVersion: published.version } });
  return { account: (await ctx.db.get(accounts, id))!, subscription: (await ctx.db.get(subscriptions, subId))!, created: true };
}

// ─── Entitlement state ───────────────────────────────────────────────────────────────────────

export async function liveGrants(ctx: Ctx, accountId: string): Promise<GrantInput[]> {
  const rows = await ctx.db.find(grants, { accountId });
  return rows.map((g) => ({ feature: g.feature, kind: g.kind, value: g.value as boolean | number | null, expiresAt: g.expiresAt, revokedAt: g.revokedAt, periodKey: g.periodKey, scope: g.scope }));
}

/** Everything needed to decide for an account: its subscription, the catalog it was sold under, and its effective rights. */
export async function commercialState(ctx: Ctx, accountId: string, principal?: { type: string; id: string }) {
  const sub = await requireSubscription(ctx, accountId);
  const catalog = await catalogAt(ctx, sub.catalogVersion);
  const pk = periodKey(sub.currentPeriodStart);
  const g = await liveGrants(ctx, accountId);
  const evaluated = effectiveEntitlements(catalog, { planKey: sub.planKey, status: sub.status as SubscriptionState, periodKey: pk }, g, Date.now(), principal);
  return { sub, catalog, periodKey: pk, ...evaluated };
}

export function planPrice(catalog: Catalog, planKey: string, priceKey: string): { plan: Plan; price: Price } {
  const plan = planOf(catalog, planKey);
  if (!plan) fail("NOT_FOUND", `No plan "${planKey}" in this catalog version.`);
  const price = priceOf(plan, priceKey);
  if (!price) fail("NOT_FOUND", `Plan "${planKey}" has no price "${priceKey}".`);
  return { plan, price };
}

// ─── Invoices ────────────────────────────────────────────────────────────────────────────────

export type Line = { kind: "subscription" | "proration_credit" | "proration_charge" | "overage" | "addon" | "discount"; description: string; quantity: number; unitAmount: number; amount: number; meter?: string; periodStart?: number; periodEnd?: number };

/** Create an open invoice. Totals are computed here, from lines, server-side: never from a client. */
export async function createInvoice(ctx: MutationCtx, input: { accountId: string; kind: "initial" | "renewal" | "upgrade" | "addon" | "final"; currency: string; lines: Line[]; percentOff?: number; catalogVersion: number; periodStart: number; periodEnd: number; purpose: { type: "subscription" | "addon"; addonKey?: string; requestedBy: string } }) {
  const subtotal = input.lines.reduce((sum, l) => sum + l.amount, 0);
  const discountable = input.lines.filter((l) => l.kind === "subscription" || l.kind === "proration_charge").reduce((sum, l) => sum + l.amount, 0);
  const { discount } = applyDiscount(discountable, input.percentOff);
  const lines = discount ? [...input.lines, { kind: "discount" as const, description: `Discount ${input.percentOff}%`, quantity: 1, unitAmount: -discount, amount: -discount }] : input.lines;
  const total = Math.max(subtotal - discount, 0);
  const seq = await ctx.db.sequence(INVOICE_SEQUENCE);
  const now = Date.now();
  const id = await ctx.db.insert(invoices, {
    accountId: input.accountId, number: `INV-${String(seq).padStart(6, "0")}`, kind: input.kind, status: total === 0 ? "paid" : "open", currency: input.currency, lines,
    subtotal, discount, total, amountPaid: 0, amountRefunded: 0, catalogVersion: input.catalogVersion, periodStart: input.periodStart, periodEnd: input.periodEnd,
    createdAt: now, ...(total === 0 ? { paidAt: now } : {}), attempts: 0, purpose: input.purpose,
  });
  await audit.record(ctx, { subject: "invoice", id, type: "invoice.created", data: { accountId: input.accountId, kind: input.kind, total, currency: input.currency } });
  return (await ctx.db.get(invoices, id))!;
}

export function subscriptionLine(plan: Plan, price: Price, seats: number, start: number, end: number): Line {
  const qty = price.model === "per_seat" ? Math.max(seats, price.minSeats ?? 1) : 1;
  return { kind: "subscription", description: `${plan.name} (${price.interval}ly${price.model === "per_seat" ? `, ${qty} seats` : ""})`, quantity: qty, unitAmount: price.unitAmount, amount: periodAmount(price, seats), periodStart: start, periodEnd: end };
}

// ─── Notifications ───────────────────────────────────────────────────────────────────────────

/** Tell an account's owner (and anyone else named) about a commercial event, only if the change commits. */
export function notify(ctx: MutationCtx, account: { ownerId: string; accountId: string }, type: string, title: string, data: Record<string, unknown>, key: string, also: string[] = []) {
  for (const recipient of new Set([account.ownerId, ...also])) {
    ctx.afterCommit.notifications.send({ recipient, type, title, data: { accountId: account.accountId, ...data }, idempotencyKey: `${type}:${key}:${recipient}` });
  }
}

// ─── Mid-period overage settlement ─────────────────────────────────────────────────────────────

/**
 * Overage accrued so far this period that no invoice has covered yet, priced under the terms the
 * account is on NOW. An upgrade bills these before the new plan's larger allowance applies, so
 * usage incurred under the old terms is never silently forgiven or re-priced.
 */
export async function accruedOverageLines(ctx: Ctx, accountId: string): Promise<Line[]> {
  const state = await commercialState(ctx, accountId);
  const counters = await ctx.db.find(usageCounters, { accountId, periodKey: state.periodKey });
  const lines: Line[] = [];
  for (const e of state.entitlements) {
    if (e.type !== "allowance" || !e.overage) continue;
    const c = counters.find((x) => x.meter === e.meter);
    if (!c || c.invoicedAt) continue;
    const u = unbilledOverage(e.value as number | null, c.used, c.billedUnits ?? 0, e.overage);
    if (u.amount > 0) lines.push({ kind: "overage", description: `${e.name}: ${u.units} beyond ${e.value} (${state.plan.name} terms, to date)`, quantity: u.units, unitAmount: e.overage.unitAmount ?? 0, amount: u.amount, meter: e.meter, periodStart: state.sub.currentPeriodStart, periodEnd: Date.now() });
  }
  return lines;
}

/** Record that an invoice billed these overage units (or closed the period), so they are never billed again. */
export async function markOverageBilled(ctx: MutationCtx, accountId: string, pk: string, lines: Line[], invoiceId: string, closePeriod: boolean) {
  for (const l of lines) {
    if (l.kind !== "overage" || !l.meter) continue;
    const [c] = await ctx.db.find(usageCounters, { accountId, meter: l.meter, periodKey: pk }, { limit: 1 });
    if (!c) continue;
    await ctx.db.patch(usageCounters, c.id, closePeriod ? { invoicedAt: Date.now(), invoiceId } : { billedUnits: (c.billedUnits ?? 0) + l.quantity, updatedAt: Date.now() });
  }
  if (closePeriod) for (const c of await ctx.db.find(usageCounters, { accountId, periodKey: pk })) if (!c.invoicedAt) await ctx.db.patch(usageCounters, c.id, { invoicedAt: Date.now(), invoiceId });
}

/** A voided invoice gives its overage back to be billed later. */
export async function releaseOverageBilled(ctx: MutationCtx, invoice: { id: string; accountId: string; lines: Line[] }) {
  for (const c of await ctx.db.find(usageCounters, { accountId: invoice.accountId })) {
    if (c.invoiceId === invoice.id) await ctx.db.patch(usageCounters, c.id, { invoicedAt: undefined, invoiceId: undefined, updatedAt: Date.now() });
  }
  const sub = await getSubscription(ctx, invoice.accountId);
  if (!sub) return;
  for (const l of invoice.lines) {
    if (l.kind !== "overage" || !l.meter) continue;
    const [c] = await ctx.db.find(usageCounters, { accountId: invoice.accountId, meter: l.meter, periodKey: periodKey(sub.currentPeriodStart) }, { limit: 1 });
    if (c && (c.billedUnits ?? 0) > 0 && !c.invoiceId) await ctx.db.patch(usageCounters, c.id, { billedUnits: Math.max((c.billedUnits ?? 0) - l.quantity, 0), updatedAt: Date.now() });
  }
}
