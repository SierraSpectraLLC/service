"use client";

import { Fragment, useState, useTransition } from "react";
import { addStockItems } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import { ITEM_KIND_LABEL, STOCK_ITEM_KINDS, checkStockItem } from "@/lib/stock";
import { toCsv } from "@/lib/csv";

type Row = { kind: string; partNumber: string; name: string; qty: string; minQty: string; bin: string };

const COLUMNS = [
  { key: "kind", label: "What", width: 74 },
  { key: "partNumber", label: "Part number", width: 140 },
  { key: "name", label: "Description", width: 170 },
  { key: "qty", label: "On hand", width: 70 },
  { key: "minQty", label: "Reorder at", width: 80 },
  { key: "bin", label: "Bin", width: 80 },
] as const;

const blank = (): Row => ({ kind: "part", partNumber: "", name: "", qty: "", minQty: "", bin: "" });
/* A row worth saving is one carrying either identity - which of the two it
   NEEDED is checkStockItem's business, and saying so per row beats a row that
   silently does not save. */
const filled = (r: Row) => !!(r.partNumber.trim() || r.name.trim());
/** The first thing wrong with a row somebody has started filling in. */
const problemWith = (r: Row) => (filled(r) ? checkStockItem(r) : null);

/**
 * Stocking a shelf, spreadsheet-style - the same grid as the catalog and asset
 * entry. An opening count posts as a receive in the ledger; a line already on
 * the shelf has its description, floor and bin updated rather than being
 * duplicated, so re-pasting a corrected count sheet is safe.
 *
 * Parts and TOOLS come in through the same grid, because they go on the same
 * shelf. The "What" column is the only difference and it decides which cell is
 * required: a part is its number, a tool is its name and its number is
 * optional - the OEM alignment tool has one, the 4 mm hex key never will.
 * lib/stock.checkStockItem is that rule, shared with the server so what greys
 * the Save button out and what the save refuses are the same sentence.
 */
