# FK-16 Option 2: explicit executor-grant compatibility — evidence (2026-11-17)

Decision (2026-11-16): keep 0.3.31's per-agent default (agent callers refused without per-agent delegation);
executor-grant sharing only by the application owner's explicit `authority.local.agentCallers: "executor-grants"`.

## Source

FeltKit clone `rkendel1/feltkit` (read-only remote), local branch `fk16-compat-0.3.32`, not pushed:

| Commit | |
|---|---|
| `c9fae9d` | Release 0.3.31 (base) |
| `1ccead6` | First candidate (unconditional executor fallback). Superseded, kept: it reversed 0.3.31's tested refusal |
| `467b10c` | Option 2: `agentCallers` opt-in, readiness check, never-skipped tests, `scripts/release-prerequisites.mjs` |
| `0a35187` | Shipped `SECURITY.md` section (the package ships `docs/SECURITY.md`, not `docs/LOCAL-AUTHORITY.md`) |

Patch series: `release/fk16/feltkit-0.3.32-option2-series/` (`git format-patch c9fae9d..0a35187`; apply with `git am`).

## Packed artifacts (built by the repository's own prepack from `0a35187`, clean tree)

Versions bumped exactly as `scripts/publish-packages.mjs` does, `npm pack -w @feltdb/feltkit -w create-feltkit`,
manifests restored afterwards. Not published.

| Artifact | sha256 | npm integrity (sha512) |
|---|---|---|
| `feltdb-feltkit-0.3.32.tgz` | `5439ba291cd1b0fe0f99615968e2febacb1f0d500759dcb5c5041a660b331cc5` | `sha512-on5G0gHGyXGL+G7GCQ9vHSpJJKg8WWcJ8w2WWpGh2L417fEEgF0vZvX19Hftj5scBqnHFmbUcYY3XO1qRAX/Tw==` |
| `create-feltkit-0.3.32.tgz` | `a9e6e4cb4cb802b6ba6750fd3aaff3547022b04a4241cebefa0c28bcff85b07a` | `sha512-AtCKHxAc0iQo3iyKdcSGGtk51GEj3w3JWfuQwojt9Fk9X9+EySH8K+qN6Gr+ois0eoO5SDjeknnuXhJhHcFH2A==` |
| published `@feltdb/feltkit@0.3.31` (for contrast) | — | `sha512-QQQEXXgVWkBV9pfWPI8I5jJPZ7s5LFcY5+7y6UdDokxY8+OmkQI339gkZVunOih26AHlJgyv9dcAYJrVQ+hhIg==` |

Identity checks: the packed `dist/runtime/local-authority.js`, `readiness.js`, `app.js`,
`application-authority.js` and `docs/SECURITY.md`, `docs/GUARANTEES.md` contain the change; the integrity differs
from 0.3.31; `create-feltkit` pins `@feltdb/feltkit` 0.3.32. `pack.log` shows the prepack build ran.

## FeltKit source-level results

| Run | Dependencies | Result | Log |
|---|---|---|---|
| Authority suites (`local-authority`, `policies`, `authority-compat`) | published `@authboundry/local` 0.1.0 | 17 tests: 14 pass, 2 skip (per-agent tests, by design without registerAgent), **1 fail: `policies.test.ts` "input decides…", a pre-existing intermittent failure (3/40 on unmodified 0.3.31; its assertion `!JSON.stringify(decisions).includes("500")` also matches random ids/timestamps)**; 0.3.31's own refusal test passes | `feltkit-authority-suites_published-local-0.1.0.log` |
| Same suites | **unpublished** `packages/local` from `rkendel1/authboundry` `50e6ad4` (local-source evidence) | 17 tests: 16 pass, 1 skip (the 0.1.0-only refusal test); every per-agent test runs and passes; the opt-in has no effect | `feltkit-authority-suites_UNPUBLISHED-authboundry-50e6ad4.log` |
| `authority-compat.test.ts` alone | published 0.1.0 | 3/3, 0 skipped | (in the suites log) |
| Release dry run, `npm run publish:packages -- --dry-run 0.3.32` | registry | build ✓; SDK 747 tests: 737 pass, **0 fail**, 10 skip; conformance 50/50; create-feltkit 12/12; examples ✓; **`test:release` passed** (prerequisites gate: 3 optional prerequisites absent, compatibility tests 3/3 unskipped, artifact contains the change); `release:gate`: every dependency published, **2 blockers: `@feltdb/feltkit` and `create-feltkit` are registered to the maintainer and this session is not logged in to npm** (the intended stop) | `publish-packages-dry-run-0.3.32_FELTDB-env-unset.log` |
| Same dry run with the container's `FELTDB_*` variables set | | 24 failures in build/deploy/platform tests; the same 24 fail on unmodified 0.3.31 and all 49 tests in those files pass on both once the variables are unset (environmental; no `FELTDB_TOKEN` is set, and FeltKit refused before connecting) | `…FELTDB-env-SET_summary.txt`, `env-isolation_*` |

The 10 skipped SDK tests are all gated on the three absent optional prerequisites: 2 per-agent delegation,
5 set-membership, 3 notification inbox. None is an FK-16 compatibility test. The examples suite skips 1 more
(Managed FeltDB live test, needs `FELTKIT_MANAGED_LIVE=1` and credentials).

## Release prerequisites (capability, installed files compared with the registry tarball)

| Prerequisite | Installed (registry) | Present | Kind | When absent |
|---|---|---|---|---|
| `@authboundry/local` per-agent delegation | 0.1.0 | no | optional | agent callers `unavailable` by default; owner opt-in shares executor grants |
| `@appport/services` notification inbox | 0.19.0 | no | optional | `page`/`unreadCount`/`markAllRead` refuse naming the release |
| `@feltdb/core` set-membership queries | 0.21.0 | no | optional | `where … in` refuses naming the release |

Gate self-tests (real exit codes): a skipped compatibility test → fail; an artifact without the change → fail;
an unpublished build carrying a published version number (`@authboundry/local` source, still "0.1.0") → fail
("files differ"); a missing required capability → fail; the true published set → pass.

## Application release gate (fresh install, `release/verify.sh`)

| Label | FeltKit | Opt-in | Result |
|---|---|---|---|
| `gate2-published-0.3.30` | registry 0.3.30 | — | **33/33** |
| `gate2-published-0.3.31` | registry 0.3.31 | — | 35/37: the app's agent-spending tests (acceptance, agents) fail; the 4 FK-16 tests pass (refusal) |
| `gate2-candidate-0.3.32-default` | packed 0.3.32 (integrity verified) | no | 35/37: **fails closed exactly as 0.3.31**; the same two app tests fail by design |
| `gate2-candidate-0.3.32-opt-in` | packed 0.3.32 (integrity verified) | yes (scratch copy only) | **37/37** |

All runs: `@authboundry/local` 0.1.0 and every other dependency from the registry; `FELTDB_*` unset.
The committed application is unchanged (still on 0.3.30).
