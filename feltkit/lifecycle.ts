/**
 * The lifecycle clock's entry points. The payments component calls `due`, then `advance` for each
 * account (one transaction each). Operators can run them by hand. `asOf` moves the clock forward
 * for demonstrations and tests and is refused in production.
 */
import { fail, s, type QueryCtx } from "@feltdb/feltkit";
import { app } from "./app.js";
import { advanceAccount, dueAccounts } from "./_lifecycle.js";

function clock(ctx: QueryCtx, asOf: number | undefined) {
  if (asOf === undefined) return Date.now();
  if (ctx.environment.production) fail("FORBIDDEN", "asOf (time travel) is refused in production.");
  return asOf;
}

export const due = app.query({
  access: "lifecycle.run",
  args: { asOf: s.optional(s.number()) },
  returns: s.array(s.string()),
  handler: async (ctx, { asOf }) => dueAccounts(ctx, clock(ctx, asOf)),
});

export const advance = app.mutation({
  access: "lifecycle.run",
  args: { accountId: s.string(), asOf: s.optional(s.number()) },
  returns: s.array(s.string()),
  handler: async (ctx, { accountId, asOf }) => advanceAccount(ctx, accountId, clock(ctx, asOf)),
});
