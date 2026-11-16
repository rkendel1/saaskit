/**
 * The commercial catalog: what is sold, at what price, granting what.
 *
 * A catalog is ONE versioned document. Drafts are edited; publishing freezes a copy as a new
 * immutable version. Subscriptions pin the version they were sold under, so editing the catalog
 * never rewrites what an existing customer bought (grandfathering is the default; migration is an
 * explicit, recorded act). Application code never reads a plan name: it asks for a feature.
 *
 * Pure module (no ctx): validation and lookups only. Money is integer minor units (cents).
 */
import { s } from "@feltdb/feltkit";

export const FEATURE_TYPES = ["boolean", "limit", "allowance", "rate"] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];
export const SCOPES = ["account", "user", "agent", "resource"] as const;
export const OVERAGE_POLICIES = ["block", "charge", "allow"] as const;
export const INTERVALS = ["month", "year"] as const;
export const PRICE_MODELS = ["flat", "per_seat"] as const;

/** null = unlimited for numeric features. */
const entitlementValue = s.union([s.boolean(), s.number({ minimum: 0 }), s.null()]);

export const featureSchema = s.object({
  key: s.string({ minLength: 1, maxLength: 80 }),
  name: s.string({ minLength: 1, maxLength: 120 }),
  description: s.optional(s.string({ maxLength: 400 })),
  /**
   * boolean   access to a feature or capability
   * limit     a ceiling on a resource that exists (projects, members, storage), checked against a live count
   * allowance a quantity consumed per billing period, metered (`meter`)
   * rate      requests per minute
   */
  type: s.enum(FEATURE_TYPES),
  /** allowance: the meter it draws from. */
  meter: s.optional(s.string()),
  unit: s.optional(s.string({ maxLength: 40 })),
  /** Who the value applies to. account = shared by the whole account. */
  scope: s.enum(SCOPES),
});

export const meterSchema = s.object({
  key: s.string({ minLength: 1, maxLength: 80 }),
  name: s.string({ minLength: 1, maxLength: 120 }),
  unit: s.string({ minLength: 1, maxLength: 40 }),
  description: s.optional(s.string({ maxLength: 400 })),
});

export const priceSchema = s.object({
  key: s.string({ minLength: 1, maxLength: 80 }),
  interval: s.enum(INTERVALS),
  currency: s.string({ minLength: 3, maxLength: 3 }),
  /** flat: per subscription per interval; per_seat: per seat per interval. */
  model: s.enum(PRICE_MODELS),
  unitAmount: s.integer({ minimum: 0 }),
  /** per_seat: the fewest seats billed. */
  minSeats: s.optional(s.integer({ minimum: 1 })),
});

export const overageSchema = s.object({
  meter: s.string(),
  /** block: refuse past the allowance. charge: allow and bill. allow: allow, never bill. */
  policy: s.enum(OVERAGE_POLICIES),
  /** charge: price per `perUnits` units beyond the allowance, in minor units. */
  unitAmount: s.optional(s.integer({ minimum: 0 })),
  perUnits: s.optional(s.integer({ minimum: 1 })),
  /** charge/allow: never exceed this many units past the allowance (a safety cap). */
  hardCap: s.optional(s.integer({ minimum: 0 })),
});

export const planSchema = s.object({
  key: s.string({ minLength: 1, maxLength: 80 }),
  productKey: s.string(),
  name: s.string({ minLength: 1, maxLength: 120 }),
  description: s.optional(s.string({ maxLength: 600 })),
  /** public: offered to customers. private: assigned by an operator (custom/enterprise). */
  visibility: s.enum(["public", "private"]),
  status: s.enum(["active", "retired"]),
  /** The plan every new account starts on, and where access falls back to. Exactly one. */
  isDefault: s.optional(s.boolean()),
  rank: s.integer({ minimum: 0 }),
  trialDays: s.optional(s.integer({ minimum: 0, maximum: 365 })),
  prices: s.array(priceSchema),
  entitlements: s.record(entitlementValue),
  overage: s.array(overageSchema),
  /** What happens to access when a customer cancels. */
  cancellation: s.enum(["end_of_period", "immediate"]),
  /** Days a past-due subscription keeps access before suspension. */
  graceDays: s.integer({ minimum: 0, maximum: 60 }),
  /** Downgrades take effect now or at period end. */
  downgrade: s.enum(["end_of_period", "immediate"]),
});

