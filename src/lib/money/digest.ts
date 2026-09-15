// The digest's money section, from the same sources the Home page decides by.
import { digestInputFrom } from "@/lib/money/decisions";
import { moneyFigures } from "@/lib/money/figures";
import type { MoneyInput } from "@/lib/digestMoney";

/**
 * "Money, whose move" for the internal digest. A projection of the decision
 * sources the Home page draws its list from, so the email and the page cannot
 * disagree about what is waiting. The register is not read here: the digest
 * goes to staff, and payroll is not theirs.
 */
export async function moneyDigest(today: string, tenantOrgId: number | null): Promise<MoneyInput> {
  const f = await moneyFigures(tenantOrgId, today, "month", { seesPayroll: false });
  return digestInputFrom(f.sources);
}
