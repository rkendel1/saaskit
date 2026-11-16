/**
 * Catalog administration: what the business sells. Operators edit one draft; publishing freezes it
 * as a new immutable version. History is never rewritten: a rollback publishes an old document as a
 * NEW version. Existing subscriptions keep the version they were sold under until migrated.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, audit, catalogVersions } from "./app.js";
import { canonical, catalogDiff, catalogProblems, catalogSchema, seedCatalog, type Catalog } from "./_catalog.js";
import { latestPublished, principalOf } from "./_commerce.js";
import { sha256Hex, type QueryCtx } from "@feltdb/feltkit";

const VersionSummary = s.object({
  id: s.string(),
  version: s.integer(),
  state: s.enum(["draft", "published", "archived"]),
  label: s.string(),
  notes: s.optional(s.string()),
  digest: s.string(),
  basedOn: s.optional(s.integer()),
  createdAt: s.number(),
  createdBy: s.string(),
  publishedAt: s.optional(s.number()),
  publishedBy: s.optional(s.string()),
  effectiveAt: s.optional(s.number()),
  migration: s.optional(s.enum(["grandfather", "migrate_at_renewal"])),
  current: s.boolean(),
  plans: s.integer(),
});

function digestOf(doc: Catalog) {
  return sha256Hex(canonical(doc)).slice(0, 16);
}

async function draftOf(ctx: QueryCtx) {
  const [d] = await ctx.db.find(catalogVersions, { state: "draft" }, { limit: 1 });
  return d ?? null;
}

/** The public offer: the current published version's public, active plans and add-ons. No sign-in needed (pricing page). */
export const offer = app.query({
  access: "public",
  capability: { name: "catalog.offer", description: "What is for sale now: public plans with prices, features and limits, and add-ons." },
  returns: s.object({ version: s.nullable(s.integer()), catalog: s.nullable(catalogSchema) }),
  handler: async (ctx) => {
    const v = await latestPublished(ctx);
    if (!v) return { version: null, catalog: null };
    const c = v.document as Catalog;
    return {
      version: v.version,
      catalog: { ...c, plans: c.plans.filter((p) => p.visibility === "public" && p.status === "active"), products: c.products.filter((p) => p.visibility === "public"), coupons: [] },
    };
  },
});

export const versions = app.query({
  access: "catalog.read.history",
  returns: s.array(VersionSummary),
  handler: async (ctx) => {
    const all = await ctx.db.find(catalogVersions, {}, { orderBy: [{ field: "version", direction: "desc" }] });
    const current = await latestPublished(ctx);
    return all.map((v) => ({
      id: v.id, version: v.version, state: v.state, label: v.label, notes: v.notes, digest: v.digest, basedOn: v.basedOn, createdAt: v.createdAt, createdBy: v.createdBy,
      publishedAt: v.publishedAt, publishedBy: v.publishedBy, effectiveAt: v.effectiveAt, migration: v.migration, current: v.id === current?.id, plans: (v.document as Catalog).plans.length,
    }));
  },
});

export const version = app.query({
  access: "catalog.read.history",
  args: { version: s.integer() },
  handler: async (ctx, { version }) => {
    const [v] = await ctx.db.find(catalogVersions, { version }, { limit: 1 });
    if (!v) fail("NOT_FOUND", `No catalog version ${version}.`);
    return { ...v, problems: catalogProblems(v.document as Catalog) };
  },
});

/** The draft being edited, with every reason it cannot be published yet. */
export const draft = app.query({
  access: "catalog.edit",
  handler: async (ctx) => {
    const d = await draftOf(ctx);
    return d ? { id: d.id, version: d.version, label: d.label, notes: d.notes ?? "", basedOn: d.basedOn ?? null, document: d.document as Catalog, problems: catalogProblems(d.document as Catalog), updatedAt: d.createdAt } : null;
  },
});

