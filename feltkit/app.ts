/**
 * SaaS Business Engine — the application definition.
 *
 * Two kinds of state live in this one FeltDB instance:
 *   - the monetized application's own data (projects): tenant-scoped by FeltKit, one workspace each;
 *   - commercial state (catalog, subscriptions, usage, invoices, provider events): keyed by an explicit
 *     `accountId` (= the workspace id), because the commercial engine must act across accounts
 *     (provider webhooks, renewals, operators). Customer-facing functions never take an accountId:
 *     they derive it from the session's workspace (`_access.ts`), so a customer cannot name another's.
 *
 * Who may do what is declared once, here. Commercial entitlement (what an account bought) is a
 * separate question, answered by the engine (`_engine.ts`), and both must allow.
 */
import { feltkit, s } from "@feltdb/feltkit";
import { catalogSchema } from "./_catalog.js";

const CUSTOMER_COMMON = ["catalog.read", "usage.reserve", "billing.read", "usage.read", "entitlements.read", "notifications.read", "notifications.update", "notifications.send", "webhooks.emit", "webhooks.deliver", "files.read", "files.write"];

export const app = feltkit({
  name: "saaskit",
  description: "SaaS Business Engine: configure how you sell an application; the platform enforces it.",
  roles: {
    // Every signed-in account, before and outside any workspace.
    person: ["catalog.read"],
    // ── Workspace (customer account) roles, highest first in auth.tenant.roles ──
    owner: [...CUSTOMER_COMMON, "billing.manage", "agents.manage", "tenant.*", "projects.*", "exports.run", "analytics.read", "agentruns.start", "api.call"],
    billing_admin: [...CUSTOMER_COMMON, "billing.manage", "agents.manage", "tenant.members.manage", "projects.read", "analytics.read"],
    member: [...CUSTOMER_COMMON, "projects.*", "exports.run", "analytics.read", "agentruns.start", "api.call"],
    // Agents act in a workspace only through these. Spending authority is separate (agent policies).
    agent: ["catalog.read", "entitlements.read", "usage.read", "projects.read", "exports.run", "analytics.read", "agentruns.execute", "capacity.request", "usage.reserve", "agents.self", "notifications.send", "webhooks.emit", "webhooks.deliver", "feltkit.agent.*"],
    // ── The business that sells the application ──
    operator: ["catalog.*", "ops.*", "lifecycle.run", "notifications.*", "webhooks.*", "configuration.*", "apikeys.*", "credential.*", "intelligence.*", "jobs.*", "schedules.*", "files.*", "feltkit.operations.*", "feltkit.agent.*"],
    // ── Runtime principals ──
    // The payments component: verified provider events and provider work results; the lifecycle clock.
    payments_gateway: ["payments.ingest", "payments.settle", "lifecycle.run", "notifications.send", "webhooks.emit", "webhooks.deliver"],
    // A server-side integration reporting usage with an API key.
    // Its after-commit effects (threshold notices, webhooks) run as it, so it needs those permissions too.
    usage_reporter: ["usage.ingest", "notifications.send", "webhooks.emit", "webhooks.deliver"],
  },
  auth: {
    accounts: { roles: ["person"] },
    tenant: {
      name: "workspace",
      roles: ["owner", "billing_admin", "member", "agent"],
      create: "anyone",
    },
  },
  dev: {
    users: [
      { id: "ada", name: "Ada (operator)", roles: ["person", "operator"] },
      { id: "grace", name: "Grace (customer)", roles: ["person"] },
      { id: "linus", name: "Linus (customer)", roles: ["person"] },
    ],
  },
  services: {
    files: true,
    notifications: {
      types: [
        "subscription.created", "subscription.activated", "payment.succeeded", "payment.failed", "renewal.upcoming", "trial.ending",
        "usage.threshold", "usage.exhausted", "usage.overage", "plan.upgraded", "plan.downgraded", "subscription.canceled",
        "subscription.expired", "refund.issued", "agent.spend", "agent.approval_requested", "agent.limit_reached", "subscription.suspended",
      ],
    },
    configuration: true,
    apiKeys: { roles: ["usage_reporter"] },
    webhooks: { events: ["subscription.updated", "invoice.paid", "invoice.payment_failed", "usage.threshold", "entitlements.changed"] },
    jobs: true,
  },
  authority: {
    local: true,
    application: "saaskit",
    capabilities: ["billing.agentspend"],
    checkCredential: "credential-ref:authboundry-check",
    executor: { principal: "agent:saaskit", type: "agent", credential: "credential-ref:authboundry-executor" },
  },
  components: {
    payments: {
      entry: "components/payments.ts",
      routes: ["/stripe/"],
      required: true,
      principal: { id: "component:payments", roles: ["payments_gateway"], displayName: "Payments gateway" },
      credentials: ["stripe-secret-key", "stripe-webhook-secret"],
      network: "egress",
      description: "Stripe: verifies provider-signed webhooks, performs provider work, drives the lifecycle clock.",
    },
  },
});

