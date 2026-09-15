import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { booksContext } from "@/lib/financeData";
import { periodEnd, periodStart, periodSpan } from "@/lib/finance";
import {
  ACCOUNT_KEYS, ACCOUNTS, accountName, closedThrough, entries, isAccountKey, isRefType, REF_LABEL, REF_TYPES,
  sumAccount, type LedgerFilter,
} from "@/lib/ledger";
import FinanceShell from "@/components/FinanceShell";
import { ReverseEntryButton } from "@/components/money/LedgerTools";
import { Id, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The journal itself: every posting, in order. The one place a figure is
 * proven. Every money figure on every other room links here with the filter
 * that made it, and the header says what the filtered rows sum to beside the
 * figure that was clicked. Rows are never edited or deleted; the reverse
 * button posts a mirror, and hides when the bank has confirmed the entry.
 */
export default async function LedgerPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const sp = await searchParams;
  const { period, today, mine, rail } = await booksContext(user, sp.period);

  const acct = isAccountKey(sp.acct) ? sp.acct : undefined;
  const type = isRefType(sp.type) ? sp.type : undefined;
  const side = sp.side === "dr" || sp.side === "cr" ? sp.side : undefined;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? sp.from : sp.period ? periodStart(today, period) : undefined;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? sp.to : sp.period ? periodEnd(today, period) : undefined;
  const org = sp.org && /^\d+$/.test(sp.org) ? Number(sp.org) : undefined;
  const q = (sp.q ?? "").trim().slice(0, 80) || undefined;
  const live = sp.live === "1";
  const filter: LedgerFilter = { tenant: mine, account: acct, side, refType: type, refId: sp.id || undefined, refOrgId: org, from, to, q, liveOnly: live };

  const [rows, figSum, orgRows, closed] = await Promise.all([
    entries(filter, 400),
    acct ? sumAccount(acct, { ...filter, side }) : Promise.resolve(null),
    db.select({ id: orgs.id, name: orgs.name }).from(orgs),
    closedThrough(),
  ]);
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  const dr = rows.reduce((n, e) => n + e.lines.reduce((m, l) => m + l.debitCents, 0), 0);
  const cr = rows.reduce((n, e) => n + e.lines.reduce((m, l) => m + l.creditCents, 0), 0);

  const desc: string[] = [];
  if (acct) desc.push(ACCOUNTS[acct].name + (side === "cr" ? " (out)" : side === "dr" ? " (in)" : ""));
  if (type) desc.push(REF_LABEL[type].toLowerCase() + "s");
  if (sp.id) desc.push(`#${sp.id}`);
  if (org !== undefined) desc.push(orgName.get(org) ?? `org ${org}`);
  if (from || to) desc.push(`${from ?? "…"} to ${to ?? "…"}`);
  if (q) desc.push(`"${q}"`);
  if (live) desc.push("live only");

  const docHref = (e: (typeof rows)[number]): string | null => {
    switch (e.refType) {
      case "invoice": return `/money/invoices/${e.refId}`;
      case "po": return `/money/purchasing/${e.refId}`;
      case "report": return `/money/reimbursements/${e.refId}`;
      case "job": return `/work/${e.refId}`;
      default: return null;
    }
  };

  return (
    <FinanceShell
      rail={rail} active="ledger"
      period={period}
      path="/money/ledger"
      title="Ledger"
      sub="Every posting, in order. The one place a figure is proven."
      actions={user.role === "owner" ? <Link className="btn sm" href="/money/reports">Exports</Link> : undefined}
    >
      <div className="panel">
        <div className="ph">
          <form method="get" action="/money/ledger" className="ledger-filters">
            <select name="acct" defaultValue={acct ?? ""} aria-label="Account">
              <option value="">Any account</option>
              {ACCOUNT_KEYS.map((k) => <option key={k} value={k}>{ACCOUNTS[k].name}</option>)}
            </select>
            <select name="type" defaultValue={type ?? ""} aria-label="Document">
              <option value="">Any document</option>
              {REF_TYPES.map((t) => <option key={t} value={t}>{REF_LABEL[t]}</option>)}
            </select>
            <input type="text" name="q" defaultValue={q ?? ""} placeholder="Search memo or number" aria-label="Search" />
            <input type="date" name="from" defaultValue={from ?? ""} aria-label="From" />
            <input type="date" name="to" defaultValue={to ?? ""} aria-label="To" />
            <label className="check"><input type="checkbox" name="live" value="1" defaultChecked={live} /> live only</label>
            {org !== undefined && <input type="hidden" name="org" value={org} />}
            {sp.id && <input type="hidden" name="id" value={sp.id} />}
            <button className="btn sm" type="submit">Filter</button>
            {desc.length > 0 && <span className="chip">{desc.join(" · ")} <Link href="/money/ledger" aria-label="Clear filters">×</Link></span>}
          </form>
          <div className={`balanced${dr === cr ? " ok" : ""}`} title="Every entry is a balanced pair; the filter cannot break that">
            {rows.length} entr{rows.length === 1 ? "y" : "ies"} · debits {formatCents(dr)} = credits {formatCents(cr)} {dr === cr ? "✓" : "✗"}
          </div>
        </div>
        {figSum !== null && acct && (
          <div className="note">
            These rows sum to <b className="money" style={{ color: "var(--ink)" }}>{formatCents(figSum)}</b> on {ACCOUNTS[acct].name}
            {from || to ? ` · ${from && to && from === periodStart(today, period) && to === periodEnd(today, period) ? periodSpan(today, period) : `${from ?? ""} to ${to ?? ""}`}` : ""}
            {" "}- the figure you clicked. Nothing on any screen is stored; this is where it comes from.
          </div>
        )}
        {closed && <div className="note">The books are closed through {closed}. Nothing dated inside that can be posted to; a correction lands today.</div>}
        <div>
          {rows.length === 0 && <div className="empty" style={{ padding: 24, textAlign: "center", color: "var(--mut)" }}>No entries match.</div>}
          {rows.map((e) => {
            const href = docHref(e);
            return (
              <details key={e.id} className={`entry${e.reversedBy ? " reversed" : ""}`}>
                <summary>
                  <span className="t-meta mut">{e.id}</span>
                  <span className="on t-small">{e.postedOn}</span>
                  <span className="memo">
                    {e.memo}
                    <span className="meta">
                      {e.refType ? REF_LABEL[e.refType] : "—"}
                      {e.refOrgId !== null ? ` · ${orgName.get(e.refOrgId) ?? ""}` : ""}
                      {e.reversesId !== null ? ` · reverses #${e.reversesId}` : ""}
                      {e.reversedBy !== null ? ` · reversed by #${e.reversedBy}` : ""}
                      {e.bankTxnId !== null ? " · matched to the bank" : ""}
                    </span>
                  </span>
                  <span className="num money">{formatCents(e.totalCents)}</span>
                  <span className="num money cr-col">{formatCents(e.totalCents)}</span>
                </summary>
                <div className="lines">
                  <div className="postings">
                    {e.lines.map((l) => (
                      <span key={l.id} style={{ display: "contents" }}>
                        <span className={l.debitCents ? "" : "in"}>{accountName(l.account)}</span>
                        <span className="num">{l.debitCents ? formatCents(l.debitCents) : ""}</span>
                        <span className="num cr">{l.creditCents ? formatCents(l.creditCents) : ""}</span>
                      </span>
                    ))}
                  </div>
                  <div className="entry-acts">
                    <span>Rows are never edited or deleted.</span>
                    {href && <Link className="btn sm" href={href}><Id>{e.refType === "invoice" || e.refType === "po" || e.refType === "report" ? `#${e.refId}` : e.refId}</Id></Link>}
                    {e.reversedBy === null && e.reversesId === null && e.refType !== "opening" && e.bankTxnId === null && user.role === "owner" && (
                      <ReverseEntryButton entryId={e.id} />
                    )}
                    {e.bankTxnId !== null && <Pill tone="good">the bank saw it, so it stays</Pill>}
                    <span className="mut">posted by {e.postedBy || "—"}</span>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
        {rows.length === 400 && <div className="note">Showing the newest 400. Narrow the filter to see the rest.</div>}
      </div>
    </FinanceShell>
  );
}