/** Start a draft from a version (default: the current one). One draft at a time. */
export const createDraft = app.mutation({
  access: "catalog.edit",
  args: { fromVersion: s.optional(s.integer()), label: s.optional(s.string({ maxLength: 120 })) },
  handler: async (ctx, { fromVersion, label }) => {
    if (await draftOf(ctx)) fail("FAILED_PRECONDITION", "A draft already exists. Publish or discard it first.");
    const [latest] = await ctx.db.find(catalogVersions, {}, { orderBy: [{ field: "version", direction: "desc" }], limit: 1 });
    let base: Catalog = seedCatalog();
    let basedOn: number | undefined;
    if (fromVersion !== undefined) {
      const [v] = await ctx.db.find(catalogVersions, { version: fromVersion }, { limit: 1 });
      if (!v) fail("NOT_FOUND", `No catalog version ${fromVersion}.`);
      base = v.document as Catalog;
      basedOn = v.version;
    } else {
      const current = await latestPublished(ctx);
      if (current) {
        base = current.document as Catalog;
        basedOn = current.version;
      }
    }
    const nextVersion = (latest?.version ?? 0) + 1;
    const id = await ctx.db.insert(catalogVersions, { version: nextVersion, state: "draft", label: label ?? `Version ${nextVersion}`, document: base, digest: digestOf(base), ...(basedOn ? { basedOn } : {}), createdAt: Date.now(), createdBy: principalOf(ctx).id });
    await audit.record(ctx, { subject: "catalog", id: String(nextVersion), type: "catalog.draft.created", data: { basedOn: basedOn ?? null } });
    return { id, version: nextVersion };
  },
});

/** Replace the draft's document. Schema-validated by FeltDB; business problems are returned, not thrown, so a draft can be work in progress. */
export const saveDraft = app.mutation({
  access: "catalog.edit",
  args: { document: catalogSchema, label: s.optional(s.string({ maxLength: 120 })), notes: s.optional(s.string({ maxLength: 2000 })) },
  returns: s.object({ problems: s.array(s.string()), digest: s.string() }),
  handler: async (ctx, { document, label, notes }) => {
    const d = await draftOf(ctx);
    if (!d) fail("FAILED_PRECONDITION", "There is no draft. Create one first.");
    const doc = document as Catalog;
    const digest = digestOf(doc);
    await ctx.db.patch(catalogVersions, d.id, { document: doc, digest, ...(label !== undefined ? { label } : {}), ...(notes !== undefined ? { notes } : {}) });
    return { problems: catalogProblems(doc), digest };
  },
});

export const discardDraft = app.mutation({
  access: "catalog.edit",
  handler: async (ctx) => {
    const d = await draftOf(ctx);
    if (!d) return;
    await ctx.db.delete(catalogVersions, d.id);
    await audit.record(ctx, { subject: "catalog", id: String(d.version), type: "catalog.draft.discarded" });
  },
});

/**
 * Publish the draft as an immutable version. New sign-ups and checkouts use it from `effectiveAt`.
 * Existing subscriptions keep their version (grandfather) or move at their next renewal.
 */
export const publish = app.mutation({
  access: "catalog.publish",
  args: { effectiveAt: s.optional(s.number()), migration: s.optional(s.enum(["grandfather", "migrate_at_renewal"])), notes: s.optional(s.string({ maxLength: 2000 })) },
  returns: s.object({ version: s.integer(), digest: s.string() }),
  capability: { name: "catalog.publish", description: "Publish the catalog draft as a new immutable version." },
  handler: async (ctx, { effectiveAt, migration, notes }) => {
    const d = await draftOf(ctx);
    if (!d) fail("FAILED_PRECONDITION", "There is no draft to publish.");
    const problems = catalogProblems(d.document as Catalog);
    if (problems.length) fail("FAILED_PRECONDITION", `The draft cannot be published: ${problems.join(" ")}`, { problems });
    const current = await latestPublished(ctx);
    if (current && current.digest === d.digest) fail("FAILED_PRECONDITION", `The draft is identical to version ${current.version}; nothing to publish.`);
    const now = Date.now();
    const who = principalOf(ctx).id;
    await ctx.db.patch(catalogVersions, d.id, { state: "published", publishedAt: now, publishedBy: who, effectiveAt: effectiveAt ?? now, migration: migration ?? "grandfather", ...(notes !== undefined ? { notes } : {}) });
    await audit.record(ctx, { subject: "catalog", id: String(d.version), type: "catalog.published", data: { digest: d.digest, effectiveAt: effectiveAt ?? now, migration: migration ?? "grandfather", previous: current?.version ?? null } });
    ctx.afterCommit.webhooks.emit("entitlements.changed", { catalogVersion: d.version });
    return { version: d.version, digest: d.digest };
  },
});

