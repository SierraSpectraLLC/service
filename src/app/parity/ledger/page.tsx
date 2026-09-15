import { redirect } from "next/navigation";
import { requireUser, myTenantOrgId } from "@/lib/authz";
import { seesBooksFor } from "@/lib/financeData";
import { latestParity, parityFor, type ParityFigure } from "@/lib/ledger/parity";
import { shopToday, shopTime } from "@/lib/shopday";
import { formatCents } from "@/lib/money";
import LedgerParityRun from "@/components/LedgerParityRun";
import { DataTable, PageHead, Panel, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Ledger parity: the money computed the old way beside the ledger's way.
 *
 * The record of the dual-write period, next to Sheet parity because it is
 * the same kind of page: two systems that must agree, and the list of where
 * they do not. Live figures are computed on load; the stored run is what the
 * hourly cron last wrote, so a diff that comes and goes is visible as such.
 */
export default async function LedgerParityPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!(await seesBooksFor(user))) redirect("/");
  const mine = myTenantOrgId(user);
  if (mine === null) redirect("/");
  const today = shopToday();
  const [live, stored] = await Promise.all([parityFor(mine, today), latestParity(mine)]);
  const off = live.filter((f) => f.diffCents !== 0);

  return (
    <div className="container wide">
      <PageHead
        crumb={<>Operations › <b>Ledger parity</b></>}
        title="Ledger parity"
        sub={`Every figure the old arithmetic can compute, beside the ledger's sum · ${today}`}
        actions={<LedgerParityRun canRun={user.role === "owner"} />}
      />
      <Panel title="Right now" count={off.length}
        hint={off.length === 0
          ? "Every figure agrees. Both sides read the same rows."
          : `${off.length} figure${off.length === 1 ? "" : "s"} differ. Each note says why - a nonzero here is either a known gap in the old arithmetic or a bug.`}>
        <ParityTable figures={live} empty="Nothing to compare yet." />
      </Panel>
      <Panel title="Last stored run"
        hint={stored ? `Written ${shopTime(stored.runAt)} by the hourly check or Run now.` : "The hourly check has not run yet."}>
        <ParityTable figures={stored?.figures ?? []} empty="No run stored yet." />
      </Panel>
    </div>
  );
}

function ParityTable({ figures, empty }: { figures: ParityFigure[]; empty: string }) {
  return (
    <DataTable
      empty={empty}
      cols={[
        { key: "figure", label: "Figure", width: "minmax(220px, 2fr)" },
        { key: "legacy", label: "Old arithmetic", align: "right", width: "130px" },
        { key: "ledger", label: "Ledger", align: "right", width: "130px" },
        { key: "diff", label: "Difference", align: "right", width: "120px" },
      ]}
      rows={figures.map((f) => ({
        key: f.key,
        cells: {
          figure: <><b>{f.label}</b><span className="t-meta mut" style={{ display: "block" }}>{f.note}</span></>,
          legacy: <span className="money">{formatCents(f.legacyCents)}</span>,
          ledger: <span className="money">{formatCents(f.ledgerCents)}</span>,
          diff: f.diffCents === 0 ? <Pill tone="good">agrees</Pill> : <Pill tone="warn">{formatCents(f.diffCents)}</Pill>,
        },
      }))}
    />
  );
}
