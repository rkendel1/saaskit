# FeltKit and Boundry remediation plan

An evidence-maintained plan, not a wishlist. Each item states its status, the evidence for it, the
owning package and its acceptance criteria. Update the status table when the evidence changes; do
not edit the historical documents it is built on.

> Boundry needs to prove not just that its individual products work, but that the published
> combination works. That is a platform guarantee in its own right.

## Evidence base

| Source | Versions | Role |
|---|---|---|
| `FELTKIT_EXPERIENCE.md` §1–7, `WORKAROUND_INVENTORY.md` | FeltKit 0.3.30, AppPort Services 0.19.0, @feltdb/core 0.21.0, @authboundry/local 0.1.0 (+ core 1.19.0) | Original evaluation. **Historical: not rewritten** |
| `FELTKIT_EXPERIENCE.md` §3.1 (dated addendum) | FeltKit 0.3.31 (published 2026-11-16 22:04 UTC); AppPort sdk 1.9.0, server 1.3.3, authorization 1.2.0, mcp 1.3.9; Services, FeltDB core, AuthBoundry unchanged | Re-verification: package source read (`npm pack`), application upgraded and the full suite run |
| This application | Runs on **0.3.30** (33/33 tests, 24/24 acceptance steps) | Regression target for every remediation |

**Unverified.** Only *published* packages were inspected. Unreleased work in the AppPort, AuthBoundry
and FeltDB repositories was not visible and is neither confirmed nor ruled out; an item below may
already be in progress there.

## Status

| ID | Item | Owner | Priority | Status | Evidence |
|---|---|---|---|---|---|
| FK-16 | **Cross-package release integrity** | FeltKit + AuthBoundry release process | **P1 — release gate** | **Candidate 4 prepared and verified, NOT published; independent review pending** (2026-11-17) | Confirmed in 0.3.31: `registerAgent` from an unpublished `@authboundry/local`; agent decisions `unavailable`; also two more unmet prerequisites (`@appport/services` inbox, `@feltdb/core` set membership). Option 2 candidate 0.3.32 (default unchanged, explicit `agentCallers: "executor-grants"` opt-in, prerequisites gate) passes the release dry run up to the npm-credential stop and the fresh-install gate: `docs/evidence/release/fk16-option2/` |
| FK-18 | Intermittent FeltKit test: `policies.test.ts` "input decides…" | FeltKit tests | P2 | Confirmed, pre-existing (separate from FK-16) | Fails 3/40 on **unmodified 0.3.31**; its assertion `!JSON.stringify(decisions).includes("500")` also matches random ids/timestamps. A flaky test cannot gate a release: assert on the specific field instead |
| FK-19 | Release test environment not isolated from ambient `FELTDB_*` variables | FeltKit release process | P2 | Confirmed (separate from FK-16) | With the container's `FELTDB_URL`/`MODE`/`APPLICATION_ID`/`NAMESPACE`/`ENVIRONMENT` set, 24 build/deploy/platform tests fail on both 0.3.31 and the candidate; all 49 in those files pass with them unset. The release run should start its tests from an explicit, clean environment rather than inherit the operator's shell |
| FK-04 (+FK-17) | System, operator and membership authority over tenant-scoped data | FeltKit + FeltDB + AuthBoundry | **P1** | Confirmed (0.3.30, unchanged 0.3.31) | `docs/AUTH.md` (closed without a tenant); FK-17: `tenancy.js` `invite`/`accept`/`addPrincipal` write without a policy point |
| FK-09 | Workspace-bound agent sessions over MCP | FeltKit + AppPort MCP | **P1** | Confirmed (unchanged 0.3.31) | `server/mcp.js` has no tenant handling; switch rotates token; misleading stale-token error |
| FK-02 | Provider-aware inbound webhooks | AppPort Services (+FeltKit) | **P1** | Confirmed (Services 0.19.0 is latest) | `WEBHOOK-SECURITY.md:78-139` |
| FK-01 | Outbound body encoding | FeltKit integrations (+AppPort) | **P1** | Confirmed (unchanged 0.3.31) | `runtime/integrations.js` sets `application/json` |
| FK-03 | Code-declared schedules with explicit principals | AppPort Services + FeltKit | P2 | Confirmed (unchanged 0.3.31) | `schedules?: boolean`; no `ctx` schedules API |
| FK-10 | Application-readable effect outcomes | FeltKit + AppPort Services | P2 | Confirmed | Failed notification visible only via `feltkit outbox list` |
| FK-14 | Bounded, opt-in client retry of retryable errors | FeltKit client | P2 | Confirmed | `client/index.js:213-236` |
| FK-06 | `QueryCtx.authority` typing | FeltKit | P3 | Confirmed (unchanged 0.3.31) | `context.d.ts` |
| FK-05 | Component identity validated at definition | FeltKit | P3 | Confirmed (0.3.30) | codegen accepted an invalid principal |
| FK-11 | `measure` understands declared components | FeltKit CLI | P3 | Confirmed (0.3.30) | needed `feltkit.measure.json` |
| FK-15 | Tenancy documentation wording | FeltKit docs | P3 | Confirmed (0.3.30) | FORBIDDEN vs NOT_FOUND |
| FK-08 | Delegation id scope and determinism | AuthBoundry local | P3 | Observed; not a demonstrated defect | Same id in two instances |
| — | Deep schema type inference | FeltDB/FeltKit | P3 | Observed | `_catalog.ts` hand-written types |
| FK-13 | Intent vs durable workflows | Product/docs decision | P3 | Clarification needed | `@feltdb/core/dist/intent.d.ts` |
| FK-07 | Principal identity in `decide` | FeltKit | — | **Resolved in 0.3.31**; keep regression coverage | `context.d.ts:333-340` (FRAME-GAP-11) |
| FK-12 | AppPort pins behind latest | FeltKit release | — | **Resolved in 0.3.31** (all four at latest) | `package.json`, `npm ls` |