// ─── Catalog ─────────────────────────────────────────────────────────────────────────────────

/** Every version of the commercial catalog. Published versions are never edited. */
export const catalogVersions = app.collection(
  "catalog_versions",
  {
    version: s.integer({ minimum: 1 }),
    state: s.enum(["draft", "published", "archived"]),
    label: s.string({ maxLength: 120 }),
    notes: s.optional(s.string({ maxLength: 2000 })),
    document: catalogSchema,
    digest: s.string(),
    basedOn: s.optional(s.integer()),
    createdAt: s.number(),
    createdBy: s.string(),
    publishedAt: s.optional(s.number()),
    publishedBy: s.optional(s.string()),
    /** New accounts and checkouts use the newest published version whose effectiveAt has passed. */
    effectiveAt: s.optional(s.number()),
    /** Accounts on older versions move at their next renewal (migrate) or stay (grandfather). */
    migration: s.optional(s.enum(["grandfather", "migrate_at_renewal"])),
  },
  { unique: [["version"]], indexes: [{ fields: ["state"] }] },
);

// ─── Accounts and subscriptions ──────────────────────────────────────────────────────────────

export const accounts = app.collection(
  "accounts",
  {
    accountId: s.string(),
    name: s.string({ maxLength: 200 }),
    ownerId: s.string(),
    billingEmail: s.optional(s.string({ maxLength: 320 })),
    status: s.enum(["active", "closed"]),
    providerCustomerRef: s.optional(s.string()),
    paymentMethod: s.optional(s.object({ ref: s.string(), brand: s.string(), last4: s.string(), expMonth: s.integer(), expYear: s.integer() })),
    createdAt: s.number(),
    closedAt: s.optional(s.number()),
  },
  { unique: [["accountId"]] },
);

const scheduledChange = s.object({
  kind: s.enum(["downgrade", "migration", "interval"]),
  planKey: s.string(),
  priceKey: s.string(),
  catalogVersion: s.integer(),
  seats: s.integer({ minimum: 1 }),
  effectiveAt: s.number(),
  requestedBy: s.string(),
});

