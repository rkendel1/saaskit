/** The business's console: revenue, catalog, customers, invoices, provider events, anomalies, audit. */
import { Fragment, useEffect, useState } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import type { Catalog } from "../feltkit/_catalog";
import { Action, Badge, Bars, Card, date, Empty, Failed, Loading, money, num, relative, Stat, value } from "./ui";

type Report = (e: unknown) => void;
type Inform = (text: string) => void;
const TABS = ["overview", "catalog", "customers", "invoices", "events", "anomalies", "audit"] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = { overview: "Overview", catalog: "Catalog & pricing", customers: "Customers", invoices: "Invoices", events: "Payment events", anomalies: "Needs attention", audit: "Audit log" };

export function OperatorConsole({ onError, inform }: { onError: Report; inform: Inform }) {
  const [tab, setTab] = useState<Tab>("overview");
  const anomalies = useQueryState(api.ops.anomalies, {});
  return (
    <div className="portal">
      <nav className="tabs" aria-label="Operations">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? "on" : ""} aria-current={tab === t ? "page" : undefined} onClick={() => setTab(t)}>
            {LABEL[t]}{t === "anomalies" && anomalies.data?.length ? <span className="count">{anomalies.data.length}</span> : null}
          </button>
        ))}
      </nav>
      {tab === "overview" && <Overview />}
      {tab === "catalog" && <CatalogAdmin onError={onError} inform={inform} />}
      {tab === "customers" && <Customers onError={onError} inform={inform} />}
      {tab === "invoices" && <InvoicesAdmin onError={onError} inform={inform} />}
      {tab === "events" && <Events onError={onError} />}
      {tab === "anomalies" && <Anomalies />}
      {tab === "audit" && <Audit />}
    </div>
  );
}

function Overview() {
  const o = useQueryState(api.ops.overview, {});
  const adoption = useQueryState(api.ops.catalogAdoption, {});
  if (o.error) return <Failed error={o.error} />;
  if (!o.data) return <Loading />;
  const d = o.data;
  return (
    <div className="grid">
      <Card className="wide">
        <div className="stats">
          <Stat label="MRR" value={money(d.mrr, d.currency)} hint={`ARR ${money(d.arr, d.currency)}`} />
          <Stat label="Revenue this month" value={money(d.revenueThisMonth, d.currency)} hint={`refunded ${money(d.refunded, d.currency)} all time`} />
          <Stat label="Overage revenue" value={money(d.overageRevenue, d.currency)} hint="usage beyond allowances" />
          <Stat label="Open invoices" value={d.openInvoices} hint={money(d.openAmount, d.currency)} />
          <Stat label="Agent spend" value={money(d.agentSpend, d.currency)} hint="charges caused by agents" />
          <Stat label="Accounts" value={d.accounts} hint={`catalog v${d.catalogVersion ?? "—"}`} />
        </div>
      </Card>
      <Card title="Revenue by month"><Bars data={d.revenueByMonth.map((r) => ({ label: r.month.slice(2), value: r.amount }))} format={(v) => money(v, d.currency)} /></Card>
      <Card title="What each plan earns">
        <table className="table"><thead><tr><th>Plan</th><th className="num">Accounts</th><th className="num">MRR</th></tr></thead>
          <tbody>{Object.entries(d.byPlan).map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{v.accounts}</td><td className="num">{money(Math.round(v.mrr), d.currency)}</td></tr>)}</tbody></table>
      </Card>
      <Card title="Subscription states"><div className="chips">{Object.entries(d.byStatus).map(([k, v]) => <span key={k}><Badge>{k}</Badge> {v}</span>)}</div></Card>
      <Card title="Consumption (all accounts, all periods)"><Bars data={Object.entries(d.usageByMeter).map(([k, v]) => ({ label: k, value: v }))} format={num} /></Card>
      <Card title="Catalog adoption">
        {!adoption.data?.length ? <Empty>No catalog published.</Empty> : <table className="table"><tbody>{adoption.data.map((v) => <tr key={v.version}><td>v{v.version} · {v.label}</td><td className="num">{v.accounts} accounts</td></tr>)}</tbody></table>}
      </Card>
      <Card title="Payment provider events"><div className="chips"><span>{d.providerEvents.total} verified</span><span><Badge tone="bad">failed</Badge> {d.providerEvents.failed}</span><span><Badge tone="warn">unmatched</Badge> {d.providerEvents.unmatched}</span></div></Card>
    </div>
  );
}

