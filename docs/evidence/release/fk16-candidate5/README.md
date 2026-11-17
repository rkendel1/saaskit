# FK-16 0.3.32 candidate 5 (2026-11-17)

FeltKit branch `fk16-compat-0.3.32` at `cc89e00`, **pushed** to `rkendel1/feltkit` at the owner's request (a branch only;
`main` unchanged at `c9fae9d`; nothing published). Series: `release/fk16/feltkit-0.3.32-candidate5-series/` (9 patches).

Changes from candidate 4 (review: `../fk16-candidate4-review/README.md`):
- `publish-packages`: before moving `latest`, BOTH packages (also one published by an earlier, resumed run) must be
  served with the checked sha512, with brief retries for registry lag; a mismatch stops with recovery instructions
  (`latest` unchanged, `pending` only). Not exercisable without the maintainer's npm login.
- "No authority configured" and an authority credential that is not set are `lasting`: integrations say "retrying
  will not change this". Tested (compat configuration test).

| Run | Result |
|---|---|
| Authority suites (compat, connections, policies, local-authority, executor-proof, authorize, application-platform) | 51: 49 pass, 0 fail, 2 per-agent skips (0.1.0) |
| Release dry run 1 | SDK 751: 740 pass, **1 fail**: `production-ops.test.ts` #10 (interrupted action, 409 expected, 200). Not in the FK-16 diff; fixture without authority; 6/6 on rerun. Recorded as FK-20 (intermittent), separate from FK-16 |
| Release dry run 2 | SDK 741/751, 0 fail, 10 capability-gated skips; conformance 50/50; create-feltkit 12/12; examples ✓; **release check passed** (gate, compat on the packed artifact); stops only at npm ownership |

Not repeated for this candidate: the fresh-install gate (candidate 4's runtime differs only in two `lasting` flags,
covered by the compat tests the gate runs against the packed artifact) and a fifth independent review.