export const productSchema = s.object({
  key: s.string({ minLength: 1, maxLength: 80 }),
  name: s.string({ minLength: 1, maxLength: 120 }),
  description: s.optional(s.string({ maxLength: 600 })),
  visibility: s.enum(["public", "private"]),
  status: s.enum(["active", "retired"]),
});

export const addonSchema = s.object({
  key: s.string({ minLength: 1, maxLength: 80 }),
  name: s.string({ minLength: 1, maxLength: 120 }),
  description: s.optional(s.string({ maxLength: 400 })),
  currency: s.string({ minLength: 3, maxLength: 3 }),
  unitAmount: s.integer({ minimum: 0 }),
  /** feature → extra quantity for the current billing period. */
  grants: s.record(s.number({ minimum: 0 })),
  /** Only offered to subscribers of these plans (empty: all paid plans). */
  plans: s.array(s.string()),
});

export const couponSchema = s.object({
  code: s.string({ minLength: 2, maxLength: 40 }),
  percentOff: s.integer({ minimum: 1, maximum: 100 }),
  /** Billing periods the discount applies to. */
  periods: s.integer({ minimum: 1, maximum: 36 }),
  plans: s.array(s.string()),
  active: s.boolean(),
});

export const catalogSchema = s.object({
  currency: s.string({ minLength: 3, maxLength: 3 }),
  features: s.array(featureSchema),
  meters: s.array(meterSchema),
  products: s.array(productSchema),
  plans: s.array(planSchema),
  addons: s.array(addonSchema),
  coupons: s.array(couponSchema),
});

export type Catalog = {
  currency: string;
  features: Array<{ key: string; name: string; description?: string; type: FeatureType; meter?: string; unit?: string; scope: (typeof SCOPES)[number] }>;
  meters: Array<{ key: string; name: string; unit: string; description?: string }>;
  products: Array<{ key: string; name: string; description?: string; visibility: "public" | "private"; status: "active" | "retired" }>;
  plans: Plan[];
  addons: Addon[];
  coupons: Array<{ code: string; percentOff: number; periods: number; plans: string[]; active: boolean }>;
};
export type EntitlementValue = boolean | number | null;
export type Price = { key: string; interval: "month" | "year"; currency: string; model: "flat" | "per_seat"; unitAmount: number; minSeats?: number };
export type Overage = { meter: string; policy: "block" | "charge" | "allow"; unitAmount?: number; perUnits?: number; hardCap?: number };
export type Plan = {
  key: string;
  productKey: string;
  name: string;
  description?: string;
  visibility: "public" | "private";
  status: "active" | "retired";
  isDefault?: boolean;
  rank: number;
  trialDays?: number;
  prices: Price[];
  entitlements: Record<string, EntitlementValue>;
  overage: Overage[];
  cancellation: "end_of_period" | "immediate";
  graceDays: number;
  downgrade: "end_of_period" | "immediate";
};
export type Addon = { key: string; name: string; description?: string; currency: string; unitAmount: number; grants: Record<string, number>; plans: string[] };