// ─── Catalog ─────────────────────────────────────────────────────────────────────────────────

function CatalogAdmin({ onError, inform }: { onError: Report; inform: Inform }) {
  const versions = useQueryState(api.catalog.versions, {});
  const draft = useQueryState(api.catalog.draft, {});
  const bootstrap = useMutation(api.catalog.bootstrap);
  const createDraft = useMutation(api.catalog.createDraft);
  const rollback = useMutation(api.catalog.rollback);
  const [diff, setDiff] = useState<{ from: number; to: number } | null>(null);
  if (versions.error) return <Failed error={versions.error} />;
  if (!versions.data) return <Loading />;
  if (!versions.data.length) return <Card title="Catalog"><Empty action={<Action run={() => bootstrap({})} onError={onError} onDone={() => inform("Published Free, Pro and Business.")}>Publish the starter catalog</Action>}>Nothing is for sale yet.</Empty></Card>;
  const current = versions.data.find((v) => v.current);
  return (
    <div className="stack">
      {draft.data ? <DraftEditor draft={draft.data} onError={onError} inform={inform} /> : (
        <Card title={`Live catalog: v${current?.version} · ${current?.label}`} actions={<Action run={() => createDraft({})} onError={onError}>Edit (new draft)</Action>}>
          <p className="muted">Published versions are immutable. Edit a draft and publish it as a new version; existing customers keep their version until you migrate them.</p>
        </Card>
      )}
      <Card title="Version history">
        <table className="table">
          <thead><tr><th>Version</th><th>State</th><th>Published</th><th>By</th><th>Existing customers</th><th>Digest</th><th /></tr></thead>
          <tbody>{versions.data.map((v) => (
            <tr key={v.id}>
              <td>v{v.version} · {v.label} {v.current && <Badge tone="good">in effect</Badge>}</td>
              <td><Badge>{v.state}</Badge></td><td>{date(v.publishedAt ?? null, true)}{v.effectiveAt && v.publishedAt && v.effectiveAt > v.publishedAt ? ` (effective ${date(v.effectiveAt)})` : ""}</td>
              <td>{v.publishedBy ?? v.createdBy}</td><td>{v.migration ?? ""}</td><td><code>{v.digest}</code></td>
              <td className="row end">
                {v.version > 1 && v.state !== "draft" && <button className="link" onClick={() => setDiff({ from: v.basedOn ?? v.version - 1, to: v.version })}>Changes</button>}
                {v.state === "published" && !v.current && !draft.data && <Action kind="ghost" run={() => rollback({ toVersion: v.version, reason: window.prompt("Why roll back?") ?? "rollback" })} confirm={`Republish v${v.version} as a new version?`} onError={onError}>Roll back to this</Action>}
              </td>
            </tr>
          ))}</tbody>
        </table>
        {diff && <DiffView {...diff} onClose={() => setDiff(null)} />}
      </Card>
    </div>
  );
}

function DiffView({ from, to, onClose }: { from: number; to: number; onClose: () => void }) {
  const d = useQueryState(api.catalog.diff, { from, to });
  return (
    <div className="diff">
      <div className="row"><strong>v{from} → v{to}</strong><button className="link" onClick={onClose}>Close</button></div>
      {!d.data ? <Loading /> : !d.data.length ? <Empty>No commercial changes.</Empty> : <ul>{d.data.map((c, i) => <li key={i}><Badge tone="info">{c.kind}</Badge> <code>{c.key}</code> {c.detail}</li>)}</ul>}
    </div>
  );
}

