import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agreements, orgs } from "@/db/schema";
import type { SessionUser } from "@/lib/authz";
import { maySeeAgreements, maySeeOrgMoney, viewTenant } from "@/lib/tenancy";
import { brandForTenant } from "@/lib/brand";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { asStatementRow, invoicesForOrg } from "@/lib/invoiceData";
import { statementFor } from "@/lib/statement";
import { daysLeft, standing, STANDING_LABEL, STANDING_TONE } from "@/lib/agreements";
import { EmptyState, DataTable, Id, PageHead, Panel, Pill } from "@/components/ui";

/**
 * The client's owner: what this service is costing, and whether they are
 * covered.
 *
 * THE DOORS THIS FILE MAY USE. invoicesForOrg(orgId) and nothing that takes a
 * tenant. allInvoices, allQuotes, collectionsBoard, costingBoard and
 * unbilledJobs are the workspace-wide readers - correct on a staff page, and
 * on this one they would be a client reading their operator's whole book.
 * They have the same shape and the same return type as the org-scoped door, so
 * the type system will not stop it; tests/invoiceIsolation greps this file for
 * their names, which is the enforcement.
 *
 * Nothing here shows a cost. A client sees what they were CHARGED - the list
 * value of their own invoices - and never what the work cost to do. That is
 * lib/redact's rule and the reason no card on this page reaches for a part's
 * costCents.
 */
export default async function ClientOwnerView({ user }: { user: SessionUser }) {
  // A client with no organization has no account to show. Not an empty page:
  // there is nothing this route can mean for them.
  if (user.orgId === null) notFound();
  const orgId = user.orgId;
  const today = shopToday();

  const [org, brand, seesMoney, seesPaper] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, orgId)).then((r) => r[0] ?? null),
    // Their provider's name, not the instance operator's - see lib/brand.
    viewTenant(user).then(brandForTenant),
    maySeeOrgMoney(user, orgId),
    maySeeAgreements(user, orgId),
  ]);
  if (!org) notFound();

  /*
   * Money and paper are separate privileges and each band is ABSENT rather
   * than zeroed when its privilege is missing. "You owe $0" and "we are not
   * showing you what you owe" look identical on a card and only one of them
   * is true - the same reasoning lib/financeData gives for the rail.
   */
  const statement = seesMoney
    ? statementFor({
        orgId,
        invoices: (await invoicesForOrg(orgId)).map(asStatementRow),
        today,
      })
    : null;

  const papers = seesPaper
    ? await db.select().from(agreements).where(eq(agreements.orgId, orgId))
        .orderBy(asc(agreements.endsOn), asc(agreements.id))
    : [];
  /*
   * Only paper that still means something. `standing` distinguishes expired
   * from cancelled from draft, and none of those is a contract this lab is
   * currently covered by - showing them here would answer "am I covered" with
   * a row that says no.
   */
  const live = papers
    .map((a) => ({ row: a, state: standing(a, today), left: daysLeft(a.endsOn, today) }))
    .filter((p) => p.state === "active" || p.state === "expiring");

  return (
    <div className="container wide">
      <PageHead
        title="Your account"
        sub={`${org.name} · serviced by ${brand.operatorName}`}
      />

      {statement && (
        <Panel
          title="What you owe"
          hint={statement.oldestDaysLate > 0
            ? `Oldest unpaid invoice is ${statement.oldestDaysLate} days past its terms.`
            : "Nothing is past its terms."}
          actions={<Link className="btn sm" href="/money/invoices">Invoices</Link>}
        >
          <div className="lanes">
            <div className="ledger">
              <div className="mut t-small">Open</div>
              <div className="t-figure">{formatCents(statement.openCents)}</div>
            </div>
            <div className="ledger">
              <div className="mut t-small">Payable now</div>
              <div className="t-figure">{formatCents(statement.payableCents)}</div>
            </div>
            {statement.disputedCents > 0 && (
              <div className="ledger">
                <div className="mut t-small">Under dispute</div>
                <div className="t-figure">{formatCents(statement.disputedCents)}</div>
              </div>
            )}
          </div>
          {org.termsDays > 0 && (
            <div className="mut t-small" style={{ marginTop: 8 }}>
              Your terms are net {org.termsDays}.
              {org.poNumber ? ` Billed against PO ${org.poNumber}.` : ""}
            </div>
          )}
        </Panel>
      )}

      {statement && statement.open.length > 0 && (
        <Panel title="Open invoices" count={statement.open.length}>
          <DataTable
            cols={[
              { key: "number", label: "Invoice", width: "minmax(120px, 1fr)" },
              { key: "standing", label: "Standing", width: "110px" },
              { key: "balance", label: "Balance", width: "110px", align: "right" },
            ]}
            rows={statement.open.map((v) => ({
              key: v.id,
              cells: {
                number: <Id>{v.number}</Id>,
                standing: <Pill tone={v.daysLate > 0 ? "bad" : "info"}>
                  {v.daysLate > 0 ? `${v.daysLate}d late` : "current"}
                </Pill>,
                balance: formatCents(v.balanceCents),
              },
            }))}
          />
        </Panel>
      )}

      {seesPaper && (
        <Panel
          title="Your coverage"
          count={live.length}
          hint="What your contracts cover, and when they need renewing."
          empty="No contract is running."
        >
          {live.length > 0 && (
            <DataTable
              cols={[
                { key: "paper", label: "Contract", width: "minmax(160px, 1.4fr)" },
                { key: "state", label: "State", width: "120px" },
                { key: "ends", label: "Ends", width: "120px", align: "right" },
              ]}
              rows={live.map((p) => ({
                key: p.row.id,
                cells: {
                  paper: <>{p.row.number ? <Id>{p.row.number}</Id> : null} {p.row.title}</>,
                  state: <Pill tone={STANDING_TONE[p.state]}>{STANDING_LABEL[p.state]}</Pill>,
                  ends: p.row.endsOn
                    ? <span className={p.left !== null && p.left <= 90 ? "" : "mut"}>{p.row.endsOn}</span>
                    : <span className="mut">&mdash;</span>,
                },
              }))}
            />
          )}
        </Panel>
      )}

      {!statement && !seesPaper && (
        <EmptyState
          title="Nothing to show here yet"
          body={`Ask ${brand.operatorName} to turn on invoice or contract visibility for your account.`}
        />
      )}

      <Panel title="Your equipment" hint="Every system we service for you, and what is happening to it.">
        <Link className="btn sm" href="/">Your lab</Link>
      </Panel>
    </div>
  );
}
