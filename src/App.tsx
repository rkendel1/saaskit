/**
 * The shell: who is signed in, which workspace they are in, and whether they see the business's
 * console (operators) or a workspace's billing portal (customers). The server decides access on
 * every call; what this shows is a convenience.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthNotices, CreateTenant, SignIn, TenantSwitcher, useConnectionState, useSession, useTenant } from "@feltdb/feltkit/react";
import { ThemeToggle } from "./theme";
import { CustomerPortal } from "./customer";
import { OperatorConsole } from "./operator";
import { can, describe } from "./ui";

type Notice = { tone: "error" | "info"; text: string } | null;
type Mode = "operator" | "customer";

export function App() {
  const { session, signInAsDevUser, signOut } = useSession();
  const tenant = useTenant();
  const live = useConnectionState();
  const [notice, setNotice] = useState<Notice>(null);
  const principal = session?.principal ?? null;
  const isOperator = can(session?.permissions ?? [], "ops.read");
  const [mode, setMode] = useState<Mode>(() => (window.location.hash.startsWith("#/ops") ? "operator" : "customer"));
  const effectiveMode: Mode = isOperator && (mode === "operator" || !tenant.current) ? "operator" : "customer";

  const tried = useRef(false);
  useEffect(() => {
    if (session && !principal && session.devUsers.length && !tried.current) {
      tried.current = true;
      void signInAsDevUser(session.devUsers[0]!.id);
    }
  }, [session, principal, signInAsDevUser]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  const report = useCallback((e: unknown) => setNotice({ tone: "error", text: describe(e) }), []);
  const inform = useCallback((text: string) => setNotice({ tone: "info", text }), []);
  const go = (m: Mode) => {
    setMode(m);
    window.location.hash = m === "operator" ? "#/ops" : "#/billing";
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img className="mark" src="/feltkit-mark.png" width="30" height="30" alt="" />
          <span className="brand-name">SaaS Business Engine</span>
          {session && !session.environment.production && <span className="env">{session.environment.name}</span>}
        </div>
        <div className="topbar-right">
          {principal && isOperator && (
            <div className="segmented" role="group" aria-label="View">
              <button className={effectiveMode === "operator" ? "on" : ""} onClick={() => go("operator")}>Business console</button>
              <button className={effectiveMode === "customer" ? "on" : ""} onClick={() => go("customer")}>Customer portal</button>
            </div>
          )}
          {principal && <TenantSwitcher />}
          <span className={`live ${live ? "on" : ""}`} title={live ? "Live: changes appear immediately" : "Connecting…"}><span className="dot" /> {live ? "Live" : "…"}</span>
          {session && session.devUsers.length > 0 && (
            <label className="identity">
              <span className="sr-only">Signed in as</span>
              <select value={principal?.id ?? ""} onChange={(e) => (e.target.value ? signInAsDevUser(e.target.value).catch(report) : signOut())} aria-label="Signed in as">
                <option value="">Signed out</option>
                {session.devUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
          )}
          {principal && !session?.devUsers.length && <button className="ghost" onClick={() => void signOut().catch(report)}>Sign out</button>}
          <ThemeToggle />
          {session?.dashboard && <a className="dashboard-link" href={session.dashboard} target="_blank" rel="noreferrer">Studio ↗</a>}
        </div>
      </header>
      <AuthNotices />
      {notice && (
        <div className={`notice ${notice.tone}`} role="status">
          {notice.text}
          <button className="ghost" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      <main className="main">
        {!session ? (
          <div className="center muted">Connecting…</div>
        ) : !principal ? (
          <div className="center"><SignIn brand={{ name: "SaaS Business Engine", logo: "/feltkit-mark.png" }} /></div>
        ) : effectiveMode === "operator" ? (
          <OperatorConsole onError={report} inform={inform} />
        ) : !tenant.current ? (
          <div className="center"><CreateTenant title="Create your workspace to start" /></div>
        ) : (
          <CustomerPortal key={tenant.current.id} onError={report} inform={inform} />
        )}
      </main>
      {session && !session.environment.production && (
        <footer className="footer">Development: payments go to a local Stripe-compatible simulator (test mode, no real money). Every decision is recorded in this app's FeltDB instance.</footer>
      )}
    </div>
  );
}