FK-16 is a release-integrity failure, not a missing feature: a release must not require
functionality absent from its declared, published dependency set.

## Execution order

1. **Establish release integrity** (FK-16) before another cross-package behaviour change ships.
2. **Design the authority and tenancy contract** (FK-04 + FK-17 + operator authority + system principals
   + policy evaluation inside tenancy-owned transactions).
3. **Complete the agent session contract** (FK-09): workspace-bound at creation, end-to-end authorization
   tests.
4. **Establish real provider behaviour**: a Stripe test-mode baseline against the *current* application.
5. **Implement the provider bridge** (FK-01 outbound, FK-02 inbound), proven equivalent to the baseline.
6. **Lifecycle and operations** (FK-03, FK-10, FK-14), then P3 typing and tooling.
7. **Migrate this application**: remove the workarounds; the unchanged acceptance scenarios are the
   regression baseline.

Contracts are defined before implementations, and a contract that spans packages ships only when
every package implementing it is published (step 1).

---

## 1. Release integrity gate (FK-16) — P1

**This is a gate, not a product capability.** It changes how releases are made, not what the platform
does.

A release of any Boundry package may ship only when:

- every runtime dependency resolves to a **published** version (no source-only or "after 0.1.0"
  capabilities);
- the complete supported dependency matrix installs from the public registry;
- integration tests exercise the real package interactions across that matrix, including delegated
  agent authorization through AuthBoundry;
- a fresh `create-feltkit` scaffold builds and runs on it;
- reference applications' acceptance suites pass on it (this application's 24 steps qualify);
- an intentional authorization-behaviour change ships with migration documentation and explicit
  compatibility treatment (feature detection that preserves prior behaviour, or a major/minor version
  signal);
- a patch release never makes an existing supported combination unusable.

Immediate remediation for 0.3.31: publish an `@authboundry/local` with `registerAgent` and test the pair,
**or** release a FeltKit patch that keeps 0.3.30 behaviour when `registerAgent` is absent. Also align the
documented outcome ("an agent that is not registered is a deny, never an error") with the observed
`unavailable`.