/** One subscription record per account; its history is in the audit trail and lifecycle events. */
export const subscriptions = app.collection(
  "subscriptions",
  {
    accountId: s.string(),
    planKey: s.string(),
    priceKey: s.string(),
    catalogVersion: s.integer(),
    status: s.enum(["incomplete", "trialing", "active", "past_due", "suspended", "canceled", "expired"]),
    seats: s.integer({ minimum: 1 }),
    currentPeriodStart: s.number(),
    currentPeriodEnd: s.number(),
    trialEnd: s.optional(s.number()),
    cancelAtPeriodEnd: s.boolean(),
    canceledAt: s.optional(s.number()),
    cancelReason: s.optional(s.string({ maxLength: 500 })),
    graceUntil: s.optional(s.number()),
    scheduledChange: s.optional(scheduledChange),
    /** Pending upgrade or first purchase awaiting a verified payment. */
    pending: s.optional(s.object({ planKey: s.string(), priceKey: s.string(), catalogVersion: s.integer(), seats: s.integer(), invoiceId: s.string(), kind: s.enum(["new", "upgrade"]) })),
    coupon: s.optional(s.object({ code: s.string(), percentOff: s.integer(), periodsLeft: s.integer() })),
    renewalNotifiedFor: s.optional(s.number()),
    createdAt: s.number(),
    updatedAt: s.number(),
  },
  { unique: [["accountId"]], indexes: [{ fields: ["status"] }] },
);

// ─── Invoices, payments, refunds ─────────────────────────────────────────────────────────────

const invoiceLine = s.object({
  kind: s.enum(["subscription", "proration_credit", "proration_charge", "overage", "addon", "discount"]),
  description: s.string(),
  quantity: s.number(),
  unitAmount: s.integer(),
  amount: s.integer(),
  meter: s.optional(s.string()),
  periodStart: s.optional(s.number()),
  periodEnd: s.optional(s.number()),
});

export const invoices = app.collection(
  "invoices",
  {
    accountId: s.string(),
    number: s.string(),
    kind: s.enum(["initial", "renewal", "upgrade", "addon", "final"]),
    status: s.enum(["draft", "open", "paid", "void", "uncollectible"]),
    currency: s.string(),
    lines: s.array(invoiceLine),
    subtotal: s.integer(),
    discount: s.integer(),
    total: s.integer(),
    amountPaid: s.integer(),
    amountRefunded: s.integer(),
    catalogVersion: s.integer(),
    periodStart: s.number(),
    periodEnd: s.number(),
    createdAt: s.number(),
    paidAt: s.optional(s.number()),
    voidedAt: s.optional(s.number()),
    attempts: s.integer(),
    nextAttemptAt: s.optional(s.number()),
    lastFailure: s.optional(s.string()),
    providerPaymentRef: s.optional(s.string()),
    /** What the invoice pays for, applied when its payment is verified. */
    purpose: s.object({ type: s.enum(["subscription", "addon"]), addonKey: s.optional(s.string()), requestedBy: s.string() }),
  },
  { unique: [["number"]], indexes: [{ fields: ["accountId"] }, { fields: ["status"] }] },
);

/** Every attempt to collect money, with its provider evidence. */
export const paymentAttempts = app.collection(
  "payment_attempts",
  {
    accountId: s.string(),
    invoiceId: s.string(),
    attempt: s.integer(),
    state: s.enum(["requested", "succeeded", "failed", "unknown"]),
    amount: s.integer(),
    providerRef: s.optional(s.string()),
    failureReason: s.optional(s.string()),
    requestedAt: s.number(),
    settledAt: s.optional(s.number()),
    via: s.enum(["checkout", "off_session"]),
  },
  { indexes: [{ fields: ["invoiceId"] }, { fields: ["accountId"] }] },
);

export const refunds = app.collection(
  "refunds",
  {
    accountId: s.string(),
    invoiceId: s.string(),
    amount: s.integer({ minimum: 1 }),
    reason: s.string({ maxLength: 500 }),
    state: s.enum(["requested", "succeeded", "failed"]),
    providerRef: s.optional(s.string()),
    requestedBy: s.string(),
    requestedAt: s.number(),
    settledAt: s.optional(s.number()),
  },
  { indexes: [{ fields: ["invoiceId"] }] },
);

export const checkouts = app.collection(
  "checkouts",
  {
    accountId: s.string(),
    invoiceId: s.string(),
    state: s.enum(["creating", "open", "completed", "expired", "failed"]),
    url: s.optional(s.string()),
    providerRef: s.optional(s.string()),
    createdAt: s.number(),
    createdBy: s.string(),
    error: s.optional(s.string()),
  },
  { indexes: [{ fields: ["accountId"] }, { fields: ["invoiceId"] }] },
);

