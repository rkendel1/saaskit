# SaaS Business Engine — architecture, models and correctness

> The developer defines the business model. The platform enforces the commercial rules. Payment
> providers process money. Durable records establish what happened.

## 1. Capability map: who owns what

| Concern | Owner | How it is used here |
|---|---|---|
| Durable state, transactions, consistency | **FeltDB** (via FeltKit `ctx.db`) | One instance per environment. Every mutation is one transaction with checked reads (phantoms included); unique constraints are replay and idempotency defences |
| Application functions, roles, React client, testing | **FeltKit** | `feltkit/*.ts` functions; roles in `feltkit/app.ts`; `createTestApp`; live queries |
| Capability contracts and invocation | **AppPort** | 16 functions declare `capability` (catalog.offer, entitlements.check/list, billing.quote, usage.ingest/reserve/commit/release, agents.authority, capacity.request, workspace.*); exposed on `/appport` and `/mcp` |
| Notifications, webhooks out, files, jobs, API keys, credentials | **AppPort Services** (in the same FeltDB) | `ctx.afterCommit.notifications/webhooks`, `ctx.services.files`, API keys for `usage_reporter`, credential custody for Stripe keys |
| Workspaces (customer accounts), members, invitations, sign-in | **FeltKit tenancy + accounts** | Workspace = billing account. Product data (`projects`, `agent_runs`) is `tenant: true` |
| Delegated authority | **AuthBoundry** (`authority.local`, native server) | Owner delegates `billing.agentspend`; decided on every chargeable agent operation |
| Agent discovery and invocation | **MCP** (FeltKit `/mcp`) | Agents list and call the commercial capabilities |
| Provider integration (Stripe) | **Application component** `components/payments.ts` | Verified webhooks in, durable provider work out, lifecycle clock (platform gaps FK-01/02/03) |
| Commercial decisions (pricing, entitlements, rating, lifecycle) | **Application** (`feltkit/_engine.ts` etc.) | Pure, tested, provider-neutral |
| Model/provider resolution | **Resolver** | Not needed: no model calls in the commercial path (AI is not part of the product's correctness) |
| Application packaging | **AppBoundry** | Not used: the app uses accounts, tenancy and a component, which AppBoundry hosts do not run yet (FeltKit docs, FK-GAP-013) |

```
 Browser / agent (MCP) / server (API key)
          │  roles checked by FeltKit (AppPort authorizer) on every call
          ▼
 feltkit/*.ts functions ── commercial engine (_engine.ts, pure) ── AuthBoundry (agent spend)
          │ one FeltDB transaction: business write + usage event + counter + audit + outbox
          ▼
 FeltDB ── outbox ──► notifications / webhooks / work for "payments" component
                                            │
                     components/payments.ts ├─► Stripe API (form-encoded, Idempotency-Key)
                                            └◄─ Stripe webhooks (Stripe-Signature) ─► payments:ingest
```

## 2. Commercial domain model

| Collection | Purpose | Key invariants |
|---|---|---|
| `catalog_versions` | Whole-catalog documents: products, plans, prices, features, meters, overage rules, add-ons, coupons | `version` unique; published versions immutable; publish blocked while `catalogProblems` ≠ ∅; rollback = new version |
| `accounts` | One per workspace: owner, billing email, provider customer, card on file | `accountId` unique (= workspace id) |
| `subscriptions` | One per account: plan, price, **pinned catalog version**, seats, status, period, trial, grace, scheduled change, pending purchase, coupon | `accountId` unique; status changes only along `TRANSITIONS` |
| `invoices` | Server-computed lines (subscription, proration, overage, add-on, discount) | `number` unique and gap-free (FeltDB sequence); totals never from clients |
| `payment_attempts`, `refunds`, `checkouts` | Every attempt to move money, with provider references | Settled only by verified provider events or reconciliation |
| `provider_events` | Every verified provider event and what it did | `(provider, eventId)` unique: replay defence |
| `usage_events` | Observed usage, append-only (corrections are new events) | `(accountId, idempotencyKey)` unique |
| `usage_counters` | Authoritative running totals per account/meter/period: `used`, `reserved`, `billedUnits`, `invoicedAt` | Written in the same transaction as each event |
| `usage_reservations`, `rate_windows` | Held capacity; per-minute counters | Reservations expire via the lifecycle clock |
| `entitlement_grants` | Operator overrides, temporary grants, purchased add-ons | Revoked, never deleted |
| `agent_policies`, `agent_spend`, `spend_requests` | Per-agent authority, per-period spend, purchase requests | One policy per (account, agent) |
| `billing_audit` | `app.auditTrail`: every material decision with actor, request id, per-subject sequence | Same transaction as the change |

## 3. Entitlement and policy model

- **Features** are typed: `boolean`, `limit` (live count), `allowance` (metered per period, draws from a
  meter), `rate` (per minute). Scope: account (user/agent scopes via scoped grants).
- **Effective value** = plan value (from the subscription's pinned catalog version, if its status grants
  the plan; otherwise the default plan) → overrides replace → grants and this period's add-ons add.
  `null` = unlimited. Every value carries its `sources`, so "why" is always answerable
  (`entitlements:explain`).
- **Overage** per meter and plan: `block`, `charge` (unitAmount per `perUnits`, optional `hardCap`),
  or `allow`.
- **Decisions** (`decide`) return `allowed`, a code (`included`, `overage`, `not_entitled`,
  `limit_reached`, `allowance_exhausted`, `rate_limited`), remaining, overage units and cost.
- **Enforcement** happens inside the capability's own mutation (`requireFeature`, `requireLimit`,
  `rateLimit`, `consume`), never in the UI. Application code names features, never plans
  (`feltkit/workspace.ts` contains no plan key).
