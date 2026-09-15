// The journal as a file. Both formats are the ledger row for row. Pure.
import { describe, expect, it } from "vitest";
import { ledgerCsv, ledgerIif } from "@/lib/ledger/exports";
import type { LedgerEntry } from "@/lib/ledger/sums";

const rows: LedgerEntry[] = [{
  id: 12, postedOn: "2026-09-03", memo: 'Sent INV-2026-014 to "LabZen", parts', refType: "invoice", refId: "14",
  refOrgId: 1, refWorkOrderId: null, reversesId: null, reversedBy: null, bankTxnId: null,
  postedBy: "joe", lines: [
    { account: "receivable", debitCents: 282000, creditCents: 0 },
    { account: "revenue_parts", debitCents: 0, creditCents: 260000 },
    { account: "sales_tax_owed", debitCents: 0, creditCents: 22000 },
  ],
} as unknown as LedgerEntry];
const name = (a: string) => ({ receivable: "Accounts receivable", revenue_parts: "Revenue, parts", sales_tax_owed: "Sales tax owed" }[a] ?? a);

describe("ledgerCsv", () => {
  it("writes one row per posting line, quoted where a memo needs it", () => {
    const csv = ledgerCsv(rows, name).split("\n");
    expect(csv[0]).toBe("entry,date,memo,document,account,debit,credit");
    expect(csv[1]).toBe('12,2026-09-03,"Sent INV-2026-014 to ""LabZen"", parts",invoice:14,Accounts receivable,2820.00,');
    expect(csv[2]).toBe('12,2026-09-03,"Sent INV-2026-014 to ""LabZen"", parts",invoice:14,"Revenue, parts",,2600.00');
    expect(csv[3]).toBe('12,2026-09-03,"Sent INV-2026-014 to ""LabZen"", parts",invoice:14,Sales tax owed,,220.00');
    expect(csv[4]).toBe("");
  });
});

describe("ledgerIif", () => {
  it("writes a general journal block per entry with signed amounts that sum to zero", () => {
    const iif = ledgerIif(rows, name).split("\n");
    expect(iif.slice(0, 3)).toEqual([
      "!TRNS\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tMEMO", "!SPL\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tMEMO", "!ENDTRNS",
    ]);
    expect(iif[3]).toBe('TRNS\tGENERAL JOURNAL\t09/03/2026\tAccounts receivable\t2820.00\tSent INV-2026-014 to "LabZen", parts');
    expect(iif[4]).toMatch(/^SPL\tGENERAL JOURNAL\t09\/03\/2026\tRevenue, parts\t-2600\.00\t/);
    expect(iif[5]).toMatch(/^SPL\t.*\t-220\.00\t/);
    expect(iif[6]).toBe("ENDTRNS");
    const sum = iif.slice(3, 6).map((l) => Number(l.split("\t")[4])).reduce((n, x) => n + x, 0);
    expect(sum).toBe(0);
  });
});
