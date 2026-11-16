# SaaS Business Engine (FeltKit reference commercial application)

Build an application, configure how you sell it, and let the platform handle the commercial
machinery: versioned plans and pricing, entitlements, usage metering, Stripe payments, the
subscription lifecycle, and agent spending authority, with an audit record for every decision.

- **Business console**: revenue/MRR, a structured catalog editor (draft, validate, publish with an
  effective date, grandfather or migrate, diff, roll back), customers with "why do they have this?"
  explanations and grants, invoices with refunds and reconciliation, verified payment events,
  anomalies, and the audit log.
- **Customer billing portal**: plan and status, next charge, usage meters, plan comparison with
  server-computed quotes, hosted checkout, invoices and receipts, payment method, agents (delegation,
  policies, purchase approvals), team and seats, and the metered product itself.
- **Agents**: commercial capabilities over AppPort and MCP (`entitlements.check`, `agents.authority`,
  `billing.quote`, `capacity.request`, `usage.reserve`…), gated by role, plan, per-agent policy and
  the owner's AuthBoundry delegation.

Screenshots: `docs/screenshots/`. Acceptance evidence: `docs/evidence/acceptance-transcript.md`.

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open the printed URL. In development you are signed in as a dev user (switch in the top bar):
**Ada** is the operator (business console), **Grace** and **Linus** are customers. Payments go to a
local Stripe-compatible simulator (test mode, no real money); its hosted checkout page opens like
Stripe's. On first run, the console offers to publish the starter catalog (Free, Pro, Business).

To fill a running dev server with realistic data (customers, usage, an agent, a trial), in a second
terminal:

```bash
npx tsx scripts/demo.ts
```

### Real Stripe (test mode)

Store the keys in FeltKit's credential custody (never in code or `.env` files you commit):

```bash
npx feltkit credential set credential-ref:stripe-secret-key
```

```bash
npx feltkit credential set credential-ref:stripe-webhook-secret
```

In production set `FELTKIT_CREDENTIAL_STRIPE_SECRET_KEY` and `FELTKIT_CREDENTIAL_STRIPE_WEBHOOK_SECRET`
and point Stripe's webhook at `https://<your-app>/stripe/webhook`. Live keys (`sk_live_…`) are refused
unless `STRIPE_ALLOW_LIVE=1`. This build has only been exercised against the simulator.

## Test it

```bash
npm test
```

33 tests (≈ 35 s): the pure engine, metering under concurrency, payment correctness through the real
payments component, the time-driven lifecycle, agent economics with a real private AuthBoundry, and the
24-step acceptance scenario.

## Where things are

| Path | What |
|---|---|
| `feltkit/app.ts` | Roles, tenancy, services, the payments component, AuthBoundry, collections |
| `feltkit/_catalog.ts`, `_engine.ts` | Catalog schema and validation; pure decision engine (entitlements, rating, proration, lifecycle) |
| `feltkit/_commerce.ts`, `_metering.ts`, `_payments.ts`, `_lifecycle.ts` | Shared state access, in-transaction metering/enforcement, applying verified payments, time-driven transitions |
| `feltkit/catalog.ts`, `billing.ts`, `usage.ts`, `entitlements.ts`, `agents.ts`, `payments.ts`, `lifecycle.ts`, `ops.ts` | Functions (operator, customer, gateway) |
| `feltkit/workspace.ts` | The monetized product: capabilities that declare the entitlements they need |
| `components/payments.ts`, `components/stripe/` | The only code that talks to Stripe; the simulator |
| `src/` | Customer portal and business console (React) |
| `tests/` | Tests and the acceptance scenario |

## Reports

- `docs/ARCHITECTURE.md`: capability map, domain/entitlement/metering/payments/lifecycle/agent models,
  security and financial-correctness report, remaining limitations.
- `FELTKIT_EXPERIENCE.md`: an evaluation of building this on FeltKit, the prioritised platform gap
  register, developer-experience scores, and the retrospective.
- `WORKAROUND_INVENTORY.md`: every workaround, why, and how to remove it; LOC figures.
- `docs/REMEDIATION_PLAN.md`: the evidence-maintained FeltKit/Boundry remediation plan built on these findings.

FeltKit's own documentation ships with the package: `npx feltkit docs`.