/** Every reason a catalog cannot be published. Empty: publishable. */
export function catalogProblems(c: Catalog): string[] {
  const problems: string[] = [];
  const dup = (what: string, keys: string[]) => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) problems.push(`Duplicate ${what} "${k}".`);
      seen.add(k);
    }
  };
  dup("feature", c.features.map((f) => f.key));
  dup("meter", c.meters.map((m) => m.key));
  dup("product", c.products.map((p) => p.key));
  dup("plan", c.plans.map((p) => p.key));
  dup("add-on", c.addons.map((a) => a.key));
  dup("coupon", c.coupons.map((k) => k.code));
  const features = new Map(c.features.map((f) => [f.key, f]));
  const meters = new Set(c.meters.map((m) => m.key));
  const products = new Set(c.products.map((p) => p.key));
  for (const f of c.features) {
    if (f.type === "allowance" && (!f.meter || !meters.has(f.meter))) problems.push(`Allowance feature "${f.key}" must name a declared meter.`);
    if (f.type !== "allowance" && f.meter) problems.push(`Only allowance features draw from a meter ("${f.key}").`);
  }
  const defaults = c.plans.filter((p) => p.isDefault);
  if (defaults.length !== 1) problems.push(`Exactly one plan must be the default (found ${defaults.length}).`);
  for (const d of defaults) {
    if (d.prices.some((p) => p.unitAmount > 0)) problems.push(`The default plan "${d.key}" must be free.`);
    if (d.status !== "active") problems.push(`The default plan "${d.key}" must be active.`);
  }
  for (const p of c.plans) {
    if (!products.has(p.productKey)) problems.push(`Plan "${p.key}" names unknown product "${p.productKey}".`);
    if (!p.prices.length) problems.push(`Plan "${p.key}" needs at least one price.`);
    dup(`price in plan ${p.key}`, p.prices.map((x) => x.key));
    for (const price of p.prices) {
      if (price.currency !== c.currency) problems.push(`Plan "${p.key}" price "${price.key}" is in ${price.currency}; the catalog bills in ${c.currency}.`);
    }
    for (const [key, value] of Object.entries(p.entitlements)) {
      const f = features.get(key);
      if (!f) problems.push(`Plan "${p.key}" grants unknown feature "${key}".`);
      else if (f.type === "boolean" && typeof value !== "boolean") problems.push(`Plan "${p.key}": "${key}" is a boolean feature.`);
      else if (f.type !== "boolean" && typeof value === "boolean") problems.push(`Plan "${p.key}": "${key}" needs a number (or null for unlimited).`);
    }
    for (const o of p.overage) {
      if (!meters.has(o.meter)) problems.push(`Plan "${p.key}" overage names unknown meter "${o.meter}".`);
      if (o.policy === "charge" && (o.unitAmount === undefined || !o.perUnits)) problems.push(`Plan "${p.key}" charges overage on "${o.meter}" without unitAmount and perUnits.`);
    }
  }
  for (const a of c.addons) {
    for (const key of Object.keys(a.grants)) {
      const f = features.get(key);
      if (!f) problems.push(`Add-on "${a.key}" grants unknown feature "${key}".`);
      else if (f.type === "boolean") problems.push(`Add-on "${a.key}" may only add quantity, not "${key}".`);
    }
    for (const p of a.plans) if (!c.plans.some((x) => x.key === p)) problems.push(`Add-on "${a.key}" names unknown plan "${p}".`);
  }
  return problems;
}

export function planOf(c: Catalog, key: string): Plan | undefined {
  return c.plans.find((p) => p.key === key);
}
export function defaultPlan(c: Catalog): Plan {
  const p = c.plans.find((x) => x.isDefault);
  if (!p) throw new Error("Catalog has no default plan.");
  return p;
}
export function priceOf(plan: Plan, key: string): Price | undefined {
  return plan.prices.find((p) => p.key === key);
}
export function featureOf(c: Catalog, key: string) {
  return c.features.find((f) => f.key === key);
}
/** The allowance feature that draws from a meter. */
export function allowanceFor(c: Catalog, meter: string) {
  return c.features.find((f) => f.type === "allowance" && f.meter === meter);
}

