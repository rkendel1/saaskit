/** The customer billing portal: one workspace's plan, usage, invoices, agents, team, and the product itself. */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { TenantSettings, useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { Action, Badge, Bars, Card, date, Empty, Failed, Loading, Meter, money, newKey, num, relative, Stat, value } from "./ui";

type Report = (e: unknown) => void;
type Inform = (text: string) => void;
const TABS = ["overview", "plans", "usage", "invoices", "agents", "team", "product"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { overview: "Overview", plans: "Plans", usage: "Usage", invoices: "Invoices", agents: "Agents", team: "Team & seats", product: "Use the product" };

const returnUrl = () => `${window.location.origin}/#/billing`;

export function CustomerPortal({ onError, inform }: { onError: Report; inform: Inform }) {
  const summary = useQueryState(api.billing.summary, {});
  const open = useMutation(api.billing.open);
  const opened = useRef(false);
  const [tab, setTab] = useState<Tab>(() => (TABS.find((t) => window.location.hash.includes(`tab=${t}`)) ?? "overview"));
  useEffect(() => {
    if (summary.data === null && !opened.current) {
      opened.current = true;
      void open({}).catch(onError);
    }
  }, [summary.data, open, onError]);
  const returned = useMemo(() => new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("result"), []);

  if (summary.error) return <Failed error={summary.error} />;
  if (!summary.data) return <Loading what="Opening your billing account" />;
  const s = summary.data;
  return (
    <div className="portal">
      <nav className="tabs" aria-label="Billing">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? "on" : ""} aria-current={tab === t ? "page" : undefined} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </nav>
      <AwaitCheckout />
      <StatusBanner s={s} returned={returned} onError={onError} />
      {tab === "overview" && <Overview s={s} go={setTab} onError={onError} />}
      {tab === "plans" && <Plans s={s} onError={onError} inform={inform} />}
      {tab === "usage" && <Usage onError={onError} inform={inform} />}
      {tab === "invoices" && <Invoices onError={onError} />}
      {tab === "agents" && <Agents onError={onError} inform={inform} />}
      {tab === "team" && <Team s={s} />}
      {tab === "product" && <Product onError={onError} inform={inform} />}
    </div>
  );
}

type Summary = NonNullable<ReturnType<typeof useQueryState<typeof api.billing.summary>>["data"]>;

function StatusBanner({ s, returned, onError }: { s: Summary; returned: string | null; onError: Report }) {
  const sub = s.subscription;
  const abandon = useMutation(api.billing.abandonPending);
  if (sub.pending) {
    return (
      <div className="banner info" role="status">
        <div>
          <strong>{returned === "success" ? "Payment received by the provider — waiting for its verified confirmation." : `Your change to ${sub.pending.planKey} is waiting for payment.`}</strong>
          <div className="muted">Access changes only when the payment provider's signed event is verified, never from this page.</div>
        </div>
        <div className="row">
          {s.pendingCheckout?.url && <a className="button primary" href={s.pendingCheckout.url}>Continue to checkout</a>}
          {!s.pendingCheckout?.url && s.pendingCheckout && <span className="muted"><span className="spinner small" /> Preparing checkout…</span>}
          <Action kind="ghost" run={() => abandon({})} onError={onError} confirm="Abandon this purchase? Its invoice will be voided.">Abandon</Action>
        </div>
      </div>
    );
  }
  if (sub.status === "past_due") return <div className="banner warn" role="alert"><div><strong>Your last payment failed.</strong> You keep {sub.planName} until {date(sub.graceUntil)} — update your card to avoid suspension.</div></div>;
  if (sub.status === "suspended") return <div className="banner bad" role="alert"><div><strong>{sub.planName} is suspended.</strong> Paid features are paused until the open invoice is paid. You are on {s.effectivePlan.name} limits.</div></div>;
  if (sub.status === "canceled") return <div className="banner warn"><div><strong>{sub.planName} is canceled.</strong> Access continues until {date(sub.currentPeriodEnd)}; then the workspace returns to Free.</div></div>;
  if (sub.status === "trialing") return <div className="banner info"><div><strong>{sub.planName} trial</strong> ends {relative(sub.trialEnd!)} ({date(sub.trialEnd)}). {s.account.paymentMethod ? "Your card will be charged then." : "Add a card to keep it."}</div></div>;
  if (sub.scheduledChange) return <div className="banner info"><div>On {date(sub.scheduledChange.effectiveAt)} your plan changes to <strong>{sub.scheduledChange.planKey}</strong>.</div></div>;
  return null;
}

function Overview({ s, go, onError }: { s: Summary; go: (t: Tab) => void; onError: Report }) {
  const sub = s.subscription;
  const inbox = useQueryState(api.inbox.list, {});
  const markRead = useMutation(api.inbox.markRead);
  const card = useMutation(api.billing.updatePaymentMethod);
  return (
    <div className="grid">
      <Card title="Your plan" actions={<button className="ghost" onClick={() => go("plans")}>Compare plans</button>}>
        <div className="plan-hero">
          <div>
            <div className="plan-name">{sub.planName} <Badge>{sub.status}</Badge></div>
            <div className="muted">
              {sub.unitAmount ? `${money(sub.unitAmount, sub.currency)} per ${sub.model === "per_seat" ? "seat per " : ""}${sub.interval}` : "Free forever"}
              {sub.model === "per_seat" && ` · ${sub.seats} seats`} · catalog v{sub.catalogVersion}
              {sub.catalogVersion < s.catalogCurrent && <span title="You keep the terms you signed up under."> (grandfathered)</span>}
            </div>
          </div>
          <div className="period">
            <div className="muted">Current period</div>
            <div>{date(sub.currentPeriodStart)} – {date(sub.currentPeriodEnd)}</div>
          </div>
        </div>
      </Card>
      <Card title="Next charge">
        {s.upcoming ? (
          <>
            <div className="big">{money(s.upcoming.total, s.upcoming.currency)}</div>
            <div className="muted">on {date(s.upcoming.at)} ({relative(s.upcoming.at)})</div>
            <dl className="kv">
              <dt>Subscription</dt><dd>{money(s.upcoming.subscription, s.upcoming.currency)}</dd>
              {s.upcoming.discount > 0 && (<><dt>Discount ({sub.coupon?.code})</dt><dd>−{money(s.upcoming.discount, s.upcoming.currency)}</dd></>)}
              <dt>Usage beyond plan (so far)</dt><dd>{money(s.upcoming.overage, s.upcoming.currency)}</dd>
            </dl>
          </>
        ) : (
          <Empty>No upcoming charge.</Empty>
        )}
      </Card>
      <Card title="Payment method" actions={<Action kind="ghost" run={async () => { const r = await card({ returnUrl: returnUrl() }); window.location.hash = `#/billing?await=${r.checkoutId}`; }} onError={onError}>{s.account.paymentMethod ? "Replace" : "Add card"}</Action>}>
        {s.account.paymentMethod ? (
          <div className="pm">
            <span className="pm-brand">{s.account.paymentMethod.brand}</span> •••• {s.account.paymentMethod.last4}
            <span className="muted"> · expires {s.account.paymentMethod.expMonth}/{s.account.paymentMethod.expYear}</span>
          </div>
        ) : (
          <Empty>No card on file. Paid plans collect one at checkout.</Empty>
        )}
        {s.openInvoices.map((i) => <OpenInvoice key={i.id} i={i} onError={onError} />)}
      </Card>
      <Card title="Usage this period" className="wide" actions={<button className="ghost" onClick={() => go("usage")}>Details</button>}>
        <div className="meters">
          {s.usage.map((u) => (
            <Meter key={u.feature} label={u.name} used={u.used} limit={u.allowance} reserved={u.reserved} unit={u.unit} policy={u.policy} />
          ))}
        </div>
      </Card>
      <Card title="What you get" className="wide">
        <table className="table">
          <thead><tr><th>Feature</th><th>Your access</th><th>Why</th></tr></thead>
          <tbody>
            {s.entitlements.map((e) => (
              <tr key={e.key}>
                <td>{e.name}</td>
                <td>{value(e.value, e.type === "rate" ? "/min" : e.unit)}</td>
                <td className="muted small">{e.sources.join(" + ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Billing notifications" className="wide">
        {inbox.isLoading ? <Loading /> : !inbox.data?.length ? <Empty>Nothing yet. You'll hear about payments, renewals, usage thresholds and agent spending here.</Empty> : (
          <ul className="feed">
            {inbox.data.slice(0, 12).map((n) => (
              <li key={n.id} className={n.read ? "read" : ""}>
                <Badge tone="info">{n.type}</Badge> <span>{n.title}</span> <span className="muted small">{relative(Date.parse(String(n.createdAt)))}</span>
                {!n.read && <button className="link" onClick={() => void markRead({ id: n.id }).catch(onError)}>Mark read</button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** After a purchase starts, follow the provider's hosted page as soon as its URL exists. */
function AwaitCheckout() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const id = new URLSearchParams(hash.split("?")[1] ?? "").get("await");
  const c = useQueryState(api.billing.checkout, id ? { checkoutId: id } : "skip");
  useEffect(() => {
    if (c.data?.url && c.data.state === "open") window.location.href = c.data.url;
  }, [c.data]);
  if (!id || !c.data || c.data.state === "completed") return null;
  if (c.data.state === "failed") return <div className="banner bad" role="alert"><div>The payment provider could not open checkout: {c.data.error}</div></div>;
  return <div className="banner info" role="status"><div><span className="spinner small" /> Opening the payment provider's secure page…</div></div>;
}

function OpenInvoice({ i, onError }: { i: Summary["openInvoices"][number]; onError: Report }) {
  const retry = useMutation(api.billing.retryPayment);
  return (
    <div className="open-invoice">
      <div><strong>{i.number}</strong> {money(i.total)} unpaid · {i.attempts} attempt(s){i.lastFailure && <span className="muted"> · {i.lastFailure}</span>}{i.nextAttemptAt && <span className="muted"> · retry {relative(i.nextAttemptAt)}</span>}</div>
      <Action kind="ghost" run={() => retry({ invoiceId: i.id })} onError={onError}>Retry now</Action>
    </div>
  );
}

function Plans({ s, onError, inform }: { s: Summary; onError: Report; inform: Inform }) {
  const offer = useQueryState(api.catalog.offer, {});
  const [interval, setInterval] = useState<"month" | "year">(s.subscription.interval);
  const [seats, setSeats] = useState(Math.max(s.subscription.seats, 1));
  const [coupon, setCoupon] = useState("");
  const [selected, setSelected] = useState<{ planKey: string; priceKey: string } | null>(null);
  const change = useMutation(api.billing.changePlan);
  const trial = useMutation(api.billing.startTrial);
  const cancel = useMutation(api.billing.cancel);
  const resume = useMutation(api.billing.resume);
  const unschedule = useMutation(api.billing.cancelScheduledChange);
  if (offer.error) return <Failed error={offer.error} />;
  if (!offer.data?.catalog) return <Loading what="Loading plans" />;
  const c = offer.data.catalog;
  const sub = s.subscription;
  const onFree = s.effectivePlan.onDefault || c.plans.find((p) => p.key === sub.planKey)?.isDefault;
  return (
    <div className="stack">
      <div className="plan-controls">
        <div className="segmented" role="group" aria-label="Billing interval">
          <button className={interval === "month" ? "on" : ""} onClick={() => setInterval("month")}>Monthly</button>
          <button className={interval === "year" ? "on" : ""} onClick={() => setInterval("year")}>Annual <span className="muted small">2 months free</span></button>
        </div>
        <label className="inline">Seats <input type="number" min={1} max={500} value={seats} onChange={(e) => setSeats(Math.max(1, Number(e.target.value) || 1))} /></label>
        {onFree && <label className="inline">Coupon <input value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} placeholder="LAUNCH20" /></label>}
      </div>
      <div className="plan-grid">
        {c.plans.sort((a, b) => a.rank - b.rank).map((p) => {
          const price = p.prices.find((x) => x.interval === interval) ?? p.prices[0]!;
          const current = p.key === sub.planKey && price.key === sub.priceKey;
          return (
            <article key={p.key} className={`plan ${current ? "current" : ""}`}>
              <h3>{p.name} {current && <Badge tone="good">current</Badge>}</h3>
              <p className="muted">{p.description}</p>
              <div className="price">{price.unitAmount ? money(price.unitAmount, price.currency) : "Free"}<span className="muted small">{price.unitAmount ? ` / ${price.model === "per_seat" ? "seat / " : ""}${price.interval}` : ""}</span></div>
              {price.model === "per_seat" && <div className="muted small">minimum {price.minSeats ?? 1} seats</div>}
              <ul className="features">
                {c.features.map((f) => (
                  <li key={f.key} className={p.entitlements[f.key] === false || p.entitlements[f.key] === 0 || !(f.key in p.entitlements) ? "off" : ""}>
                    <span>{f.name}</span><span>{value(f.key in p.entitlements ? p.entitlements[f.key]! : f.type === "boolean" ? false : 0, f.type === "rate" ? "/min" : "")}</span>
                  </li>
                ))}
              </ul>
              {p.overage.filter((o) => o.policy !== "block").length > 0 && (
                <div className="muted small">Beyond allowances: {p.overage.filter((o) => o.policy === "charge").map((o) => `${o.meter} ${money(o.unitAmount ?? 0)}/${o.perUnits === 1 ? "unit" : num(o.perUnits)}`).join(", ")}</div>
              )}
              {p.overage.every((o) => o.policy === "block") && <div className="muted small">Hard limits: usage stops at the allowance.</div>}
              <div className="plan-actions">
                {!current && <button className="primary" onClick={() => setSelected({ planKey: p.key, priceKey: price.key })}>{p.rank > (c.plans.find((x) => x.key === sub.planKey)?.rank ?? 0) ? "Upgrade" : "Switch"}</button>}
                {!current && onFree && p.trialDays ? <Action kind="ghost" run={() => trial({ planKey: p.key, priceKey: price.key, seats })} onDone={() => inform(`Your ${p.name} trial has started.`)} onError={onError}>Try free for {p.trialDays} days</Action> : null}
              </div>
            </article>
          );
        })}
      </div>
      {selected && <QuoteBox sel={selected} seats={seats} coupon={coupon || undefined} onClose={() => setSelected(null)} run={async () => {
        const r = await change({ ...selected, seats, ...(coupon ? { coupon } : {}), returnUrl: returnUrl() });
        setSelected(null);
        if (r.checkoutId) window.location.hash = `#/billing?await=${r.checkoutId}`;
        else inform(r.effective === "period_end" ? "Scheduled for the end of your billing period." : r.charged ? "Charging your card on file — the change applies when the provider confirms." : "Done.");
      }} onError={onError} />}
      <Card title="Subscription">
        <div className="row">
          {sub.status === "canceled" && sub.cancelAtPeriodEnd ? (
            <Action run={() => resume({})} onError={onError} onDone={() => inform("Your subscription will renew.")}>Resume subscription</Action>
          ) : !onFree ? (
            <Action kind="danger" run={() => cancel({ reason: "Canceled from the billing portal" })} confirm="Cancel your subscription? Access follows your plan's cancellation policy." onDone={(r) => inform(r.status === "expired" ? "Canceled. You are on Free now." : `Canceled. Access continues until ${date(r.accessUntil)}.`)} onError={onError}>Cancel subscription</Action>
          ) : <span className="muted">You are on the free plan.</span>}
          {sub.scheduledChange && <Action kind="ghost" run={() => unschedule({})} onError={onError}>Keep current plan</Action>}
        </div>
      </Card>
    </div>
  );
}

function QuoteBox({ sel, seats, coupon, onClose, run, onError }: { sel: { planKey: string; priceKey: string }; seats: number; coupon?: string; onClose: () => void; run: () => Promise<void>; onError: Report }) {
  const q = useQueryState(api.billing.quote, { ...sel, seats, ...(coupon ? { coupon } : {}) });
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Review change">
      <div className="modal-body card">
        <h2>Review your change</h2>
        {q.error ? <Failed error={q.error} /> : !q.data ? <Loading what="Pricing" /> : (
          <>
            <p>
              {q.data.kind === "downgrade" ? (q.data.effective === "now" ? "This takes effect now." : `This takes effect on ${date(q.data.effectiveAt)}, at the end of your paid period. Nothing is charged today.`)
                : q.data.kind === "upgrade" ? "You are charged the difference for the rest of this period; the new limits apply as soon as the payment is confirmed."
                : q.data.kind === "same" ? "That is your current plan." : "You'll pay for the first period now. The plan starts when the payment is confirmed."}
            </p>
            {q.data.lines.length > 0 && (
              <table className="table">
                <tbody>
                  {q.data.lines.map((l, i) => <tr key={i}><td>{l.description}</td><td className="num">{money(l.amount, q.data!.currency)}</td></tr>)}
                  <tr className="total"><td>Due today</td><td className="num">{money(q.data.total, q.data.currency)}</td></tr>
                </tbody>
              </table>
            )}
            <p className="muted small">Prices are computed on the server from the published catalog.</p>
            <div className="row end">
              <button className="ghost" onClick={onClose}>Back</button>
              {q.data.kind !== "same" && <Action run={run} onError={onError}>{q.data.total > 0 ? `Confirm and pay ${money(q.data.total, q.data.currency)}` : "Confirm"}</Action>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Usage({ onError, inform }: { onError: Report; inform: Inform }) {
  const u = useQueryState(api.usage.summary, {});
  const recent = useQueryState(api.usage.recent, { limit: 30 });
  const exportCsv = useMutation(api.usage.exportCsv);
  if (u.error) return <Failed error={u.error} />;
  if (!u.data) return <Loading />;
  return (
    <div className="stack">
      <Card title={`Usage · ${date(u.data.periodStart)} – ${date(u.data.periodEnd)}`} actions={<Action kind="ghost" run={() => exportCsv({})} onDone={(r) => inform(`Exported ${r.rows} events to a CSV file (Files service, id ${r.fileId}).`)} onError={onError}>Export CSV</Action>}>
        <div className="usage-grid">
          {u.data.meters.map((m) => (
            <div key={m.meter} className="usage-meter">
              <Meter label={m.name} used={m.used} limit={m.allowance} reserved={m.reserved} unit={m.unit} policy={m.policy} />
              <Bars data={m.daily.map((d) => ({ label: d.day.slice(5), value: d.quantity }))} height={90} />
              {m.byActor.length > 0 && (
                <table className="table compact">
                  <thead><tr><th>Who</th><th className="num">Used</th><th className="num">Cost</th></tr></thead>
                  <tbody>{m.byActor.map((a) => <tr key={a.actorType + a.actorId}><td>{a.actorType === "agent" ? "🤖 " : ""}{a.actorId}{a.onBehalfOf && <span className="muted small"> for {a.onBehalfOf}</span>}</td><td className="num">{num(a.quantity)}</td><td className="num">{money(a.cost)}</td></tr>)}</tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      </Card>
      <Card title="Recent usage events">
        {!recent.data?.length ? <Empty>No usage recorded yet.</Empty> : (
          <table className="table compact">
            <thead><tr><th>When</th><th>Meter</th><th className="num">Qty</th><th>Who</th><th>Disposition</th><th className="num">Cost</th></tr></thead>
            <tbody>{recent.data.map((e) => <tr key={e.id}><td>{date(e.recordedAt, true)}</td><td>{e.meter}</td><td className="num">{num(e.quantity)}</td><td>{e.actorType}:{e.actorId}</td><td><Badge>{e.disposition}</Badge></td><td className="num">{money(e.estimatedCost)}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Invoices({ onError }: { onError: Report }) {
  const list = useQueryState(api.billing.invoiceList, {});
  const refunds = useQueryState(api.billing.refundList, {});
  const [open, setOpen] = useState<string | null>(null);
  if (list.error) return <Failed error={list.error} />;
  if (!list.data) return <Loading />;
  if (!list.data.length) return <Card><Empty>No invoices yet. They appear when you subscribe, renew, or buy capacity.</Empty></Card>;
  void onError;
  return (
    <Card title="Invoices and receipts">
      <table className="table">
        <thead><tr><th>Number</th><th>Date</th><th>Kind</th><th>Status</th><th className="num">Total</th><th className="num">Refunded</th><th /></tr></thead>
        <tbody>
          {list.data.map((i) => (
            <Fragment key={i.id}>
              <tr>
                <td>{i.number}</td><td>{date(i.createdAt)}</td><td>{i.kind}</td><td><Badge>{i.status}</Badge></td><td className="num">{money(i.total, i.currency)}</td><td className="num">{i.amountRefunded ? money(i.amountRefunded, i.currency) : ""}</td>
                <td><button className="link" onClick={() => setOpen(open === i.id ? null : i.id)} aria-expanded={open === i.id}>{open === i.id ? "Hide" : i.status === "paid" ? "Receipt" : "Details"}</button></td>
              </tr>
              {open === i.id && (
                <tr className="detail"><td colSpan={7}>
                  <table className="table compact"><tbody>
                    {i.lines.map((l, k) => <tr key={k}><td>{l.description}</td><td className="num">{l.quantity !== 1 ? num(l.quantity) : ""}</td><td className="num">{money(l.amount, i.currency)}</td></tr>)}
                    <tr className="total"><td>Total</td><td /><td className="num">{money(i.total, i.currency)}</td></tr>
                    {i.paidAt && <tr><td className="muted">Paid {date(i.paidAt, true)}</td><td /><td className="num">{money(i.amountPaid, i.currency)}</td></tr>}
                    {(refunds.data ?? []).filter((r) => r.invoiceId === i.id).map((r) => <tr key={r.id}><td className="muted">Refund · {r.reason} <Badge>{r.state}</Badge></td><td /><td className="num">−{money(r.amount, i.currency)}</td></tr>)}
                  </tbody></table>
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Agents({ onError, inform }: { onError: Report; inform: Inform }) {
  const o = useQueryState(api.agents.overview, {});
  const delegations = useQueryState(api.agents.myDelegations, {});
  const setPolicy = useMutation(api.agents.setPolicy);
  const revoke = useMutation(api.agents.revokePolicy);
  const decide = useMutation(api.agents.decideRequest);
  const delegate = useMutation(api.agents.delegateSpending);
  const withdraw = useMutation(api.agents.withdrawSpending);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ budget: 500, perOp: 100, meters: ["agent.executions"], purchases: true });
  if (o.error) return <Failed error={o.error} />;
  if (!o.data) return <Loading />;
  const active = (delegations.data ?? []).find((d) => d.status === "active");
  return (
    <div className="stack">
      {!o.data.agentsEnabled && <div className="banner warn">Agents are not included in your plan. Upgrade to let agents work in this workspace.</div>}
      <Card title="Your delegation (AuthBoundry)">
        <p className="muted">Agents never get financial authority from being able to call the app. Before any agent can incur a charge, <em>you</em> delegate spending to the application at AuthBoundry; each agent then needs its own policy below. Withdrawing stops the very next charge.</p>
        {active ? (
          <div className="row"><Badge tone="good">delegated</Badge><span className="muted small">{active.id}{active.expiresAt ? ` · expires ${date(active.expiresAt)}` : ""}</span><Action kind="danger" run={() => withdraw({ delegationId: active.id })} onError={onError}>Withdraw</Action></div>
        ) : (
          <Action run={() => delegate({})} onDone={() => inform("Spending delegated to agents under their policies.")} onError={onError}>Delegate spending to agents</Action>
        )}
      </Card>
      <Card title="Agents in this workspace">
        {!o.data.agents.length ? <Empty>No agents yet. An operator issues an agent identity (<code>feltkit session create --type agent</code>) and a workspace owner adds it.</Empty> : (
          <table className="table">
            <thead><tr><th>Agent</th><th>Authority</th><th className="num">Spent this period</th><th className="num">Operations</th><th /></tr></thead>
            <tbody>
              {o.data.agents.map((a) => (
                <tr key={a.agentId}>
                  <td>🤖 {a.displayName}{!a.member && <span className="muted small"> (not a member)</span>}</td>
                  <td>{a.policy?.enabled ? <span>{a.policy.meters.join(", ") || "no meters"} · budget {money(a.policy.budgetPerPeriod)} · per op {money(a.policy.perOperationLimit)}{a.policy.mayRequestPurchases ? " · may request purchases" : ""}</span> : <Badge tone="muted">no spending authority</Badge>}</td>
                  <td className="num">{money(a.spent)}{a.policy?.enabled ? <span className="muted small"> / {money(a.policy.budgetPerPeriod)}</span> : null}</td>
                  <td className="num">{a.operations}</td>
                  <td className="row end">
                    <button className="ghost" onClick={() => { setEditing(a.agentId); if (a.policy) setForm({ budget: a.policy.budgetPerPeriod, perOp: a.policy.perOperationLimit, meters: a.policy.meters, purchases: a.policy.mayRequestPurchases }); }}>Set policy</button>
                    {a.policy?.enabled && <Action kind="danger" run={() => revoke({ agentId: a.agentId })} onError={onError}>Revoke</Action>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {editing && (
          <form className="policy-form" onSubmit={(e) => { e.preventDefault(); void setPolicy({ agentId: editing, enabled: true, budgetPerPeriod: form.budget, perOperationLimit: form.perOp, meters: form.meters, mayRequestPurchases: form.purchases }).then(() => { setEditing(null); inform("Policy saved."); }, onError); }}>
            <h3>Spending policy for {editing}</h3>
            <label>Overage budget per period (cents) <input type="number" min={0} value={form.budget} onChange={(e) => setForm({ ...form, budget: Number(e.target.value) })} /></label>
            <label>Largest single charge without approval (cents) <input type="number" min={0} value={form.perOp} onChange={(e) => setForm({ ...form, perOp: Number(e.target.value) })} /></label>
            <fieldset><legend>May consume</legend>{["agent.executions", "exports", "api.requests"].map((m) => <label key={m} className="inline"><input type="checkbox" checked={form.meters.includes(m)} onChange={(e) => setForm({ ...form, meters: e.target.checked ? [...form.meters, m] : form.meters.filter((x) => x !== m) })} /> {m}</label>)}</fieldset>
            <label className="inline"><input type="checkbox" checked={form.purchases} onChange={(e) => setForm({ ...form, purchases: e.target.checked })} /> May request purchases (always needs your approval)</label>
            <div className="row end"><button type="button" className="ghost" onClick={() => setEditing(null)}>Cancel</button><button className="primary">Save policy</button></div>
          </form>
        )}
      </Card>
      <Card title="Purchase requests from agents">
        {!o.data.requests.length ? <Empty>No requests.</Empty> : (
          <table className="table">
            <thead><tr><th>When</th><th>Agent</th><th>Asks for</th><th>Why</th><th className="num">Amount</th><th>State</th><th /></tr></thead>
            <tbody>{o.data.requests.map((r) => (
              <tr key={r.id}>
                <td>{relative(r.requestedAt)}</td><td>{r.agentId}</td><td>{r.addonKey}</td><td className="small">{r.justification}</td><td className="num">{money(r.amount)}</td><td><Badge>{r.state}</Badge></td>
                <td className="row end">{r.state === "pending" && (<>
                  <Action run={() => decide({ requestId: r.id, approve: true, returnUrl: returnUrl() })} onDone={(x) => { if (x.checkoutId) window.location.hash = `#/billing?await=${x.checkoutId}`; else inform("Approved: charging your card on file."); }} onError={onError}>Approve</Action>
                  <Action kind="ghost" run={() => decide({ requestId: r.id, approve: false, returnUrl: returnUrl() })} onError={onError}>Reject</Action>
                </>)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Team({ s }: { s: Summary }) {
  const limit = s.entitlements.find((e) => e.key === "team.members.max");
  return (
    <div className="stack">
      <Card title="Seats">
        <div className="stats">
          <Stat label="People in this workspace" value={s.seats.members} />
          <Stat label="Your plan allows" value={value(limit?.value ?? null)} />
          {s.subscription.model === "per_seat" && <Stat label="Seats billed" value={s.subscription.seats} hint="Change seats from Plans." />}
        </div>
      </Card>
      <TenantSettings className="card" />
    </div>
  );
}

function Product({ onError, inform }: { onError: Report; inform: Inform }) {
  const projects = useQueryState(api.workspace.listProjects, {});
  const create = useMutation(api.workspace.createProject);
  const runExport = useMutation(api.workspace.runExport);
  const apiCall = useMutation(api.workspace.apiCall);
  const analytics = useQueryState(api.workspace.advancedAnalytics, {});
  const [name, setName] = useState("");
  return (
    <div className="grid">
      <Card title="Projects" className="wide">
        <p className="muted small">This is the application being sold. Every action below asks the commercial engine whether your plan allows it, and meters it in the same transaction.</p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void create({ name }).then(() => setName(""), onError); }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" aria-label="New project name" />
          <button className="primary">Create project</button>
        </form>
        {!projects.data?.length ? <Empty>No projects yet.</Empty> : (
          <table className="table"><tbody>{projects.data.map((p) => (
            <tr key={p.id}><td>{p.name}</td><td className="muted small">{date(p.createdAt)}</td><td className="row end">
              <Action kind="ghost" run={() => runExport({ projectId: p.id, format: "csv", idempotencyKey: newKey("ui-export") })} onDone={(r) => inform(r.disposition === "overage" ? `Exported (beyond your allowance: ${money(r.estimatedCost)}).` : "Exported.")} onError={onError}>Export CSV</Action>
              <Action kind="ghost" run={() => apiCall({ endpoint: `/v1/projects/${p.id}`, idempotencyKey: newKey("ui-api") })} onError={onError}>API call</Action>
            </td></tr>
          ))}</tbody></table>
        )}
      </Card>
      <Card title="Advanced analytics" className="wide">
        {analytics.error ? <div className="locked">🔒 {analytics.error.message} <span className="muted">Upgrade under Plans.</span></div> : !analytics.data ? <Loading /> : <Bars data={analytics.data.cohorts.map((c) => ({ label: c.week, value: c.retained }))} format={(v) => `${v}%`} />}
      </Card>
    </div>
  );
}
