/** Shared UI primitives: money, dates, badges, meters, charts, empty/loading/error states, actions. */
import { useState, type ReactNode } from "react";
import type { FeltKitClientError } from "@feltdb/feltkit/react";

export function money(minor: number | null | undefined, currency = "usd") {
  if (minor === null || minor === undefined) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
}
export function date(ts: number | null | undefined, withTime = false) {
  if (!ts) return "—";
  return new Intl.DateTimeFormat(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(new Date(ts));
}
export function num(n: number | null | undefined) {
  if (n === null || n === undefined) return "Unlimited";
  return new Intl.NumberFormat().format(n);
}
export function value(v: boolean | number | null, unit = "") {
  if (v === true) return "Included";
  if (v === false) return "—";
  if (v === null) return "Unlimited";
  return `${num(v)}${unit ? ` ${unit}` : ""}`;
}
export function relative(ts: number) {
  const d = ts - Date.now();
  const abs = Math.abs(d);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 3_600_000) return rtf.format(Math.round(d / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(d / 3_600_000), "hour");
  return rtf.format(Math.round(d / 86_400_000), "day");
}

export function describe(error: unknown): string {
  const e = error as FeltKitClientError & { details?: { hint?: string } };
  if (e?.code === "FORBIDDEN") return `Not allowed: ${e.message}`;
  if (e?.code === "UNAUTHORIZED") return "Sign in to continue.";
  return e?.message ?? String(error);
}

const TONES: Record<string, string> = {
  active: "good", paid: "good", applied: "good", included: "good", succeeded: "good", completed: "good", approved: "good", ready: "good",
  trialing: "info", open: "info", pending: "info", requested: "info", creating: "info", overage: "warn",
  past_due: "warn", canceled: "warn", stale: "muted", ignored: "muted", void: "muted", expired: "muted", draft: "muted", archived: "muted", published: "good", rejected: "muted",
  suspended: "bad", failed: "bad", unmatched: "warn", uncollectible: "bad", high: "bad", medium: "warn", low: "muted",
};
export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  const t = tone ?? TONES[String(children)] ?? "muted";
  return <span className={`badge ${t}`}>{String(children).replace(/_/g, " ")}</span>;
}

export function Meter({ used, limit, reserved = 0, label, unit, policy }: { used: number; limit: number | null; reserved?: number; label: string; unit?: string; policy?: string }) {
  const unlimited = limit === null;
  const pct = unlimited || !limit ? 0 : Math.min((used / limit) * 100, 100);
  const rpct = unlimited || !limit ? 0 : Math.min((reserved / limit) * 100, 100 - pct);
  const over = !unlimited && limit !== null && used > limit;
  const tone = over ? "bad" : pct >= 80 ? "warn" : "good";
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="muted">
          {num(used)} {unlimited ? "" : `/ ${num(limit)}`} {unit}
          {over && <Badge tone="warn">{`+${num(used - (limit ?? 0))} ${policy === "charge" ? "billed" : policy === "allow" ? "allowed" : "over"}`}</Badge>}
        </span>
      </div>
      <div className="meter-bar" role="meter" aria-valuemin={0} aria-valuemax={limit ?? used} aria-valuenow={used} aria-label={label}>
        <div className={`meter-fill ${tone}`} style={{ width: `${unlimited ? 4 : pct}%` }} />
        {rpct > 0 && <div className="meter-reserved" style={{ width: `${rpct}%` }} title={`${reserved} reserved`} />}
      </div>
    </div>
  );
}

/** A bar chart in plain HTML/CSS: no chart library, and text is never stretched. */
export function Bars({ data, format = (v: number) => String(v), height = 140 }: { data: Array<{ label: string; value: number }>; format?: (v: number) => string; height?: number }) {
  if (!data.length) return <Empty>No data yet.</Empty>;
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="bars" role="img" aria-label={data.map((d) => `${d.label}: ${format(d.value)}`).join(", ")}>
      {data.map((d) => (
        <div key={d.label} className="bar-col" title={`${d.label}: ${format(d.value)}`}>
          <div className="bar-track" style={{ height }}>
            <div className="bar" style={{ height: `${Math.max((d.value / max) * 100, 1)}%` }} />
          </div>
          <div className="bar-label">{d.label}</div>
        </div>
      ))}
    </div>
  );
}

export function Stat({ label, value: v, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{v}</div>
      {hint && <div className="stat-hint muted">{hint}</div>}
    </div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div>{children}</div>
      {action}
    </div>
  );
}
export function Loading({ what = "Loading" }: { what?: string }) {
  return <div className="loading" aria-live="polite"><span className="spinner" /> {what}…</div>;
}
export function Failed({ error }: { error: unknown }) {
  return <div className="failed" role="alert">{describe(error)}</div>;
}

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** A button that runs an async action, shows progress, and reports failure. */
export function Action({ run, children, kind = "primary", disabled, confirm, onDone, onError }: { run: () => Promise<unknown>; children: ReactNode; kind?: "primary" | "ghost" | "danger"; disabled?: boolean; confirm?: string; onDone?: (r: any) => void; onError: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={kind}
      disabled={disabled || busy}
      aria-busy={busy}
      onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true);
        try {
          // Not `onDone?.(await run())`: an optional call skips evaluating its argument when onDone is absent.
          const result = await run();
          onDone?.(result);
        } catch (e) {
          onError(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <span className="spinner small" /> : null}
      {children}
    </button>
  );
}

export function newKey(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function can(granted: string[], permission: string): boolean {
  return granted.some((g) => g === "*" || g === permission || (g.endsWith(".*") && permission.startsWith(g.slice(0, -1))));
}
