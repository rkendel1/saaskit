/**
 * Usage: reported by a server integration (API key), reserved ahead of long work, corrected by
 * operators, read and exported by customers. Observed usage is the append-only event log; the
 * counters are written with every event in the same transaction and are what decisions use.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, audit, reservations, usageCounters, usageEvents } from "./app.js";
import { allowanceFor } from "./_catalog.js";
import { callerAccountId, commercialState, principalOf } from "./_commerce.js";
import { decide } from "./_engine.js";
import { agentPolicyFor, consume, counterFor, entitlement } from "./_metering.js";

const ConsumeResult = s.object({ duplicate: s.boolean(), eventId: s.string(), disposition: s.string(), overageUnits: s.number(), estimatedCost: s.integer() });

/**
 * Usage reported by the application's own backend (an API key holding usage_reporter). The key is
 * the business's, like a provider secret key, so it names the account. Idempotent per key.
 */
export const ingest = app.mutation({
  access: "usage.ingest",
  args: { accountId: s.string(), meter: s.string(), quantity: s.number({ minimum: 0 }), idempotencyKey: s.string({ minLength: 1, maxLength: 200 }), resource: s.optional(s.string({ maxLength: 200 })), occurredAt: s.optional(s.number()), source: s.optional(s.string({ maxLength: 80 })) },
  returns: ConsumeResult,
  capability: { name: "usage.ingest", description: "Report metered usage for an account (server integrations). Idempotent by idempotencyKey." },
  handler: async (ctx, a) => {
    const r = await consume(ctx, { accountId: a.accountId, meter: a.meter, quantity: a.quantity, idempotencyKey: a.idempotencyKey, actor: principalOf(ctx), source: a.source ?? "api", resource: a.resource, occurredAt: a.occurredAt });
    return { duplicate: r.duplicate, eventId: r.event.id, disposition: r.event.disposition, overageUnits: r.event.overageUnits, estimatedCost: r.event.estimatedCost };
  },
});

/** Hold allowance for work that will finish later, so concurrent work cannot spend it first. */
export const reserve = app.mutation({
  access: "usage.reserve",
  args: { meter: s.string(), quantity: s.number({ minimum: 0 }), ttlSeconds: s.optional(s.integer({ minimum: 10, maximum: 86_400 })), idempotencyKey: s.string({ minLength: 1, maxLength: 200 }) },
  returns: s.object({ reservationId: s.string(), expiresAt: s.number(), remaining: s.nullable(s.number()) }),
  capability: { name: "usage.reserve", description: "Reserve allowance before long-running work; commit the actual quantity or release it." },
  handler: async (ctx, { meter, quantity, ttlSeconds, idempotencyKey }) => {
    const accountId = callerAccountId(ctx);
    const actor = principalOf(ctx);
    const [existing] = await ctx.db.find(reservations, { accountId, idempotencyKey }, { limit: 1 });
    if (existing) return { reservationId: existing.id, expiresAt: existing.expiresAt, remaining: null };
    const state = await commercialState(ctx, accountId, actor);
    const feature = allowanceFor(state.catalog, meter) ?? fail("NOT_FOUND", `No allowance draws from meter "${meter}".`);
    if (actor.type === "agent") {
      const p = await agentPolicyFor(ctx, accountId, actor.id);
      if (!p || !p.enabled || p.revokedAt || !p.meters.includes(meter)) fail("FORBIDDEN", `Agent ${actor.id} may not reserve "${meter}".`, { hint: "AGENT_METER_NOT_ALLOWED" });
    }
    const counter = await counterFor(ctx, accountId, meter, state.periodKey);
    const d = decide(entitlement(state, feature.key), quantity, { used: counter?.used ?? 0, reserved: counter?.reserved ?? 0 });
    // A reservation may only hold included allowance: overage is never reserved implicitly.
    if (!d.allowed || d.code !== "included") fail("FAILED_PRECONDITION", d.allowed ? `Only ${d.remaining ?? 0} included ${feature.unit ?? ""} remain; reserve less or buy capacity.` : d.reason, { hint: "ENTITLEMENT", decision: d });
    const now = Date.now();
    const expiresAt = now + (ttlSeconds ?? 900) * 1000;
    const id = await ctx.db.insert(reservations, { accountId, meter, periodKey: state.periodKey, quantity, state: "held", holderId: actor.id, holderType: actor.type, idempotencyKey, expiresAt, createdAt: now });
    if (counter) await ctx.db.patch(usageCounters, counter.id, { reserved: counter.reserved + quantity, updatedAt: now });
    else await ctx.db.insert(usageCounters, { accountId, meter, periodKey: state.periodKey, used: 0, reserved: quantity, notified: [], updatedAt: now });
    return { reservationId: id, expiresAt, remaining: d.remaining ?? null };
  },
});