/** Every verified provider event, once. The unique key is the replay defence. */
export const providerEvents = app.collection(
  "provider_events",
  {
    provider: s.string(),
    eventId: s.string(),
    type: s.string(),
    providerCreatedAt: s.number(),
    receivedAt: s.number(),
    accountId: s.optional(s.string()),
    outcome: s.enum(["applied", "ignored", "stale", "unmatched", "failed"]),
    detail: s.string({ maxLength: 1000 }),
    objectRef: s.optional(s.string()),
  },
  { unique: [["provider", "eventId"]], indexes: [{ fields: ["accountId"] }] },
);

// ─── Usage and entitlements ──────────────────────────────────────────────────────────────────

/** Observed usage, append-only. Corrections are new events with negative quantity. */
export const usageEvents = app.collection(
  "usage_events",
  {
    accountId: s.string(),
    meter: s.string(),
    quantity: s.number(),
    kind: s.enum(["consume", "adjustment"]),
    idempotencyKey: s.string({ minLength: 1, maxLength: 200 }),
    actorId: s.string(),
    actorType: s.string(),
    agentId: s.optional(s.string()),
    onBehalfOf: s.optional(s.string()),
    resource: s.optional(s.string({ maxLength: 200 })),
    source: s.string({ maxLength: 80 }),
    reason: s.optional(s.string({ maxLength: 500 })),
    periodKey: s.string(),
    catalogVersion: s.integer(),
    /** included: within the allowance; overage: billable beyond it. Decided when recorded. */
    disposition: s.enum(["included", "overage", "adjustment"]),
    overageUnits: s.number(),
    estimatedCost: s.integer(),
    occurredAt: s.number(),
    recordedAt: s.number(),
    requestId: s.string(),
  },
  { unique: [["accountId", "idempotencyKey"]], indexes: [{ fields: ["accountId", "periodKey"] }, { fields: ["accountId", "agentId"] }] },
);

/** The authoritative running total per account, meter and period, written in the same transaction as each event. */
export const usageCounters = app.collection(
  "usage_counters",
  {
    accountId: s.string(),
    meter: s.string(),
    periodKey: s.string(),
    used: s.number(),
    reserved: s.number(),
    notified: s.array(s.number()),
    /** Set when the period's overage was put on an invoice: invoiced usage. */
    invoicedAt: s.optional(s.number()),
    invoiceId: s.optional(s.string()),
    /** Overage units of this period already put on an invoice mid-period (an upgrade settles them under the old plan). */
    billedUnits: s.optional(s.number()),
    updatedAt: s.number(),
  },
  { unique: [["accountId", "meter", "periodKey"]], indexes: [{ fields: ["accountId"] }] },
);

export const reservations = app.collection(
  "usage_reservations",
  {
    accountId: s.string(),
    meter: s.string(),
    periodKey: s.string(),
    quantity: s.number({ minimum: 0 }),
    state: s.enum(["held", "committed", "released", "expired"]),
    holderId: s.string(),
    holderType: s.string(),
    idempotencyKey: s.string(),
    expiresAt: s.number(),
    createdAt: s.number(),
    settledAt: s.optional(s.number()),
    committedQuantity: s.optional(s.number()),
  },
  { unique: [["accountId", "idempotencyKey"]], indexes: [{ fields: ["accountId", "state"] }] },
);

export const rateWindows = app.collection(
  "rate_windows",
  { accountId: s.string(), feature: s.string(), window: s.number(), count: s.integer() },
  { unique: [["accountId", "feature", "window"]] },
);

