# FK-16 0.3.32 candidate 2: corrections after the final review (2026-11-17)

Decision (2026-11-17): keep the hosted-authority contract for 0.3.32 (agent callers decided as the executor), identify
it accurately, and defer one hosted/local opt-in policy to a later minor release. The review that led here:
`../fk16-final-review/README.md`.

## Source

FeltKit clone, local branch `fk16-compat-0.3.32`, not pushed (read-only remote). New commit `9f13291` on top of
`0a35187`. Series: `release/fk16/feltkit-0.3.32-candidate2-series/` (`git format-patch c9fae9d..9f13291`, 4 patches;
patch 1 is the superseded first candidate, kept for history, reversed in effect by patch 2).

| Review finding | Correction in `9f13291` |
|---|---|
| 1 Hosted bypass | Hosted kept as documented; decisions recorded `hosted-executor-grants`; SECURITY/GUARANTEES/LOCAL-AUTHORITY/CHANGELOG say the local opt-in does not govern hosted |
| 2 Readiness | `authority.agent-callers`: hosted (pass), not started (warn "not yet known"), failed / no address (fail), per-agent (pass), refused (warn), shared grants (warn) |
| 3 Marker durability | `authorityMode` (`local-executor`, `local-per-agent`, `local-executor-grants-opt-in`, `hosted-executor`, `hosted-executor-grants`) in the decision, activity (refusals before AuthBoundry included), invocation decision notes, policy decision records, integration call records |
| 4 Falsy config | `local: false/null/0/""` off again, as 0.3.31; only objects validated |
| 5 Docs | POLICIES, CONNECTIONS corrected; SECURITY, GUARANTEES, LOCAL-AUTHORITY, CHANGELOG agree |
| 6 Gate prerequisites | `@authboundry/local` + `@authboundry/core` required, probed by starting a real authority and asking a decision; `AUTHBOUNDRY_CLI_PATH` refused; per-agent judged by `runtime/authority-contract.ts` (imported from the built dist), the same contract the runtime and tests use |
| 7 Registry verification | every installed copy (nested too) of `@authboundry/*`, `@appport/*`, `@feltdb/*` (not feltkit), `mailerport`; metadata online; tarball sha512 = registry integrity; E404 "not published" vs "unreachable"; offline refused; release-check passes stderr through |
| + retry guidance | agent caller refused on a person's connection: `FAILED_PRECONDITION`, "retrying will not change this" |

## Results

| Run | Result | Evidence |
|---|---|---|
| Full SDK suite (source, published deps) | 751: 741 pass, 0 fail, 10 skip (per-agent 2, set-membership 5, inbox 3; none FK-16) | `sdk-full-suite_summary.txt` |
| Compat tests `authority-compat.test.ts` | 7/7, 0 skipped: contract, local default (incl. deferred start), local opt-in, durable policy evidence, hosted, failed start, configuration | in the gate run |
| Authority suites against **unpublished** AuthBoundry `50e6ad4` (local-source evidence only) | 28: 27 pass, 0 fail, 1 skip (the 0.1.0-only refusal test); per-agent branches run | `authority-suites_UNPUBLISHED-authboundry-50e6ad4.log` |
| Prerequisite gate on the real install | exit 0: required AuthBoundry probe passes; 26 upstream copies match the registry (incl. nested `@appport/services@0.18.0`); compat 7/7 | `release-prerequisites_installed-registry.txt` |
| Gate self-tests (real exit codes) | all exit 1, with the right diagnosis: offline; unreachable registry (12 s, "unreachable", not "unpublished"); `AUTHBOUNDRY_CLI_PATH`; unpublished build carrying 0.1.0 ("files differ"); version 0.1.999 ("not published (registry-confirmed)"); an injected skipped compat test | `gate-selftest_*.txt` |
| Release dry run `--dry-run 0.3.32`, `FELTDB_*` unset | build ✓, SDK 741/751 0 fail, conformance 50/50, create-feltkit 12/12, examples ✓, `test:release` ✓; `release:gate` stops only on npm ownership (not logged in) | `publish-packages-dry-run-0.3.32_FELTDB-env-unset.log` |
| Packed artifacts | `@feltdb/feltkit` 0.3.32 sha512 `vlC2Dsi5…` (≠ candidate 1 `on5G0gHG…`); `create-feltkit` unchanged, byte-identical to candidate 1; tarball `dist` identical to the tested build | `artifact-hashes.txt`, `pack.log` |
| Fresh install, default | 35/37: fails closed exactly as 0.3.31 (the app's two agent-spending tests); FK-16 tests pass; integrity and marker verified | `../gate3-candidate2-0.3.32-default/` |
| Fresh install, opt-in | **37/37**; integrity and marker verified | `../gate3-candidate2-0.3.32-opt-in/` |

Not published. FK-16 remains open until an independent review of this candidate passes and the published package
passes fresh-install verification.