/** Record what the reserved work actually used (may be less or, within the plan's rules, more). */
export const commit = app.mutation({
  access: "usage.reserve",
  args: { reservationId: s.string(), quantity: s.number({ minimum: 0 }) },
  returns: s.object({ eventId: s.nullable(s.string()), released: s.number() }),
  capability: { name: "usage.commit", description: "Settle a reservation with the quantity actually used." },
  handler: async (ctx, { reservationId, quantity }) => {
    const accountId = callerAccountId(ctx);
    const actor = principalOf(ctx);
    const r = await ctx.db.get(reservations, reservationId);
    if (!r || r.accountId !== accountId) fail("NOT_FOUND", "No such reservation.");
    if (r.holderId !== actor.id) fail("FORBIDDEN", "Only the holder settles a reservation.");
    if (r.state !== "held") fail("FAILED_PRECONDITION", `The reservation is ${r.state}.`);
    let eventId: string | null = null;
    if (quantity > 0) {
      const res = await consume(ctx, { accountId, meter: r.meter, quantity, idempotencyKey: `reservation:${r.id}`, actor, source: "reservation", fromReservation: r.quantity });
      eventId = res.event.id;
    } else {
      const c = await counterFor(ctx, accountId, r.meter, r.periodKey);
      if (c) await ctx.db.patch(usageCounters, c.id, { reserved: Math.max(c.reserved - r.quantity, 0), updatedAt: Date.now() });
    }
    await ctx.db.patch(reservations, r.id, { state: "committed", committedQuantity: quantity, settledAt: Date.now() });
    return { eventId, released: Math.max(r.quantity - quantity, 0) };
  },
});

export const release = app.mutation({
  access: "usage.reserve",
  args: { reservationId: s.string() },
  capability: { name: "usage.release", description: "Give back a reservation's capacity unused." },
  returns: s.object({ released: s.number() }),
  handler: async (ctx, { reservationId }) => {
    const accountId = callerAccountId(ctx);
    const r = await ctx.db.get(reservations, reservationId);
    if (!r || r.accountId !== accountId) fail("NOT_FOUND", "No such reservation.");
    if (r.holderId !== principalOf(ctx).id && !ctx.auth.has("billing.manage")) fail("FORBIDDEN", "Only the holder or a billing manager releases a reservation.");
    if (r.state !== "held") return { released: 0 };
    const c = await counterFor(ctx, accountId, r.meter, r.periodKey);
    if (c) await ctx.db.patch(usageCounters, c.id, { reserved: Math.max(c.reserved - r.quantity, 0), updatedAt: Date.now() });
    await ctx.db.patch(reservations, r.id, { state: "released", settledAt: Date.now() });
    return { released: r.quantity };
  },
});

/** The current period's usage: totals, who consumed it (people and agents), and a daily series. */
export const summary = app.query({
  access: "usage.read",
  handler: async (ctx) => {
    const accountId = callerAccountId(ctx);
    const state = await commercialState(ctx, accountId);
    const events = await ctx.db.find(usageEvents, { accountId, periodKey: state.periodKey });
    const counters = await ctx.db.find(usageCounters, { accountId, periodKey: state.periodKey });
    const meters = state.catalog.meters.map((m) => {
      const e = state.entitlements.find((x) => x.meter === m.key);
      const c = counters.find((x) => x.meter === m.key);
      const mine = events.filter((x) => x.meter === m.key);
      const byActor = new Map<string, { actorId: string; actorType: string; onBehalfOf: string | null; quantity: number; cost: number }>();
      for (const ev of mine) {
        const k = `${ev.actorType}:${ev.actorId}`;
        const row = byActor.get(k) ?? { actorId: ev.actorId, actorType: ev.actorType, onBehalfOf: ev.onBehalfOf ?? null, quantity: 0, cost: 0 };
        row.quantity += ev.quantity;
        row.cost += ev.estimatedCost;
        byActor.set(k, row);
      }
      const daily = new Map<string, number>();
      for (const ev of mine) {
        const day = new Date(ev.occurredAt).toISOString().slice(0, 10);
        daily.set(day, (daily.get(day) ?? 0) + ev.quantity);
      }
      return { meter: m.key, name: m.name, unit: m.unit, allowance: (e?.value as number | null) ?? 0, used: c?.used ?? 0, reserved: c?.reserved ?? 0, policy: e?.overage?.policy ?? "block", byActor: [...byActor.values()].sort((a, b) => b.quantity - a.quantity), daily: [...daily.entries()].sort().map(([day, quantity]) => ({ day, quantity })) };
    });
    return { periodKey: state.periodKey, periodStart: state.sub.currentPeriodStart, periodEnd: state.sub.currentPeriodEnd, meters };
  },
});

export const recent = app.query({
  access: "usage.read",
  args: { limit: s.optional(s.integer({ minimum: 1, maximum: 200 })) },
  handler: async (ctx, { limit }) => {
    const accountId = callerAccountId(ctx);
    const rows = await ctx.db.find(usageEvents, { accountId }, { orderBy: [{ field: "recordedAt", direction: "desc" }], limit: limit ?? 50 });
    return rows.map((e) => ({ id: e.id, meter: e.meter, quantity: e.quantity, kind: e.kind, disposition: e.disposition, actorId: e.actorId, actorType: e.actorType, onBehalfOf: e.onBehalfOf ?? null, resource: e.resource ?? null, estimatedCost: e.estimatedCost, recordedAt: e.recordedAt, source: e.source, reason: e.reason ?? null }));
  },
});

