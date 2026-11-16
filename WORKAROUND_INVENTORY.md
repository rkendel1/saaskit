# Workaround inventory

Every place this application does something the platform should own, why, whether the current
platform releases support it natively (checked in the installed source, FeltKit 0.3.30 /
AppPort Services 0.19.0 / AuthBoundry local 0.1.0), and what removing it would take.
Gap IDs refer to `FELTKIT_EXPERIENCE.md` §3.

## Summary

| Metric | Value | Source |
|---|--:|---|
| Authored application code (domain + experience + infrastructure + config) | 4,669 LOC | `feltkit measure` |
| Domain / application code | 2,929 LOC | `feltkit measure` (feltkit/) |
| App-built infrastructure | 399 LOC | `feltkit measure` (components/, simulator excluded) |
| Workaround code (lines that exist only because of a platform gap) | ≈ 210 LOC | counted per item below |
| Tests supporting the implementation | 33 tests, 1,234 LOC (incl. 222-line Stripe simulator) | `npx feltkit test`, `feltkit measure` |
| Workarounds remaining | 8 | this file |
| Workarounds eliminated during the build | 4 (plus 4 avoided by using native features first) | below |

## Remaining workarounds

| ID | What | Reason (gap) | Native now? | LOC | Where | Removal plan |
|---|---|---|---|--:|---|---|
| W-01 | Own Stripe HTTP client (form encoding, Idempotency-Key, error mapping) called from a component | FK-01: `app.integration` is JSON-only | No (`runtime/integrations.js:288`) | 35 | `components/stripe/stripe.ts` (`formEncode`, `request`) | Declare `app.integration("stripe", …)` with form encoding; move calls to `ctx.integrations.invoke`, gain `verify` for unknown outcomes |
| W-02 | Stripe-Signature verification, webhook route, replay defence via unique `provider_events` | FK-02: inbound lifecycle verifies only AppPort signatures | No (`WEBHOOK-SECURITY.md:78-139`) | 58 (18 verify + 30 route + 10 dedup) | `components/stripe/stripe.ts`, `components/payments.ts` (`receive`), `feltkit/payments.ts` | Register a Stripe inbound integration; handler = `payments:ingest`; keep `provider_events` as the business record but drop replay logic; gain dead-letter handling |
| W-03 | Lifecycle clock inside the payments component | FK-03: no code-declared schedules, none runnable as a declared principal | No (`services.schedules?: boolean`, no `ctx.services.schedules`) | 53 (15 clock + 25 `lifecycle.ts` + 13 `dueAccounts`) | `components/payments.ts` (`clock`), `feltkit/lifecycle.ts`, `feltkit/_lifecycle.ts` | Declare a schedule in `feltkit/app.ts` running `lifecycle:advance` fan-out as an app principal |
| W-04 | Cast `QueryCtx` to `MutationCtx` to read `ctx.authority` | FK-06 | No (type only; runtime works) | 1 | `feltkit/agents.ts` (`myDelegations`) | Delete the cast when the type is fixed |
| W-05 | `authorityPrincipal()` adds `user:` before `onBehalfOf` | FK-07 | **Yes in 0.3.31**, but upgrading is blocked by FK-16 (removal made, tested, reverted) | 3 | `feltkit/_metering.ts` | Delete when `decide` maps through `authority.principal` |
| W-06 | Billing state keyed by explicit `accountId`; customer functions derive it from the session (`callerAccountId`) and never accept it as an argument | FK-04: no cross-tenant access for system principals | No (`docs/AUTH.md`: closed without a tenant) | 3 (helper) + 44 call sites | `feltkit/_commerce.ts` and every customer function | Make billing collections `tenant: true` with a declared system reader for `component:payments` and operators; delete `callerAccountId` |
| W-07 | Agents choose a workspace over `/api/tenants/switch` and must use the rotated token for MCP | FK-09 | No (`server/mcp.js`, no `--tenant` on `session create`) | 6 | `scripts/demo.ts` | `feltkit session create --tenant`, or an MCP workspace tool |
| W-08 | `feltkit.measure.json` declarations so runtime components count as infrastructure | FK-11 | No | config | `feltkit.measure.json` | Delete when measure reads `feltkit({ components })` |

W-06 is the most important item: it is only 3 lines of helper, but it makes **customer isolation of
billing data an application responsibility**. It is covered by `tests/metering.test.ts`
("tenant isolation and role separation") and by the rule that no customer-facing function takes an
`accountId` argument (grep `feltkit/billing.ts`, `usage.ts`, `agents.ts`, `entitlements.ts`,
`workspace.ts`: only operator (`ops.*`) and gateway (`payments.*`, `lifecycle.*`) functions do).

Not counted as workarounds (they are product decisions): the provider-neutral boundary
(`components/stripe/provider.ts`), the Stripe simulator (a test double), the `spend_requests` approval
flow (native `approval: "required"` runs as the proposer, which is the wrong authority for "agent asks,
owner pays" — a design difference, not a defect).

## Eliminated or avoided

| ID | Original approach | Native capability used instead | Verified by | Complexity removed |
|---|---|---|---|---|
| E-1 | Agent spending gated only by an application policy table | AuthBoundry delegation via `feltkit({ authority: { local: true } })`, decided on every charge; the policy stays as the per-agent layer | `tests/agents.test.ts` (refused before delegation, allowed after, refused after withdrawal; decision ids in audit) | A self-built consent store would have duplicated AuthBoundry |
| E-2 | Module-level cache of catalog versions | Read the immutable version each time | Removed before tests; noted because it would leak across FeltDB instances | Cache invalidation code and a correctness risk |
| E-3 | Planned: own outbox/job table for provider calls | `ctx.afterCommit.work` + `ctx.work.claim/finish` (leases, fencing, retries, `unknown`) | `tests/payments.test.ts`, `tests/lifecycle.test.ts` | ≈ 200–300 LOC of queue code not written |
| E-4 | Planned: own audit table | `app.auditTrail` (per-subject FeltDB sequence, same transaction) | Every lifecycle/payments/agent test reads it | ≈ 100–150 LOC not written |
| A-1 | Planned: own sign-in, workspace switcher, members/invitations UI | FeltKit React `SignIn`, `TenantSwitcher`, `CreateTenant`, `TenantSettings`, `AuthNotices` | `docs/screenshots/*` | An entire account UI not written |
| A-2 | Planned: own notification store | AppPort Services notifications via `ctx.afterCommit.notifications` (deduplicated by key) | `tests/lifecycle.test.ts`, acceptance steps 13–15 | — |
| A-3 | Planned: own file storage for usage exports | `ctx.services.files.upload` | `usage:exportCsv` (manual, UI) | — |
| A-4 | Planned: own MCP server for agents | FeltKit `/mcp` exposes every `capability` | `scripts/demo.ts`, curl transcript in `notes/dx-log.md` | — |

E-3/E-4/A-1…A-4 were "avoided" (checked the platform before building), not built and later deleted; I
list them separately so the numbers are not inflated. LOC figures for avoided code are estimates.

## Regression coverage for each remaining workaround

| ID | Test |
|---|---|
| W-01 | `tests/payments.test.ts` (prorated upgrade charges the card off-session through the client) |
| W-02 | `tests/payments.test.ts` (forged/missing/stale signatures; redelivery; out-of-order; mismatch) |
| W-03 | `tests/lifecycle.test.ts` (all six) |
| W-05 | `tests/agents.test.ts` (delegation allow/deny) |
| W-06 | `tests/metering.test.ts` (tenant isolation and role separation) |
| W-07 | `scripts/demo.ts` (manual against `npm run dev`) |
