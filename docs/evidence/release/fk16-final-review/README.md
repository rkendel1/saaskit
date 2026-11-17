# FK-16 0.3.32 candidate: final independent review (2026-11-17)

Reviewer: a separate read-only agent given the diff `c9fae9d..0a35187`, the packed tarballs and the five
questions, not the author's conclusions. No repository was modified; one temporary swap of
`node_modules/@authboundry/local` was restored and verified by sha256. Items marked (run) were verified by
experiment, (read) by reading source. The author re-checked the hosted path, the `local: false` break and the
POLICIES/CONNECTIONS wording against source.

**Verdict: do not publish 0a35187.**

| # | Question | Verdict | Finding |
|---|---|---|---|
| 1 | Every executor-authority path constrained by the opt-in | Partially | Local authority: `decide`, policy `delegated`, person-owned connections, `app.agent`, MCP sessions, agent-queued jobs all pass through `agentDecision` (run for decide/policy; read for integrations/jobs). **Hosted / external authority (`local-authority.ts:306`, also `authority.local` with a resolving `url`) decides an agent caller with the executor's grants without the opt-in and without the marker** (run). Named agents never fall back (run). Notes: service principals and person-owned `runtime.agent` tasks are decided as the executor by design / pre-existing |
| 2 | Readiness reflects the effective mode | Partially | Correct when running, including across package changes between restarts (run). Reports **pass** for external/hosted (actually executor), failed start (actually refused), and before the deferred start. "Has per-agent" is tested three different ways (decision/getter, registration, gate) |
| 3 | Marker durable and inspectable; cannot affect authorization | Partially | Cannot affect authorization (nothing reads it). Present only in the returned decision and the best-effort, pruned (2000 entries) activity log. **Absent from durable policy evidence** (run), invocation decision notes and integration evidence (read) |
| 4 | Gate covers every prerequisite relied on | Does not hold | Misses `@authboundry/core` (+ platform binary): the native server that makes every decision. No nested/transitive comparison. Probe differs from runtime check and compat test. All three prerequisites optional, so none can fail the gate |
| 5 | Registry comparison deterministic, reproducible | Partially | Path+hash comparison sound. **Passes offline from the npm cache alone** (run). Network failure fails closed but mis-diagnosed as "unpublished" (run). `npm view`/`npm pack` run with different cwd (latent `.npmrc` divergence). Nested `node_modules` skipped. stderr discarded by `release-check` |

Other:
- **API break in a patch release** (run): `authority.local: false | null | 0 | ""` now throws at definition; 0.3.31 treated falsy as off.
- **Shipped docs misdescribe behaviour**: `docs/POLICIES.md:51`, `docs/CONNECTIONS.md:47,92` still say agent callers are decided as the executor.
- `LOCAL-AUTHORITY.md` and `CHANGELOG.md` are not shipped; CHANGELOG says the gate checks the packed artifact (it checks `packages/sdk/dist`; tarball dist verified identical separately).
- Tarballs carry 0.3.32 from the publish script's bump; HEAD says 0.3.31.
- No tests for policy `delegated`/integrations in opt-in or hosted mode, nor readiness in external/failed/deferred states; per-agent branches skip with 0.1.0 (compat test 3/3 against unreleased AuthBoundry source, local evidence only).
- Downgrade per-agent → 0.1.0 hides agent-naming grants from `grants.list()` (nothing widened).
- Default-mode refusal on a person's connection says "Try again"; it is a configuration state.