type Draft = NonNullable<ReturnType<typeof useQueryState<typeof api.catalog.draft>>["data"]>;

function DraftEditor({ draft, onError, inform }: { draft: Draft; onError: Report; inform: Inform }) {
  const [doc, setDoc] = useState<Catalog>(draft.document);
  const [dirty, setDirty] = useState(false);
  const [problems, setProblems] = useState<string[]>(draft.problems);
  const [migration, setMigration] = useState<"grandfather" | "migrate_at_renewal">("grandfather");
  const [effective, setEffective] = useState("");
  const save = useMutation(api.catalog.saveDraft);
  const publish = useMutation(api.catalog.publish);
  const discard = useMutation(api.catalog.discardDraft);
  useEffect(() => { if (!dirty) { setDoc(draft.document); setProblems(draft.problems); } }, [draft, dirty]);
  const edit = (f: (c: Catalog) => void) => { const next = structuredClone(doc); f(next); setDoc(next); setDirty(true); };
  const plans = [...doc.plans].sort((a, b) => a.rank - b.rank);
  return (
    <Card title={`Draft v${draft.version}${draft.basedOn ? ` (from v${draft.basedOn})` : ""}`} actions={<>
      <Action kind="ghost" disabled={!dirty} run={async () => { const r = await save({ document: doc }); setProblems(r.problems); setDirty(false); }} onError={onError}>Save draft</Action>
      <Action disabled={dirty || problems.length > 0} run={() => publish({ migration, ...(effective ? { effectiveAt: new Date(effective).getTime() } : {}) })} confirm="Publish this catalog? New sign-ups use it immediately (or at its effective date)." onDone={(r) => inform(`Published v${r.version}.`)} onError={onError}>Publish</Action>
      <Action kind="danger" run={() => discard({})} confirm="Discard this draft?" onError={onError}>Discard</Action>
    </>}>
      {problems.length > 0 && <div className="banner bad"><strong>Can't publish yet:</strong><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
      {dirty && <div className="banner info">Unsaved changes. Save to validate.</div>}
      <div className="row wrap">
        <label className="inline">Existing customers <select value={migration} onChange={(e) => setMigration(e.target.value as typeof migration)}><option value="grandfather">keep their current version (grandfather)</option><option value="migrate_at_renewal">move to this version at renewal</option></select></label>
        <label className="inline">Effective <input type="datetime-local" value={effective} onChange={(e) => setEffective(e.target.value)} /> <span className="muted small">(empty: now)</span></label>
      </div>
      <div className="scroll-x">
        <table className="table editor">
          <thead>
            <tr><th>Feature</th>{plans.map((p) => <th key={p.key}><input aria-label={`${p.key} name`} value={p.name} onChange={(e) => edit((c) => { c.plans.find((x) => x.key === p.key)!.name = e.target.value; })} /><div className="muted small">{p.key}{p.isDefault ? " · default" : ""}</div></th>)}</tr>
          </thead>
          <tbody>
            {plans[0]!.prices.length > 0 && doc.plans.flatMap((p) => p.prices).length > 0 && (
              <tr className="section"><td>Prices (cents)</td>{plans.map((p) => (
                <td key={p.key}>{p.prices.map((pr) => (
                  <label key={pr.key} className="price-edit">{pr.interval}{pr.model === "per_seat" ? "/seat" : ""}
                    <input type="number" min={0} value={pr.unitAmount} onChange={(e) => edit((c) => { c.plans.find((x) => x.key === p.key)!.prices.find((x) => x.key === pr.key)!.unitAmount = Number(e.target.value); })} />
                  </label>
                ))}</td>
              ))}</tr>
            )}
            {doc.features.map((f) => (
              <tr key={f.key}>
                <td>{f.name}<div className="muted small">{f.key} · {f.type}</div></td>
                {plans.map((p) => {
                  const v = p.entitlements[f.key];
                  const set = (nv: boolean | number | null) => edit((c) => { c.plans.find((x) => x.key === p.key)!.entitlements[f.key] = nv; });
                  return (
                    <td key={p.key}>
                      {f.type === "boolean" ? <input type="checkbox" aria-label={`${p.key} ${f.key}`} checked={v === true} onChange={(e) => set(e.target.checked)} /> : (
                        <span className="limit-edit">
                          <input type="number" min={0} aria-label={`${p.key} ${f.key}`} disabled={v === null} value={v === null ? "" : Number(v ?? 0)} onChange={(e) => set(Number(e.target.value))} />
                          <label className="small"><input type="checkbox" checked={v === null} onChange={(e) => set(e.target.checked ? null : 0)} /> ∞</label>
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="section"><td>Beyond allowance</td>{plans.map((p) => (
              <td key={p.key}>{p.overage.map((o, i) => (
                <div key={o.meter} className="overage-edit small">
                  {o.meter}: <select value={o.policy} onChange={(e) => edit((c) => { c.plans.find((x) => x.key === p.key)!.overage[i]!.policy = e.target.value as "block"; })}><option value="block">block</option><option value="charge">charge</option><option value="allow">allow</option></select>
                  {o.policy === "charge" && <><input type="number" min={0} value={o.unitAmount ?? 0} aria-label="cents" onChange={(e) => edit((c) => { c.plans.find((x) => x.key === p.key)!.overage[i]!.unitAmount = Number(e.target.value); })} />¢/{num(o.perUnits ?? 1)}</>}
                </div>
              ))}</td>
            ))}</tr>
            <tr className="section"><td>Cancellation · grace · trial</td>{plans.map((p) => (
              <td key={p.key} className="small policy-cell">
                <select value={p.cancellation} onChange={(e) => edit((c) => { c.plans.find((x) => x.key === p.key)!.cancellation = e.target.value as "immediate"; })}><option value="end_of_period">end of period</option><option value="immediate">immediately</option></select>
                <label>grace <input type="number" min={0} max={60} value={p.graceDays} onChange={(e) => edit((c) => { c.plans.find((x) => x.key === p.key)!.graceDays = Number(e.target.value); })} /> days</label>
                <label>trial <input type="number" min={0} value={p.trialDays ?? 0} onChange={(e) => edit((c) => { c.plans.find((x) => x.key === p.key)!.trialDays = Number(e.target.value) || undefined; })} /> days</label>
                <label>visibility <select value={p.visibility} onChange={(e) => edit((c) => { c.plans.find((x) => x.key === p.key)!.visibility = e.target.value as "public"; })}><option value="public">public</option><option value="private">private</option></select></label>
              </td>
            ))}</tr>
          </tbody>
        </table>
      </div>
      <details><summary>Add a plan</summary><AddPlan doc={doc} onAdd={(key, name) => edit((c) => { const base = c.plans.find((p) => p.key === "pro") ?? c.plans[0]!; c.plans.push({ ...structuredClone(base), key, name, isDefault: false, rank: Math.max(...c.plans.map((p) => p.rank)) + 1, visibility: "private", prices: base.prices.map((p) => ({ ...p, key: `${key}-${p.interval}` })) }); })} /></details>
    </Card>
  );
}

function AddPlan({ doc, onAdd }: { doc: Catalog; onAdd: (key: string, name: string) => void }) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const taken = doc.plans.some((p) => p.key === key);
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); if (key && !taken) { onAdd(key, name || key); setKey(""); setName(""); } }}>
      <input placeholder="key (e.g. enterprise)" value={key} onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} aria-label="Plan key" />
      <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Plan name" />
      <button className="ghost" disabled={!key || taken}>Add (copies Pro, private)</button>
    </form>
  );
}

// ─── Customers ───────────────────────────────────────────────────────────────────────────────

function Customers({ onError, inform }: { onError: Report; inform: Inform }) {
  const list = useQueryState(api.ops.accountList, {});
  const [selected, setSelected] = useState<string | null>(null);
  if (list.error) return <Failed error={list.error} />;
  if (!list.data) return <Loading />;
  return (
    <div className="split">
      <Card title="Customers">
        {!list.data.length ? <Empty>No customers yet. Accounts appear when a workspace opens billing.</Empty> : (
          <table className="table clickable">
            <thead><tr><th>Workspace</th><th>Plan</th><th>Status</th><th>Card</th><th className="num">Open</th></tr></thead>
            <tbody>{list.data.map((a) => (
              <tr key={a.accountId} className={selected === a.accountId ? "selected" : ""} onClick={() => setSelected(a.accountId)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setSelected(a.accountId)}>
                <td>{a.name}<div className="muted small">owner {a.ownerId}</div></td><td>{a.plan} <span className="muted small">v{a.catalogVersion}</span></td><td><Badge>{a.subscriptionStatus ?? "—"}</Badge></td><td className="small">{a.paymentMethod ?? "—"}</td><td className="num">{a.openInvoices || ""}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {selected ? <CustomerDetail accountId={selected} onError={onError} inform={inform} /> : <Card><Empty>Select a customer to see why they have what they have.</Empty></Card>}
    </div>
  );
}

function CustomerDetail({ accountId, onError, inform }: { accountId: string; onError: Report; inform: Inform }) {
  const d = useQueryState(api.ops.accountDetail, { accountId });
  const grants = useQueryState(api.entitlements.grantsForAccount, { accountId });
  const grant = useMutation(api.entitlements.grant);
  const revoke = useMutation(api.entitlements.revoke);
  const [why, setWhy] = useState<string | null>(null);
  const explain = useQueryState(api.entitlements.explainForAccount, why ? { accountId, feature: why } : "skip");
  const [g, setG] = useState({ feature: "exports.monthly", kind: "grant" as "grant" | "override", value: "100", days: "30", reason: "" });
  if (d.error) return <Failed error={d.error} />;
  if (!d.data) return <Loading />;
  const x = d.data;
  return (
    <div className="stack">
      <Card title={x.account.name} actions={<Badge>{x.subscription.status}</Badge>}>
        <dl className="kv">
          <dt>Plan</dt><dd>{x.subscription.planKey} ({x.subscription.priceKey}) · catalog v{x.subscription.catalogVersion} · effective access: {x.effectivePlan}</dd>
          <dt>Period</dt><dd>{date(x.subscription.currentPeriodStart)} – {date(x.subscription.currentPeriodEnd)}</dd>
          <dt>Card</dt><dd>{x.account.paymentMethod ? `${x.account.paymentMethod.brand} •••• ${x.account.paymentMethod.last4}` : "none"}</dd>
          <dt>Provider customer</dt><dd><code>{x.account.providerCustomerRef ?? "—"}</code></dd>
        </dl>
      </Card>
      <Card title="Entitlements (click one for why)">
        <table className="table compact clickable"><tbody>{x.entitlements.map((e) => (
          <tr key={e.key} onClick={() => setWhy(e.key)} tabIndex={0} onKeyDown={(ev) => ev.key === "Enter" && setWhy(e.key)}><td>{e.name}</td><td>{value(e.value)}</td><td className="muted small">{e.used !== null ? `used ${num(e.used)}` : ""}</td><td className="muted small">{e.sources.join(" + ")}</td></tr>
        ))}</tbody></table>
        {why && explain.data && <ol className="explain">{explain.data.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
      </Card>
      <Card title="Grant or override">
        <form className="row wrap" onSubmit={(e) => { e.preventDefault(); const v = g.value === "true" ? true : g.value === "false" ? false : g.value === "unlimited" ? null : Number(g.value); void grant({ accountId, feature: g.feature, kind: g.kind, value: v, reason: g.reason || "operator grant", ...(g.days ? { expiresAt: Date.now() + Number(g.days) * 86_400_000 } : {}) }).then(() => inform("Granted. It applies on the customer's next request — no redeploy."), onError); }}>
          <select value={g.feature} onChange={(e) => setG({ ...g, feature: e.target.value })} aria-label="Feature">{x.entitlements.map((e) => <option key={e.key} value={e.key}>{e.key}</option>)}</select>
          <select value={g.kind} onChange={(e) => setG({ ...g, kind: e.target.value as "grant" })} aria-label="Kind"><option value="grant">add</option><option value="override">replace</option></select>
          <input value={g.value} onChange={(e) => setG({ ...g, value: e.target.value })} aria-label="Value (number, true/false, unlimited)" size={8} />
          <label className="inline">for <input value={g.days} onChange={(e) => setG({ ...g, days: e.target.value })} size={3} aria-label="Days" /> days</label>
          <input value={g.reason} onChange={(e) => setG({ ...g, reason: e.target.value })} placeholder="Reason (recorded)" aria-label="Reason" />
          <button className="primary">Apply</button>
        </form>
        {(grants.data ?? []).length > 0 && <table className="table compact"><tbody>{grants.data!.map((r) => (
          <tr key={r.id}><td>{r.kind} {r.feature} = {JSON.stringify(r.value)}</td><td className="small muted">{r.reason}</td><td className="small">{r.revokedAt ? "revoked" : r.expiresAt ? `until ${date(r.expiresAt)}` : ""}</td><td>{!r.revokedAt && r.kind !== "addon" && <Action kind="ghost" run={() => revoke({ grantId: r.id, reason: "operator" })} onError={onError}>Revoke</Action>}</td></tr>
        ))}</tbody></table>}
      </Card>
      <Card title="History">
        <ul className="timeline">{x.history.slice(0, 40).map((h) => <li key={h.id}><span className="muted small">{date(h.at, true)}</span> <strong>{h.type}</strong> <span className="muted small">by {h.actor}</span>{h.data && <code className="small">{JSON.stringify(h.data).slice(0, 160)}</code>}</li>)}</ul>
      </Card>
      <Card title="Provider events">
        {!x.events.length ? <Empty>None.</Empty> : <table className="table compact"><tbody>{x.events.map((e) => <tr key={e.id}><td>{date(e.receivedAt, true)}</td><td>{e.type}</td><td><Badge>{e.outcome}</Badge></td><td className="small">{e.detail}</td></tr>)}</tbody></table>}
      </Card>
    </div>
  );
}

function InvoicesAdmin({ onError, inform }: { onError: Report; inform: Inform }) {
  const [status, setStatus] = useState<"" | "open" | "paid" | "void">("");
  const list = useQueryState(api.ops.invoiceList, status ? { status } : {});
  const refund = useMutation(api.ops.refund);
  const reconcile = useMutation(api.ops.reconcile);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title="Invoices" actions={<select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status"><option value="">All</option><option value="open">Open</option><option value="paid">Paid</option><option value="void">Void</option></select>}>
      {list.error ? <Failed error={list.error} /> : !list.data ? <Loading /> : !list.data.length ? <Empty>No invoices.</Empty> : (
        <table className="table">
          <thead><tr><th>Number</th><th>Account</th><th>Kind</th><th>Status</th><th className="num">Total</th><th className="num">Refunded</th><th>Attempts</th><th /></tr></thead>
          <tbody>{list.data.map((i) => (
            <Fragment key={i.id}>
              <tr>
                <td><button className="link" onClick={() => setOpen(open === i.id ? null : i.id)}>{i.number}</button></td><td className="small">{i.accountId.slice(0, 10)}…</td><td>{i.kind}</td><td><Badge>{i.status}</Badge></td><td className="num">{money(i.total, i.currency)}</td><td className="num">{i.amountRefunded ? money(i.amountRefunded) : ""}</td><td>{i.attempts}{i.lastFailure && <span className="muted small"> · {i.lastFailure}</span>}</td>
                <td className="row end">
                  {i.status === "paid" && i.amountPaid > i.amountRefunded && <Action kind="ghost" run={async () => { const a = window.prompt(`Refund how much (cents, max ${i.amountPaid - i.amountRefunded})?`); if (a) await refund({ invoiceId: i.id, amount: Number(a), reason: window.prompt("Reason?") ?? "operator refund" }); }} onDone={() => inform("Refund requested; it settles when the provider confirms.")} onError={onError}>Refund</Action>}
                  <Action kind="ghost" run={() => reconcile({ invoiceId: i.id })} onDone={(n) => inform(`Asked the provider about ${n} payment(s).`)} onError={onError}>Reconcile</Action>
                </td>
              </tr>
              {open === i.id && <tr className="detail"><td colSpan={8}><table className="table compact"><tbody>{i.lines.map((l, k) => <tr key={k}><td>{l.kind}</td><td>{l.description}</td><td className="num">{money(l.amount, i.currency)}</td></tr>)}</tbody></table></td></tr>}
            </Fragment>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

function Events({ onError }: { onError: Report }) {
  const [outcome, setOutcome] = useState<"" | "applied" | "ignored" | "stale" | "unmatched" | "failed">("");
  const ev = useQueryState(api.ops.events, outcome ? { outcome } : {});
  const [status, setStatus] = useState<any>(null);
  useEffect(() => { void fetch("/stripe/status").then((r) => r.json()).then(setStatus, onError); }, [onError]);
  return (
    <div className="stack">
      <Card title="Payments component">
        {!status ? <Loading /> : (
          <div className="stats">
            <Stat label="Provider" value={`${status.provider ?? "none"} (${status.mode ?? "—"})`} hint={status.problem ?? (status.simulator ? `simulator ${status.simulator}` : "")} />
            <Stat label="Webhooks received" value={status.stats.received} hint={`${status.stats.rejected} rejected (bad signature)`} />
            <Stat label="Duplicates absorbed" value={status.stats.duplicates} />
            <Stat label="Provider work" value={status.stats.workDone} hint={`${status.stats.workRetried} retried · ${status.stats.workFailed} failed`} />
          </div>
        )}
      </Card>
      <Card title="Verified provider events" actions={<select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)} aria-label="Outcome"><option value="">All</option>{["applied", "ignored", "stale", "unmatched", "failed"].map((o) => <option key={o} value={o}>{o}</option>)}</select>}>
        {ev.error ? <Failed error={ev.error} /> : !ev.data ? <Loading /> : !ev.data.length ? <Empty>No events yet.</Empty> : (
          <table className="table compact">
            <thead><tr><th>Received</th><th>Event</th><th>Type</th><th>Outcome</th><th>What it did</th></tr></thead>
            <tbody>{ev.data.map((e) => <tr key={e.id}><td>{date(e.receivedAt, true)}</td><td><code className="small">{e.eventId}</code></td><td>{e.type}</td><td><Badge>{e.outcome}</Badge></td><td className="small">{e.detail}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Anomalies() {
  const a = useQueryState(api.ops.anomalies, {});
  if (a.error) return <Failed error={a.error} />;
  if (!a.data) return <Loading />;
  return (
    <Card title="Needs attention">
      {!a.data.length ? <Empty>Nothing needs attention. Failed or unmatched provider events, stuck checkouts, exhausting dunning and unsettled charges appear here.</Empty> : (
        <table className="table"><tbody>{a.data.map((x, i) => <tr key={i}><td><Badge>{x.severity}</Badge></td><td>{x.kind.replace(/_/g, " ")}</td><td className="small">{x.detail}</td><td className="small muted">{x.accountId?.slice(0, 10)}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

function Audit() {
  const a = useQueryState(api.ops.recentAudit, { limit: 200 });
  if (a.error) return <Failed error={a.error} />;
  if (!a.data) return <Loading />;
  return (
    <Card title="Every material decision">
      <ul className="timeline">{a.data.map((h) => <li key={h.id}><span className="muted small">{date(h.at, true)} ({relative(h.at)})</span> <Badge tone="info">{h.subjectType}</Badge> <strong>{h.type}</strong> <span className="muted small">by {h.actor} ({h.actorType}) · req {h.requestId.slice(0, 12)}</span>{h.data && <code className="small">{JSON.stringify(h.data).slice(0, 200)}</code>}</li>)}</ul>
    </Card>
  );
}
