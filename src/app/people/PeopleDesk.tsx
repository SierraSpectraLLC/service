"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setHouseHr } from "@/app/actions";
import { formatCents } from "@/lib/money";
import { DataTable, Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

export type RosterRow = {
  email: string;
  name: string;
  /** owner | staff, as house_members holds it. */
  role: string;
  isHr: boolean;
  /** Whether they have a name at all - see the page, and the note on the row. */
  nameable: boolean;
  unclaimedCents: number;
  unclaimedCount: number;
  draftCount: number;
  submittedCount: number;
};

/**
 * The roster, as the thing HR actually does something with.
 *
 * One row per person and one question per column: what are they out of pocket
 * for, is a claim of theirs sitting somewhere, and - for the owner - do they
 * administer anybody else. The action on the row is the one that matters:
 * open a claim in their name and start filling it, because the reason this
 * page exists is that people hand over receipts instead of filing anything.
 */
export default function PeopleDesk({ roster, isOwner }: {
  roster: RosterRow[];
  /**
   * Only the owner may hand out HR. Everything else here is available to HR
   * as well - they see the same roster and open the same claims - because
   * that is the job. Deciding who else gets to do the job is not.
   */
  isOwner: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const toggleHr = (row: RosterRow) =>
    startTransition(async () => {
      const res = await setHouseHr(row.email, !row.isHr);
      if (res?.error) { toast({ message: res.error }); return; }
      toast({
        message: row.isHr
          ? `${row.name || row.email} is no longer HR`
          : `${row.name || row.email} is HR - they can file a claim for anybody here and read the payroll register`,
      });
      router.refresh();
    });

  return (
    <Panel
      title="The roster"
      count={roster.length || undefined}
      hint="Everybody on staff here. Open a claim in somebody's name to file the receipts they handed you."
      empty="Nobody on the roster yet. Settings › Our people is where somebody gets a login."
    >
      {roster.length > 0 && (
        <DataTable
          cols={[
            { key: "who", label: "Person", width: "minmax(180px, 1.6fr)" },
            { key: "access", label: "Access", width: "150px" },
            { key: "unclaimed", label: "Out of pocket", width: "140px", align: "right" },
            { key: "claims", label: "Claims", width: "150px" },
            { key: "act", label: "", width: "150px", align: "right" },
          ]}
          rows={roster.map((r) => ({
            key: r.email,
            cells: {
              who: (
                <>
                  <span style={{ fontWeight: 600 }}>{r.name || <span className="mut">no name set</span>}</span>
                  <div className="mut t-meta">{r.email}</div>
                </>
              ),
              access: (
                <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  <Pill tone={r.role === "owner" ? "good" : "neutral"}>{r.role}</Pill>
                  {r.isHr && <Pill tone="info">HR</Pill>}
                </span>
              ),
              unclaimed: r.unclaimedCents > 0
                ? <span title={`${r.unclaimedCount} expense${r.unclaimedCount === 1 ? "" : "s"} not on a report`}>
                    {formatCents(r.unclaimedCents)}
                  </span>
                : <span className="mut">&mdash;</span>,
              claims: (
                <span className="t-small">
                  {r.submittedCount > 0 && <Pill tone="warn">{r.submittedCount} awaiting payout</Pill>}
                  {r.submittedCount === 0 && r.draftCount > 0 && (
                    <span className="mut">{r.draftCount} open</span>
                  )}
                  {r.submittedCount === 0 && r.draftCount === 0 && <span className="mut">&mdash;</span>}
                </span>
              ),
              act: (
                <span style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                  {/* A report is filed against a NAME - expense_reports.person -
                      so somebody with none cannot be the subject of one. Saying
                      so beats a picker that silently leaves them out. */}
                  {/* Through the reimbursement desk's own create form rather
                      than straight into a new row. This button used to mint a
                      report on the spot - nameless, and attached to no job -
                      which is the one shape the desk no longer lets anybody
                      make. The name rides along; the form opens with them
                      already chosen, and the action checks the roster again. */}
                  {r.nameable ? (
                    <Link className="btn sm"
                      href={`/money/reimbursements?for=${encodeURIComponent(r.name)}`}>
                      Open a claim
                    </Link>
                  ) : (
                    <span className="mut t-meta" title="Set their name in Settings › Our people first">
                      needs a name
                    </span>
                  )}
                  {isOwner && (
                    <button className="btn sm link" disabled={pending}
                      onClick={() => toggleHr(r)}>
                      {r.isHr ? "remove HR" : "make HR"}
                    </button>
                  )}
                </span>
              ),
            },
          }))}
        />
      )}
      {isOwner && (
        <div className="mut t-small" style={{ marginTop: 10 }}>
          HR may file a reimbursement claim for anybody on this roster and read the
          payroll register. It is not the books: what the shop has invoiced, is owed
          and has collected stays yours. Logins, roles and passwords are still
          <Link href="/settings/admin"> Settings › Our people</Link>.
        </div>
      )}
    </Panel>
  );
}
