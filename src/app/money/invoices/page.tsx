import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { allInvoices, asStatementRow } from "@/lib/invoiceData";
import { invoiceView, STANDING_LABEL, STANDING_TONE } from "@/lib/statement";
import FinanceShell from "@/components/FinanceShell";
import { financeContext } from "@/lib/financeData";
import { NewInvoiceButton } from "@/components/NewMoneyButtons";
import BackfillButton from "@/components/BackfillButton";
import { DataTable, Dot, FacetStrip, Id, PageHead, Pill, Toolbar } from "@/components/ui";
import type { DataRow } from "@/components/ui/DataTable";
import DeleteRowAction from "@/components/DeleteRowAction";

export const dynamic = "force-dynamic";

/** Every bill in the workspace, and what each one is actually standing at. */
export default async function InvoicesPage({ searchParams }: {
  searchParams: Promise<{ q?: string; standing?: string; period?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const { q = "", standing = "", period: periodParam } = await searchParams;
  const { period, seesPayroll, figures: fig } = await financeContext(user, periodParam);

  const today = shopToday();
  const [full, orgRows] = await Promise.all([
    allInvoices(),
    db.select({ id: orgs.id, name: orgs.name, kind: orgs.kind }).from(orgs),
  ]);
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));

  const rows = full.map((f) => ({ f, v: invoiceView(asStatementRow(f), today) }));
  const needle = q.trim().toLowerCase();
  const hit = ({ f }: typeof rows[number]) =>
    !needle
    || f.row.number.toLowerCase().includes(needle)
    || (orgName.get(f.row.orgId) ?? "").toLowerCase().includes(needle)
    || f.row.poNumber.toLowerCase().includes(needle);
  const shown = rows.filter((r) => (!standing || r.v.standing === standing) && hit(r));

  const href = (s: string) => {
    const p = new URLSearchParams();
    if (needle) p.set("q", needle);
    if (s && s !== standing) p.set("standing", s);
    return `/money/invoices${p.size ? `?${p}` : ""}`;
  };

  const isOwner = user.role === "owner";
  const toRow = ({ f, v }: typeof rows[number]): DataRow => ({
    key: f.row.id,
    href: `/money/invoices/${f.row.id}`,
    group: v.standing === "paid" || v.standing === "void" ? "Settled" : "Open",
    cells: {
      dot: <Dot tone={STANDING_TONE[v.standing]} />,
      number: <Id>{f.row.number}</Id>,
      client: (
        <span style={{ minWidth: 0, display: "block" }}>
          <span style={{ fontWeight: 600 }}>{orgName.get(f.row.orgId) ?? "(client gone)"}</span>
          <span className="mut t-meta" style={{ display: "block" }}>
            {f.row.poNumber ? `PO ${f.row.poNumber}` : "no PO on file"}
          </span>
        </span>
      ),
      state: <Pill tone={STANDING_TONE[v.standing]}>{STANDING_LABEL[v.standing]}</Pill>,
      due: (
        <span className="mut">
          {f.row.dueOn ? (v.daysLate > 0 ? `${v.daysLate}d overdue` : `due ${f.row.dueOn}`) : "not sent"}
        </span>
      ),
      total: <b className="t-body">{formatCents(v.linesCents + v.feesCents)}</b>,
      balance: v.balanceCents > 0 ? <b className="t-body">{formatCents(v.balanceCents)}</b> : <span className="mut">-</span>,
      // The store puts a client's parts order here as a draft invoice, which
      // is what makes a delete on the LIST worth having: the four test orders
      // somebody wants gone are four rows, not four pages to open.
      act: isOwner ? (
        <DeleteRowAction kind="invoice" id={f.row.id} number={f.row.number} what="the invoice"
          note={v.paidCents > 0
            ? `${formatCents(v.paidCents)} has been paid against this invoice. Deleting it destroys that record too.`
            : "Its lines, fees and payments go with it. The work order it came from is untouched."} />
      ) : null,
    },
  });

  return (
    <FinanceShell
      rail={{ active: "invoices", amounts: fig.amounts, seesPayroll }}
      period={period}
      path="/money/invoices"
      title="Invoices"
      sub="What has been billed, and what has come back."
      actions={<>
        <BackfillButton kind="invoice" today={today}
          clients={orgRows.filter((o) => o.kind === "client").map((o) => ({ id: o.id, name: o.name }))} />
        <NewInvoiceButton clients={orgRows.filter((o) => o.kind === "client").map((o) => ({ id: o.id, name: o.name }))} />
      </>}
    >
      <Toolbar
        search={
          <form action="/money/invoices">
            {standing && <input type="hidden" name="standing" value={standing} />}
            <input name="q" defaultValue={q} placeholder="Invoice number, client or PO" aria-label="Search invoices" />
          </form>
        }
        facets={
          <FacetStrip facets={(Object.keys(STANDING_LABEL) as (keyof typeof STANDING_LABEL)[]).map((s) => ({
            key: s, label: STANDING_LABEL[s],
            count: rows.filter((r) => r.v.standing === s && hit(r)).length || undefined,
            on: standing === s, href: href(s),
          }))} />
        }
      />
      <DataTable
        cols={[
          { key: "dot", label: "", width: "12px" },
          { key: "number", label: "Invoice", width: "100px" },
          { key: "client", label: "Client", width: "minmax(160px, 1.6fr)" },
          { key: "state", label: "Standing", width: "120px" },
          { key: "due", label: "Due", width: "minmax(110px, 1fr)", hideMobile: true },
          { key: "total", label: "Total", width: "110px" },
          { key: "balance", label: "Open", width: "110px" },
          ...(isOwner ? [{ key: "act", label: "", width: "64px" }] : []),
        ]}
        rows={shown.map(toRow)}
        empty="No invoices."
      />
    </FinanceShell>
  );
}
