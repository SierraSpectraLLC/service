import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { collectionsBoard } from "@/lib/invoiceData";
import { brokenPromiseLine, CHANNEL_LABEL, ladderFor } from "@/lib/dunning";
import { feeClause } from "@/lib/billingPolicy";
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
        sub=""
      />
      <MoneyTabs active="collections" counts={{ collections: late.length }} />

      {late.length === 0
        ? <EmptyState title="Nothing in collections." />
        : (
          <>
            <div className="mut t-body" style={{ margin: "10px 0" }}>
              {formatCents(owed)} across {late.length} invoice{late.length === 1 ? "" : "s"}.
            </div>
            {late.map(({ invoice: f, view, step, policy, brokenPromise }) => {
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
                      {broken}
                    </div>
                  )}
                  {openDisputes.map((d) => (
                    <div key={d.id} className="t-body" style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                      <span className="pill warn">Disputed</span>{" "}
                      {d.reason}
                    </div>
                  ))}

                  {/* The whole ladder, not only the rung that is due. What has
                      been sent, what is owed now, and who each remaining one
                      goes to - because the answer to "why is this still open"
                      is usually three rungs back. */}
                  <div style={{ marginTop: 8 }}>
                    {ladderFor({
                      dueOn: f.row.dueOn, today, policy,
                      log: f.dunning.map((d) => ({ rung: d.rung, sentOn: d.sentOn })),
                      promiseBroken: brokenPromise,
                    }).map((s) => {
                      const sent = f.dunning.find((d) => d.rung === s.rung.key);
                      return (
                        <div key={s.rung.key} className="row-2"
                          style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                          <span style={{ width: 66, flexShrink: 0 }}>
                            {s.state === "done"
                              ? <Pill tone="good">done</Pill>
                              : s.state === "now"
                                ? <Pill tone="bad">now</Pill>
                                : <span className="mut t-meta">{s.dueOn || "-"}</span>}
                          </span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span className="t-body" style={{ fontWeight: s.state === "now" ? 700 : 400 }}>
                              {s.rung.action}
                            </span>
                            <span className="mut t-meta" style={{ display: "block" }}>
                              {s.contact
                                ? `to ${s.contact.name}, ${s.contact.role.toLowerCase()}`
                                : "to the billing contact"}
                              {sent ? ` · sent ${sent.sentOn}` : ""}
                            </span>
                          </span>
                          <span className="mut t-meta" style={{ width: 74, flexShrink: 0 }}>
                            {CHANNEL_LABEL[s.rung.channel]}
                          </span>
                          {s.state === "now" && (
                            <DunningRungButton
                              invoiceId={f.row.id} number={f.row.number} action={s.rung.action}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {!step && (
                    <div className="mut t-small" style={{ marginTop: 6 }}>Nothing due today.</div>
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
