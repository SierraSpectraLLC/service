import Link from "next/link";
import { myTenantOrgId, type SessionUser } from "@/lib/authz";
import { readTenant } from "@/lib/tenancy";
import { brandForTenant } from "@/lib/brand";
import { formatCents } from "@/lib/money";
import { periodSpan } from "@/lib/finance";
import { booksContext } from "@/lib/financeData";
import { allInvoices } from "@/lib/invoiceData";
import { asStatementRow } from "@/lib/invoiceData";
import { aging, invoiceView } from "@/lib/statement";
import PositionLine from "@/components/PositionLine";
import { DataTable, Id, PageHead, Panel, Pill } from "@/components/ui";

/**
 * The operator's owner: the business, on one page.
 *
 * Deliberately a summary. Every number here is one lib/financeData already
 * computes for /money, read through the same booksContext so the two pages
 * cannot disagree, and every one of them links to the room that owns it. The
 * failure this avoids is a second set of totals - two pages answering "what
 * are we owed" with different numbers because one of them grew its own query.
 */
export default async function OperatorOwnerView({ user, periodParam }: {
  user: SessionUser;
  periodParam?: string;
}) {
  // The window, the permission and every figure, asked the one way. This
  // redirects a staff member who may not read the books, which is the same
  // thing /money does to them.
  const { period, today, figures: fig } = await booksContext(user, periodParam);
  const tenant = readTenant(user);
  const [brand, invoices] = await Promise.all([
    brandForTenant(myTenantOrgId(user)),
    // Already cache()d and already fetched by financeFigures on this render,
    // so this is the same rows, not a second read.
    allInvoices(tenant),
  ]);

  const { moneyIn: mIn, moneyOut: mOut } = fig;
  const owed = mIn.currentCents + mIn.pastDueCents;
  const owes = mOut.purchasingCents + mOut.reimbursementsCents;

  /*
   * How late the late money is. aging() buckets by daysLate and bucketOf
   * returns `current` for anything not yet past its terms, so d30 + d60 + d90
   * is pastDueCents by construction - this split cannot disagree with the
   * figure above it.
   */
  const buckets = aging(invoices.map((f) => invoiceView(asStatementRow(f), today))).buckets;
  const late: [string, number][] = [
    ["1-30 days", buckets.d30], ["31-60", buckets.d60], ["60+", buckets.d90],
  ];

  return (
    <div className="container wide">
      <PageHead
        title="Owner view"
        sub={`${brand.operatorName} · what is owed, what is owed out, and what needs you · ${periodSpan(today, period)}`}
        /* The way back. These two pages are one person's two questions - what
           is the shop doing today, and how is the business doing - so each
           carries the door to the other and neither needs a nav word. */
        actions={<Link className="btn sm" href="/">Switch to dashboard</Link>}
      />

      <PositionLine
        owedCents={owed} owesCents={owes}
        pastDueCents={mIn.pastDueCents} pastDueCount={mIn.pastDueCount}
        period={period}
      />

      {mIn.pastDueCents > 0 && (
        <Panel
          title="How late"
          hint="Past-due money by age. The same figure as the line above, split by how long it has been waiting."
          actions={<Link className="btn sm" href="/money/collections">Collections</Link>}
        >
          <div className="lanes">
            {late.map(([label, cents]) => (
              <div key={label} className="ledger">
                <div className="mut t-small">{label}</div>
                <div className="t-figure">{formatCents(cents)}</div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel
        title="Needs a decision"
        count={fig.decisions.length}
        hint="Gathered from every ledger. Each one is somebody waiting on you."
        empty="Nothing is waiting on a decision."
        actions={<Link className="btn sm" href="/money">Financial</Link>}
      >
        {fig.decisions.length > 0 && (
          <DataTable
            cols={[
              { key: "what", label: "What", width: "minmax(240px, 2fr)" },
              { key: "detail", label: "Detail", width: "minmax(160px, 1.4fr)", hideMobile: true },
            ]}
            rows={fig.decisions.map((d) => ({
              key: d.key,
              href: d.href,
              cells: {
                what: <><Pill tone={d.tone}>{d.tone === "bad" ? "now" : "soon"}</Pill> <span>{d.title}</span></>,
                detail: <span className="mut">{d.detail}</span>,
              },
            }))}
          />
        )}
      </Panel>

      <Panel
        title="Not yet invoiced"
        count={mIn.unbilledJobs}
        hint={`${formatCents(mIn.unbilledCents)} of closed work nobody has billed.`}
        empty="Every closed job has been invoiced."
        actions={<Link className="btn sm" href="/money/invoices">Invoices</Link>}
      >
        {fig.unbilled.length > 0 && (
          <DataTable
            cols={[
              { key: "job", label: "Job", width: "minmax(160px, 1.4fr)" },
              { key: "client", label: "Client", width: "minmax(120px, 1fr)", hideMobile: true },
              { key: "value", label: "Value", width: "110px", align: "right" },
            ]}
            rows={fig.unbilled.map((j) => ({
              key: j.woId,
              href: `/work/${j.woId}`,
              cells: {
                job: <Id>{j.number}</Id>,
                client: <span className="mut">{j.orgName}</span>,
                value: formatCents(j.valueCents),
              },
            }))}
          />
        )}
      </Panel>

      {/* The work half is not reproduced here. /work is where a job is
          cleared and it is not gated on the books, so an owner following
          this lands where their dispatchers already are. */}
      <Panel
        title="The floor"
        hint="Work, stages and turnaround live where the people doing them work."
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link className="btn sm" href="/work">Jobs</Link>
          <Link className="btn sm" href="/">The board</Link>
          <Link className="btn sm" href="/metrics">Metrics</Link>
          <Link className="btn sm" href="/money/contracts">Contracts</Link>
        </div>
      </Panel>
    </div>
  );
}
