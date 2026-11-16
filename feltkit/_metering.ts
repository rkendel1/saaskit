/**
 * Metering and enforcement inside the caller's transaction.
 *
 * An application capability calls `consume` (or `requireFeature` / `requireLimit` / `rateLimit`)
 * in the SAME mutation that performs the work. FeltDB commits the business change, the usage event,
 * the counter and the agent's spend together, or none of them: there is no window where work
 * happened but was not metered, or was metered but did not happen. Concurrent consumers of one
 * counter conflict at commit (CONFLICT, retryable) instead of losing an increment.
 */
import { fail } from "@feltdb/feltkit";
import type { MutationCtx, QueryCtx } from "@feltdb/feltkit";
import { agentPolicies, agentSpend, audit, rateWindows, usageCounters, usageEvents } from "./app.js";
import { allowanceFor, crossedThresholds, decide, type Decision, type EffectiveEntitlement } from "./_engine.js";
import { commercialState, getAccount, notify } from "./_commerce.js";

type Ctx = QueryCtx | MutationCtx;
type State = Awaited<ReturnType<typeof commercialState>>;
export type Actor = { id: string; type: string };

export function entitlement(state: State, feature: string): EffectiveEntitlement | undefined {
  return state.entitlements.find((e) => e.key === feature);
}

export async function counterFor(ctx: Ctx, accountId: string, meter: string, periodKey: string) {
  const [c] = await ctx.db.find(usageCounters, { accountId, meter, periodKey }, { limit: 1 });
  return c ?? null;
}

function deny(d: Decision, extra: Record<string, unknown> = {}): never {
  fail(d.code === "rate_limited" ? "RATE_LIMITED" : "FAILED_PRECONDITION", d.reason, { hint: "ENTITLEMENT", decision: d, ...extra });
}

/** A boolean feature must be on for this account (and principal, for scoped grants). */
export async function requireFeature(ctx: Ctx, accountId: string, feature: string, actor?: Actor) {
  const state = await commercialState(ctx, accountId, actor);
  const d = decide(entitlement(state, feature), 1, {});
  if (!d.allowed) deny(d);
  return state;
}

/** A limit feature must leave room for `adding` more beyond `current` (a live count the caller made). */
export async function requireLimit(ctx: Ctx, accountId: string, feature: string, current: number, adding = 1, actor?: Actor) {
  const state = await commercialState(ctx, accountId, actor);
  const d = decide(entitlement(state, feature), adding, { count: current });
  if (!d.allowed) deny(d);
  return d;
}

/** Fixed one-minute window per account and feature. */
export async function rateLimit(ctx: MutationCtx, accountId: string, feature: string, now = Date.now()) {
  const state = await commercialState(ctx, accountId);
  const window = Math.floor(now / 60_000);
  const [row] = await ctx.db.find(rateWindows, { accountId, feature, window }, { limit: 1 });
  const d = decide(entitlement(state, feature), 1, { count: row?.count ?? 0 });
  if (!d.allowed) deny(d);
  if (row) await ctx.db.patch(rateWindows, row.id, { count: row.count + 1 });
  else await ctx.db.insert(rateWindows, { accountId, feature, window, count: 1 });
  return d;
}

export interface ConsumeInput {
  accountId: string;
  meter: string;
  quantity: number;
  idempotencyKey: string;
  actor: Actor;
  source: string;
  resource?: string;
  occurredAt?: number;
  /** Count against an existing reservation instead of fresh allowance (see reservations). */
  fromReservation?: number;
}

/**
 * Meter `quantity` of `meter` for the account, as `actor`. Refuses (and writes nothing) when the
 * plan does not allow it, or when an agent lacks the spending authority it would need. A repeated
 * idempotency key returns the first recording and changes nothing.
 */
