# FK-16 source-level evidence (FeltKit clone), 2026-11-16

Source tests run inside the FeltKit monorepo clone (`rkendel1/feltkit` at `c9fae9d Release 0.3.31`, read-only;
candidate committed locally as `1ccead6` on branch `fk16-compat-0.3.32`, not pushed). Patch:
`release/fk16/feltkit-0.3.32-rc.1-candidate.patch`. Command for each log:

    cd packages/sdk && node --import tsx --test --test-concurrency=1 test/local-authority.test.ts test/policies.test.ts [test/authority-compat.test.ts]

| Log | FeltKit source | @authboundry/local | Result |
|---|---|---|---|
| `1-unmodified-0.3.31-source_published-local-0.1.0.log` | unmodified 0.3.31 | **published** 0.1.0 (registry integrity `sha512-O6bS7Ehf…`, no `registerAgent`) | 14 tests: 12 pass, **2 skipped** (both per-agent tests); no test covers an agent caller with 0.1.0 |
| (not kept as a separate log) new `authority-compat.test.ts` on unmodified source | unmodified 0.3.31 | published 0.1.0 | **fails**: `agent caller, plain: unavailable … needs registerAgent` — the test detects FK-16 |
| `2-candidate-source_published-local-0.1.0.log` | candidate | published 0.1.0 | 15 tests: 12 pass, 2 skipped, **1 fail**: 0.3.31's own test "an @authboundry/local without per-agent delegation: … agent decisions are refused" expects `[false, "unavailable"]`, gets `[true, "allow"]` |
| `3-candidate-source_UNPUBLISHED-local-authboundry-50e6ad4.log` | candidate | **unpublished** source from `rkendel1/authboundry` `50e6ad4` `packages/local` (still versioned 0.1.0) | 15 tests: 14 pass, 1 skipped (the 0.1.0-only refusal test); all per-agent tests run and pass; compatibility marker absent in per-agent mode |

Not release evidence: no artifact was packed, nothing was installed from a packed candidate, and the
application release gate (`release/verify.sh`) was not run against the candidate. Stopped on a semantic
conflict: the candidate reverses 0.3.31's deliberate, tested refusal of agent decisions under 0.1.0.
