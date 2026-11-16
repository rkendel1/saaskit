/**
 * FK-16 release-integrity tests (FeltKit 0.3.31 family against the PUBLISHED @authboundry/local).
 * Run by release/verify.sh inside a scratch copy of the application, after the full application suite.
 * Expectations encode the corrected contract; on unpatched 0.3.31 the agent-caller test fails, which
 * is the reproduction of FK-16.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addAgent, api, setup, workspace } from "./helpers.ts";

const probe = (api as any).zzfk16.decide;

test("FK-07 regression: every documented onBehalfOf form resolves to the same principal", async () => {
  const t = await setup();
  try {
    const { c } = await workspace(t, "grace", "Acme");
    for (const form of ["plain", "prefixed", "person", "principal"]) {
      const d = await c.mutation(probe, { form });
      assert.deepEqual([d.allowed, d.outcome, d.onBehalfOf], [false, "deny", "user:grace"], `${form} before the grant`);
    }
    const g = await c.mutation(api.agents.delegateSpending, {});
    for (const form of ["plain", "prefixed", "person", "principal"]) {
      const d = await c.mutation(probe, { form });
      assert.deepEqual([d.allowed, d.onBehalfOf, d.delegationId], [true, "user:grace", g.id], `${form} after the grant`);
    }
    // Unauthorized delegation stays denied: linus never delegated.
    const other = await c.mutation(probe, { form: "other" });
    assert.deepEqual([other.allowed, other.outcome], [false, "deny"]);
  } finally {
    await t.close();
  }
});

test("FK-16: an agent caller decides with the delegation it has, and the evidence names who decided", async () => {
  const t = await setup();
  try {
    const { c, accountId } = await workspace(t, "grace", "Acme");
    const bot = await addAgent(t, accountId, "agent-ops");
    const before = await bot.mutation(probe, { form: "plain" });
    assert.equal(before.allowed, false, "no delegation yet: refused");
    assert.notEqual(before.outcome, "allow");
    await c.mutation(api.agents.delegateSpending, {});
    const d = await bot.mutation(probe, { form: "plain" });
    // With @authboundry/local 0.1.0 (no registerAgent) the agent decides as the application's executor,
    // the 0.3.30 contract; the decision says so. Never a silent per-agent claim.
    assert.equal(d.outcome, "allow", `agent caller: ${d.outcome} ${d.reason ?? ""}`);
    assert.equal(d.executor, "agent:saaskit");
    assert.equal(d.proven, true, "the executor is proven by its agent credential");
  } finally {
    await t.close();
  }
});

test("FK-16: asking explicitly to decide as a named agent fails explicitly when the authority cannot", async () => {
  const t = await setup();
  try {
    const { c, accountId } = await workspace(t, "grace", "Acme");
    await addAgent(t, accountId, "agent-ops");
    await c.mutation(api.agents.delegateSpending, {});
    const d = await c.mutation(probe, { form: "plain", agent: "agent-ops" });
    assert.deepEqual([d.allowed, d.outcome], [false, "unavailable"]);
    assert.match(String(d.reason), /registerAgent/);
  } finally {
    await t.close();
  }
});

test("FK-16: an agent can never decide as another agent", async () => {
  const t = await setup();
  try {
    const { c, accountId } = await workspace(t, "grace", "Acme");
    const bot = await addAgent(t, accountId, "agent-ops");
    await c.mutation(api.agents.delegateSpending, {});
    const d = await bot.mutation(probe, { form: "plain", agent: "agent-other" });
    assert.deepEqual([d.allowed, d.outcome], [false, "deny"]);
  } finally {
    await t.close();
  }
});
