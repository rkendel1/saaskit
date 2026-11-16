/**
 * The commercial decision engine. Pure functions over plain data: no ctx, no clock, no I/O.
 * Everything that decides money or access is here so it can be tested exhaustively and
 * reviewed in one place. Callers pass `now` explicitly.
 */
import { allowanceFor, defaultPlan, featureOf, planOf, type Catalog, type EntitlementValue, type Overage, type Plan, type Price } from "./_catalog.js";

// ─── Subscription lifecycle ──────────────────────────────────────────────────────────────────

export const SUBSCRIPTION_STATES = ["incomplete", "trialing", "active", "past_due", "suspended", "canceled", "expired"] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

/**
 * Every allowed transition. Anything else is a bug or an attack and is refused.
 *   incomplete  a paid subscription waiting for its first verified payment
 *   trialing    access to the plan without payment until trialEnd
 *   active      paid and current
 *   past_due    a renewal payment failed; access continues until graceUntil
 *   suspended   grace ran out; access falls back to the default plan; payment reactivates
 *   canceled    will not renew; access per the plan's cancellation policy until it ends
 *   expired     terminal for this subscription; the account is back on the default plan
 */
export const TRANSITIONS: Record<SubscriptionState, readonly SubscriptionState[]> = {
  incomplete: ["active", "trialing", "expired"],
  trialing: ["active", "past_due", "canceled", "expired"],
  active: ["active", "past_due", "canceled", "expired"],
  past_due: ["active", "suspended", "canceled", "expired"],
  suspended: ["active", "canceled", "expired"],
  canceled: ["active", "expired"],
  expired: [],
};
export function canTransition(from: SubscriptionState, to: SubscriptionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Whether a subscription in this state grants its own plan (otherwise: the default plan). */
export function grantsPlan(status: SubscriptionState): boolean {
  return status === "trialing" || status === "active" || status === "past_due" || status === "canceled";
}

// ─── Time ────────────────────────────────────────────────────────────────────────────────────

/** Calendar arithmetic in UTC; the 31st plus a month is the last day of the next month. */
export function addInterval(ts: number, interval: "month" | "year", count = 1): number {
  const d = new Date(ts);
  const months = interval === "month" ? count : 12 * count;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
}
export const DAY = 86_400_000;

/** The usage period key: counters reset when a subscription's period changes. */
export function periodKey(periodStart: number): string {
  return `p:${new Date(periodStart).toISOString()}`;
}

// ─── Rating ──────────────────────────────────────────────────────────────────────────────────

export function billedSeats(price: Price, seats: number): number {
  return price.model === "per_seat" ? Math.max(seats, price.minSeats ?? 1) : 1;
}
/** What one period of this price costs, in minor units. */
export function periodAmount(price: Price, seats: number): number {
  return price.unitAmount * billedSeats(price, seats);
}

/**
 * A mid-period change from one price to another: credit the unused part of what was paid,
 * charge the remaining part of the new price. Time-proportional, rounded to the minor unit
 * (credit rounds down, charge rounds up: the customer is never credited more than they paid).
 */
export function prorate(oldAmount: number, newAmount: number, periodStart: number, periodEnd: number, now: number) {
  const total = periodEnd - periodStart;
  const remaining = Math.min(Math.max(periodEnd - now, 0), total);
  const fraction = total > 0 ? remaining / total : 0;
  const credit = Math.floor(oldAmount * fraction);
  const charge = Math.ceil(newAmount * fraction);
  return { fraction, credit, charge, net: charge - credit };
}

/** Units past the allowance and what they cost under the plan's overage rule. */
export function overageCharge(allowance: number | null, used: number, rule: Overage | undefined) {
  if (allowance === null || !rule) return { units: 0, amount: 0 };
  const units = Math.max(used - allowance, 0);
  if (rule.policy !== "charge" || units === 0) return { units, amount: 0 };
  const per = rule.perUnits ?? 1;
  return { units, amount: Math.ceil(units / per) * (rule.unitAmount ?? 0) };
}

/** Overage not yet billed: units past the allowance minus units already invoiced this period. */
export function unbilledOverage(allowance: number | null, used: number, billedUnits: number, rule: Overage | undefined) {
  if (allowance === null || !rule) return { units: 0, amount: 0 };
  const units = Math.max(used - allowance - billedUnits, 0);
  if (rule.policy !== "charge" || units === 0) return { units, amount: 0 };
  return { units, amount: Math.ceil(units / (rule.perUnits ?? 1)) * (rule.unitAmount ?? 0) };
}

export function applyDiscount(amount: number, percentOff: number | undefined): { discount: number; total: number } {
  if (!percentOff || amount <= 0) return { discount: 0, total: amount };
  const discount = Math.floor((amount * percentOff) / 100);
  return { discount, total: amount - discount };
}

// ─── Entitlements ────────────────────────────────────────────────────────────────────────────

export interface GrantInput {
  feature: string;
  kind: "override" | "grant" | "addon";
  value: EntitlementValue;
  expiresAt?: number;
  revokedAt?: number;
  periodKey?: string;
  scope?: { type: "user" | "agent"; id: string };
}
export interface SubscriptionInput {
  planKey: string;
  status: SubscriptionState;
  periodKey: string;
}
export interface EffectiveEntitlement {
  key: string;
  name: string;
  type: "boolean" | "limit" | "allowance" | "rate";
  unit?: string;
  meter?: string;
  value: EntitlementValue;
  /** Plan value before grants, for "why" explanations. */
  planValue: EntitlementValue;
  sources: string[];
  overage?: Overage;
}

/**
 * The account's effective rights: the plan its subscription grants now (or the default plan),
 * then operator overrides (replace), then grants and add-ons (add to numeric values).
 * Grants scoped to a user or agent apply only when evaluating for that principal.
 */
export function effectiveEntitlements(catalog: Catalog, sub: SubscriptionInput | null, grants: GrantInput[], now: number, principal?: { type: string; id: string }): { plan: Plan; onDefault: boolean; entitlements: EffectiveEntitlement[] } {
  const subscribed = sub && grantsPlan(sub.status) ? planOf(catalog, sub.planKey) : undefined;
  const plan = subscribed ?? defaultPlan(catalog);
  const live = grants.filter((g) => !g.revokedAt && (g.expiresAt === undefined || g.expiresAt > now) && (g.kind !== "addon" || !sub || g.periodKey === sub.periodKey) && (!g.scope || (principal && g.scope.type === principal.type && g.scope.id === principal.id)));
  const entitlements = catalog.features.map((f): EffectiveEntitlement => {
    const planValue: EntitlementValue = f.key in plan.entitlements ? plan.entitlements[f.key]! : f.type === "boolean" ? false : 0;
    let value: EntitlementValue = planValue;
    const sources = [`plan:${plan.key}`];
    for (const g of live.filter((x) => x.feature === f.key && x.kind === "override")) {
      value = g.value;
      sources.push(g.scope ? `override:${g.scope.type}:${g.scope.id}` : "override");
    }
    for (const g of live.filter((x) => x.feature === f.key && x.kind !== "override")) {
      if (f.type === "boolean") {
        if (g.value === true) value = true;
      } else if (value !== null && typeof g.value === "number") {
        value = (value as number) + g.value;
      } else if (g.value === null) value = null;
      sources.push(g.kind);
    }
    return { key: f.key, name: f.name, type: f.type, unit: f.unit, meter: f.meter, value, planValue, sources, overage: f.meter ? plan.overage.find((o) => o.meter === f.meter) : undefined };
  });
  return { plan, onDefault: !subscribed, entitlements };
}

export type DecisionCode = "included" | "overage" | "not_entitled" | "limit_reached" | "allowance_exhausted" | "rate_limited" | "unknown_feature";
export interface Decision {
  feature: string;
  allowed: boolean;
  code: DecisionCode;
  reason: string;
  limit: EntitlementValue;
  used?: number;
  reserved?: number;
  remaining?: number | null;
  /** Units of this request beyond the allowance, and what they will cost. */
  overageUnits?: number;
  estimatedCost?: number;
}

/**
 * Decide one request against one effective entitlement.
 *   boolean    allowed iff true
 *   limit      `current` + quantity must stay ≤ value (null: unlimited)
 *   allowance  used + reserved + quantity vs value; past it the overage rule decides
 *   rate       `current` requests in this minute + quantity ≤ value
 */
export function decide(e: EffectiveEntitlement | undefined, quantity: number, current: { used?: number; reserved?: number; count?: number }): Decision {
  if (!e) return { feature: "?", allowed: false, code: "unknown_feature", reason: "No such feature in the catalog.", limit: null };
  const base = { feature: e.key, limit: e.value };
  if (e.type === "boolean") {
    return e.value === true ? { ...base, allowed: true, code: "included", reason: `${e.name} is included.` } : { ...base, allowed: false, code: "not_entitled", reason: `${e.name} is not included in your plan.` };
  }
  if (e.type === "limit" || e.type === "rate") {
    const count = current.count ?? 0;
    if (e.value === null) return { ...base, allowed: true, code: "included", reason: "Unlimited.", used: count, remaining: null };
    const limit = e.value as number;
    if (count + quantity <= limit) return { ...base, allowed: true, code: "included", reason: `${count + quantity} of ${limit}.`, used: count, remaining: limit - count - quantity };
    return { ...base, allowed: false, code: e.type === "rate" ? "rate_limited" : "limit_reached", reason: e.type === "rate" ? `Rate limit of ${limit} ${e.unit ?? "per minute"} reached.` : `Your plan allows ${limit} ${e.unit ?? ""}`.trim() + ".", used: count, remaining: Math.max(limit - count, 0) };
  }
  // allowance
  const used = current.used ?? 0;
  const reserved = current.reserved ?? 0;
  if (e.value === null) return { ...base, allowed: true, code: "included", reason: "Unlimited.", used, reserved, remaining: null, overageUnits: 0, estimatedCost: 0 };
  const allowance = e.value as number;
  const after = used + reserved + quantity;
  if (after <= allowance) return { ...base, allowed: true, code: "included", reason: `Included: ${after} of ${allowance} ${e.unit ?? ""}`.trim() + ".", used, reserved, remaining: allowance - after, overageUnits: 0, estimatedCost: 0 };
  const rule = e.overage;
  const overBefore = Math.max(used + reserved - allowance, 0);
  const overageUnits = after - allowance - overBefore;
  if (!rule || rule.policy === "block" || allowance === 0 && !rule) {
    return { ...base, allowed: false, code: "allowance_exhausted", reason: `Your ${e.name.toLowerCase()} allowance (${allowance}) is used up for this period.`, used, reserved, remaining: Math.max(allowance - used - reserved, 0), overageUnits };
  }
  if (rule.hardCap !== undefined && after - allowance > rule.hardCap) {
    return { ...base, allowed: false, code: "allowance_exhausted", reason: `The overage cap (${rule.hardCap} past ${allowance}) is reached.`, used, reserved, remaining: 0, overageUnits };
  }
  const before = overageCharge(allowance, used + reserved, rule).amount;
  const afterCost = overageCharge(allowance, after, rule).amount;
  return { ...base, allowed: true, code: "overage", reason: rule.policy === "charge" ? `Beyond your allowance of ${allowance}: billed as overage.` : `Beyond your allowance of ${allowance}; not billed.`, used, reserved, remaining: 0, overageUnits, estimatedCost: afterCost - before };
}

/** Usage thresholds that notify the account, as fractions of the allowance. */
export const THRESHOLDS = [0.8, 1] as const;
export function crossedThresholds(allowance: EntitlementValue, before: number, after: number, already: number[]): number[] {
  if (typeof allowance !== "number" || allowance <= 0) return [];
  return THRESHOLDS.filter((t) => !already.includes(t) && before < allowance * t && after >= allowance * t);
}

export { allowanceFor, featureOf };
