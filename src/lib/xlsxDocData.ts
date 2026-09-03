import { descriptionLines } from "@/lib/billing";
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
  /** The catalogued number quoted, where the line came off one. */
  partNumber?: string;
};

/**
 * Invoice/quote lines as the sheet wants them.
 *
 * A covered line keeps its description and quantity and prices at ZERO in the
 * sheet, with the covering agreement named - because the sheet's row formula
 * multiplies qty by price, and a covered line priced at list would charge the
 * client for what the contract already paid.
 *
 * A description that runs to several lines becomes several ROWS: the charge,
 * then its detail, each in its own row, priced on the first one only. That is
 * how the shop's own quotes have always looked - a system on one row and the
 * seven modules it covers under it - and typing those seven rows by hand into
 * the exported file is the work this removes.
 */
export const invoiceLinesForXlsx = (lines: StoredLine[]): DocLine[] =>
  lines.flatMap((l) => {
    const { head, rest } = descriptionLines(l.description);
    const charge: DocLine = {
      description: [
        head,
        l.detail && ` - ${l.detail}`,
        l.covered && ` (covered${l.coveredBy ? ` by ${l.coveredBy}` : ""})`,
      ].filter(Boolean).join(""),
      // The template has always had this column and nothing ever filled it. It
      // is what a client's purchasing department matches a quote against, and
      // what the shop reorders by - see quote_lines.part_number.
      partNumber: l.partNumber ?? "",
      qty: l.qty,
      unitPrice: l.covered ? 0 : l.unitCents / 100,
    };
    // No quantity and no price on a continuation row: the charge is stated
    // once. The template's row formula prints "-" beside them, which is what
    // the shop's own paper does.
    return [charge, ...rest.map((r): DocLine => ({ description: r, continuation: true }))];
  });
