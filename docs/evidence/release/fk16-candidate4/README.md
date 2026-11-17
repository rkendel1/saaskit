# FK-16 0.3.32 candidate 4: the gate proves the published artifact (2026-11-17)

Review of candidate 3: `../fk16-candidate3-review/README.md` (no runtime blocker; release gate and evidence partially).
FeltKit local branch `fk16-compat-0.3.32` (not pushed), new commit `3debafa` on `4c19dfa`. Series:
`release/fk16/feltkit-0.3.32-candidate4-series/` (`git format-patch c9fae9d..3debafa`, 8 patches).

| Review finding | Correction |
|---|---|
| Compat tests ran on `src/` | They run against the packed tarball's `dist` (`../src` points at it). Proven by a mutation of the extracted tarball only: the hosted test failed (prototype, before integration) |
| Published tarball not tied to the checked one | The gate packs both packages and, with `FELTKIT_RELEASE_ARTIFACT_DIR`, keeps them with `artifact.json`; `publish-packages` publishes exactly those files and, before moving `latest`, requires the registry to serve their sha512 |
| Loose provenance | Uncommitted release manifests may differ from the commit in version strings only; `create-feltkit` lockstep pin checked |
| E401/E403 as unreachable | Classified as "refused" |
| Policy records ambiguous | Delegation entries keep a refusal's `reason` (tested: "Per-agent delegation needs …" vs "not an agent registered") |
| Person's call FAILED_PRECONDITION undocumented | Message points to readiness generally; CONNECTIONS and CHANGELOG say it applies to any caller in a configuration state |
| Empty url wording; GUARANTEES details | CHANGELOG states the development fallback; GUARANTEES corrected (refused integration decisions, null vs unreachable) |

## Results

| Run | Result | Evidence |
|---|---|---|
| Gate on clean `3debafa` | exit 0: artifact from `3debafa`, no uncommitted change, version committed, content true; `create-feltkit` lockstep; compat **against the packed artifact** 7/7, 0 skipped; 26/26 registry copies match | `release-prerequisites_clean-3debafa.json` |
| Gate self-tests | non-version change in a manifest → exit 1; `create-feltkit` pin out of lockstep → exit 1; version-only bump (as the publish script writes it) → exit 0 | `gate-selftest_*.json` |
| Publish path | the gate kept both tarballs; `npm publish <tarball> --dry-run --tag pending` reports the same integrity as checked (`JRGDr0wJ…` feltkit, `AtCKHxAc…` create-feltkit) | `checked-artifact.json`, `gate-kept-artifacts.txt` |
| Release dry run on `3debafa`, `FELTDB_*` unset | build ✓; SDK 751: 741 pass, 0 fail, 10 capability-gated skips; conformance 50/50; create-feltkit 12/12; examples ✓; **release check passed**; stops only at npm ownership | `publish-packages-dry-run-0.3.32_3debafa_FELTDB-env-unset.log` |
| Fresh install of the checked tarball (integrity + marker verified) | default 35/37, fails closed exactly as 0.3.31; opt-in **37/37** | `../gate5-candidate4-0.3.32-default/`, `../gate5-candidate4-0.3.32-opt-in/` |
| Authority suites against the **unpublished** AuthBoundry `50e6ad4` (local evidence only) | 28: 27 pass, 0 fail, 1 skip (0.1.0-only test); restored identically | `authority-suites_UNPUBLISHED-authboundry-50e6ad4.log` |

Not exercised here: the real `npm publish` and the pre-promotion integrity comparison (they need the maintainer's npm
login). Not published; FK-16 remains open.