/** Export this period's usage events as CSV, stored with the Files service. */
export const exportCsv = app.mutation({
  access: "usage.read",
  returns: s.object({ fileId: s.string(), rows: s.integer() }),
  handler: async (ctx) => {
    const accountId = callerAccountId(ctx);
    const state = await commercialState(ctx, accountId);
    const events = await ctx.db.find(usageEvents, { accountId, periodKey: state.periodKey }, { orderBy: [{ field: "recordedAt", direction: "asc" }] });
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = ["event_id,recorded_at,meter,quantity,kind,disposition,actor_type,actor_id,on_behalf_of,resource,estimated_cost_minor,catalog_version,request_id"]
      .concat(events.map((e) => [e.id, new Date(e.recordedAt).toISOString(), e.meter, e.quantity, e.kind, e.disposition, e.actorType, e.actorId, e.onBehalfOf ?? "", e.resource ?? "", e.estimatedCost, e.catalogVersion, e.requestId].map(q).join(",")))
      .join("\n");
    const file = await ctx.services.files.upload({ name: `usage-${state.periodKey.replace(/[^0-9A-Za-z]/g, "")}.csv`, contentType: "text/csv", content: csv, metadata: { accountId, kind: "usage-export" } });
    return { fileId: file.id, rows: events.length };
  },
});

/**
 * Correct usage (operators). An adjustment is a new event; nothing is rewritten. Usage on an
 * invoiced period cannot be adjusted: that is a refund or credit, not a usage change.
 */
export const adjust = app.mutation({
  access: "ops.usage.adjust",
  args: { accountId: s.string(), meter: s.string(), quantity: s.number(), reason: s.string({ minLength: 3, maxLength: 500 }), idempotencyKey: s.string({ minLength: 1 }) },
  returns: s.object({ eventId: s.string(), used: s.number() }),
  handler: async (ctx, a) => {
    if (a.quantity === 0) fail("INVALID_ARGUMENT", "An adjustment changes usage by a non-zero quantity.");
    const [dup] = await ctx.db.find(usageEvents, { accountId: a.accountId, idempotencyKey: a.idempotencyKey }, { limit: 1 });
    const state = await commercialState(ctx, a.accountId);
    const counter = await counterFor(ctx, a.accountId, a.meter, state.periodKey);
    if (dup) return { eventId: dup.id, used: counter?.used ?? 0 };
    if (counter?.invoicedAt) fail("FAILED_PRECONDITION", "This period's usage is already invoiced; issue a refund instead.");
    const used = Math.max((counter?.used ?? 0) + a.quantity, 0);
    const now = Date.now();
    const who = principalOf(ctx);
    const id = await ctx.db.insert(usageEvents, { accountId: a.accountId, meter: a.meter, quantity: a.quantity, kind: "adjustment", idempotencyKey: a.idempotencyKey, actorId: who.id, actorType: who.type, source: "operator", reason: a.reason, periodKey: state.periodKey, catalogVersion: state.sub.catalogVersion, disposition: "adjustment", overageUnits: 0, estimatedCost: 0, occurredAt: now, recordedAt: now, requestId: ctx.requestId });
    if (counter) await ctx.db.patch(usageCounters, counter.id, { used, updatedAt: now });
    else await ctx.db.insert(usageCounters, { accountId: a.accountId, meter: a.meter, periodKey: state.periodKey, used, reserved: 0, notified: [], updatedAt: now });
    await audit.record(ctx, { subject: "usage", id: `${a.accountId}:${a.meter}`, type: "usage.adjusted", data: { quantity: a.quantity, reason: a.reason, eventId: id } });
    return { eventId: id, used };
  },
});

/** Reconcile counters against the event log (operators). Reports and repairs drift. */
export const reconcileCounters = app.mutation({
  access: "ops.usage.adjust",
  args: { accountId: s.string() },
  returns: s.array(s.object({ meter: s.string(), periodKey: s.string(), counter: s.number(), events: s.number(), repaired: s.boolean() })),
  handler: async (ctx, { accountId }) => {
    const out = [];
    for (const c of await ctx.db.find(usageCounters, { accountId })) {
      const total = (await ctx.db.find(usageEvents, { accountId, meter: c.meter, periodKey: c.periodKey })).reduce((a, e) => a + e.quantity, 0);
      const fixed = Math.max(total, 0);
      const drift = Math.abs(fixed - c.used) > 1e-9;
      if (drift) {
        await ctx.db.patch(usageCounters, c.id, { used: fixed, updatedAt: Date.now() });
        await audit.record(ctx, { subject: "usage", id: `${accountId}:${c.meter}`, type: "usage.counter_repaired", data: { periodKey: c.periodKey, was: c.used, now: fixed } });
      }
      out.push({ meter: c.meter, periodKey: c.periodKey, counter: c.used, events: total, repaired: drift });
    }
    return out;
  },
});
