/**
 * FK-16 release-verification probe. Copied into a scratch copy of the application by
 * release/verify.sh (as feltkit/zzfk16.ts); never part of the shipped application.
 *
 * Calls ctx.authority.decide exactly as application code does, as whoever calls it, and returns
 * the decision's evidence fields so tests can assert who decided and for whom.
 */
import { s } from "@feltdb/feltkit";
import { app } from "./app.js";

const FORMS = {
  plain: "grace",
  prefixed: "user:grace",
  person: { person: "grace" },
  principal: { principal: "user:grace" },
  other: "linus",
} as const;

export const decide = app.mutation({
  access: "authenticated",
  args: { form: s.enum(["plain", "prefixed", "person", "principal", "other"]), agent: s.optional(s.string()) },
  handler: async (ctx, { form, agent }) => {
    // Cast: 0.3.30's types accept only a string onBehalfOf and no `agent`; 0.3.31 accepts all four forms.
    const d = await ctx.authority.decide({ capability: "billing.agentspend", onBehalfOf: FORMS[form], ...(agent ? { agent } : {}) } as never);
    return { allowed: d.allowed, outcome: d.outcome, reason: d.reason, executor: d.executor, onBehalfOf: d.onBehalfOf, delegationId: d.delegationId, proven: d.executorProof?.proven ?? null, authorityMode: (d as { authorityMode?: string | null }).authorityMode ?? null, lasting: (d as { lasting?: boolean }).lasting ?? false };
  },
});
