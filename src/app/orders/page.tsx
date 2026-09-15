import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agreements, orgs, quoteLines as quoteLinesTable, quotes as quotesTable, shareLinks } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { maySeeOrgMoney } from "@/lib/tenancy";
import { isStaffRole } from "@/lib/tenants";
import { descriptionLines } from "@/lib/billing";
import { formatCents } from "@/lib/money";
import { shopMonthDay, shopToday } from "@/lib/shopday";
import { asStatementRow, invoicesForOrg } from "@/lib/invoiceData";
import { invoiceView, statementFor } from "@/lib/statement";
import { drawdown, standing as agreementStanding, type Allowance } from "@/lib/agreements";
import { usageFor } from "@/lib/agreementUsage";
import { quoteStanding } from "@/lib/quotes";
import {
  facetMatches, invoiceOrderStatus, quoteOrderStatus, type OrderFacet, type OrderStatus,
} from "@/lib/clientOrders";
import { FacetStrip, Id, PageHead, Pill, Toolbar } from "@/components/ui";

export const dynamic = "force-dynamic";

type Row = {
  key: string; href: string; number: string; when: string; what: string; sub: string;
  status: OrderStatus; totalCents: number; token: string;
  action: "" | "pay" | "approve"; at: number;
};

/**
 * Everything parts, for the client: their orders, the quotes waiting on them,
 * and the invoices those became. The rows ARE the billing rails' rows - this
 * page only reads them in order language, and anything with the orange edge
 * is waiting on you, the same rule as the rest of the portal.
 */