export default function StockGrid({ stockroomId, knownParts, onDone }: {
  stockroomId: number;
  /** Numbers from the parts catalog, the price book and existing shelves, with
      the book's name where it has one - autocomplete plus description fill.
      `resolvesTo` is set on a number that is somebody ELSE's spelling of the
      part - the maker's, or one it superseded - and names the number the book
      calls it now. */
  knownParts: { pn: string; name: string; resolvesTo?: string }[];
  onDone?: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([blank(), blank(), blank()]);
  const [error, setError] = useState("");
  const [failures, setFailures] = useState<{ row: number; name: string; error: string }[]>([]);
  const [saved, setSaved] = useState("");
  const [pending, startTransition] = useTransition();

  const setCell = (i: number, key: keyof Row, value: string) =>
    setRows((rs) => rs.map((r, n) => {
      if (n !== i) return r;
      const next = { ...r, [key]: value };
      // Typing a number the parts catalog knows fills the description in, the
      // same way the book fills names on the shelf - one source of truth.
      //
      // And typing SOMEBODY ELSE'S number for the same part - the maker's, or
      // one the book has since superseded - puts the book's own number on the
      // shelf instead. A shelf counted under two spellings of one part is two
      // lines that never add up.
      if (key === "partNumber") {
        const typed = value.trim().toLowerCase();
        const hit = knownParts.find((p) => p.pn.toLowerCase() === typed);
        if (hit?.resolvesTo) next.partNumber = hit.resolvesTo;
        if (hit?.name && !r.name.trim()) next.name = hit.name;
      }
      return next;
    }));

  const onPaste = (e: React.ClipboardEvent, atRow: number, atCol: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return;
    e.preventDefault();
    const grid = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    setRows((rs) => {
      const out = [...rs];
      grid.forEach((cells, dr) => {
        const ri = atRow + dr;
        while (out.length <= ri) out.push(blank());
        const row = { ...out[ri] };
        cells.forEach((cell, dc) => {
          const col = COLUMNS[atCol + dc];
          if (!col) return;
          // The kind column is a word in a spreadsheet and a value here, so a
          // pasted "Tool" has to land as "tool" rather than as nothing.
          const v = cell.trim();
          (row as Record<string, string>)[col.key] = col.key === "kind"
            ? (v.toLowerCase() === "tool" ? "tool" : "part")
            : v;
        });
        out[ri] = row;
      });
      return out;
    });
  };

  const usable = rows.filter(filled);
  /* Greyed on the same rule the server refuses on, so the button and the
     sentences under the rows can never disagree. */
  const blocked = usable.some((r) => checkStockItem(r) !== null);

  const save = () => {
    setError(""); setFailures([]); setSaved("");
    startTransition(async () => {
      const res = await addStockItems(stockroomId, usable);
      if (res?.error) { setError(res.error); return; }
      setFailures(res.failures ?? []);
      const bits = [
        res.created ? `${res.created} new line${res.created === 1 ? "" : "s"}` : "",
        res.updated ? `${res.updated} updated` : "",
      ].filter(Boolean);
      setSaved(bits.join(", ") || "Nothing changed");
      if (bits.length) toast({ message: `Stocked the lines - ${bits.join(", ")}` });
      const bad = new Set((res.failures ?? []).map((f) => f.row));
      setRows(bad.size ? usable.filter((_, i) => bad.has(i + 1)) : [blank(), blank(), blank()]);
      if (!bad.size) onDone?.();
    });
  };

  const template = () => toCsv([
    COLUMNS.map((c) => c.label),
    ["Part", "228-35145-91", "Plunger seal kit", "4", "2", "A-3"],
    ["Part", "5181-3323", "Inlet septa (50pk)", "1", "1", "B-1"],
    // A tool with a number and a tool without: both shapes, so a count sheet
    // pasted back in does not have to guess which columns matter.
    ["Tool", "G1946-80006", "CDS alignment tool", "1", "1", "Drawer 2"],
    ["Tool", "", "4 mm hex key", "3", "2", "Drawer 2"],
  ]);

  return (
    <div>
      <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }}>
        <table className="t-small" style={{ borderCollapse: "collapse", minWidth: 560 }}>
          <thead>
            <tr>
              <th style={{ width: 26 }} />
              {COLUMNS.map((c) => (
                <th key={c.key} className="t-meta" style={{ textAlign: "left", padding: "6px 6px", borderBottom: "1px solid var(--line)", color: "var(--slate)", width: c.width }}>
                  {c.label}
                  {/* No star on either identity column: which one is required
                      is the row's own answer now, said in the row. */}
                </th>
              ))}
              <th style={{ width: 30 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <Fragment key={i}>
              <tr style={{ background: filled(r) ? "#FBFDFF" : undefined }}>
                <td className="mut" style={{ fontSize: 10, textAlign: "right", padding: "0 4px" }}>{i + 1}</td>
                {COLUMNS.map((c, ci) => (
                  <td key={c.key} style={{ padding: 2, borderBottom: "1px solid var(--line)" }}>
                    {c.key === "kind" ? (
                      <select value={r.kind} aria-label={`What, row ${i + 1}`} className="t-small"
                        onChange={(e) => setCell(i, "kind", e.target.value)}
                        style={{ width: "100%", padding: "3px 4px" }}>
                        {STOCK_ITEM_KINDS.map((k) => (
                          <option key={k} value={k}>{ITEM_KIND_LABEL[k]}</option>
                        ))}
                      </select>
                    ) : (
                      <input value={r[c.key]} aria-label={`${c.label}, row ${i + 1}`}
                        list={c.key === "partNumber" ? "stock-known-parts" : undefined}
                        inputMode={c.key === "qty" || c.key === "minQty" ? "numeric" : undefined}
                        className={c.key === "partNumber" ? "mono t-small" : "t-small"}
                        /* The one cell this row cannot do without, named where
                           somebody is already looking rather than after a save
                           bounces the row back at them. */
                        placeholder={
                          c.key === "partNumber" ? (r.kind === "tool" ? "optional" : "required")
                            : c.key === "name" ? (r.kind === "tool" ? "required - 4 mm hex key" : "")
                            : undefined
                        }
                        onChange={(e) => setCell(i, c.key, e.target.value)}
                        onPaste={(e) => onPaste(e, i, ci)}
                        style={{ width: "100%", padding: "3px 4px" }} />
                    )}
                  </td>
                ))}
                <td style={{ padding: 2, borderBottom: "1px solid var(--line)" }}>
                  {rows.length > 1 && (
                    <button className="btn link t-small" aria-label={`Remove row ${i + 1}`} style={{ color: "var(--t-bad-fg)" }}
                      onClick={() => setRows((rs) => rs.filter((_, n) => n !== i))}>×</button>
                  )}
                </td>
              </tr>
              {/* Directly under the row it is about, while they are still
                  typing it. A grid that waits for Save to explain itself makes
                  somebody go back and find the row that bounced. */}
              {problemWith(r) && (
                <tr>
                  <td />
                  <td colSpan={COLUMNS.length + 1} className="t-small"
                    style={{ color: "var(--t-bad-fg)", padding: "0 6px 4px" }}>
                    {problemWith(r)}
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <datalist id="stock-known-parts">{knownParts.map((p) => <option key={p.pn} value={p.pn}>{p.name}</option>)}</datalist>

      <div className="row-2" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={() => setRows((rs) => [...rs, blank()])}>＋ Row</button>
        <button className="btn sm" onClick={() => setRows((rs) => [...rs, ...Array.from({ length: 5 }, blank)])}>＋ 5</button>
        <a className="btn link t-small"
          href={"data:text/csv;charset=utf-8," + encodeURIComponent(template())}
          download="stock-template.csv">download template</a>
        <span className="mut t-meta">Reorder at 0 means never suggest reordering.</span>
        <button className="btn sm accent" style={{ marginLeft: "auto" }} onClick={save} disabled={pending || !usable.length || blocked}>
          {pending ? "Saving..." : `Save ${usable.length || ""} line${usable.length === 1 ? "" : "s"}`.replace("  ", " ")}
        </button>
      </div>

      {saved && <div className="t-small" style={{ color: "var(--t-good-fg)", fontWeight: 700, marginTop: 8 }}>{saved} ✓</div>}
      {failures.length > 0 && (
        <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>
          {failures.length} row{failures.length === 1 ? "" : "s"} still above:
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {failures.map((f) => <li key={f.row}>{f.name}: {f.error}</li>)}
          </ul>
        </div>
      )}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
