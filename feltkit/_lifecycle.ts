/**
 * Subscription lifecycle transitions that time drives. `advanceAccount` is idempotent: it looks at
 * the account's state as of `now`, performs every transition that is due, records each with its
 * reason, and does nothing when nothing is due. One account per transaction, so one account's
 * conflict never holds up another's renewal.
 */
import { fail, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { audit, invoices, reservations, subscriptions, usageCounters } from "./app.js";
import { defaultPlan, planOf, priceOf, type Catalog, type Plan } from "./_catalog.js";
import { catalogAt, createInvoice, getAccount, latestPublished, liveGrants, notify, planPrice, subscriptionLine, type Line } from "./_commerce.js";
import { addInterval, canTransition, DAY, overageCharge, periodKey, type SubscriptionState } from "./_engine.js";
import { openCheckout, requestCharge } from "./_payments.js";

export const NOTICE_DAYS = 3;

/** End a subscription and put the account back on the default plan of the current catalog. */
export async function expireToDefault(ctx: MutationCtx, accountId: string, reason: string, now = Date.now()) {
  const [sub] = await ctx.db.find(subscriptions, { accountId }, { limit: 1 });
  if (!sub) return;
  if (!canTransition(sub.status as SubscriptionState, "expired")) fail("FAILED_PRECONDITION", `Cannot expire a ${sub.status} subscription.`);
  const published = await latestPublished(ctx);
  const catalog = (published?.document ?? (await catalogAt(ctx, sub.catalogVersion))) as Catalog;
  const plan = defaultPlan(catalog);
  const price = plan.prices[0]!;
  await audit.record(ctx, { subject: "subscription", id: accountId, type: "subscription.expired", data: { plan: sub.planKey, reason, transition: `${sub.status}→expired` } });
  await ctx.db.patch(subscriptions, sub.id, {
    planKey: plan.key, priceKey: price.key, catalogVersion: published?.version ?? sub.catalogVersion, status: "active", seats: 1, currentPeriodStart: now, currentPeriodEnd: addInterval(now, price.interval),
    cancelAtPeriodEnd: false, canceledAt: undefined, cancelReason: undefined, graceUntil: undefined, scheduledChange: undefined, pending: undefined, trialEnd: undefined, coupon: undefined, renewalNotifiedFor: undefined, updatedAt: now,
  });
  await audit.record(ctx, { subject: "subscription", id: accountId, type: "subscription.reset_to_default", data: { plan: plan.key } });
  const account = await getAccount(ctx, accountId);
  if (account) notify(ctx, account, "subscription.expired", `Your workspace is now on ${plan.name}`, { plan: plan.key, reason }, `expired:${sub.currentPeriodEnd}:${now}`);
  ctx.afterCommit.webhooks.emit("subscription.updated", { accountId, status: "active", plan: plan.key });
  ctx.afterCommit.webhooks.emit("entitlements.changed", { accountId });
}

/** Overage lines for a period that has ended, from the authoritative counters; marks them invoiced. */
async function overageLines(ctx: MutationCtx, accountId: string, catalog: Catalog, plan: Plan, pk: string, start: number, end: number) {
  const counters = await ctx.db.find(usageCounters, { accountId, periodKey: pk });
  const grantRows = (await liveGrants(ctx, accountId)).filter((g) => g.kind === "addon" && g.periodKey === pk);
  const lines: Line[] = [];
  const toMark: string[] = [];
  for (const c of counters) {
    if (c.invoicedAt) continue;
    const feature = catalog.features.find((f) => f.type === "allowance" && f.meter === c.meter);
    if (!feature) continue;
    let allowance = plan.entitlements[feature.key] ?? 0;
    if (typeof allowance === "number") allowance += grantRows.filter((g) => g.feature === feature.key).reduce((a, g) => a + (typeof g.value === "number" ? g.value : 0), 0);
    const rule = plan.overage.find((o) => o.meter === c.meter);
    const charge = overageCharge(allowance as number | null, c.used, rule);
    toMark.push(c.id);
    if (charge.amount > 0) lines.push({ kind: "overage", description: `${feature.name}: ${charge.units} beyond ${allowance}`, quantity: charge.units, unitAmount: rule?.unitAmount ?? 0, amount: charge.amount, meter: c.meter, periodStart: start, periodEnd: end });
  }
  return { lines, toMark };
}

async function markInvoiced(ctx: MutationCtx, ids: string[], invoiceId: string, now: number) {
  for (const id of ids) await ctx.db.patch(usageCounters, id, { invoicedAt: now, invoiceId });
}

/** Renew: bill the ended period's overage plus the next period, and move the period forward. */
async function renew(ctx: MutationCtx, accountId: string, now: number) {
  const [sub] = await ctx.db.find(subscriptions, { accountId }, { limit: 1 });
  const account = (await getAccount(ctx, accountId))!;
  const oldCatalog = await catalogAt(ctx, sub!.catalogVersion);
  const oldPlan = planOf(oldCatalog, sub!.planKey)!;
  const oldStart = sub!.currentPeriodStart;
  const oldEnd = sub!.currentPeriodEnd;
  const over = await overageLines(ctx, accountId, oldCatalog, oldPlan, periodKey(oldStart), oldStart, oldEnd);

  // What the next period is: a scheduled change, a migration to the newest catalog, or the same.
  let planKey = sub!.planKey, priceKey = sub!.priceKey, version = sub!.catalogVersion, seats = sub!.seats;
  let reason = "renewal";
  if (sub!.scheduledChange && sub!.scheduledChange.effectiveAt <= now) {
    ({ planKey, priceKey, catalogVersion: version, seats } = sub!.scheduledChange);
    reason = `scheduled ${sub!.scheduledChange.kind}`;
  } else {
    const newest = await latestPublished(ctx);
    if (newest && newest.version > version && newest.migration === "migrate_at_renewal") {
      const np = planOf(newest.document as Catalog, planKey);
      if (np && np.status === "active" && priceOf(np, priceKey)) {
        version = newest.version;
        reason = `migrated from catalog v${sub!.catalogVersion} to v${version}`;
      }
    }
  }
  const catalog = await catalogAt(ctx, version);
  const { plan, price } = planPrice(catalog, planKey, priceKey);
  const start = oldEnd;
  const end = addInterval(start, price.interval);
  const lines: Line[] = [...over.lines];
  if (!plan.isDefault) lines.unshift(subscriptionLine(plan, price, seats, start, end));
  const coupon = sub!.coupon && sub!.coupon.periodsLeft > 0 ? sub!.coupon : undefined;
  await ctx.db.patch(subscriptions, sub!.id, {
    planKey, priceKey, catalogVersion: version, seats, currentPeriodStart: start, currentPeriodEnd: end, scheduledChange: undefined, updatedAt: now,
    ...(coupon ? { coupon: { ...coupon, periodsLeft: coupon.periodsLeft - 1 } } : {}),
  });
  await audit.record(ctx, { subject: "subscription", id: accountId, type: "subscription.renewed", data: { reason, from: sub!.planKey, plan: planKey, catalogVersion: version, periodStart: start, periodEnd: end } });
  if (planKey !== sub!.planKey) notify(ctx, account, "plan.downgraded", `You are now on ${plan.name}`, { plan: planKey, from: sub!.planKey }, `renew-change:${start}`);
  if (!lines.length) {
    await markInvoiced(ctx, over.toMark, "", now);
    return `renewed (${reason}); nothing to bill`;
  }
  const invoice = await createInvoice(ctx, { accountId, kind: "renewal", currency: catalog.currency, lines, percentOff: coupon?.percentOff, catalogVersion: version, periodStart: start, periodEnd: end, purpose: { type: "subscription", requestedBy: "lifecycle" } });
  await markInvoiced(ctx, over.toMark, invoice.id, now);
  if (invoice.status === "paid") return `renewed (${reason}); invoice ${invoice.number} needs no payment`;
  const charged = await requestCharge(ctx, invoice, account);
  if (!charged) {
    // No card on file: the renewal cannot be collected. Grace starts now.
    const graceUntil = now + oldPlan.graceDays * DAY;
    await ctx.db.patch(subscriptions, sub!.id, { status: "past_due", graceUntil });
    await audit.record(ctx, { subject: "subscription", id: accountId, type: "subscription.past_due", data: { invoiceId: invoice.id, reason: "no payment method", graceUntil, transition: `${sub!.status}→past_due` } });
    notify(ctx, account, "payment.failed", `Add a payment method to keep ${plan.name}`, { invoiceId: invoice.id, graceUntil }, `nocard:${invoice.id}`);
  }
  return `renewed (${reason}); invoice ${invoice.number} ${charged ? "charging" : "awaiting a payment method"}`;
}

/** Perform every transition due for one account as of `now`. Returns what was done. */
export async function advanceAccount(ctx: MutationCtx, accountId: string, now: number): Promise<string[]> {
  const done: string[] = [];
  // Reservations that were never settled give their capacity back.
  for (const r of await ctx.db.find(reservations, { accountId, state: "held" })) {
    if (r.expiresAt > now) continue;
    await ctx.db.patch(reservations, r.id, { state: "expired", settledAt: now });
    const [c] = await ctx.db.find(usageCounters, { accountId, meter: r.meter, periodKey: r.periodKey }, { limit: 1 });
    if (c) await ctx.db.patch(usageCounters, c.id, { reserved: Math.max(c.reserved - r.quantity, 0), updatedAt: now });
    done.push(`reservation ${r.id} expired`);
  }
  for (let step = 0; step < 6; step++) {
    const [sub] = await ctx.db.find(subscriptions, { accountId }, { limit: 1 });
    if (!sub || sub.pending) break;
    const account = (await getAccount(ctx, accountId))!;
    const catalog = await catalogAt(ctx, sub.catalogVersion);
    const plan = planOf(catalog, sub.planKey)!;
    const status = sub.status as SubscriptionState;

    if (status === "trialing" && sub.trialEnd !== undefined) {
      if (sub.trialEnd <= now) {
        if (account.paymentMethod) {
          await ctx.db.patch(subscriptions, sub.id, { status: "active", trialEnd: undefined, updatedAt: now });
          await audit.record(ctx, { subject: "subscription", id: accountId, type: "subscription.trial_converted", data: { transition: "trialing→active" } });
          done.push(await renew(ctx, accountId, now));
        } else {
          await expireToDefault(ctx, accountId, "trial ended without a payment method", now);
          done.push("trial ended → default plan");
        }
        continue;
      }
      if (sub.trialEnd - NOTICE_DAYS * DAY <= now && sub.renewalNotifiedFor !== sub.trialEnd) {
        await ctx.db.patch(subscriptions, sub.id, { renewalNotifiedFor: sub.trialEnd });
        notify(ctx, account, "trial.ending", `Your ${plan.name} trial ends soon`, { trialEnd: sub.trialEnd, hasPaymentMethod: Boolean(account.paymentMethod) }, `trial-ending:${sub.trialEnd}`);
        done.push("trial ending notice");
        continue;
      }
      break;
    }
    if (status === "canceled" && sub.cancelAtPeriodEnd && sub.currentPeriodEnd <= now) {
      // Final bill for usage overage in the last period, then back to the default plan.
      const over = await overageLines(ctx, accountId, catalog, plan, periodKey(sub.currentPeriodStart), sub.currentPeriodStart, sub.currentPeriodEnd);
      if (over.lines.length) {
        const invoice = await createInvoice(ctx, { accountId, kind: "final", currency: catalog.currency, lines: over.lines, catalogVersion: sub.catalogVersion, periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd, purpose: { type: "subscription", requestedBy: "lifecycle" } });
        await markInvoiced(ctx, over.toMark, invoice.id, now);
        await requestCharge(ctx, invoice, account);
      } else await markInvoiced(ctx, over.toMark, "", now);
      await expireToDefault(ctx, accountId, "canceled at period end", now);
      done.push("cancellation completed");
      continue;
    }
    if (status === "past_due" && sub.graceUntil !== undefined && sub.graceUntil <= now) {
      await ctx.db.patch(subscriptions, sub.id, { status: "suspended", updatedAt: now });
      await audit.record(ctx, { subject: "subscription", id: accountId, type: "subscription.suspended", data: { graceUntil: sub.graceUntil, transition: "past_due→suspended" } });
      notify(ctx, account, "subscription.suspended", `${plan.name} features are paused until payment`, { plan: plan.key }, `suspended:${sub.graceUntil}`);
      ctx.afterCommit.webhooks.emit("entitlements.changed", { accountId });
      done.push("grace ended → suspended");
      continue;
    }
    if ((status === "active" || status === "past_due") && sub.currentPeriodEnd <= now) {
      if (plan.isDefault) {
        // Free plans roll their period (allowances reset) without billing.
        const price = priceOf(plan, sub.priceKey) ?? plan.prices[0]!;
        await ctx.db.patch(subscriptions, sub.id, { currentPeriodStart: sub.currentPeriodEnd, currentPeriodEnd: addInterval(sub.currentPeriodEnd, price.interval), updatedAt: now });
        done.push("free period rolled");
      } else done.push(await renew(ctx, accountId, now));
      continue;
    }
    if (status === "active" && !plan.isDefault && sub.currentPeriodEnd - NOTICE_DAYS * DAY <= now && sub.renewalNotifiedFor !== sub.currentPeriodEnd) {
      await ctx.db.patch(subscriptions, sub.id, { renewalNotifiedFor: sub.currentPeriodEnd });
      const price = priceOf(plan, sub.priceKey)!;
      notify(ctx, account, "renewal.upcoming", `${plan.name} renews soon`, { at: sub.currentPeriodEnd, amount: price.unitAmount, scheduledChange: sub.scheduledChange?.planKey ?? null }, `renewal:${sub.currentPeriodEnd}`);
      done.push("renewal notice");
      continue;
    }
    break;
  }
  // Dunning: retry due renewal invoices with the card on file.
  const account = await getAccount(ctx, accountId);
  if (account) {
    for (const inv of await ctx.db.find(invoices, { accountId, status: "open" })) {
      if (inv.nextAttemptAt !== undefined && inv.nextAttemptAt <= now && (await requestCharge(ctx, inv, account))) done.push(`retrying ${inv.number}`);
    }
  }
  return done;
}

/** The accounts with something due as of `now`. A bounded scan of subscriptions and open work. */
export async function dueAccounts(ctx: QueryCtx, now: number): Promise<string[]> {
  const due = new Set<string>();
  for (const sub of await ctx.db.find(subscriptions, {})) {
    if (sub.pending) continue;
    const soon = now + NOTICE_DAYS * DAY;
    if (sub.currentPeriodEnd <= soon || (sub.trialEnd !== undefined && sub.trialEnd <= soon) || (sub.graceUntil !== undefined && sub.graceUntil <= now)) {
      if (sub.currentPeriodEnd <= now || (sub.trialEnd ?? Infinity) <= now || (sub.graceUntil ?? Infinity) <= now || (sub.renewalNotifiedFor !== sub.currentPeriodEnd && sub.renewalNotifiedFor !== sub.trialEnd)) due.add(sub.accountId);
    }
  }
  for (const inv of await ctx.db.find(invoices, { status: "open" })) if (inv.nextAttemptAt !== undefined && inv.nextAttemptAt <= now) due.add(inv.accountId);
  for (const r of await ctx.db.find(reservations, { state: "held" })) if (r.expiresAt <= now) due.add(r.accountId);
  return [...due];
}

/** Buy an add-on for the current period: an invoice, paid by the card on file or a checkout. */
export async function purchaseAddonFor(ctx: MutationCtx, accountId: string, addonKey: string, requestedBy: string, returnUrl: string) {
  const [sub] = await ctx.db.find(subscriptions, { accountId }, { limit: 1 });
  if (!sub) fail("FAILED_PRECONDITION", "Open billing first.");
  const catalog = await catalogAt(ctx, sub.catalogVersion);
  const plan = planOf(catalog, sub.planKey)!;
  const addon = catalog.addons.find((a) => a.key === addonKey);
  if (!addon) fail("NOT_FOUND", `No add-on "${addonKey}" for your plan's catalog version.`);
  if (addon.plans.length ? !addon.plans.includes(plan.key) : plan.isDefault) fail("FAILED_PRECONDITION", `${addon.name} is not available on ${plan.name}.`);
  if (sub.status !== "active" && sub.status !== "trialing") fail("FAILED_PRECONDITION", `Add-ons need an active subscription (this one is ${sub.status}).`);
  const account = (await getAccount(ctx, accountId))!;
  const invoice = await createInvoice(ctx, {
    accountId, kind: "addon", currency: addon.currency, catalogVersion: sub.catalogVersion, periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd,
    lines: [{ kind: "addon", description: addon.name, quantity: 1, unitAmount: addon.unitAmount, amount: addon.unitAmount }], purpose: { type: "addon", addonKey, requestedBy },
  });
  await audit.record(ctx, { subject: "entitlement", id: accountId, type: "addon.purchase_started", data: { addon: addonKey, invoiceId: invoice.id, requestedBy } });
  if (await requestCharge(ctx, invoice, account)) return { invoiceId: invoice.id, charged: true };
  const checkoutId = await openCheckout(ctx, account, { invoice, mode: "payment", description: `${addon.name} — ${invoice.number}`, returnUrl, createdBy: requestedBy });
  return { invoiceId: invoice.id, charged: false, checkoutId };
}

