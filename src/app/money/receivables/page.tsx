import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { booksContext } from "@/lib/financeData";
import { periodSpan, periodWord, withPeriod } from "@/lib/finance";
import { exposureByClient, type ReceivableRow } from "@/lib/money/figures";
import FinanceShell from "@/components/FinanceShell";
import DecisionButton from "@/components/money/DecisionButton";
import { NewInvoiceButton, NewQuoteButton } from "@/components/NewMoneyButtons";
import { billableOrgs } from "@/lib/referralData";
import { Id, Pill } from "@/components/ui";
import type { Tone } from "@/lib/tones";

export const dynamic = "force-dynamic";

const STAGES: { k: ReceivableRow["stage"]; label: string; unit: string }[] = [
  { k: "quoted", label: "Quoted", unit: "quote" },
  { k: "awarded", label: "Awarded, in work", unit: "job" },
  { k: "unbilled", label: "Worked, unbilled", unit: "job" },
  { k: "current", label: "Invoiced, in terms", unit: "invoice" },
  { k: "pastdue", label: "Past due", unit: "invoice" },
  { k: "paid", label: "Paid", unit: "payment" },
];

const PILL: Record<string, [Tone, string]> = {
  draft: ["faint", "Draft"], sent: ["info", "Sent"], partial: ["warn", "Partial"], paid: ["good", "Paid"],
  "in work": ["info", "In work"], closed: ["warn", "Unbilled"],
};

/**
 * Everything owed to the shop, from quote to paid: one pipeline, six stages,
 * one list. Left to right is the order money moves. Quotes and unbilled work
 * are not in the ledger yet - they are the pipeline's promise, not its record
 * - and the copy says so.
 */