export default async function OrdersPage({ searchParams }: {
  searchParams: Promise<{ f?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (isStaffRole(user.role) && user.orgId === null) redirect("/money");
  if (user.orgId === null) redirect("/");
  const [org] = await db.select().from(orgs).where(eq(orgs.id, user.orgId));
  if (!org || org.kind !== "client") redirect("/");
  /* What their organization has been quoted and billed is their organization's
     money, not everybody's who can sign in to it. See maySeeOrgMoney. */
  if (!(await maySeeOrgMoney(user, org.id))) redirect("/");
  const { f = "" } = await searchParams;
  const facet: OrderFacet = ["needsyou", "settled", "all"].includes(f) ? (f as OrderFacet) : "open";

  const today = shopToday();
  const [full, myQuotes, papers] = await Promise.all([
    invoicesForOrg(org.id),
    db.select().from(quotesTable).where(eq(quotesTable.orgId, org.id)).orderBy(desc(quotesTable.id)),
    db.select().from(agreements).where(eq(agreements.orgId, org.id)),
  ]);
  const [invLinks, qLinks, qLines] = await Promise.all([
    full.length
      ? db.select({ invoiceId: shareLinks.invoiceId, token: shareLinks.token }).from(shareLinks)
          .where(and(inArray(shareLinks.invoiceId, full.map((x) => x.row.id)), isNull(shareLinks.revokedAt)))
      : [],
    myQuotes.length
      ? db.select({ quoteId: shareLinks.quoteId, token: shareLinks.token }).from(shareLinks)
          .where(and(inArray(shareLinks.quoteId, myQuotes.map((q) => q.id)), isNull(shareLinks.revokedAt)))
      : [],
    myQuotes.length
      ? db.select().from(quoteLinesTable).where(inArray(quoteLinesTable.quoteId, myQuotes.map((q) => q.id)))
      : [],
  ]);

  // The statement: what is open, what is payable now, how late the oldest is.
  // Same arithmetic as the shop's Receivables room, so both sides of the
  // table read one figure.
  const statement = statementFor({ orgId: org.id, invoices: full.map(asStatementRow), today });

  /* What is left on the agreement, for the contracts WE hold that are live.
     Usage is a query per agreement; a failed read is reported as "could not
     read" rather than folded into a zero, because "0 of 8 visits used" is
     good news wrongly on the one card that has to be trusted about money. */
  const live = papers.filter((a) => a.providerOrgId === null && a.kind === "contract")
    .map((a) => ({ a, state: agreementStanding(a, today) }))
    .filter((p) => p.state === "active" || p.state === "expiring");
  const allowances = await Promise.all(live.map(async ({ a }) => {
    try {
      const used = await usageFor(a, org.id);
      return { a, left: drawdown(a, used), failed: false };
    } catch {
      return { a, left: null, failed: true };
    }
  }));
  const allowanceLine = (label: string, x: Allowance, fmt: (n: number) => string) => {
    if (!x.tracked) return null;
    if (x.unlimited) return `${label}: unlimited (${fmt(x.used)} so far)`;
    return `${label}: ${fmt(Math.max(0, x.remaining))} of ${fmt(x.included)} left${x.over ? ` - over by ${fmt(-x.remaining)}` : ""}`;
  };

  const summarize = (names: string[]) => {
    // The charge, not its detail. A line item can run to several lines - the
    // system, then the modules it covers - and a one-row summary that ran them
    // together would read as one very long sentence in a table cell.
    const heads = names.map((n) => descriptionLines(n).head);
    const shown = heads.filter(Boolean).slice(0, 2).join(" · ");
    return heads.length > 2 ? `${shown} +${heads.length - 2}` : shown || "Order";
  };

  const rows: Row[] = [
    ...full.map((x): Row => {
      const v = invoiceView(asStatementRow(x), today);
      const status = invoiceOrderStatus(x.row, v);
      return {
        key: `i${x.row.id}`, href: `/orders/i/${x.row.id}`,
        number: x.row.number, when: shopMonthDay(x.row.createdAt),
        what: summarize(x.lines.map((l) => l.description)),
        sub: x.row.dueOn && v.balanceCents > 0 ? `due ${x.row.dueOn}` : "",
        status, totalCents: v.linesCents + v.feesCents,
        token: invLinks.find((l) => l.invoiceId === x.row.id)?.token ?? "",
        action: status.needsYou ? "pay" : "", at: x.row.createdAt.getTime(),
      };
    }),
    ...myQuotes.map((q): Row => {
      const s = quoteStanding(q, today);
      const status = quoteOrderStatus(q, s);
      const mine = qLines.filter((l) => l.quoteId === q.id);
      return {
        key: `q${q.id}`, href: `/orders/q/${q.id}`,
        number: q.number, when: shopMonthDay(q.createdAt),
        what: summarize(mine.map((l) => l.description)),
        sub: s === "awaiting" && q.expiresOn ? `good to ${q.expiresOn}` : "",
        status,
        totalCents: mine.filter((l) => !l.covered)
          .reduce((n, l) => n + Math.round((l.qty / 1000) * l.unitCents), 0),
        token: qLinks.find((l) => l.quoteId === q.id)?.token ?? "",
        action: status.needsYou ? "approve" : "", at: q.createdAt.getTime(),
      };
    }),
  ].sort((a, b) => Number(b.status.needsYou) - Number(a.status.needsYou) || b.at - a.at);

  const shown = rows.filter((r) => facetMatches(facet, r.status));
  const count = (k: OrderFacet) => rows.filter((r) => facetMatches(k, r.status)).length;
  const href = (k: OrderFacet) => (k === "open" ? "/orders" : `/orders?f=${k}`);

  return (
    <div className="container wide">
      <PageHead
        title="Orders"
        sub="Everything parts - orders, quotes waiting on you, and their invoices."
        actions={<Link href="/store" className="btn sm primary" style={{ textDecoration: "none" }}>Order parts</Link>}
      />
      <Toolbar
        facets={
          <FacetStrip facets={([
            ["open", "Open"], ["needsyou", "Needs you"], ["settled", "Settled"], ["all", "All"],
          ] as [OrderFacet, string][]).map(([k, label]) => ({
            key: k, label, count: count(k) || undefined, on: facet === k, href: href(k),
          }))} />
        }
      />

      {(statement.open.length > 0 || allowances.length > 0) && (
        <div className="two">
          <div className="panel">
            <div className="ph"><h2>Your statement</h2><span className="t-meta mut">
              {statement.oldestDaysLate > 0 ? `oldest unpaid invoice is ${statement.oldestDaysLate} days past its terms` : "nothing is past its terms"}
            </span></div>
            <div className="pb">
              <div className="lanes">
                <div className="ledger"><div className="mut t-small">Open</div><div className="t-figure">{formatCents(statement.openCents)}</div></div>
                <div className="ledger"><div className="mut t-small">Payable now</div><div className="t-figure">{formatCents(statement.payableCents)}</div></div>
                {statement.disputedCents > 0 && (
                  <div className="ledger"><div className="mut t-small">Under question</div><div className="t-figure">{formatCents(statement.disputedCents)}</div></div>
                )}
              </div>
              <div className="mut t-small" style={{ marginTop: 8 }}>
                {statement.open.length} open invoice{statement.open.length === 1 ? "" : "s"}.
                {org.termsDays > 0 ? ` Your terms are net ${org.termsDays}.` : ""}
                {" "}Pay each from its row below; a question about a line goes on the order itself.
              </div>
            </div>
          </div>
          {allowances.length > 0 && (
            <div className="panel">
              <div className="ph"><h2>Left on your agreement</h2><span className="t-meta mut">what the contract still covers</span></div>
              <div className="pb">
                {allowances.map(({ a, left, failed }) => (
                  <div key={a.id} style={{ paddingBlock: 4 }}>
                    <div className="t-body" style={{ fontWeight: 600 }}>{a.title || a.number || "Service agreement"}{a.endsOn ? <span className="mut t-meta"> · through {a.endsOn}</span> : null}</div>
                    {failed || !left ? (
                      <div className="mut t-small">Usage could not be read just now.</div>
                    ) : (
                      [
                        allowanceLine("Visits", left.visits, (n) => String(n)),
                        allowanceLine("Parts", left.parts, formatCents),
                        allowanceLine("Labor", left.labor, (n) => `${Math.round(n / 60)} h`),
                      ].filter(Boolean).map((line) => <div key={line} className="t-small">{line}</div>)
                    )}
                    {!failed && left && !left.visits.tracked && !left.parts.tracked && !left.labor.tracked && (
                      <div className="mut t-small">No counted allowances on this agreement.</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {shown.map((r, n) => (
          <div key={r.key} style={{
            display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "12px 14px",
            borderTop: n === 0 ? "none" : "1px solid var(--line)",
            borderLeft: r.status.needsYou ? "3px solid var(--coral)" : "3px solid transparent",
          }}>
            <Link href={r.href} style={{ textDecoration: "none", color: "inherit", flex: "0 0 110px" }}>
              <Id>{r.number}</Id>
              <div className="mut t-meta">{r.when}</div>
            </Link>
            <Link href={r.href} style={{ textDecoration: "none", color: "inherit", flex: "1 1 200px", minWidth: 160 }}>
              <div className="t-body" style={{ fontWeight: 600 }}>{r.what}</div>
              {r.sub && <div className="mut t-meta">{r.sub}</div>}
            </Link>
            <Pill tone={r.status.tone}>{r.status.label}</Pill>
            {/* A fully covered quote totals zero, and a blank money cell on a
                money page reads as a bug rather than as good news. */}
            <b className="mono t-body" style={{ width: 90, textAlign: "right" }}>
              {r.totalCents > 0
                ? formatCents(r.totalCents)
                : <span className="t-small" style={{ color: "var(--t-good-fg)" }}>covered</span>}
            </b>
            <span style={{ width: 150, textAlign: "right" }}>
              {r.action === "approve" ? (
                /* Answered on the order's own page, in session. This used to
                   link out to the PUBLIC share page even for somebody already
                   signed in - and only when an un-revoked share link happened
                   to exist. */
                <Link className="btn sm primary plain" href={r.href}>Review &amp; approve</Link>
              ) : r.action === "pay" && r.token ? (
                /* Payment still goes through the hosted page: taking a card is
                   the payment processor's job and the token is what it is
                   handed. Approval is ours, and did not need to leave. */
                <Link className="btn sm primary plain" href={`/share/${r.token}`}>
                  Pay {formatCents(r.totalCents)}
                </Link>
              ) : (
                <Link className="btn sm plain" href={r.href}>Details</Link>
              )}
            </span>
          </div>
        ))}
        {shown.length === 0 && <div className="empty" style={{ border: 0 }}><b>Nothing here.</b></div>}
      </div>
      <div className="mut t-meta">Anything with an orange edge is waiting on you - same rule as the rest of the portal.</div>
    </div>
  );
}
