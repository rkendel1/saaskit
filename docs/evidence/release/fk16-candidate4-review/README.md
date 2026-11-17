# FK-16 candidate 4 (3debafa): independent review (2026-11-17)

Read-only reviewer, same brief as before (requirements and three properties, no author conclusions). Interrupted once
by a usage limit and resumed; tree verified clean and `@authboundry/local` byte-identical in between. Housekeeping at
the end: one temporary copy of the unreleased source over `node_modules/@authboundry/local`, restored and verified
by sha256; `git status` empty; no `release-artifact-*` left.

**No blocker. Three should-fix items before a real publish.**

| Property | Verdict | Findings |
|---|---|---|
| 1 Authorization | Holds | compat 7/7 on 0.1.0 and 7/7 with the unpublished source (local evidence: per-agent branches correct); opt-in only for an agent caller naming no agent; hosted unchanged, `agentCallers` not consulted; falsy config preserved |
| 2 Evidence | Holds | `authorityMode` in invocation notes, activity, policy `delegations[]` (durable), integration records; never read to authorize; readiness distinguishes six states; durability claims match code. Should-fix: "no authority configured" and an unreadable/missing credential not `lasting` → integrations still say "Try again". Notes: "not installed" recorded as `local-per-agent` (documented); `ActivityEntry` type lacks the new fields |
| 3 Release | Partially | Verified: gate exit 0, compat on the packed artifact 7/7, 27 upstream copies match incl. nested, tarballs reproduced byte for byte, shipped docs identical, failure classification (E404, E502, ECONNREFUSED). Should-fix: `publish-packages` resume path promoted a package published by an earlier run without checking it; the post-publish failure message pointed to a rerun that cannot recover. Should-fix (structural): the gate proves the workspace's installed copies, not what a consumer resolves (`@authboundry/local >=0.1.0` peer, core via local); today the installed versions equal the registry's latest. Notes: leftover `pending` dist-tags at 0.3.31; `withoutVersions` edge case; per-agent skips in other suites if the probe crashes; temp dir not removed; `artifact.json` holds only artifact data |

Response: candidate 5 (`cc89e00`) fixes the two publish-packages items and the lasting refusals (tested). The
consumer-resolution item is recorded as a known limit (FeltKit's gate verifies the installed set; resolution across
upstream releases is the ecosystem release system's concern), not changed.
