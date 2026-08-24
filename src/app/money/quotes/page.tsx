import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { allQuotes, quoteTotal } from "@/lib/invoiceData";
import { daysToExpiry, quoteStanding, STANDING_LABEL, STANDING_TONE } from "@/lib/quotes";
import MoneyTabs from "@/components/MoneyTabs";
import { NewQuoteButton } from "@/components/NewMoneyButtons";
import { DataTable, Dot, FacetStrip, Id, PageHead, Pill, Toolbar } from "@/components/ui";
import type { DataRow } from "@/components/ui/DataTable";

export const dynamic = "force-dynamic";

/** Priced work waiting on a client's yes, and what it is worth. */
export default async function QuotesPage({ searchParams }: {
  searchParams: Promise<{ q?: string; standing?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const { q = "", standing = "" } = await searchParams;

  const today = shopToday();
  const [full, orgRows] = await Promise.all([
    allQuotes(),
    db.select({ id: orgs.id, name: orgs.name, kind: orgs.kind }).from(orgs),
  ]);
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));

  const rows = full.map((f) => ({ f, s: quoteStanding(f.row, today), total: quoteTotal(f) }));
  const needle = q.trim().toLowerCase();
  const hit = ({ f }: typeof rows[number]) =>
    !needle
    || f.row.number.toLowerCase().includes(needle)
    || f.row.title.toLowerCase().includes(needle)
    || (orgName.get(f.row.orgId) ?? "").toLowerCase().includes(needle);
  const shown = rows.filter((r) => (!standing || r.s === standing) && hit(r));
  const awaiting = rows.filter((r) => r.s === "awaiting");

  const href = (s: string) => {
    const p = new URLSearchParams();
    if (needle) p.set("q", needle);
    if (s && s !== standing) p.set("standing", s);
    return `/money/quotes${p.size ? `?${p}` : ""}`;
  };

  const toRow = ({ f, s, total }: typeof rows[number]): DataRow => {
    const left = daysToExpiry(f.row.expiresOn, today);
    return {
      key: f.row.id,
      href: `/money/quotes/${f.row.id}`,
      group: s === "awaiting" ? "Open" : "Answered",
      cells: {
        dot: <Dot tone={STANDING_TONE[s]} />,
        number: <Id>{f.row.number}</Id>,
        what: (
          <span style={{ minWidth: 0, display: "block" }}>
            <span style={{ fontWeight: 600 }}>{f.row.title || "Quote"}</span>
            <span className="mut t-meta" style={{ display: "block" }}>{orgName.get(f.row.orgId) ?? ""}</span>
          </span>
        ),
        state: <Pill tone={STANDING_TONE[s]}>{STANDING_LABEL[s]}</Pill>,
        expiry: (
          <span className="mut">
            {s === "awaiting" && left !== null
              ? (left <= 7 ? `${left}d left` : `to ${f.row.expiresOn}`)
              : f.row.answeredOn || f.row.expiresOn || "-"}
          </span>
        ),
        deposit: f.row.depositPct > 0 ? <span className="mut">{f.row.depositPct}%</span> : null,
        total: <b className="t-body">{formatCents(total)}</b>,
      },
    };
  };

  return (
    <div className="container wide">
      <PageHead
        crumb={<><Link href="/money">Billing</Link> › <b>Quotes</b></>}
        title="Quotes"
        sub=""
        actions={<NewQuoteButton today={today} clients={orgRows.filter((o) => o.kind === "client").map((o) => ({ id: o.id, name: o.name }))} />}
      />
      <MoneyTabs active="quotes" counts={{ quotes: awaiting.length }} />
      <Toolbar
        search={
          <form action="/money/quotes">
            {standing && <input type="hidden" name="standing" value={standing} />}
            <input name="q" defaultValue={q} placeholder="Quote number, job or client" aria-label="Search quotes" />
          </form>
        }
        facets={
          <FacetStrip facets={(Object.keys(STANDING_LABEL) as (keyof typeof STANDING_LABEL)[]).map((s) => ({
            key: s, label: STANDING_LABEL[s],
            count: rows.filter((r) => r.s === s && hit(r)).length || undefined,
            on: standing === s, href: href(s),
          }))} />
        }
      />
      <DataTable
        cols={[
          { key: "dot", label: "", width: "12px" },
          { key: "number", label: "Quote", width: "92px" },
          { key: "what", label: "Job", width: "minmax(180px, 1.8fr)" },
          { key: "state", label: "Standing", width: "130px" },
          { key: "expiry", label: "Good to", width: "minmax(100px, 1fr)", hideMobile: true },
          { key: "deposit", label: "Deposit", width: "80px", hideMobile: true },
          { key: "total", label: "Total", width: "110px" },
        ]}
        rows={shown.map(toRow)}
        empty="No quotes."
      />
    </div>
  );
}