**Acceptance:** this application upgrades to the next FeltKit release with no code change, and
`tests/agents.test.ts` and acceptance step 17 pass on packages installed from the registry.

### Status (2026-11-17): Option 2 chosen, candidate verified, not published

Decision: an upgrade must not silently widen authority. 0.3.31's per-agent default stays; sharing the executor's
grants is an application owner's explicit choice. The acceptance criterion above is therefore revised: with
`@authboundry/local` 0.1.0, an application that relied on executor grants upgrades with **one deliberate
configuration line** (`authority: { local: { agentCallers: "executor-grants" } }`), not with no change.

| Behaviour | 0.3.32 candidate |
|---|---|
| Agent caller, no per-agent support, default | `unavailable` (as 0.3.31); the refusal names the opt-in |
| Agent caller, opted in | executor's grants; decision and activity marked `compatibility: "executor-grants"`; readiness warns |
| Decision naming an agent, no per-agent support | `unavailable`, never the executor |
| Per-agent support installed | per-agent decides; the opt-in has no effect (readiness says so) |
| Invalid `agentCallers` | `TypeError` when the app is defined |

Evidence (`docs/evidence/release/fk16-option2/README.md`): FeltKit patch series
`release/fk16/feltkit-0.3.32-option2-series/`; packed `@feltdb/feltkit` 0.3.32 sha512 `on5G0gHG…` (≠ 0.3.31);
release dry run: SDK 737/747 pass, 0 fail, 10 capability-gated skips, `test:release` passes, `release:gate` stops
only on npm credentials; fresh install: 0.3.30 33/33, 0.3.31 35/37, candidate default 35/37 (fails closed by
design), candidate with opt-in **37/37**.

Remaining before FK-16 is resolved: a maintainer applies the series, publishes 0.3.32 with the real release
process, and the fresh-install gate passes against the **published** artifact. Then Option A (AuthBoundry server
fix, then `@authboundry/local` with a new version and a core floor), then per-agent semantics as the deliberate
path via a FeltKit minor with migration guidance.

Not part of FK-16, recorded separately: FK-18 (an intermittent pre-existing test) and FK-19 (the release run
inherits ambient `FELTDB_*` variables). Both make release results depend on luck or on the operator's shell; the
fix belongs in FeltKit's own test and release scripts (assert precisely; run tests with an explicit environment),
not in a separate release system. Cross-repository release operations are out of scope for FeltKit's gate.

Before publication: one final independent review of the candidate (every executor-authority path constrained by
the opt-in; readiness reflects the effective mode; the compatibility marker is durable and inspectable; the gate
covers every prerequisite the package relies on; the registry comparison is deterministic).

Per-agent delegation (an agent decides as itself, needing its own grant) is the better security model.
This application should adopt it once the gate is met: owners would grant each agent, rather than
granting the application's executor for all agents.

## 2. Authority and tenancy contract (FK-04 + FK-17) — P1

### Three authority contexts, kept distinct

| Context | Acts on | Must not |
|---|---|---|
| Customer principal | Its authorized workspace | Name another workspace by argument |
| Component/system principal | Explicitly declared collections and operations across workspaces, for a declared purpose | Inherit another component's access |
| Operator principal | Administrative operations across workspaces | Need membership in, or impersonation of, the customer's workspace |

Impersonation may exist as a separate, explicitly audited feature; it must not be the mechanism ordinary
operator access depends on. The proposed `tenant: { system: [...] }` syntax is deliberately not adopted
before the contract below is designed.

The contract must answer: which principal; which operations and collections; read-only or read/write;
how the target tenant is selected and validated; how the access is recorded (actual principal, target
tenant, purpose, authorization evidence); how authority is narrowed and revoked; how tests prove
isolation between components.

### Policy at platform-owned mutations (FK-17)

Applications must be able to enforce policy (seat limits first) at the tenancy mutations themselves:
invitation, acceptance, direct member addition, removal where it affects capacity, and other tenancy
changes subject to application policy. A check outside the membership transaction is a
time-of-check/time-of-use race: two invitations each see one free seat, both commit.