/** Operator overrides, temporary grants and purchased add-ons. Revoked, never deleted. */
export const grants = app.collection(
  "entitlement_grants",
  {
    accountId: s.string(),
    feature: s.string(),
    kind: s.enum(["override", "grant", "addon"]),
    value: s.union([s.boolean(), s.number(), s.null()]),
    scope: s.optional(s.object({ type: s.enum(["user", "agent"]), id: s.string() })),
    periodKey: s.optional(s.string()),
    expiresAt: s.optional(s.number()),
    reason: s.string({ maxLength: 500 }),
    source: s.optional(s.string()),
    createdBy: s.string(),
    createdAt: s.number(),
    revokedAt: s.optional(s.number()),
    revokedBy: s.optional(s.string()),
  },
  { indexes: [{ fields: ["accountId"] }] },
);

// ─── Agent economics ─────────────────────────────────────────────────────────────────────────

/** What an agent may spend for an account. No policy: the agent may not incur any charge. */
export const agentPolicies = app.collection(
  "agent_policies",
  {
    accountId: s.string(),
    agentId: s.string(),
    /** The person the agent answers to: its consumption is attributed to them. */
    principalOwner: s.string(),
    enabled: s.boolean(),
    /** Overage the agent may cause per billing period (minor units). 0: included usage only. */
    budgetPerPeriod: s.integer({ minimum: 0 }),
    /** Largest charge a single operation may incur without approval. */
    perOperationLimit: s.integer({ minimum: 0 }),
    /** Meters it may consume. Empty: none. */
    meters: s.array(s.string()),
    /** Whether it may request purchases (add-ons); they always need a person's approval. */
    mayRequestPurchases: s.boolean(),
    updatedBy: s.string(),
    updatedAt: s.number(),
    revokedAt: s.optional(s.number()),
  },
  { unique: [["accountId", "agentId"]] },
);

/** Overage charges an agent incurred per period: the budget's counter, written with each usage event. */
export const agentSpend = app.collection(
  "agent_spend",
  { accountId: s.string(), agentId: s.string(), periodKey: s.string(), spent: s.integer(), operations: s.integer(), units: s.number(), updatedAt: s.number() },
  { unique: [["accountId", "agentId", "periodKey"]] },
);

/** A purchase an agent asked for. Only a person with billing.manage can approve it. */
export const spendRequests = app.collection(
  "spend_requests",
  {
    accountId: s.string(),
    agentId: s.string(),
    addonKey: s.string(),
    amount: s.integer(),
    justification: s.string({ maxLength: 1000 }),
    state: s.enum(["pending", "approved", "rejected", "expired"]),
    requestedAt: s.number(),
    decidedBy: s.optional(s.string()),
    decidedAt: s.optional(s.number()),
    invoiceId: s.optional(s.string()),
  },
  { indexes: [{ fields: ["accountId", "state"] }] },
);

// ─── The monetized application ───────────────────────────────────────────────────────────────

/** The workspace's own data: tenant-scoped by FeltKit (another workspace's records do not exist). */
export const projects = app.collection(
  "projects",
  { name: s.string({ minLength: 1, maxLength: 80 }), createdAt: s.number(), createdBy: s.string() },
  { tenant: true },
);

export const agentRuns = app.collection(
  "agent_runs",
  { agentId: s.string(), task: s.string({ maxLength: 500 }), state: s.enum(["queued", "done", "refused"]), result: s.optional(s.string({ maxLength: 2000 })), requestedBy: s.string(), createdAt: s.number() },
  { tenant: true },
);

// ─── Audit ───────────────────────────────────────────────────────────────────────────────────

/** Every material commercial decision, in the same transaction as the change it describes. */
export const audit = app.auditTrail("billing_audit", { subjects: ["account", "catalog", "subscription", "invoice", "usage", "agent", "entitlement"] as const });

// ─── Counters ────────────────────────────────────────────────────────────────────────────────

/** Gap-free invoice numbering. */
export const INVOICE_SEQUENCE = "invoice-number";
