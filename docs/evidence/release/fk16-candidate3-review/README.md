# FK-16 candidate 3 (4c19dfa): independent review (2026-11-17)

Read-only reviewer given the diff `c9fae9d..4c19dfa`, the packed tarballs, the requirements and the three properties,
not the author's conclusions. Tree left clean; two temporary swaps of `node_modules/@authboundry/local` (copied
source, symlink) restored and verified by per-file sha256, no symlink left.

**No runtime blocker. Not yet proven: "the gate proves the exact artifact".**

| Property | Verdict | Findings |
|---|---|---|
| 1 Authorization | Holds | All callers go through `agentDecision`; opt-in only for an agent caller naming no agent; named agents refused in every mode; hosted detection consistent; only objects validated; nothing reads `authorityMode` (run + read; per-agent branches also run against the unpublished source as local evidence). Note: `authorityUrl` `\|\|` lets an empty variable fall back to the `development` default outside production (0.3.31 refused); contradicts the CHANGELOG wording |
| 2 Evidence | Partially | Should-fix: durable policy records cannot tell "per-agent not installed" from "agent not registered" (both `local-per-agent`, no reason kept). Should-fix: a person's integration call is `FAILED_PRECONDITION` on a failed start / no address, pointing at `authority.agent-callers`; CONNECTIONS/CHANGELOG describe it for agent callers only. Notes: unreadable credential still "Try again" (pre-existing); GUARANTEES says refused integration calls are in activity only (also invocation notes); unreachable hosted keeps a non-null mode |
| 3 Release | Partially | Verified: gate exit 0; required probe; pack reproduced (sha256 `f5dc87ed…`); nested copies; copied source → files differ; symlink → not a registry copy; E404 vs ECONNREFUSED classification. Should-fix: compat tests run on `src/`, the tarball's runtime is only string-checked; `npm publish -w` repacks and the checked sha512 is never compared; uncommitted release manifests may differ in anything, `committedVersion` never compared. Notes: `create-feltkit` provenance not checked; unbounded peer/core ranges; E401/E403 reported as unreachable; copies outside `npm ls` not seen |