export default async function ReceivablesPage({ searchParams }: {
  searchParams: Promise<{ period?: string; stage?: string; org?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const sp = await searchParams;
  const { period, today, mine, figures: f, rail } = await booksContext(user, sp.period);
  const stage = STAGES.find((s) => s.k === sp.stage)?.k ?? null;
  const org = sp.org ? Number(sp.org) : null;

  const counts: Record<ReceivableRow["stage"], { cents: number; n: number; tone?: Tone }> = {
    quoted: f.stages.quoted,
    awarded: f.stages.awarded,
    unbilled: { ...f.stages.unbilled, tone: f.stages.unbilled.cents ? "warn" : undefined },
    current: f.stages.current,
    pastdue: { ...f.stages.pastDue, tone: f.stages.pastDue.cents ? "bad" : undefined },
    paid: { ...f.stages.paid, tone: "good" },
  };
  const billable = await billableOrgs(mine);
  const payable = [...billable.clients, ...billable.peers];
  const shown = f.receivables.filter((r) => (!stage || r.stage === stage) && (org === null || r.orgId === org));
  const exposure = exposureByClient(f);
  const max = Math.max(1, ...exposure.map((e) => e.cents));
  const href = (k: string | null) => withPeriod(`/money/receivables${k ? `?stage=${k}` : ""}`, period);

  return (
    <FinanceShell
      rail={rail} active="receivables"
      period={period}
      path="/money/receivables"
      title="Receivables"
      sub={`Everything owed to the shop, from quote to paid · ${periodSpan(today, period)}`}
      actions={<><NewQuoteButton today={today} clients={payable} /><NewInvoiceButton clients={payable} /></>}
    >
      <div className="panel">
        <div className="stages">
          {STAGES.map((s) => {
            const c = counts[s.k];
            return (
              <Link key={s.k} href={href(stage === s.k ? null : s.k)} aria-current={stage === s.k ? "true" : undefined}>
                <div className="k">{s.k === "paid" ? `Paid, ${periodWord(period)}` : s.label}</div>
                <div className={`v${c.tone ? ` ${c.tone}` : ""}`}>{formatCents(c.cents)}</div>
                <div className="c">{c.n} {s.unit}{c.n === 1 ? "" : "s"}</div>
              </Link>
            );
          })}
        </div>
        <div className="note">
          Left to right is the order money moves. Quotes and unbilled work are not in the ledger yet - they are the pipeline&apos;s promise, not its record. Tap a stage to filter; tap it again to clear.
        </div>
      </div>

      <div className="panel">
        <div className="ph">
          <h2>{stage ? STAGES.find((s) => s.k === stage)!.label : "The whole pipeline"} <span className="t-meta mut">{shown.length} row{shown.length === 1 ? "" : "s"}</span></h2>
          {(stage || org !== null) && (
            <span className="chip">
              {stage ? STAGES.find((s) => s.k === stage)!.label : ""}{stage && org !== null ? " · " : ""}{org !== null ? f.orgName.get(org) ?? "" : ""}
              {" "}<Link href={href(null)} aria-label="Clear">×</Link>
            </span>
          )}
        </div>
        <div className="tblwrap">
          <table className="list">
            <thead><tr><th>Client</th><th>Document</th><th>What</th><th className="r">Amount</th><th></th></tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={5} className="empty">Nothing at this stage.</td></tr>}
              {shown.map((r) => {
                const [tone, label] = PILL[r.status] ?? ["neutral", r.status];
                return (
                  <tr key={`${r.stage}-${r.doc}-${r.sort}`} className="row">
                    <td><Link className="plain" href={`/money/receivables?org=${r.orgId}`}>{r.orgName}</Link></td>
                    <td><Link className="plain doc" href={r.href}><Id>{r.doc}</Id></Link><br /><Pill tone={tone}>{label}</Pill></td>
                    <td className="title">{r.title}<span className="meta">{r.meta}</span></td>
                    <td className={`num${r.tone ? ` fig ${r.tone}` : ""}`}>{formatCents(r.cents)}</td>
                    <td className="acts">
                      {r.stage === "quoted" && <Link className="btn sm" href={r.href}>Open</Link>}
                      {r.stage === "awarded" && <Link className="btn sm" href={r.href}>Open job</Link>}
                      {r.stage === "unbilled" && !r.draft && r.workOrderId && (
                        <DecisionButton action={{ kind: "draft-invoice", workOrderId: r.workOrderId, number: r.doc, label: "Draft invoice" }} />
                      )}
                      {r.stage === "unbilled" && r.draft && r.invoiceId && (
                        <DecisionButton action={{ kind: "send-invoice", id: r.invoiceId, label: "Send" }} />
                      )}
                      {r.stage === "pastdue" && (
                        <Link className={`btn sm${r.disputed ? "" : " accent"}`} href={r.href}>{r.disputed ? "Resolve dispute" : "Send next rung"}</Link>
                      )}
                      {r.stage === "current" && <Link className="btn sm" href={r.href}>Record payment</Link>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="ph"><h2>Exposure by client</h2><span className="t-meta mut">awarded + unbilled + invoiced, excluding quotes and paid</span></div>
        <div className="tblwrap">
          <table className="list"><tbody>
            {exposure.length === 0 && <tr><td className="empty">Nobody owes anything.</td></tr>}
            {exposure.map((e) => (
              <tr key={e.orgId}>
                <td style={{ width: "40%" }}><Link className="plain" href={`/money/clients?org=${e.orgId}`}>{e.orgName}</Link></td>
                <td><div className="bar" style={{ margin: 0 }}><span style={{ width: `${(e.cents / max) * 100}%`, background: "var(--navy)" }} /></div></td>
                <td className="num"><Figure_ cents={e.cents} orgId={e.orgId} /></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      </div>
    </FinanceShell>
  );
}

/** Exposure includes what is not yet in the ledger, so the door opens the client's rows. */
function Figure_({ cents, orgId }: { cents: number; orgId: number }) {
  return <Link className="fig money" href={`/money/ledger?acct=receivable&org=${orgId}`}>{formatCents(cents)}</Link>;
}