export async function consume(ctx: MutationCtx, input: ConsumeInput) {
  if (!(input.quantity > 0)) fail("INVALID_ARGUMENT", "Usage quantity must be positive; use an adjustment to correct usage.");
  const [dup] = await ctx.db.find(usageEvents, { accountId: input.accountId, idempotencyKey: input.idempotencyKey }, { limit: 1 });
  if (dup) {
    if (dup.meter !== input.meter || dup.quantity !== input.quantity) fail("CONFLICT", `Idempotency key "${input.idempotencyKey}" was already used for different usage.`, { hint: "IDEMPOTENCY_MISMATCH" });
    return { duplicate: true, event: dup, decision: null };
  }
  const state = await commercialState(ctx, input.accountId, input.actor);
  const feature = allowanceFor(state.catalog, input.meter);
  if (!feature) fail("NOT_FOUND", `No allowance feature draws from meter "${input.meter}" in catalog v${state.sub.catalogVersion}.`);
  const ent = entitlement(state, feature.key)!;
  const counter = await counterFor(ctx, input.accountId, input.meter, state.periodKey);
  const used = counter?.used ?? 0;
  const reserved = Math.max((counter?.reserved ?? 0) - (input.fromReservation ?? 0), 0);
  const decision = decide(ent, input.quantity, { used, reserved });
  const account = (await getAccount(ctx, input.accountId))!;

  // Agents: commercial permission and spending authority are separate from being allowed to call.
  let agentPolicy: Awaited<ReturnType<typeof agentPolicyFor>> | null = null;
  if (input.actor.type === "agent") {
    const agentsOn = decide(entitlement(state, "agents.enabled"), 1, {});
    if (!agentsOn.allowed) deny(agentsOn, { agent: input.actor.id });
    agentPolicy = await agentPolicyFor(ctx, input.accountId, input.actor.id);
    if (!agentPolicy || !agentPolicy.enabled || agentPolicy.revokedAt) fail("FORBIDDEN", `Agent ${input.actor.id} has no consumption authority for this account. An owner grants it under Billing → Agents.`, { hint: "AGENT_NO_POLICY" });
    if (!agentPolicy.meters.includes(input.meter)) fail("FORBIDDEN", `Agent ${input.actor.id} may not consume "${input.meter}".`, { hint: "AGENT_METER_NOT_ALLOWED" });
  }
  // A refusal commits nothing; the exhaustion notice was sent by the event that reached the allowance.
  if (!decision.allowed) deny(decision);
  const cost = decision.estimatedCost ?? 0;
  let spend: Awaited<ReturnType<typeof agentSpendFor>> | null = null;
  if (agentPolicy && cost > 0) {
    spend = await agentSpendFor(ctx, input.accountId, input.actor.id, state.periodKey);
    const spent = spend?.spent ?? 0;
    if (cost > agentPolicy.perOperationLimit) {
      fail("FAILED_PRECONDITION", `This operation would cost ${cost} (minor units), above agent ${input.actor.id}'s per-operation limit of ${agentPolicy.perOperationLimit}. A person must approve it.`, { hint: "AGENT_APPROVAL_REQUIRED", decision, cost });
    }
    if (spent + cost > agentPolicy.budgetPerPeriod) {
      fail("FAILED_PRECONDITION", `Agent ${input.actor.id} would exceed its budget for this period (${spent + cost} > ${agentPolicy.budgetPerPeriod}).`, { hint: "AGENT_BUDGET_EXHAUSTED", decision, cost, spent });
    }
  }

  const now = Date.now();
  const eventId = await ctx.db.insert(usageEvents, {
    accountId: input.accountId, meter: input.meter, quantity: input.quantity, kind: "consume", idempotencyKey: input.idempotencyKey,
    actorId: input.actor.id, actorType: input.actor.type,
    ...(input.actor.type === "agent" ? { agentId: input.actor.id, onBehalfOf: agentPolicy!.principalOwner } : {}),
    ...(input.resource ? { resource: input.resource } : {}),
    source: input.source, periodKey: state.periodKey, catalogVersion: state.sub.catalogVersion,
    disposition: decision.code === "overage" ? "overage" : "included", overageUnits: decision.overageUnits ?? 0, estimatedCost: cost,
    occurredAt: input.occurredAt ?? now, recordedAt: now, requestId: ctx.requestId,
  });
  const after = used + input.quantity;
  const newReserved = Math.max((counter?.reserved ?? 0) - (input.fromReservation ?? 0), 0);
  const crossed = crossedThresholds(ent.value, used + (counter?.reserved ?? 0) - (input.fromReservation ?? 0), after + newReserved, counter?.notified ?? []);
  if (counter) await ctx.db.patch(usageCounters, counter.id, { used: after, reserved: newReserved, notified: [...counter.notified, ...crossed], updatedAt: now });
  else await ctx.db.insert(usageCounters, { accountId: input.accountId, meter: input.meter, periodKey: state.periodKey, used: after, reserved: newReserved, notified: crossed, updatedAt: now });

  for (const t of crossed) {
    const pct = Math.round(t * 100);
    const exhausted = t >= 1;
    notify(ctx, account, exhausted ? "usage.exhausted" : "usage.threshold", exhausted ? `You have used all ${ent.value} included ${ent.unit ?? ent.name}` : `You have used ${pct}% of your ${ent.name.toLowerCase()}`, { meter: input.meter, feature: ent.key, used: after, allowance: ent.value, overagePolicy: ent.overage?.policy ?? "block" }, `${input.meter}:${state.periodKey}:${pct}`);
    ctx.afterCommit.webhooks.emit("usage.threshold", { accountId: input.accountId, meter: input.meter, threshold: t, used: after, allowance: ent.value });
    await audit.record(ctx, { subject: "usage", id: `${input.accountId}:${input.meter}`, type: exhausted ? "usage.allowance_exhausted" : "usage.threshold_crossed", data: { threshold: t, used: after, allowance: ent.value, periodKey: state.periodKey } });
  }
  if (decision.code === "overage" && (used + (counter?.reserved ?? 0)) <= (ent.value as number)) {
    notify(ctx, account, "usage.overage", `Usage of ${ent.name.toLowerCase()} is now beyond your plan`, { meter: input.meter, policy: ent.overage?.policy, unitAmount: ent.overage?.unitAmount, perUnits: ent.overage?.perUnits }, `${input.meter}:${state.periodKey}:overage`);
    await audit.record(ctx, { subject: "usage", id: `${input.accountId}:${input.meter}`, type: "usage.overage_started", data: { policy: ent.overage?.policy, periodKey: state.periodKey } });
  }

  if (agentPolicy) {
    const row = spend ?? (await agentSpendFor(ctx, input.accountId, input.actor.id, state.periodKey));
    if (row) await ctx.db.patch(agentSpend, row.id, { spent: row.spent + cost, operations: row.operations + 1, units: row.units + input.quantity, updatedAt: now });
    else await ctx.db.insert(agentSpend, { accountId: input.accountId, agentId: input.actor.id, periodKey: state.periodKey, spent: cost, operations: 1, units: input.quantity, updatedAt: now });
    if (cost > 0) {
      notify(ctx, account, "agent.spend", `Agent ${input.actor.id} incurred a charge`, { agentId: input.actor.id, cost, meter: input.meter }, `${eventId}`, [agentPolicy.principalOwner]);
      await audit.record(ctx, { subject: "agent", id: `${input.accountId}:${input.actor.id}`, type: "agent.spent", data: { cost, meter: input.meter, eventId, onBehalfOf: agentPolicy.principalOwner } });
    }
  }
  return { duplicate: false, event: (await ctx.db.get(usageEvents, eventId))!, decision };
}

export async function agentPolicyFor(ctx: Ctx, accountId: string, agentId: string) {
  const [p] = await ctx.db.find(agentPolicies, { accountId, agentId }, { limit: 1 });
  return p ?? null;
}
export async function agentSpendFor(ctx: Ctx, accountId: string, agentId: string, periodKey: string) {
  const [p] = await ctx.db.find(agentSpend, { accountId, agentId, periodKey }, { limit: 1 });
  return p ?? null;
}
