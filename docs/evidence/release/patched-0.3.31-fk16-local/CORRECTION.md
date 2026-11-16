# Correction: this run did NOT test a patched FeltKit

Recorded 2026-11-16, after the run and after commit `f1efacd`, whose message drew the wrong conclusion
from it ("the patch covers one refusal site; another path still refuses"). The run files in this
directory are kept unchanged as evidence.

## What this directory actually contains

A second run of **unmodified, published `@feltdb/feltkit` 0.3.31**. The file installed as
`feltdb-feltkit-0.3.31-fk16-local.tgz` is byte-identical to the registry artifact:

| | sha512 (npm integrity) |
|---|---|
| `npm view @feltdb/feltkit@0.3.31 dist.integrity` | `QQQEXXgVWkBV9pfWPI8I5jJPZ7s5LFcY5+7y6UdDokxY8+OmkQI339gkZVunOih26AHlJgyv9dcAYJrVQ+hhIg==` |
| the "patched" tarball, and `package-lock.json` in a fresh install of it | same |

The installed `dist/runtime/local-authority.js` has sha256
`d361579d2fc1b2063c0c5b41fc8c4ae9875724dde7058c16267eb2d9d97f44cf`, identical to the published file,
and does not contain the patch.

## How it happened

1. `npm pack @feltdb/feltkit@0.3.31` downloaded the published tarball as `feltdb-feltkit-0.3.31.tgz`.
2. The unpacked copy was edited, then `npm pack` was run on it. The package's `prepack` script is
   `npm run build` (`rm -rf dist && tsc …`): it deleted `dist/`, including the edit, and failed (a published
   package has no TypeScript source), so **no tarball was written**. The command's output was discarded.
3. The published tarball, which had the same file name, was then renamed `…-fk16-local.tgz` as if it were the
   patched build. Its timestamp (23:11:44.636) precedes the edit (23:11:44.869).

## Consequences

- The "same 3 failures" result is a reproduction of FK-16, not evidence of a second refusal path.
- The candidate patch in `release/fk16/feltkit-0.3.31-fk16.patch` has **never been executed**.
- The harness (`release/verify.sh`) was not at fault; the manual tarball step was. A patched artifact
  must be built with `npm pack --ignore-scripts` (or from source) and its integrity checked to
  **differ** from the published one before a run is labelled "patched".