/** A stable digest of a catalog document, so identical content is recognisable across versions. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The commercial model a new installation starts with: Free, Pro and Business. */
export function seedCatalog(): Catalog {
  return {
    currency: "usd",
    features: [
      { key: "analytics.advanced", name: "Advanced analytics", type: "boolean", scope: "account" },
      { key: "projects.max", name: "Projects", type: "limit", unit: "projects", scope: "account" },
      { key: "exports.monthly", name: "Exports per month", type: "allowance", meter: "exports", unit: "exports", scope: "account" },
      { key: "api.requests.monthly", name: "API requests per month", type: "allowance", meter: "api.requests", unit: "requests", scope: "account" },
      { key: "api.requests.per_minute", name: "API requests per minute", type: "rate", unit: "requests/min", scope: "account" },
      { key: "storage.max_gb", name: "Storage", type: "limit", unit: "GB", scope: "account" },
      { key: "agents.enabled", name: "Agents", type: "boolean", scope: "account" },
      { key: "agents.executions.monthly", name: "Agent executions per month", type: "allowance", meter: "agent.executions", unit: "executions", scope: "account" },
      { key: "team.members.max", name: "Team members", type: "limit", unit: "members", scope: "account" },
      { key: "support.priority", name: "Priority support", type: "boolean", scope: "account" },
    ],
    meters: [
      { key: "exports", name: "Exports", unit: "exports" },
      { key: "api.requests", name: "API requests", unit: "requests" },
      { key: "agent.executions", name: "Agent executions", unit: "executions" },
    ],
    products: [{ key: "workspace", name: "Workspace", description: "The collaborative analytics workspace.", visibility: "public", status: "active" }],
    plans: [
      {
        key: "free", productKey: "workspace", name: "Free", description: "For trying things out.", visibility: "public", status: "active", isDefault: true, rank: 0,
        prices: [{ key: "free-monthly", interval: "month", currency: "usd", model: "flat", unitAmount: 0 }],
        entitlements: { "analytics.advanced": false, "projects.max": 3, "exports.monthly": 10, "api.requests.monthly": 1000, "api.requests.per_minute": 10, "storage.max_gb": 1, "agents.enabled": false, "agents.executions.monthly": 0, "team.members.max": 2, "support.priority": false },
        overage: [{ meter: "exports", policy: "block" }, { meter: "api.requests", policy: "block" }, { meter: "agent.executions", policy: "block" }],
        cancellation: "immediate", graceDays: 0, downgrade: "immediate",
      },
      {
        key: "pro", productKey: "workspace", name: "Pro", description: "For growing teams that ship every day.", visibility: "public", status: "active", rank: 1, trialDays: 14,
        prices: [
          { key: "pro-monthly", interval: "month", currency: "usd", model: "flat", unitAmount: 2900 },
          { key: "pro-annual", interval: "year", currency: "usd", model: "flat", unitAmount: 29000 },
        ],
        entitlements: { "analytics.advanced": true, "projects.max": 25, "exports.monthly": 500, "api.requests.monthly": 100000, "api.requests.per_minute": 100, "storage.max_gb": 50, "agents.enabled": true, "agents.executions.monthly": 1000, "team.members.max": 10, "support.priority": false },
        overage: [
          { meter: "exports", policy: "charge", unitAmount: 5, perUnits: 1, hardCap: 5000 },
          { meter: "api.requests", policy: "charge", unitAmount: 100, perUnits: 1000 },
          { meter: "agent.executions", policy: "charge", unitAmount: 10, perUnits: 1, hardCap: 10000 },
        ],
        cancellation: "end_of_period", graceDays: 7, downgrade: "end_of_period",
      },
      {
        key: "business", productKey: "workspace", name: "Business", description: "Per-seat pricing, higher limits, priority support.", visibility: "public", status: "active", rank: 2, trialDays: 14,
        prices: [
          { key: "business-monthly", interval: "month", currency: "usd", model: "per_seat", unitAmount: 2000, minSeats: 3 },
          { key: "business-annual", interval: "year", currency: "usd", model: "per_seat", unitAmount: 20000, minSeats: 3 },
        ],
        entitlements: { "analytics.advanced": true, "projects.max": null, "exports.monthly": 5000, "api.requests.monthly": 1000000, "api.requests.per_minute": 1000, "storage.max_gb": 500, "agents.enabled": true, "agents.executions.monthly": 10000, "team.members.max": 100, "support.priority": true },
        overage: [
          { meter: "exports", policy: "charge", unitAmount: 2, perUnits: 1 },
          { meter: "api.requests", policy: "charge", unitAmount: 50, perUnits: 1000 },
          { meter: "agent.executions", policy: "charge", unitAmount: 5, perUnits: 1 },
        ],
        cancellation: "end_of_period", graceDays: 14, downgrade: "end_of_period",
      },
    ],
    addons: [
      { key: "exports-1000", name: "1,000 extra exports", description: "Added to this billing period.", currency: "usd", unitAmount: 1000, grants: { "exports.monthly": 1000 }, plans: [] },
      { key: "agent-500", name: "500 agent executions", description: "Added to this billing period.", currency: "usd", unitAmount: 1500, grants: { "agents.executions.monthly": 500 }, plans: [] },
    ],
    coupons: [{ code: "LAUNCH20", percentOff: 20, periods: 3, plans: ["pro", "business"], active: true }],
  };
}

