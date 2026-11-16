# Building the SaaS Business Engine on FeltKit — a developer's evaluation

Written while building this repository, by the developer who built it (an AI coding agent, working
from an empty repository with `npm create feltkit@latest`). Every claim below points at a file, a
test, or a command I ran. Where I could not verify something, I say so.

- Platform: `@feltdb/feltkit` 0.3.30, `@feltdb/core` 0.21.0, `@appport/services` 0.19.0,
  `@authboundry/local` 0.1.0 (+ `@authboundry/core` 1.19.0 native server). Node 22.
- Outcome: the full 24-step acceptance scenario passes (`tests/acceptance.test.ts`,
  `docs/evidence/acceptance-transcript.md`); 33 tests pass in ~33 s.
- Raw notes taken during the build: `notes/dx-log.md`.

## Contents

1. [Summary](#1-summary)
2. [Feature-by-feature experience](#2-feature-by-feature-experience)
3. [Platform gap register (prioritised)](#3-platform-gap-register-prioritised)
4. [Developer-experience scores](#4-developer-experience-scores)
5. [Application bugs I made (not platform gaps)](#5-application-bugs-i-made-not-platform-gaps)
6. [Complexity and LOC](#6-complexity-and-loc)
7. [Retrospective, in the first person](#7-retrospective-in-the-first-person)

---

## 1. Summary

**What FeltKit did very well.** Transactions. Nearly every financially sensitive property of this
application — no lost usage increments under concurrency, no double-recorded usage, no double-applied
provider event, no business change without its audit record, no notification for a change that did not
commit — falls out of FeltKit's *checked reads + one transaction per mutation + after-commit outbox*,
with **zero locks, queues or idempotency tables written by me** beyond ordinary unique constraints.
The test that fires 20 concurrent exports at a 10-export allowance gets exactly 10 commits and 10
entitlement refusals, never a lost update (`tests/metering.test.ts`).

**Where I had to build infrastructure.** Everything that touches the payment provider: FeltKit's
integration layer cannot speak Stripe's form-encoded API (FK-01), its inbound-webhook lifecycle only
verifies AppPort's own signature scheme (FK-02), and there is no code-declared schedule (FK-03). The
documented escape hatch — a *runtime component* — is good, and I used it: 399 lines of
app-built infrastructure, all in `components/`.

**Where the platform's model fought the domain.** Tenancy. FeltKit's tenant-scoped collections are
an excellent default for *product* data (I use them for `projects`), but a commercial engine must act
across accounts (webhooks, renewals, operators), and there is no sanctioned cross-tenant access for
system principals (FK-04). I keep billing state keyed by an explicit `accountId` and enforce isolation
in my own code — the most important workaround in the codebase, because isolation is now my
responsibility, not the platform's.

**Agent story: strong primitives, one hole.** Roles, AuthBoundry delegation (`authority.local`, real
native server, proven executor credential), MCP discovery and per-call attribution all worked. But an
agent that only speaks MCP cannot choose a workspace, and choosing one over HTTP rotates its token
(FK-09).

**Would I choose FeltKit again for this?** Yes — see §7 for the honest version with caveats.

---

## 2. Feature-by-feature experience

Each section: **A** intended, **B** actual, **C** friction, **D** evidence.

### 2.1 Platform audit and upgrades (Phase A/B)

- **A.** Inventory the Boundry packages, upgrade to latest compatible.
- **B.** `create-feltkit` 0.3.30 scaffolded a working app; its own 8 tests passed in 2.6 s before I
  changed anything. The package ships its docs (`node_modules/@feltdb/feltkit/docs`, 21 files) and
  Agent Skills — the single best onboarding decision in the ecosystem: I never needed the network to
  learn an API. Version state:

  | Package | Installed (via FeltKit) | Latest on npm | Action |
  |---|---|---|---|
  | @feltdb/feltkit | 0.3.30 | 0.3.30 | current |
  | @feltdb/core | 0.21.0 | 0.21.0 | current |
  | @appport/services | 0.19.0 | 0.19.0 | current |
  | @appport/sdk | 1.8.1 | 1.9.0 | **not upgraded**: pinned exactly by FeltKit |
  | @appport/server | 1.3.2 | 1.3.3 | not upgraded (pinned) |
  | @appport/authorization | 1.1.1 | 1.2.0 | not upgraded (pinned) |
  | @appport/mcp | 1.3.8 | 1.3.9 | not upgraded (pinned) |
  | @appport/protocol, schema, integration, resolver-client | 1.5.0, 1.1.6, 1.2.5, 0.3.0 | same | current |
  | @authboundry/local | — | 0.1.0 | **added** (optional peer FeltKit needs for `authority.local`) |
  | @authboundry/core | — | 1.19.0 | added transitively (native server) |

- **C.** FeltKit pins `@appport/*` exactly and its release checks forbid `overrides`
  (`docs/ARCHITECTURE.md` "One copy of FeltDB"). So "upgrade the AppPort SDK" is not an application
  decision; it waits for a FeltKit release (FK-12). I chose not to force overrides: it would put the
  app on a combination FeltKit never tested. FeltDB "Intent" (`@feltdb/core/dist/intent.d.ts`) turned
  out to be natural-language→module planning, not a durable workflow engine; lifecycle workflows are
  therefore built from jobs/outbox/components (FK-13).
- **D.** `npm ls --depth=1`; `npm view <pkg> version` for each (session log).

### 2.2 Commercial catalog and versioning (Phase C)

- **A.** A versioned, validated commercial model; no plan conditionals in application code.
- **B.** One collection (`catalog_versions`) holding a schema-validated document per version
  (`feltkit/_catalog.ts`, `feltkit/catalog.ts`). FeltDB enforces the nested schema on every write, so a
  malformed catalog cannot be stored at all; business rules (`catalogProblems`) block publishing.
  Published versions are immutable; rollback republishes an old document as a new version; subscriptions
  pin a version (grandfathering) until an explicit migration at renewal. `sha256Hex` (pure, from
  FeltKit) gives content digests. `app.auditTrail` records every publish. About 450 LOC including the
  seed catalog; no infrastructure.
- **C.** Large nested schemas are verbose in `s.*` (the catalog schema is ~110 lines). I had to keep a
  parallel hand-written TypeScript `Catalog` type because inferring through `s.union`/`s.record` produced
  types too loose to be useful. A schema-to-type story for deep documents would help.
- **D.** `tests/engine.test.ts`, `tests/lifecycle.test.ts` ("catalog changes never rewrite existing
  customers…").

### 2.3 Entitlements and enforcement (Phase D)

- **A.** Applications ask for *features*, never plans; commercial entitlement and authorization are
  separate and both must allow.
- **B.** A pure engine (`feltkit/_engine.ts`, 163 LOC) evaluates plan → overrides → grants/add-ons,
  scoped grants, expiry, lapsed-state fallback. App capabilities call `requireFeature`, `requireLimit`,
  `rateLimit` or `consume` inside their own mutation (`feltkit/workspace.ts`). Authorization stays in
  FeltKit roles (`feltkit/app.ts`), checked before the handler on every interface. `entitlements.check`
  and `entitlements.list` are AppPort capabilities, so agents get the same answers over MCP.
- **C.**
  - FeltKit's tenancy *claims* (`app.requireClaim(ctx, "plan", ["pro"])`, `docs/AUTH.md`) actively
    advertise the plan-in-membership pattern that this mission calls an anti-pattern. It is fine for small
    apps, but there is no platform notion of an entitlement *contract* (value + source + usage). I did not
    use claims at all.
  - Seat limits vs. tenancy: workspace invitations/memberships are FeltKit routes, not my functions. I did
    not find a hook to refuse a membership change when `team.members.max` is reached, so seat limits are
    reported (Team tab) but **not enforced at invite time**. I did not exhaustively verify that no such
    hook exists; the `authorize` hook documentation covers functions only.
- **D.** `tests/metering.test.ts` (limits, rate limits), `tests/engine.test.ts` (evaluation),
  acceptance step 10.

### 2.4 Usage metering (Phase D)

- **A.** Durable, idempotent, attributed usage with reservations, adjustments, reconciliation; no
  financial calculation on projections.
- **B.** Append-only `usage_events` (unique on `(accountId, idempotencyKey)`) plus an authoritative
  `usage_counters` row written **in the same transaction** as each event and the business work. Checked
  reads make concurrent consumers conflict instead of losing increments; the payments component's
  `ctx.call` retries CONFLICT automatically. Reservations hold included allowance; the lifecycle clock
  expires abandoned ones. Adjustments are new events; invoiced periods refuse adjustment;
  `usage:reconcileCounters` recomputes counters from events. Thresholds notify once via
  `ctx.afterCommit.notifications`. CSV export uses the Files service (`ctx.services.files.upload`).
- **C.**
  - Retrying CONFLICT is every caller's job. The component's `ctx.call` retries 4×
    (`server/components.js:78-83`), but the browser client does not retry retryable errors
    (`client/index.js:213-236`), so a customer double-clicking under load can see a CONFLICT (FK-14).
  - After-commit effects run **as the caller**: my `usage_reporter` API-key role silently failed to send
    threshold notifications until I granted it `notifications.send` (found by the acceptance test). The
    mutation succeeded and the failure was only visible in `feltkit outbox list` — there is no
    application-readable API for failed effects, so my operator console cannot show them (FK-10).
- **D.** `tests/metering.test.ts` (6 tests, incl. 20-way concurrency and racing duplicate keys),
  acceptance steps 11–16.

### 2.5 Payments and Stripe (Phase E)

- **A.** Use the platform's integration and inbound-webhook machinery; keep the domain provider-neutral.
- **B.** What I expected to use, and what happened:

  | Expected | Reality | Used instead |
  |---|---|---|
  | `app.integration("stripe", …)` for API calls (credential custody, evidence, `verify` for unknown outcomes) | Bodies are always JSON (`runtime/integrations.js:288-289, 488`); Stripe requires form encoding | A runtime component calling Stripe itself (`components/stripe/stripe.ts`) — FK-01 |
  | `services.webhooks.inbound.stripe` (durable processing/failed/dead lifecycle, replay refusal) | Verifies only `x-appport-signature[-v2]` over `<ts>.<body>` (`@appport/services/docs/WEBHOOK-SECURITY.md:78-139`) | Component route `/stripe/webhook` verifying `Stripe-Signature`, then `payments:ingest` with a unique `provider_events` row as the replay defence — FK-02 |
  | — | `ctx.afterCommit.work` + `ctx.work.claim/finish` (leased, fenced, retried, `unknown` outcomes) | Exactly right for provider calls; no queue of my own |

  The provider boundary (`components/stripe/provider.ts`) keeps Stripe types out of `feltkit/`. A
  deterministic Stripe-compatible simulator (`components/stripe/simulator.ts`) speaks Stripe's HTTP,
  form encoding, Idempotency-Key and signature scheme, so the production client and verifier run
  unchanged in tests. Money state changes **only** on verified provider events or a server-to-server
  reconciliation read.
- **C.**
  - With FK-01/FK-02 fixed I would delete roughly 110 of the 399 infrastructure lines (form encoding,
    signature verification, the webhook route and its error mapping) and gain AppPort's dead-letter
    lifecycle, which I currently lack: a poison event is retried by Stripe until Stripe gives up.
  - **Not verified against real Stripe.** No Stripe test key was available in this environment. The
    client was exercised only against the simulator; real-API divergences (parameter names, 402 shapes)
    remain possible.
- **D.** `tests/payments.test.ts` (7 tests: forged/missing/stale signatures, redelivery, out-of-order,
  amount/account mismatch, declined card, off-session prorated upgrade + refund, reconciliation).

### 2.6 Subscription lifecycle (Phase F)

- **A.** Durable, idempotent, time-driven transitions with reasons and evidence.
- **B.** An explicit transition table (`_engine.ts`), `advanceAccount` per account per transaction
  (`_lifecycle.ts`), every transition audited with `transition: "a→b"`. Renewals bill arrears overage
  from authoritative counters; dunning retries; grace → suspension falls back to the default plan;
  cancellation keeps paid-through access; trials; scheduled downgrades; catalog migration at renewal.
- **C.** No code-declared schedule (FK-03): a schedule is created through Studio/AppPort by a person and
  runs as that person, and `ctx` has no schedules API. The lifecycle clock therefore lives in the payments
  component (`clock()`), which is the wrong owner for "subscriptions renew". Time-travel for tests is my
  own `asOf` argument (refused in production).
- **D.** `tests/lifecycle.test.ts` (6 tests).

### 2.7 Agent economics (Phase G)

- **A.** Application authorization, commercial entitlement and spending authority independently
  represented and enforced; discovery over MCP.
- **B.** Four gates, all exercised in `tests/agents.test.ts` and acceptance steps 17–18:
  1. FeltKit role `agent` (what the agent may call);
  2. plan entitlement `agents.enabled` + allowance;
  3. per-agent policy in the app (meters, budget, per-operation limit, purchase requests);
  4. **AuthBoundry**: the account owner's live delegation of `billing.agentspend` to the application's
     executor, decided by `ctx.authority.decide({ onBehalfOf })` on every chargeable operation. The
     decision id and delegation id are written into the audit event. Withdrawing the delegation stops
     the very next charge.

  `authority.local` started a real private AuthBoundry from the native binary, with no configuration
  beyond `feltkit({ authority })`, and reported `executorProof.proven: true`. That is impressive.
- **C.**
  - `ctx.authority.grants.grant` records the delegator as `user:<id>` but `decide({ onBehalfOf })` takes
    the id verbatim, so `onBehalfOf: "grace"` is denied with `delegation_missing` while
    `onBehalfOf: "user:grace"` is allowed (FK-07). I lost time to this; nothing in the error hinted at it.
  - `QueryCtx` does not declare `authority` though the runtime provides it (FK-06): I cast.
  - Native approvals (`approval: "required"`) run the approved mutation *as the proposer with the
    proposer's permissions*. For "an agent asks, a billing owner pays", the agent would need
    `billing.manage`, which defeats the separation, so I built a small `spend_requests` flow instead.
  - MCP + tenancy (FK-09), verified with curl against the dev server:
    `tools/call` → `FAILED_PRECONDITION: Choose a workspace first.`; switching via
    `POST /api/tenants/switch` returns a **new** token and revokes the old one immediately; the old token
    on `/mcp` then gets "An agent session token is required…", which is misleading.
- **D.** `tests/agents.test.ts`; `scripts/demo.ts` (agent over HTTP and MCP); `notes/dx-log.md`.

### 2.8 Customer portal and business console (Phase H)

- **A.** A coherent product, not admin pages.
- **B.** `src/` (1,254 LOC): customer portal (plan, banners for every state, next charge, meters,
  compare/quote/change, hosted checkout redirect, invoices/receipts, agents, team, the product itself)
  and business console (MRR/revenue, structured catalog editor with validation/publish/diff/rollback,
  customers with "why" explanations and grants, invoices with refunds/reconcile, provider events,
  anomalies, audit). **FeltKit's React auth components** (`SignIn`, `TenantSwitcher`, `CreateTenant`,
  `TenantSettings` with members and invitations, `AuthNotices`) picked up my CSS tokens and saved me an
  entire account/workspace UI. Live queries made every screen update without wiring.
  Screenshots: `docs/screenshots/`.
- **C.** `page.goto()` in Playwright never reached `load` while the live stream was open; I used
  `domcontentloaded`. Worth a line in the testing docs.
- **D.** `docs/screenshots/*.png` taken from a real `feltkit dev` server driven by Playwright, including
  a real redirect to the simulated hosted checkout and back.

### 2.9 Tooling

- `feltkit build` verified 80 functions, 16 capabilities, the schema contract, the frontend and the
  component bundle in one step.
- `feltkit measure` is an excellent idea and produced the LOC table in §6 — after I corrected it: it
  classified my runtime components (`components/`) as UI "experience" (FK-11).
- `feltkit codegen` accepted an invalid component principal that only failed at start (FK-05), although
  the error at start was exemplary.

---

## 3. Platform gap register (prioritised)

Severity: **High** = forced app-built infrastructure or a security-relevant burden; **Medium** = real
friction or a silent failure mode; **Low** = papercut.

| ID | Sev | Owner | Gap | Evidence (source / repro) | Workaround | Recommendation |
|---|---|---|---|---|---|---|
| FK-02 | High | AppPort Services (+FeltKit wiring) | Inbound webhooks verify only AppPort's signature scheme; Stripe-Signature (and other provider schemes) cannot use the durable inbound lifecycle (processing/failed/dead, replay) | `@appport/services/docs/WEBHOOK-SECURITY.md:78-139`; no `stripe` verifier in `dist/` (grep). Repro: register an integration, POST a Stripe-signed event → refused | Component route + `provider_events` unique key (W-02) | Pluggable verifiers with built-ins for Stripe (`t=,v1=`), Svix and GitHub; keep the lifecycle provider-neutral |
| FK-01 | High | FeltKit | `app.integration` operations always send JSON | `dist/runtime/integrations.js:288-289, 488`. Repro: any POST operation → `content-type: application/json` | Own Stripe client in a component (W-01) | `bodyEncoding: "json" \| "form"` per operation (Stripe, Twilio, many OAuth-era APIs) |
| FK-04 | High | FeltKit | No sanctioned cross-tenant access to tenant-scoped collections for system principals (components, operators, lifecycle) | `docs/AUTH.md` "No tenant in the call: closed"; `CollectionOptions.tenant` (`dist/app.d.ts:356-363`) | Billing keyed by explicit `accountId`; isolation enforced in app code via `callerAccountId` (W-06) | `tenant: { system: ["component:payments", "operator"] }`, each cross-tenant read audited |
| FK-09 | High (agent products) | FeltKit | An MCP-only agent cannot select a workspace; switching over HTTP rotates the token; the stale token's MCP error is misleading; `session create` has no `--tenant` | `dist/server/mcp.js:84`; curl transcript in `notes/dx-log.md` | Switch via `/api/tenants/switch`, use the rotated token (W-07) | `feltkit session create --tenant <id>`, an MCP `feltkit_workspace_switch` tool, and a precise "token was replaced" error |
| FK-03 | Medium | FeltKit / AppPort Services | No code-declared schedules; `ctx` has no schedules API; schedules run as their human creator | `ServicesConfig.schedules?: boolean` (`dist/runtime/services.d.ts:172`); no `schedules` on `ctx.services` (`dist/runtime/context.d.ts:173-181`) | Lifecycle clock in the payments component (W-03) | `services.schedules: { name: { every, handler, principal } }` in `feltkit/app.ts` |
| FK-07 | Medium (**fixed in 0.3.31**) | FeltKit | `ctx.authority.decide({ onBehalfOf })` is not mapped through `authority.principal`, while grants are | `dist/runtime/application-authority.js:33-51`; repro in `notes/dx-log.md` (deny `delegation_missing` → allow with `user:` prefix) | `authorityPrincipal()` in `_metering.ts` (W-05) | Map `onBehalfOf` like grants, or reject unprefixed ids with a hint |
| FK-10 | Medium | FeltKit | Failed after-commit effects are not readable by application code | Only `feltkit outbox list` / Studio; found when a threshold notice failed silently (acceptance) | None (role fixed) | `ctx.outbox.failed()` query or an `effect.failed` event apps can subscribe to |
| FK-14 | Medium | FeltKit client | Browser client does not retry `CONFLICT` with `retryable: true`; components do | `dist/client/index.js:213-236` vs `dist/server/components.js:78-83` | None in UI (remaining limitation) | Opt-in bounded retry for retryable errors in `useMutation` |
| FK-13 | Medium | Ecosystem docs | "Intent" (FeltDB) is NL→implementation planning, not durable workflows; there is no workflow/state-machine primitive | `@feltdb/core/dist/intent.d.ts` | State machine in `_engine.ts` + component clock | Document the intended home for durable workflows, or provide one |
| FK-06 | Low | FeltKit | `QueryCtx` lacks `authority` in its type | `dist/runtime/context.d.ts:145-163`; a query calling `ctx.authority.grants.list()` works at runtime | Cast (W-04) | Add it (read-only) to `QueryCtx` |
| FK-05 | Low | FeltKit | Component principal validated at start, not at definition/codegen (docs say definition) | `docs/COMPONENTS.md` Identity row; codegen accepted `payments-gateway` | — | Validate in `feltkit()` |
| FK-11 | Low | FeltKit measure | Runtime components classified as UI "experience" | `feltkit measure --json` before `feltkit.measure.json` | Declarations (W-08) | Classify files named in `feltkit({ components })` as infrastructure |
| FK-08 | Low | AuthBoundry local | Delegation ids are identical across separate AuthBoundry instances | Same id in test and dev environments (Agents screenshot) | — | Include an instance-unique component, or document determinism |
| FK-12 | Info (**largely fixed in 0.3.31**) | FeltKit release | `@appport/*` pinned exactly, behind latest | §2.1 table | — | Faster pin bumps, or ranges with conformance tests |
| FK-16 | High | FeltKit + AuthBoundry release | 0.3.31 requires an unpublished `@authboundry/local` (`registerAgent`) for agent-caller delegation; decisions return `unavailable` | §3.1 | Stay on 0.3.30 | Publish the AuthBoundry release first, or gate the new path behind capability detection that preserves the 0.3.30 behaviour; test the published combination |
| FK-17 | Medium | FeltKit tenancy | No hook at the membership boundary for commercial limits (seats) | §3.1 | Seat limits displayed, not enforced | A membership policy evaluated inside tenancy's write transaction |
| FK-15 | Info | FeltKit docs | Non-member calling with a tenant gets `FORBIDDEN` in tests vs `NOT_FOUND` wording in AUTH.md | `tests/metering.test.ts` isolation test | — | Align wording |

### 3.1 Re-verification against FeltKit 0.3.31 (published after this build)

Checked in the 0.3.31 package source (`npm pack @feltdb/feltkit@0.3.31`) and by upgrading this
application to it and running the full suite. Other packages had no newer release
(`@feltdb/core` 0.21.0, `@appport/services` 0.19.0, `@authboundry/local` 0.1.0, `@authboundry/core` 1.19.0).

| Gap | Status in 0.3.31 | Evidence |
|---|---|---|
| FK-07 | **Fixed.** `onBehalfOf: "ada"` is mapped through `authority.principal` as grants are; `"user:ada"`, `{ person }`, `{ principal }` also accepted (FRAME-GAP-11) | `dist/runtime/context.d.ts:333-340`, `dist/runtime/application-authority.js` `onBehalfOfPrincipal` |
| FK-12 | **Largely fixed.** Pins now `@appport/sdk` 1.9.0, `server` 1.3.3, `authorization` 1.2.0, `mcp` 1.3.9 (all latest) | `package.json`; `npm ls` after upgrade |
| FK-01, FK-03, FK-04, FK-06, FK-09 | Unchanged | `integrations.js` still sets `content-type: application/json`; `schedules?: boolean`; no system access on `tenant`; `QueryCtx` still lacks `authority`; no tenant handling in `server/mcp.js` |
| FK-16 (new, **High**) | 0.3.31 makes an agent caller decide **as itself** (per-agent delegation), which needs `registerAgent` from an `@authboundry/local` release that does not exist (0.1.0 is the only published version). Every agent-initiated `ctx.authority.decide` returns `outcome: "unavailable"`. The doc comment says an unregistered agent is "a deny, never an error"; the observed outcome is `unavailable`. Fails closed (safe), but delegated agent spending cannot work on any published package set | `dist/runtime/local-authority.js:38` (`NEEDS_AGENTS`), `:199-201`; upgrading this app turned `tests/agents.test.ts` and acceptance step 17 red with "Per-agent delegation needs @authboundry/local with registerAgent (after 0.1.0, authboundry 001ce42)" |
| FK-17 (new, Medium; was "unverified" in §2.3) | **Confirmed:** no extension point at the membership boundary. `invite`, `accept` and `addPrincipal` write memberships directly in tenancy's own transaction; the new `app.policy` layer covers functions only, and tenancy routes are not functions. Seat limits cannot be enforced atomically by an application | `dist/runtime/tenancy.js:198-227, 336-354, 387-432`; `docs/POLICIES.md` layer table |

Decision: this application stays on **0.3.30** until FK-16 is resolved (a published
`@authboundry/local` with `registerAgent`, and FeltKit's agent path tested against it). The W-05 removal
was made, tested and reverted; it is a one-line change once the upgrade is possible.

New in 0.3.31 and relevant: declarative `app.policy` rules, including a `delegated` condition decided
by AuthBoundry (`docs/POLICIES.md`). It could express "an agent may run this function on behalf of the
owner" declaratively. It cannot replace this app's spend gate, which only asks AuthBoundry when the
computed cost of a specific call is above zero.

---

## 4. Developer-experience scores

Scores are mine, for this build. 10 is best; for "custom infrastructure required", 10 means none.

### Phase C–D: domain, entitlements, metering

| Dimension | Score | Why |
|---|---|---|
| Discoverability | 9 | Docs and skills ship in the package; `inspect`, Studio, generated API |
| API ergonomics | 8 | `app.mutation` + `ctx.db` + `afterCommit` + `auditTrail` read naturally; deep schemas verbose |
| Type safety | 7 | Good inference for functions and docs; weak for nested `s.union`/`s.record` documents |
| Documentation | 9 | `TRANSACTIONS.md`, `GUARANTEES.md` are unusually honest and precise |
| Error handling | 9 | Codes + hints + `retryable`; refusal messages name the missing permission and the file to change |
| Testing experience | 9 | `createTestApp` per test, `t.as(…, { tenant })`, `t.provisionTenant`, 33 tests in 33 s |
| Operational visibility | 7 | Activity, outbox CLI, Studio; failed effects not app-readable (FK-10) |
| Custom infrastructure required | 9 | None for consistency, idempotency, audit, notifications |
| Overall | 8.5 | The core is the best part of the platform |

### Phase E: payments

| Dimension | Score | Why |
|---|---|---|
| Discoverability | 7 | Components and inbound webhooks are documented; that Stripe fits neither integration nor inbound took source reading |
| API ergonomics | 7 | `afterCommit.work` + `work.claim/finish` excellent; `ComponentHost` testable |
| Type safety | 7 | Component context well typed |
| Documentation | 7 | COMPONENTS.md explains *why* signature schemes are app-owned — helpful, but it is still my code |
| Error handling | 8 | Component start failures are precise |
| Testing experience | 9 | Real component over real HTTP in tests via public `ComponentHost.start` |
| Operational visibility | 7 | Component health in `/_feltkit/health`; my own `/stripe/status` for webhook stats |
| Custom infrastructure required | 5 | 399 LOC of provider plumbing (FK-01, FK-02) |
| Overall | 7 | Good escape hatch, missing the provider bridge |

### Phase F–G: lifecycle and agent economics

| Dimension | Score | Why |
|---|---|---|
| Discoverability | 7 | AuthBoundry local "just started"; MCP+tenancy gap discovered only by trying |
| API ergonomics | 6 | `onBehalfOf` mapping (FK-07); approvals model unsuited to "agent asks, owner pays" |
| Type safety | 6 | `QueryCtx.authority` missing (FK-06) |
| Documentation | 7 | Delegation semantics clear; principal mapping not |
| Error handling | 5 | `delegation_missing` with no hint; misleading stale-token MCP error |
| Testing experience | 8 | Real AuthBoundry in tests (~6 s first decision) |
| Operational visibility | 8 | Decision ids returned and auditable |
| Custom infrastructure required | 6 | Lifecycle clock in a component (FK-03); spend-request flow |
| Overall | 6.5 | Right primitives; seams between them need work |

### Phase H–I: UI, acceptance, tooling

| Dimension | Score | Why |
|---|---|---|
| Discoverability | 8 | React hooks and auth components obvious from the starter |
| API ergonomics | 9 | Live queries + `useMutation` + auth components |
| Type safety | 9 | Generated API typed end to end |
| Documentation | 8 | AUTH.md screens section is complete |
| Error handling | 8 | Client errors carry codes/hints |
| Testing experience | 7 | No FeltKit-provided UI test harness; Playwright `load` quirk |
| Operational visibility | 8 | `feltkit measure`, `build` verification |
| Custom infrastructure required | 9 | None |
| Overall | 8.5 | |

**Overall developer experience across the build: 7.5 / 10.**

---

## 5. Application bugs I made (not platform gaps)

Listed so they are not mistaken for platform defects:

1. Dunning and grace were anchored to when the failure *event arrived*, not when money was due
   (`_payments.ts`; fixed, `tests/lifecycle.test.ts`).
2. A mid-period upgrade would have silently forgiven overage accrued under the old plan (fixed with
   `billedUnits`; regression test "an upgrade settles overage accrued under the old terms").
3. A module-level catalog cache keyed by version number would leak between FeltDB instances (removed).
4. `onDone?.(await run())` never evaluated `run()` when `onDone` was absent: every such UI button was
   inert (found only by the Playwright walkthrough; `src/ui.tsx`).
5. Plan cards showed "unlimited" as 0 (`null ?? 0`); error notices rendered under modal dialogs.
6. My `usage_reporter` role lacked the permissions its after-commit effects need.

---

## 6. Complexity and LOC

From `feltkit measure` with the declarations in `feltkit.measure.json` (report kept in
`docs/evidence/measure.json`):

| Class | Files | LOC |
|---|--:|--:|
| Domain (`feltkit/`) | 16 | 2,929 |
| Experience (`src/`, html, css) | 5 | 1,254 |
| App-built infrastructure (`components/` minus simulator) | 3 | 399 |
| Configuration | 4 | 87 |
| Tests (incl. Stripe simulator 222, demo script 82) | 10 | 1,234 |
| **Authored (domain+experience+infra+config)** | 28 | **4,669** |

Workaround share (details in `WORKAROUND_INVENTORY.md`): about **220 LOC** exist only because of
FK-01/02/03/04/06/07, i.e. ~4.7 % of authored code — small in lines, large in responsibility (webhook
security, cross-account isolation). Code I did **not** have to write because the platform provided it
(rough, from comparable systems I would otherwise build): transaction/concurrency control and
idempotency (~300), outbox for notifications/webhooks/provider work (~400), audit trail (~150),
sessions/accounts/workspaces/invitations and their UI (~1,500), credential custody (~200),
AuthBoundry server management (~300), MCP server (~400). Those are estimates, not measurements.

---

## 7. Retrospective, in the first person

**1. What was surprisingly easy?** Correctness under concurrency. I wrote metering the naïve way —
read the counter, decide, write the counter and the event — and FeltKit's checked reads made it
correct. The 20-way race test passed the first time. Testing the real payments component over real
HTTP inside `createTestApp` was also far easier than I expected.

**2. What was surprisingly difficult?** Agents and workspaces over MCP, and the AuthBoundry principal
mapping. Both failures looked like "permission denied" with nothing pointing at the cause.

**3. Where did FeltKit eliminate substantial code?** Transactions + after-commit outbox (no queues, no
idempotency service), `app.auditTrail`, accounts/workspaces/invitations with ready React screens,
credential custody, the private AuthBoundry, MCP exposure of my capabilities with no extra code,
component durable work with leases and `unknown` outcomes.

**4. Where did I write infrastructure that should have been provided?** Stripe outbound client (FK-01),
Stripe webhook verification and replay defence (FK-02), the lifecycle clock (FK-03), cross-account
isolation for billing (FK-04).

**5. Especially good APIs:** `ctx.afterCommit.*`, `ctx.afterCommit.work` + `ctx.work.claim/finish`,
`app.auditTrail`, `createTestApp().as(who, { tenant })`, `ComponentHost.start`, `feltkit build`,
`feltkit measure`, error hints.

**6. Awkward or confusing APIs:** `ctx.authority.decide` vs grants principal mapping; tenancy claims that
invite plan-checks; `approval: "required"` running as the proposer (correct for its purpose, wrong for
spend approval); deep `s.*` schemas.

**7. Packages that worked particularly well together:** FeltKit + FeltDB (transactions), FeltKit +
AppPort Services (outbox, files, notifications), FeltKit + AuthBoundry local (zero-config delegation).

**8. Unclear package boundaries:** where provider-specific webhook verification belongs (COMPONENTS.md
says the application; WEBHOOK-SECURITY.md implies AppPort Services); where durable workflows belong
("Intent" is not it); who owns schedules for application principals.

**9. Missing capabilities:** form-encoded integrations; provider webhook verifiers; code-declared
schedules; cross-tenant system access; MCP workspace selection; app-readable failed effects; client
retries for retryable errors.

**10. Workarounds I eliminated:** I replaced my policy-only agent spending gate with a real AuthBoundry
delegation (the policy remains as the per-agent layer), removed a cross-instance cache, and avoided
building an audit log, an outbox, a job queue for provider calls, and an account/workspace UI by
checking the platform first. I did not have a chance to eliminate any of the FK-01..04 workarounds:
none of those capabilities exist in the current releases (verified in source, §3).

**11. Workarounds that remain:** W-01…W-08 in `WORKAROUND_INVENTORY.md`.

**12. What prevented me from building faster?** Reading platform source to answer "is this supported?"
(integrations, inbound webhooks, schedules, tenancy). The docs are good about what *is* supported and
quieter about what is not.

**13. What would I change about FeltKit?** Ship a payments-grade inbound/outbound provider bridge
(FK-01/02), a system-principal story for tenancy (FK-04), and make agents-in-workspaces work over MCP
(FK-09). Those three would have removed most of my infrastructure and my biggest risk.

**14. Fix before another developer builds a similar app:** FK-02, FK-04, FK-09, FK-07, FK-10, in that
order.

**15. Would I choose FeltKit again for an application of this complexity?** Yes. The transactional core,
outbox, audit trail, tenancy and testing harness carried most of the weight of a financially sensitive
system, and every place it fell short had a documented, testable escape hatch (components). I would
choose it knowing I will own the provider bridge and cross-account isolation until FK-01/02/04 land —
and I would budget time to read source, because "not supported" is rarely stated.
