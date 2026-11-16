/**
 * Seed a running development server (`npm run dev`) with a realistic demonstration, entirely through
 * the application's public HTTP API — the same calls the UI and agents make:
 *
 *   npx tsx scripts/demo.ts [http://localhost:3000]
 *
 * Development only: it signs in as the declared dev users and completes checkouts on the local
 * Stripe simulator (test mode, no real money). It also proves the agent path over HTTP and MCP.
 */
import { execFileSync } from "node:child_process";
import { createClient } from "@feltdb/feltkit/client";
import { api } from "../feltkit/_generated/api.ts";

const URL_ = process.argv[2] ?? "http://localhost:3000";
const RETURN = `${URL_}/#/billing`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const log = (...a: unknown[]) => console.log("•", ...a);

async function as(user: string) {
  const c = createClient({ url: URL_, session: "bearer" });
  await c.signInAsDevUser(user);
  return c;
}
async function settle() {
  await fetch(`${URL_}/stripe/sim/settle`, { method: "POST" });
  await sleep(150);
}
async function pay(c: ReturnType<typeof createClient>, checkoutId: string, card = "pm_card_visa") {
  for (let i = 0; i < 40; i++) {
    await settle();
    const co = await c.query(api.billing.checkout, { checkoutId });
    if (co?.url) {
      const session = co.url.split("/checkout/")[1];
      const r = await fetch(`${URL_}/stripe/sim/checkout/${session}/complete`, { method: "POST", body: JSON.stringify({ card }) });
      await settle();
      return r.json();
    }
  }
  throw new Error("checkout never got a URL");
}

async function main() {
  const ada = await as("ada");
  log("operator publishes the launch catalog:", await ada.mutation(api.catalog.bootstrap, {}));

  // Grace: Acme Analytics on Pro, heavy usage, an agent.
  const grace = await as("grace");
  await grace.createTenant("Acme Analytics");
  await grace.mutation(api.billing.open, {});
  const projects = [];
  for (const n of ["Website funnel", "Mobile retention", "Pricing experiment"]) projects.push(await grace.mutation(api.workspace.createProject, { name: n }));
  for (let i = 0; i < 6; i++) await grace.mutation(api.workspace.runExport, { projectId: projects[i % 3]!, format: "csv", idempotencyKey: key("exp") });
  const up = await grace.mutation(api.billing.changePlan, { planKey: "pro", priceKey: "pro-monthly", returnUrl: RETURN });
  log("grace chose Pro; paying on the hosted checkout:", await pay(grace, up.checkoutId!));
  log("grace is now on", (await grace.query(api.billing.summary, {}))!.subscription.planKey);
  for (const n of ["Churn model", "Q4 board deck", "Onboarding"]) await grace.mutation(api.workspace.createProject, { name: n });
  for (let i = 0; i < 412; i++) await grace.mutation(api.workspace.runExport, { projectId: projects[i % 3]!, format: i % 2 ? "pdf" : "csv", idempotencyKey: key("exp") });
  for (let i = 0; i < 40; i++) await grace.mutation(api.workspace.apiCall, { endpoint: "/v1/reports", idempotencyKey: key("api") });
  log("grace used", (await grace.query(api.billing.summary, {}))!.usage.map((u) => `${u.meter}=${u.used}`).join(" "));

  // An agent, issued by the operator, added to Acme with a spending policy and a delegation.
  const tenants = await grace.tenants();
  const acme = tenants.current!.id;
  const out = execFileSync("npx", ["feltkit", "session", "create", "--type", "agent", "--id", "agent-analyst", "--role", "agent", "--label", "Acme analyst agent"], { encoding: "utf8" });
  const token = out.match(/fks?_[A-Za-z0-9_-]{20,}/)?.[0] ?? out.trim().split(/\s+/).pop()!;
  await grace.addMember("agent-analyst", "agent");
  await grace.mutation(api.agents.setPolicy, { agentId: "agent-analyst", enabled: true, budgetPerPeriod: 300, perOperationLimit: 50, meters: ["agent.executions", "exports"], mayRequestPurchases: true });
  await grace.mutation(api.agents.delegateSpending, {});
  // Choosing a workspace rotates the session token (FeltKit replaces the session); MCP has no way to
  // choose one, so the agent switches over /api and uses the NEW token everywhere (gap FK-09).
  const switched = await (await fetch(`${URL_}/api/tenants/switch`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ tenantId: acme }) })).json();
  const agentToken: string = switched.token;
  const agent = createClient({ url: URL_, session: "bearer" });
  agent.setToken(agentToken);
  log("agent authority:", await agent.query(api.agents.myAuthority, {}));
  for (let i = 0; i < 25; i++) await agent.mutation(api.workspace.agentExecute, { task: `Summarize anomaly batch ${i + 1}`, idempotencyKey: key("run") });
  log("agent check before an export:", await agent.query(api.entitlements.check, { feature: "exports.monthly" }));
  log("agent asks for capacity:", await agent.mutation(api.agents.requestCapacity, { addonKey: "agent-500", justification: "Month-end close needs ~400 more summarisation runs." }));
  // MCP: what an agent sees, over the real endpoint.
  const mcp = async (method: string, params: unknown) => (await (await fetch(`${URL_}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${agentToken}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).text());
  await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "demo", version: "1" } });
  const tools = await mcp("tools/list", {});
  const names = [...tools.matchAll(/"name":"([a-z0-9_.]+)"/g)].map((m) => m[1]);
  const viaMcp = await mcp("tools/call", { name: "entitlements_check", arguments: { feature: "agents.executions.monthly" } });
  log("agent asks over MCP whether more runs are included:", viaMcp.slice(0, 240));
  log("MCP tools visible to the agent:", names.filter((n) => /entitlements|billing|usage|agents|capacity|catalog|workspace/.test(n!)).join(", ") || tools.slice(0, 300));

  // Linus: Globex on Free, near its limits.
  const linus = await as("linus");
  await linus.createTenant("Globex");
  await linus.mutation(api.billing.open, {});
  const g = await linus.mutation(api.workspace.createProject, { name: "Launch plan" });
  for (let i = 0; i < 9; i++) await linus.mutation(api.workspace.runExport, { projectId: g, format: "csv", idempotencyKey: key("exp") });
  await linus.createTenant("Initech");
  await linus.mutation(api.billing.open, {});
  log("Initech starts a Business trial:", await linus.mutation(api.billing.startTrial, { planKey: "business", priceKey: "business-monthly", seats: 3 }));
  log("done. Open", URL_);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