/** What changed between two catalog documents, in commercial terms. */
export function catalogDiff(a: Catalog, b: Catalog) {
  const changes: Array<{ kind: string; key: string; detail: string }> = [];
  const byKey = <T extends { key: string }>(xs: T[]) => new Map(xs.map((x) => [x.key, x]));
  const pa = byKey(a.plans), pb = byKey(b.plans);
  for (const [k, p] of pb) {
    const old = pa.get(k);
    if (!old) { changes.push({ kind: "plan.added", key: k, detail: p.name }); continue; }
    for (const price of p.prices) {
      const op = old.prices.find((x) => x.key === price.key);
      if (!op) changes.push({ kind: "price.added", key: `${k}/${price.key}`, detail: `${price.unitAmount} ${price.currency}/${price.interval}` });
      else if (op.unitAmount !== price.unitAmount || op.model !== price.model) changes.push({ kind: "price.changed", key: `${k}/${price.key}`, detail: `${op.unitAmount} → ${price.unitAmount}` });
    }
    for (const op of old.prices) if (!p.prices.some((x) => x.key === op.key)) changes.push({ kind: "price.removed", key: `${k}/${op.key}`, detail: "" });
    const keys = new Set([...Object.keys(old.entitlements), ...Object.keys(p.entitlements)]);
    for (const f of keys) {
      if (canonical(old.entitlements[f]) !== canonical(p.entitlements[f])) changes.push({ kind: "entitlement.changed", key: `${k}/${f}`, detail: `${JSON.stringify(old.entitlements[f] ?? null)} → ${JSON.stringify(p.entitlements[f] ?? null)}` });
    }
    if (canonical(old.overage) !== canonical(p.overage)) changes.push({ kind: "overage.changed", key: k, detail: "overage rules changed" });
    if (old.status !== p.status || old.visibility !== p.visibility) changes.push({ kind: "plan.availability", key: k, detail: `${old.visibility}/${old.status} → ${p.visibility}/${p.status}` });
  }
  for (const k of pa.keys()) if (!pb.has(k)) changes.push({ kind: "plan.removed", key: k, detail: "" });
  const fa = byKey(a.features), fb = byKey(b.features);
  for (const k of fb.keys()) if (!fa.has(k)) changes.push({ kind: "feature.added", key: k, detail: fb.get(k)!.name });
  for (const k of fa.keys()) if (!fb.has(k)) changes.push({ kind: "feature.removed", key: k, detail: "" });
  return changes;
}

