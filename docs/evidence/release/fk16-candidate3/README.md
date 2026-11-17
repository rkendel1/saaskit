# FK-16 0.3.32 candidate 3: corrections after the second review (2026-11-17)

Review of candidate 2: `../fk16-candidate2-review/README.md`. FeltKit local branch `fk16-compat-0.3.32` (not pushed),
three new commits on `9f13291`:

| Commit | |
|---|---|
| `1736d4e` | Fixes for the review: B1, B2, evidence and docs (below) |
| `5b5f062` | Release 0.3.32 version commit, exactly as `scripts/publish-packages.mjs` writes the manifests; the artifact now comes from a commit |
| `4c19dfa` | Gate fix found by this round's own dry run: `npm ls` lists a copy once per dependent and only some entries carry `resolved`; the last one won, so 8 registry copies were reported "not a registry copy" (the gate failed closed: `publish-packages-dry-run_5b5f062_stopped-by-gate-defect.log`) |

Series: `release/fk16/feltkit-0.3.32-candidate3-series/` (`git format-patch c9fae9d..4c19dfa`, 7 patches).

| Review finding | Correction |
|---|---|
| B1 linked/file copies skipped | Every installed upstream copy is kept; a link, symlink on disk, `file:` or missing registry source is "not a registry copy" (fails) |
| B2 artifact not from the commit; gate read `dist` | Release version committed; the gate packs `@feltdb/feltkit` itself, inspects the tarball (version vs committed version, FK-16 content in dist and docs, commit, only release manifests may differ), probes with the tarball's own contract, reports its sha512 |
| Tests detected per-agent by source text | `startProbeAuthority` + `missingPerAgentMethods` (`runtime/authority-contract.ts`) used by the gate and the `local-authority`, `policies` tests; the compat test uses the runtime's view of the same contract |
| Scope registries | A differing `@authboundry`/`@appport`/`@feltdb` scope registry is refused |
| Failed start not lasting | Lasting (no "Try again"); `authorityMode` null |
| Empty url variable | No address everywhere (`authorityUrl`); readiness and decisions agree |
| Mode on unevaluated refusals | null when nothing was evaluated |
| Refusals not recorded | Every refusal FeltKit makes after configuration is recorded |
| Durability overstated | SECURITY, GUARANTEES, CHANGELOG state each record's own durability |
| GUARANTEES "always the executor" | Corrected |
| Required field on exported type | `authorityMode` optional; `AuthorityMode` exported |
| LOCAL-AUTHORITY.md not shipped | Shipped |

## Results

| Run | Result | Evidence |
|---|---|---|
| Release dry run on `4c19dfa`, `FELTDB_*` unset | build ✓; SDK 751: 741 pass, 0 fail, 10 capability-gated skips; conformance 50/50; create-feltkit 12/12; examples ✓; **release check passed**; stops only at npm ownership (not logged in) | `publish-packages-dry-run-0.3.32_4c19dfa_FELTDB-env-unset.log` |
| Gate on clean `4c19dfa` | exit 0; artifact from `4c19dfa`, no uncommitted changes, 0.3.32 committed, content checks true; 26/26 registry copies match; compat 7/7, 0 skipped | `release-prerequisites_clean-4c19dfa.json` |
| Gate self-tests (exit 1 each) | symlinked unpublished source ("not a registry copy" and required probe fails); copied unpublished source ("files differ"); version 0.1.999 ("no registry source recorded"); offline; unreachable; `AUTHBOUNDRY_CLI_PATH`; scope registry; injected skip (also caught as an uncommitted change) | `gate-selftest_*.json` |
| Pack reproducibility | the same sha512 `MoDMg4GK…` in every gate run (8) and the separate pack | `artifact-hashes.txt` |
| Fresh install, default (integrity + marker verified) | 35/37: fails closed exactly as 0.3.31; FK-16 tests pass | `../gate4-candidate3-0.3.32-default/` |
| Fresh install, opt-in | **37/37** | `../gate4-candidate3-0.3.32-opt-in/` |

Limits stated plainly: per-agent branches cannot run against the published `@authboundry/local` 0.1.0 (they ran
against the unpublished source in candidate 2's local-source evidence only); the E404 "not published" path was
exercised in candidate 2's self-tests, not this round's. Not published; FK-16 remains open.
