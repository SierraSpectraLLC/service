import type { Brand } from "@/lib/brand";
import type { DocLine } from "@/lib/xlsxDocs";

/** The download response headers, with the document's number as the filename. */
export const xlsxHeaders = (number: string): Record<string, string> => ({
  "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "Content-Disposition": `attachment; filename="${number.replace(/[^\w.-]+/g, "_") || "document"}.xlsx"`,
});

/** The footer contact line the templates leave blank for us. */
export const docContactLine = (brand: Brand): string =>
  [brand.operatorName || brand.name, brand.contactEmail].filter(Boolean).join(" | ");

type StoredLine = {
  kind: string; description: string; detail: string;
  /** Real units already (thousandths resolved by the caller). */
  qty: number; unitCents: number; covered: boolean; coveredBy: string;
};

/**
 * Invoice/quote lines as the sheet wants them.
 *
 * A covered line keeps its description and quantity and prices at ZERO in the
 * sheet, with the covering agreement named - because the sheet's row formula
 * multiplies qty by price, and a covered line priced at list would charge the
 * client for what the contract already paid.
 */
export const invoiceLinesForXlsx = (lines: StoredLine[]): DocLine[] =>
  lines.map((l) => ({
    description: [
      l.description,
      l.detail && ` - ${l.detail}`,
      l.covered && ` (covered${l.coveredBy ? ` by ${l.coveredBy}` : ""})`,
    ].filter(Boolean).join(""),
    partNumber: "",
    qty: l.qty,
    unitPrice: l.covered ? 0 : l.unitCents / 100,
  }));
