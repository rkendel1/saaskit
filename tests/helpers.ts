/**
 * Test harness: a fresh FeltDB instance per test app, the seed catalog published, customer
 * workspaces provisioned through FeltKit tenancy, and the real payments component started through
 * FeltKit's public ComponentHost and reached over real HTTP (the Stripe simulator behind it).
 */
process.env.GATEWAY_WORK_MS ??= "20";
process.env.GATEWAY_CLOCK_MS ??= "3600000";

import { createServer, type Server } from "node:http";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { ComponentHost } from "@feltdb/feltkit/server";
import { api } from "../feltkit/_generated/api.ts";

export { api };
export const RETURN = "http://localhost:3000/billing";

export async function setup(): Promise<TestApp> {
  const t = await createTestApp();
  await t.as("ada").mutation(api.catalog.bootstrap, {});
  return t;
}

export async function workspace(t: TestApp, owner = "grace", name = "Acme") {
  const tenant = await t.provisionTenant(name, { id: owner, type: "user", roles: ["person"] });
  const c = t.as(owner, { tenant: tenant.id });
  await c.mutation(api.billing.open, {});
  return { accountId: tenant.id, c };
}

/** Add an agent principal to a workspace, as an operator provisions one. */
export async function addAgent(t: TestApp, accountId: string, agentId: string) {
  await t.tenancy!.provision({ tenantId: accountId, principal: { id: agentId, type: "agent", displayName: agentId }, role: "agent" }, "ada");
  return t.as({ id: agentId, type: "agent", roles: [] }, { tenant: accountId });
}

export interface Gateway {
  url: string;
  host: ComponentHost;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  get(path: string): Promise<{ status: number; body: any }>;
  /** Drive provider work and deliver every pending provider event. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export async function startGateway(t: TestApp): Promise<Gateway> {
  const host = await ComponentHost.start(t.runtime, { from: "sources", projectDir: process.cwd() });
  const server: Server = createServer((req, res) => {
    if (!host.handle(req, res, new URL(req.url ?? "/", "http://x").pathname)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(url + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: r.status, body: parsed as any };
  };
  const gw: Gateway = {
    url, host,
    post: (p, b, h) => call("POST", p, b ?? {}, h),
    get: (p) => call("GET", p),
    async settle() {
      // Two rounds: work may produce events whose handling records more work.
      for (let i = 0; i < 3; i++) {
        const r = await call("POST", "/stripe/sim/settle", {});
        if (r.status !== 200) throw new Error(`settle failed: ${JSON.stringify(r.body)}`);
        await new Promise((res) => setTimeout(res, 30));
      }
    },
    async close() {
      await host.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  return gw;
}

/** Complete a hosted checkout as the customer would, with a Stripe test card. */
export async function payCheckout(t: TestApp, gw: Gateway, c: ReturnType<TestApp["as"]>, checkoutId: string, card = "pm_card_visa") {
  await gw.settle();
  const checkout = await c.query(api.billing.checkout, { checkoutId });
  if (!checkout?.url) throw new Error(`checkout ${checkoutId} has no URL yet: ${JSON.stringify(checkout)}`);
  const sessionId = checkout.url.split("/checkout/")[1]!;
  const r = await gw.post(`/stripe/sim/checkout/${sessionId}/complete`, { card });
  await gw.settle();
  return r.body as { status: string };
}

/** Retry a call that may lose a race (CONFLICT is retryable by contract). */
export async function retrying<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if ((e as { code?: string }).code !== "CONFLICT" || !(e as { retryable?: boolean }).retryable || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (i + 1)));
    }
  }
}

export async function rejects(p: Promise<unknown>, code: string, hint?: string | RegExp) {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string; details?: any; hint?: string };
    if (err.code !== code) throw new Error(`expected ${code}, got ${err.code}: ${err.message}`);
    if (hint) {
      const h = err.details?.hint ?? err.hint ?? "";
      const ok = typeof hint === "string" ? h === hint || err.message?.includes(hint) : hint.test(`${h} ${err.message}`);
      if (!ok) throw new Error(`expected hint ${hint}, got ${h}: ${err.message}`);
    }
    return err;
  }
  throw new Error(`expected ${code}, but it succeeded`);
}
