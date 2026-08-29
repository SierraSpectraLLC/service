import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { payroll } from "@/db/schema";
import { requireUser, myTenantOrgId } from "@/lib/authz";
import { payrollViewerFor } from "@/lib/hr";
import { formatCents } from "@/lib/money";
import {
  isOwnRow, maySeePayroll, monthlyCostCents, PAY_KINDS, type PayRow,
} from "@/lib/payroll";
import { navSection } from "@/lib/navData";
import SectionShell from "@/components/SectionShell";
import { DataTable, EmptyState, Panel, Pill, Stack } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * YOUR pay - not the register.
 *
 * /money/payroll is the register and stays behind the register gate, which is
 * right and is also why an ordinary engineer had nowhere at all to check what
 * the company records about paying them. A payroll you cannot check is a
 * payroll kept ABOUT you rather than for you.
 *
 * This is the other side of that: your own rows, from the same table, filtered
 * by the same rule (lib/payroll.isOwnRow, matched on the address, which is the
 * only identity a payroll row and an account reliably share). It also resolves
 * the awkward case the nav had - a client manager with the payroll flag used
 * to reach an operator's route, /money/payroll, from a group in their own
 * portal. Whoever may read a whole register still can, by the link at the
 * bottom of this page.
 */
export default async function AccountPayPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const section = await navSection("account");

  // Their own company's, always. A page that took an org id would be a page
  // somebody could point at somebody else's.
  const mine = user.orgId ?? myTenantOrgId(user);
  if (mine === null) redirect("/account");

  // Assembled by lib/hr, which is the only place that reads either roster.
  const viewer = await payrollViewerFor(user);
  const all = (await db.select().from(payroll).where(eq(payroll.orgId, mine))
    .orderBy(asc(payroll.effectiveOn)).catch(() => [])) as PayRow[];
  const mineRows = all.filter((r) => isOwnRow(viewer, r));
  const readsRegister = maySeePayroll(viewer, mine);

  const kindLabel = (k: string) => PAY_KINDS.find((x) => x.key === k)?.label ?? k;
  const unit = (k: string) => PAY_KINDS.find((x) => x.key === k)?.unit ?? "";
  const current = mineRows.filter((r) => !r.endsOn);

  return (
    <SectionShell section={section} active="/account/pay"
      title="My pay" sub="What your company records about paying you.">
      <Stack gap={3}>
        <Panel title="Your pay records" count={mineRows.length || undefined}>
          {mineRows.length === 0 ? (
            <EmptyState title="Nothing recorded for your address yet."
              body="Pay rows are matched on the email you sign in with. If you are paid here and this is empty, whoever runs payroll has it under a different address." />
          ) : (
            <DataTable
              cols={[
                { key: "what", label: "Pay", width: "minmax(140px, 2fr)" },
                { key: "rate", label: "Rate", width: "minmax(110px, 1fr)", align: "right" },
                { key: "month", label: "Cost a month", width: "minmax(110px, 1fr)", align: "right", hideMobile: true },
                { key: "from", label: "From", width: "110px" },
                { key: "state", label: "", width: "90px", align: "right" },
              ]}
              rows={mineRows.map((r) => ({
                key: r.id,
                cells: {
                  what: <span className="t-body">{kindLabel(r.kind)}{r.title ? ` · ${r.title}` : ""}</span>,
                  rate: <span className="mono">{formatCents(r.amountCents)} {unit(r.kind)}</span>,
                  /* The employer-cost figure, because it is a fact the company
                     already holds about this person and reading it about
                     yourself gives nothing away about anybody else. */
                  month: <span className="mono">{formatCents(monthlyCostCents(r))}</span>,
                  from: <span className="mut">{r.effectiveOn}</span>,
                  state: r.endsOn
                    ? <Pill tone="faint">ended {r.endsOn}</Pill>
                    : <Pill tone="good">current</Pill>,
                },
              }))}
            />
          )}
        </Panel>

        <Panel title="What you spent" hint="Money you laid out and want back is its own room.">
          <div className="t-body">
            Claims and their approvals live in{" "}
            <Link href="/money/reimbursements">Reimbursements</Link>.
          </div>
        </Panel>

        {current.length > 0 && (
          <div className="mut t-small">
            These are the records, not a paystub: what actually landed in your
            account is on the payslip your payroll provider issues.
          </div>
        )}

        {readsRegister && (
          <div className="mut t-small">
            You may also read your organization&apos;s whole{" "}
            <Link href="/money/payroll">payroll register</Link>.
          </div>
        )}
      </Stack>
    </SectionShell>
  );
}