- **Authorization vs entitlement:** FeltKit roles decide *who may call*; the engine decides *what the
  account bought*; both must allow. Example: member Marie may use analytics (role ✓, entitlement ✓) but
  may not cancel (role ✗); a Free workspace's owner may call analytics (role ✓) but is refused
  (entitlement ✗).
- **Configuration lifecycle:** draft → publish (optionally with an effective date) → grandfather or
  migrate at renewal → rollback as a new version. Configuration changes take effect on the next call:
  no redeploy (acceptance step 20 asserts the runtime instance is unchanged).

## 4. Usage metering

Observed (`usage_events`) → reserved (`usage_counters.reserved`, `usage_reservations`) → billable
(beyond allowance, priced by the plan at the time of use: `disposition`, `estimatedCost`) → invoiced
(`billedUnits` mid-period, `invoicedAt/invoiceId` at period close). Financial calculations read only
counters and events, never UI projections. Duplicates: idempotency key per account; a reused key with
different content is a `CONFLICT` (`IDEMPOTENCY_MISMATCH`). Concurrency: checked reads; losers retry.
Reconciliation: `usage:reconcileCounters` recomputes counters from events. Exports: CSV via the Files
service. Thresholds at 80 % and 100 % notify once per period.

## 5. Payments

- **Provider boundary**: `components/stripe/provider.ts` (`PaymentProvider`, `NormalizedEvent`). Only the
  component knows Stripe.
- **Outbound**: a mutation records durable work in its own transaction (`checkout.create`,
  `invoice.charge`, `refund.create`, `payment.reconcile`); the component claims it under a lease, calls
  Stripe with a stable Idempotency-Key (`charge:<invoice>:<attempt>`), and reports references
  (`payments:workResult`). Retryable failures retry with backoff; non-retryable ones are recorded.
- **Inbound**: `POST /stripe/webhook` verifies `Stripe-Signature` (HMAC-SHA256 over `t.body`, constant
  time, 5-minute tolerance, rotation-friendly multiple `v1`), normalizes, enriches card details from the
  provider API (never from the sender), and calls `payments:ingest` as `component:payments`.
- **Ingest**: first write is the `provider_events` row (unique), in the same transaction as its effects.
  Checks: invoice exists, account matches, amount and currency equal the server-computed total, invoice
  is still open. Out-of-order: a late failure for a paid invoice is `stale`; checkout completion grants
  nothing by itself. Anomalies are recorded, never thrown (a throw would make the provider retry forever).
- **Model**: engine-rated, provider-charged. The engine computes every invoice; Stripe moves money. Plans
  are not mirrored into Stripe products/prices, so there is one source of commercial truth.

## 6. Subscription lifecycle

States: `incomplete`, `trialing`, `active`, `past_due`, `suspended`, `canceled`, `expired` with an
explicit transition table. Time-driven transitions run per account, one transaction each
(`lifecycle:advance`), idempotent: renewal notices (3 days), renewals (next period + arrears overage,
scheduled changes, migrations), trial notices/conversion/expiry, dunning (retry days 1/3/5 counted from
the due date), grace → suspension (access falls back to the default plan), cancellation completion
(final overage invoice, back to the default plan), reservation expiry. Upgrades are prorated (credit
floored, charge ceiled; accrued overage settled under the old terms); downgrades follow the current
plan's policy; cancellation follows the plan's `cancellation` policy. Every transition is audited with
its reason and evidence.