/** Republish an earlier version's document as a new version. History stays as it was. */
export const rollback = app.mutation({
  access: "catalog.publish",
  args: { toVersion: s.integer(), reason: s.string({ minLength: 3, maxLength: 500 }) },
  returns: s.object({ version: s.integer() }),
  handler: async (ctx, { toVersion, reason }) => {
    if (await draftOf(ctx)) fail("FAILED_PRECONDITION", "Discard or publish the current draft before rolling back.");
    const [old] = await ctx.db.find(catalogVersions, { version: toVersion }, { limit: 1 });
    if (!old || old.state === "draft") fail("NOT_FOUND", `No published version ${toVersion}.`);
    const current = await latestPublished(ctx);
    if (current?.digest === old.digest) fail("FAILED_PRECONDITION", `Version ${toVersion} is already what is published.`);
    const [latest] = await ctx.db.find(catalogVersions, {}, { orderBy: [{ field: "version", direction: "desc" }], limit: 1 });
    const now = Date.now();
    const who = principalOf(ctx).id;
    const next = latest!.version + 1;
    await ctx.db.insert(catalogVersions, { version: next, state: "published", label: `Rollback to v${toVersion}`, notes: reason, document: old.document, digest: old.digest, basedOn: toVersion, createdAt: now, createdBy: who, publishedAt: now, publishedBy: who, effectiveAt: now, migration: "grandfather" });
    await audit.record(ctx, { subject: "catalog", id: String(next), type: "catalog.rolled_back", data: { toVersion, reason } });
    return { version: next };
  },
});

/** What changed between two versions, in commercial terms. */
export const diff = app.query({
  access: "catalog.read.history",
  args: { from: s.integer(), to: s.integer() },
  handler: async (ctx, { from, to }) => {
    const [a] = await ctx.db.find(catalogVersions, { version: from }, { limit: 1 });
    const [b] = await ctx.db.find(catalogVersions, { version: to }, { limit: 1 });
    if (!a || !b) fail("NOT_FOUND", "Both versions must exist.");
    return catalogDiff(a.document as Catalog, b.document as Catalog);
  },
});

/** First run: publish the seed model (Free, Pro, Business) when nothing is published. Idempotent. */
export const bootstrap = app.mutation({
  access: "catalog.publish",
  returns: s.object({ version: s.integer(), created: s.boolean() }),
  handler: async (ctx) => {
    const current = await latestPublished(ctx);
    if (current) return { version: current.version, created: false };
    const [any] = await ctx.db.find(catalogVersions, {}, { limit: 1 });
    if (any) fail("FAILED_PRECONDITION", "Catalog versions exist but none is in effect; publish the draft instead.");
    const doc = seedCatalog();
    const now = Date.now();
    const who = principalOf(ctx).id;
    await ctx.db.insert(catalogVersions, { version: 1, state: "published", label: "Launch pricing", document: doc, digest: digestOf(doc), createdAt: now, createdBy: who, publishedAt: now, publishedBy: who, effectiveAt: now, migration: "grandfather" });
    await audit.record(ctx, { subject: "catalog", id: "1", type: "catalog.published", data: { seed: true } });
    return { version: 1, created: true };
  },
});