One coherent extension mechanism, not a seat-limit hook bolted onto tenancy.

**Evidence on the substrate (0.3.30 source).** Tenancy writes are ordinary FeltDB transactions on the
application's **same instance** (`TenancyStore` uses `instance.handle("feltkit.tenancy")`;
`#write(operations)` → `db.transaction({ operations })`, `dist/runtime/tenancy.js:70-72`; runtime
`runtime.js:386`). Today those transactions carry only tenancy's own records with `requireAbsent`/
`ifVersion` preconditions; nothing fences the member *count*. Inference, not yet demonstrated: because
application functions also commit through FeltDB transactions on the same instance with checked reads,
the substrate can express "membership write + application entitlement read, committed together or
not at all". The work is in FeltKit's tenancy layer, which would need to run the policy with a
fenced reader and include its read set in the membership transaction. To be confirmed by a spike; if
it cannot, a defined transactional integration contract is required. A best-effort callback is not
acceptable for capacity or financial enforcement.

**Acceptance criteria**

- Customer functions cannot read or mutate another tenant's records.
- An explicitly authorized component principal can perform a declared cross-tenant operation; an
  unauthorized component cannot perform the same operation.
- An operator can inspect and administer a customer's tenant-scoped data without membership or
  impersonation; the record names the operator, target tenant and purpose.
- Every cross-tenant access leaves durable audit evidence.
- No customer-facing function accepts a caller-supplied tenant/account id in place of authorization.
- Two concurrent invitations/acceptances against the last seat: exactly one commits.
- Test helpers provision and exercise system and operator principals without bypassing production
  authorization.
- This application migrates its billing collections to native tenant scoping and removes
  `callerAccountId` (W-06), and enforces `team.members.max` at the membership boundary.

## 3. Agent session contract (FK-09) — P1

For agents, workspace selection is a **session-creation** decision:

1. the agent authenticates;
2. it selects a workspace it is authorized for (checked against its live membership);
3. the session is bound to that workspace;
4. MCP capabilities execute in that context, which the session exposes explicitly (for example, an
   initialize or session-info result naming the workspace and role);
5. changing workspace means creating a new session.

Human sessions keep switching. `feltkit session create` gains workspace binding; an MCP-only agent can
list its workspaces and obtain a bound session without undocumented HTTP calls.

**Acceptance:** an MCP-only client discovers and binds an authorized workspace; an unauthorized
workspace is refused; the bound workspace is visible; no MCP call can execute against a different
workspace; a replaced or stale token produces an actionable, specific error. This application's demo
needs no `/api/tenants/switch` call (removes W-07).

## 4. Provider integration (FK-01, FK-02) — P1

### Entry gate: real Stripe test-mode baseline

Before any native provider work replaces the current implementation:

1. Run the current application against Stripe test mode.
2. Record request/response behaviour, signature verification, idempotency, error mapping (including
   402 card errors) and reconciliation outcomes.
3. Build the native path; run the same scenarios; compare.
4. Remove W-01/W-02 only when equivalence is demonstrated.

The simulator stays for deterministic edge cases (forged signatures, redelivery, failure injection). It
proves this implementation, not compatibility with the provider.

### FK-02 — inbound

Two concerns, decoupled: **authenticity verification** (pluggable provider verifiers; Stripe, Svix,
GitHub initially; timestamp tolerance, rotation, raw-body preservation, precise failure reasons) and
**durable processing** (provider-neutral: accepted-event processing, retry, failed, dead-letter,
authorized replay). The application keeps `provider_events` as commercial history and drops
infrastructure-level replay defence.

**Acceptance:** valid signatures accepted; forged, stale, malformed and missing rejected before the
trusted path; duplicates not reprocessed; failures durable and inspectable; poison events dead-lettered;
replay requires an authorized action; raw bodies verified without reserialization; this application
removes its webhook route and replay logic.

### FK-01 — outbound