## 7. Agent economics

| Gate | Representation | Enforced by |
|---|---|---|
| Application authorization | workspace role `agent` | FeltKit roles, every interface |
| Commercial entitlement | `agents.enabled`, `agents.executions.monthly` | `consume` |
| Per-agent spending authority | `agent_policies`: meters, budget per period, per-operation limit, may request purchases | `consume` (budget and limit checked before any write) |
| Person's delegation | AuthBoundry delegation `billing.agentspend` (owner → app executor) | `ctx.authority.decide({ onBehalfOf })` on every chargeable operation; decision and delegation ids audited |

Agents discover their authority (`agents.authority`), ask before acting (`entitlements.check` returns
`agent.authorized` and remaining budget), and request capacity (`capacity.request`), which only a person
with `billing.manage` can approve. Usage carries `actorType: agent`, `agentId` and `onBehalfOf`.

## 8. Security and financial correctness report

| Property | How it holds | Evidence |
|---|---|---|
| Tenant isolation | Product data tenant-scoped by FeltKit; billing functions derive the account from the session's workspace, never an argument | `tests/metering.test.ts` "tenant isolation and role separation" |
| Account ownership / customer access | Workspace roles; non-members of a workspace get no role there | same |
| Administrator permissions | `ops.*`, `catalog.*` only on `operator` | same; `catalog.publish` refused for customers |
| Delegated authority | AuthBoundry delegation per person; withdrawable | `tests/agents.test.ts` |
| Agent spending restrictions | Policy + budget + per-operation limit + delegation + entitlement | `tests/agents.test.ts` (3 tests) |
| Webhook verification | Stripe-Signature, timestamp window, constant-time compare | `tests/payments.test.ts` (forged, missing, stale) |
| Duplicate events | Unique `(provider, eventId)` in the effect's transaction | redelivery ×3 → applied once |
| Out-of-order events | State-guarded application; stale failures ignored | reverse-order delivery test; late-failure test |
| Concurrent usage | Checked reads + counters in the same transaction | 20-way race test |
| Duplicate usage | Unique idempotency key; mismatch refused | racing duplicate test; `IDEMPOTENCY_MISMATCH` |
| Refunds | Bounded by `amountPaid − refunded/in-flight`; settled only by provider event | prorated-upgrade test |
| Failed payments | Dunning, grace, suspension, recovery on new card | `tests/lifecycle.test.ts` |
| Subscription transitions | Explicit table; every transition audited | engine test; lifecycle tests |
| Entitlement changes | Versioned catalog; grandfathering; migrations only at renewal | catalog-versions lifecycle test |
| Historical billing correctness | Pinned versions; overage priced at time of use; mid-period upgrade settles old-terms overage; invoiced periods cannot be adjusted | overage-on-upgrade test; usage adjust test |
| Payment secrets | Only credential references (`stripe-secret-key`, `stripe-webhook-secret`) in FeltKit custody; live keys refused unless `STRIPE_ALLOW_LIVE=1`; no secret in FeltDB, code, logs or the UI | `components/payments.ts` |
| Client-provided prices / entitlements | Never accepted: quotes and invoices computed server-side from the catalog; the provider's paid amount must equal the invoice | amount-mismatch test |
| Client-reported payment status | Ignored: only verified provider events or reconciliation reads change money state | acceptance step 5 ("still Free until paid") |
| Audit trail | `billing_audit` for every material decision; `provider_events` for every provider event | acceptance step 24 |

## 9. Remaining limitations (known, not hidden)

- **Not run against real Stripe test mode** (no key in this environment). The client was exercised
  against the Stripe-compatible simulator only.
- Seat limits (`team.members.max`) are shown but not enforced when members are invited through
  FeltKit's tenancy routes.
- The browser UI does not retry retryable `CONFLICT`s (FK-14); under contention a user may need to click
  again.
- `lifecycle:due` scans all subscriptions (fine for thousands of accounts, not millions).
- Single currency per catalog; no tax calculation; immediate downgrades issue no credit; dunning stops
  after three retries without marking the invoice `uncollectible` automatically.
- Agent budgets count overage cost only, not included allowance consumption.
- Billing isolation is application-enforced (FK-04).
- Agents using only MCP cannot select a workspace (FK-09).
