# FK-16 candidate 2 (9f13291): independent review (2026-11-17)

Reviewer: a separate read-only agent given the diff `c9fae9d..9f13291`, the packed tarballs, the maintainer's
requirements and the three properties to establish, not the author's conclusions. It modified no repository; one
temporary symlink swap of `node_modules/@authboundry/local` was restored and verified by sha256 and mode.

**Verdict: not publishable as is.**

| Property | Verdict | Findings |
|---|---|---|
| 1 Authorization correctness | Holds | No path widens authority. Opt-in only for an agent caller naming no agent; a named agent never falls back; hosted unchanged from 0.3.31; failed/deferred start fail closed; nothing reads `authorityMode`; only objects validated (run + read). Notes: `platform/platform.ts:234` delegatedAuthority is a separate, unchanged path without `authorityMode`; built-in `runtime.agent` tools run as the owning person (pre-existing) |
| 2 Evidence correctness | Partially | Should-fix: failed local start not `lasting` (integrations say "Try again"); empty authority-url variable read as hosted by readiness but as no address by decisions; `authorityMode` set on refusals where nothing was evaluated; refusals (no url, invalid, credential) not recorded; docs overstate durability ("every durable record"). Note: GUARANTEES `decide` row "always the executor" |
| 3 Release correctness | Does not hold | **B1 blocker (run):** a symlinked unpublished `@authboundry/local` passed the gate (exit 0): linked/`file:` copies were skipped. **B2 blocker (read):** the tarballs carried an uncommitted 0.3.32 version bump, and the gate inspected `packages/sdk/dist`, not the tarball. Should-fix: `local-authority`/`policies` tests still detected per-agent by source text. Note: scope registries not covered |

Other: per-agent branches cannot run against published 0.1.0 (gate exercises refusal and opt-in only);
`authorityMode` required on an exported type (breaks implementers); `AuthorityMode` not exported;
`LOCAL-AUTHORITY.md` not shipped.