Operation-level request encoding (JSON, `application/x-www-form-urlencoded`), keeping credential custody,
call evidence and unknown-outcome verification in the existing integration mechanism. Not a Stripe
special case.

**Acceptance:** deterministic encoding tested for nested values, arrays, nulls and special characters;
headers match the declared encoding; credentials stay in custody; `verify` settles unknown outcomes;
this application removes its Stripe HTTP client (W-01).

## 5. Lifecycle and operations — P2

- **FK-03** Code-declared schedules: stable identity, cadence, handler, **explicit execution principal**,
  durable run state, retry/failure semantics, audit, disable/resume. Prefer schedule + existing durable
  work over a new workflow engine. *Acceptance:* versioned with the app; no undeclared principal;
  duplicate triggers cannot duplicate business transitions; defined missed-run recovery; observable
  failures; deterministic time advancement in tests without production overrides. Removes W-03.
- **FK-10** Permission-scoped effect outcomes (identity, originating operation, status, failure
  category, safe diagnostic, attempts, authorized retry/dismissal; no credentials or others' history).
  *Acceptance:* the operator console shows and retries a failed notification; retry never re-runs the
  business mutation; unauthorized users cannot inspect or replay.
- **FK-14** Opt-in, bounded retry for errors marked `retryable`, configurable per mutation. The safety
  contract is explicit: retries are safe for mutations protected by idempotency keys or state checks
  (as every mutation in this application is). *Acceptance:* no duplicate business effects under
  repeated conflict.

## 6. Correctness, tooling and documentation — P3

| ID | Remediation | Acceptance |
|---|---|---|
| FK-05 | Validate component principal in `feltkit()` | Invalid identity fails before startup with the same diagnostic |
| FK-06 | Read-only `authority` on `QueryCtx` | No cast (removes W-04); compile-time tests |
| FK-11 | `measure` classifies `feltkit({ components })` entries as infrastructure | No `feltkit.measure.json` needed (removes W-08) |
| FK-15 | Align AUTH.md with actual responses | Docs and tests agree |
| FK-08 | Document and test delegation-id scope | Determinism explicitly guaranteed, or corrected |
| Schema inference | Useful types for deep `s.union`/`s.record` | Representative nested-schema type tests |
| FK-13 | Decide and document where durable workflows live; do not broaden Intent by name alone | A documented product decision |

## 7. Package boundaries

| Package | Owns | Must not |
|---|---|---|
| FeltDB | Transactional state, schema enforcement, checked reads, durable records | Become a workflow engine via "Intent" without a product decision |
| FeltKit | Declarations and composition: identity, tenancy, principals, components, schedules, client behaviour, authorization wiring | Reimplement contracts other packages own |
| AppPort / Services | Provider-neutral integration contracts, inbound lifecycle, verifier adapters, durable execution, effect interfaces | Push provider protocols into every application |
| AuthBoundry | Canonical principal identity, delegation, revocation, decisions | Ship decision semantics FeltKit cannot use with published packages (FK-16) |
| AppBoundry, Resolver | No defect demonstrated by this evidence; no tickets created | — |

Each package owns its durable contract; FeltKit composes them; applications own business meaning,
not missing platform infrastructure.

## 8. Not platform work

| Finding | Classification | Action |
|---|---|---|
| Dunning anchored to event arrival; upgrade forgave overage; cross-instance cache; inert buttons; unlimited shown as 0; notices under dialogs | Application bugs (fixed) | Keep regression coverage |
| `usage_reporter` lacked effect permissions | Application configuration | Improve visibility (FK-10); never bypass authorization |
| Native approval runs as proposer | Intended authority model | Keep the spend-request design unless a broader approval contract is justified |
| Stripe simulator only | Unverified integration risk | §4 entry gate |
| Playwright `load` with live streams | Testing documentation | Document `domcontentloaded` |

No generic retry mechanism may be added to hide incorrect state transitions.

## 9. Success: the workarounds disappear

| Workaround | Expected after remediation | Unblocked by |
|---|---|---|
| W-01 Stripe HTTP client | Native integration invocation | FK-01 + §4 baseline |
| W-02 Webhook route and verification | Provider-aware inbound lifecycle | FK-02 + §4 baseline |
| W-03 Payments-component clock | Declared application schedule | FK-03 |
| W-04 `QueryCtx` cast | Removed | FK-06 |
| W-05 `authorityPrincipal()` | Removed (native since 0.3.31) | **FK-16** (upgrade blocked) |
| W-06 Explicit account isolation | Platform-enforced tenant/system/operator access | FK-04 |
| W-07 Manual workspace token switching | Workspace-bound MCP sessions | FK-09 |
| W-08 Measure declarations | Removed | FK-11 |

Done means: the same 24 acceptance steps, concurrency and idempotency tests pass; customer isolation
does not regress; provider signature failures and redelivery are tested through the native path; failed
effects are visible to operators; real Stripe test mode passes.

Three measurements, not a LOC target:

- **Infrastructure displaced:** application code actually removed (baseline: 399 LOC app-built
  infrastructure, ≈ 210 LOC workaround code; `feltkit measure`).
- **Responsibility transferred:** security, retries, delivery and lifecycle guarantees enforced by the
  owning package, demonstrated by that package's tests.
- **Evidence retained:** the same or stronger guarantees shown by automated tests and durable
  operational records.

## Change log

| Date | Change | Evidence |
|---|---|---|
| 2026-11-17 | FK-18 (flaky `policies.test.ts` assertion) and FK-19 (release tests inherit ambient `FELTDB_*`) recorded as separate findings, not part of FK-16; final independent review of the 0.3.32 candidate required before publication | `docs/evidence/release/fk16-option2/` |
| 2026-11-17 | Final review of candidate 1 found 7 defects (`fk16-final-review/`). Decision: keep hosted authority's documented contract for 0.3.32, identify it; one hosted/local policy deferred to a minor. Candidate 2 (`9f13291`) corrects all 7 plus the retry guidance; verified by tests, gate self-tests, dry run and fresh install. Not published; pending independent review | `docs/evidence/release/fk16-candidate2/` |
| 2026-11-17 | Second review (candidate 2) found 2 gate blockers (linked copies skipped; artifact not from a commit, gate read dist) and evidence gaps; authorization held. Candidate 3 (`4c19dfa`, with a committed 0.3.32 version) corrects them; dry run, gate, self-tests, fresh install recorded. Not published; third review pending | `docs/evidence/release/fk16-candidate2-review/`, `docs/evidence/release/fk16-candidate3/` |
| 2026-11-17 | Third review (candidate 3): no runtime blocker; the gate did not yet prove the published artifact. Candidate 4 (`3debafa`): compat tests on the packed artifact, publish uses the checked tarballs and compares integrity before `latest`, version-only provenance, refusal reasons in policy records. Not published; fourth review pending | `docs/evidence/release/fk16-candidate3-review/`, `docs/evidence/release/fk16-candidate4/` |
| 2026-11-16 | Plan created from the 0.3.30 evaluation | `FELTKIT_EXPERIENCE.md` §1–7 |
| 2026-11-17 | FK-16 Option 2 (explicit `agentCallers` opt-in; default unchanged) implemented in a FeltKit candidate, release prerequisites gate added, packed 0.3.32 verified by hash, dry run and fresh install. Not published. First candidate (unconditional fallback) superseded: it reversed 0.3.31's tested refusal | `docs/evidence/release/fk16-option2/` |
| 2026-11-16 | FK-16 "patched" run found to have tested unmodified 0.3.31 (artifact never contained the patch) | `docs/evidence/release/patched-0.3.31-fk16-local/CORRECTION.md` |
| 2026-11-16 | Re-verified against 0.3.31: FK-07 and FK-12 resolved; FK-16 discovered (app stays on 0.3.30); FK-17 confirmed and merged into FK-04; release gate made P1; operator authority, workspace-bound agent sessions and the Stripe entry gate added | `FELTKIT_EXPERIENCE.md` §3.1 |
