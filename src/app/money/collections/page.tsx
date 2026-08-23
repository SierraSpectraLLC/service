import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { collectionsBoard } from "@/lib/invoiceData";
import { brokenPromiseLine, CHANNEL_LABEL, CHANNEL_TONE } from "@/lib/dunning";
import { STANDING_LABEL, STANDING_TONE } from "@/lib/statement";
import MoneyTabs from "@/components/MoneyTabs";
import DunningRungButton from "@/components/DunningRungButton";
import { EmptyState, Id, PageHead, Panel, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Whose move it is on every invoice that is still out - and on the ones that
 * are late, which rung of the ladder is owed and who it is addressed to.
 *
 * Rung two and up name a NEW person on purpose. Sending the fourth reminder to
 * the contact who has ignored the first three is how an invoice ages out; the
 * ladder in lib/dunning encodes that, and this page is where it is read.
 */
export default async function CollectionsPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");

  const today = shopToday();
  const [board, orgRows] = await Promise.all([
    collectionsBoard(today),
    db.select({ id: orgs.id, name: orgs.name }).from(orgs),
  ]);
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));

  const late = board
    .filter((b) => b.view.daysLate > 0 || b.step !== null)
    .sort((a, b) => b.view.daysLate - a.view.daysLate);
  const owed = late.reduce((n, b) => n + b.view.balanceCents, 0);

  return (
    <div className="container wide">
      <PageHead
        crumb={<><Link href="/money">Billing</Link> › <b>Collections</b></>}
        title="Collections"
        sub="Every invoice with a rung due, and who that rung is addressed to. Nothing here is sent by opening the page."
      />
      <MoneyTabs active="collections" counts={{ collections: late.length }} />

      {late.length === 0
        ? <EmptyState title="Nothing is in collections." body="Every open invoice is inside its terms." />
        : (
          <>
            <div className="mut t-body" style={{ margin: "10px 0" }}>
              {formatCents(owed)} across {late.length} invoice{late.length === 1 ? "" : "s"}.
            </div>
            {late.map(({ invoice: f, view, step, brokenPromise }) => {
              const broken = brokenPromiseLine(
                f.promises.map((p) => ({ promisedOn: p.promisedOn, byName: p.byName, keptOn: p.keptOn })),
                today, f.row.number,
              );
              const openDisputes = f.disputes.filter((d) => d.resolvedOn === null);
              const liveFeeCents = f.fees.filter((x) => !x.waived).reduce((n, x) => n + x.amountCents, 0);
              return (
                <Panel
                  key={f.row.id}
                  title={
                    <Link href={`/money/invoices/${f.row.id}`} style={{ textDecoration: "none" }}>
                      <Id>{f.row.number}</Id> {orgName.get(f.row.orgId) ?? ""}
                    </Link>
                  }
                  actions={<Pill tone={STANDING_TONE[view.standing]}>{STANDING_LABEL[view.standing]}</Pill>}
                  hint={
                    <>
                      {formatCents(view.payableCents)} being asked for
                      {view.daysLate > 0 ? ` · ${view.daysLate} days past due` : ""}
                      {liveFeeCents > 0 ? ` · ${formatCents(liveFeeCents)} in fees` : ""}
                      {view.disputedCents > 0 ? ` · ${formatCents(view.disputedCents)} paused by a dispute` : ""}
                    </>
                  }
                >
                  {broken && (
                    <div className="t-body" style={{ padding: "6px 0", color: "var(--t-bad-fg)" }}>
                      {broken} The ladder skips a rung.
                    </div>
                  )}
                  {openDisputes.map((d) => (
                    <div key={d.id} className="t-body" style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                      <span className="pill warn">Disputed</span>{" "}
                      {d.reason}
                      <span className="mut t-meta" style={{ display: "block" }}>
                        Reminders quote only the undisputed remainder until it is resolved.
                      </span>
                    </div>
                  ))}

                  {step ? (
                    <div className="row-2" style={{ alignItems: "baseline", padding: "8px 0", borderTop: "1px solid var(--line)" }}>
                      <Pill tone={CHANNEL_TONE[step.rung.channel]}>{CHANNEL_LABEL[step.rung.channel]}</Pill>
                      <span className="t-body" style={{ flex: 1, minWidth: 0 }}>
                        <b>{step.rung.action}</b>
                        <span className="mut t-meta" style={{ display: "block" }}>
                          {step.contact
                            ? `to ${step.contact.name}, ${step.contact.role.toLowerCase()}`
                            : "to the billing contact"}
                          {" · "}{step.rung.why}
                          {brokenPromise ? " · escalated, a promise was broken" : ""}
                        </span>
                      </span>
                      <DunningRungButton
                        invoiceId={f.row.id} number={f.row.number} action={step.rung.action}
                      />
                    </div>
                  ) : (
                    <div className="mut t-body" style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
                      Nothing is due on the ladder today.
                    </div>
                  )}

                  {f.dunning.length > 0 && (
                    <div className="mut t-meta" style={{ marginTop: 6 }}>
                      Sent so far: {f.dunning.map((d) => `${d.rung} ${d.sentOn}`).join(" · ")}
                    </div>
                  )}
                  <div className="row-2" style={{ marginTop: 8 }}>
                    <Link href={`/money/invoices/${f.row.id}`} className="btn sm" style={{ textDecoration: "none" }}>
                      Open the invoice
                    </Link>
                    {view.daysLate > 30 && (
                      <Link href={`/money/invoices/${f.row.id}/letter`} className="btn sm" style={{ textDecoration: "none" }}>
                        Demand letter
                      </Link>
                    )}
                  </div>
                </Panel>
              );
            })}
          </>
        )}
    </div>
  );
}
