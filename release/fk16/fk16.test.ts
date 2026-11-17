/**
 * FK-16 release-integrity tests for this application, against the INSTALLED FeltKit and the PUBLISHED
 * @authboundry/local. Run by release/verify.sh --fk16 inside a scratch copy (FeltKit ≥ 0.3.31: the
 * `agent` option and object onBehalfOf forms do not exist in 0.3.30).
 *
 * Expected behaviour follows the decision (docs/REMEDIATION_PLAN.md, FK-16, Option 2):
 *   - default: an agent caller decides only as itself; with @authboundry/local 0.1.0 it is `unavailable`;
 *   - authority.local.agentCallers: "executor-grants" (owner's opt-in, FeltKit ≥ 0.3.32): it shares the
 *     executor's grants, and every such decision records authorityMode "local-executor-grants-opt-in";
 *   - FeltKit ≥ 0.3.32 records authorityMode on every decision (absent, read as null, before it);
 *   - a decision naming an agent is never decided as the executor; an agent never decides as another.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addAgent, api, setup, workspace } from "./helpers.ts";
import { app } from "../feltkit/app.ts";

const probe = (api as any).zzfk16.decide;
const local = (app.options as any).authority?.local;
const OPTED_IN = typeof local === "object" && local?.agentCallers === "executor-grants";
const FELTKIT = JSON.parse(readFileSync(new URL("../node_modules/@feltdb/feltkit/package.json", import.meta.url), "utf8")).version as string;
const PER_AGENT = readFileSync(new URL("../node_modules/@authboundry/local/index.js", import.meta.url), "utf8").includes("registerAgent");
const HAS_MODE = FELTKIT.localeCompare("0.3.32", undefined, { numeric: true }) >= 0;
const modeOr = (m: string) => (HAS_MODE ? m : null);
const MODE = `FeltKit ${FELTKIT}, agentCallers ${OPTED_IN ? "executor-grants" : "default"}, per-agent ${PER_AGENT ? "installed" : "absent"}`;

test(`FK-07 regression: every documented onBehalfOf form resolves to one principal; unrelated delegation denied [${MODE}]`, async () => {
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
      assert.deepEqual([d.allowed, d.onBehalfOf, d.delegationId, d.authorityMode], [true, "user:grace", g.id, modeOr("local-executor")], `${form} after the grant`);
    }
    const other = await c.mutation(probe, { form: "other" });
    assert.deepEqual([other.allowed, other.outcome], [false, "deny"], "linus never delegated");
  } finally {
    await t.close();
  }
});

test(`FK-16: an agent caller's decision follows the owner's explicit choice, and says so [${MODE}]`, async () => {
  const t = await setup();
  try {
    const { c, accountId } = await workspace(t, "grace", "Acme");
    const bot = await addAgent(t, accountId, "agent-ops");
    const before = await bot.mutation(probe, { form: "plain" });
    assert.equal(before.allowed, false, "no delegation: refused in every mode");
    await c.mutation(api.agents.delegateSpending, {});
    const d = await bot.mutation(probe, { form: "plain" });
    if (PER_AGENT) {
      assert.deepEqual([d.allowed, d.authorityMode], [false, modeOr("local-per-agent")], "per-agent installed: the executor's grant never allows an agent");
    } else if (OPTED_IN) {
      assert.deepEqual([d.allowed, d.outcome, d.executor, d.authorityMode], [true, "allow", "agent:saaskit", "local-executor-grants-opt-in"], `opt-in: ${d.reason}`);
      assert.equal(d.proven, true);
    } else {
      assert.deepEqual([d.allowed, d.outcome, d.authorityMode], [false, "unavailable", modeOr("local-per-agent")], "default: fail closed");
      if (HAS_MODE) assert.equal(d.lasting, true, "a configuration state: retrying does not change it");
      assert.match(String(d.reason), /registerAgent/);
    }
  } finally {
    await t.close();
  }
});

test(`FK-16: a decision naming an agent never falls back to the executor [${MODE}]`, async () => {
  const t = await setup();
  try {
    const { c, accountId } = await workspace(t, "grace", "Acme");
    await addAgent(t, accountId, "agent-ops");
    await c.mutation(api.agents.delegateSpending, {});
    const d = await c.mutation(probe, { form: "plain", agent: "agent-ops" });
    assert.equal(d.allowed, false);
    assert.notEqual(d.authorityMode, "local-executor-grants-opt-in", "never the executor's grants");
    if (!PER_AGENT) {
      assert.equal(d.outcome, "unavailable");
      assert.match(String(d.reason), /registerAgent/);
    }
  } finally {
    await t.close();
  }
});

test(`FK-16: an agent can never decide as another agent [${MODE}]`, async () => {
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
