"use client";

import { useMemo, useState, useTransition } from "react";
import { addPartPrices, deletePartPrice } from "@/app/actions";
import { formatCents, centsToInput } from "@/lib/money";
import { groupByPn, normalizePn } from "@/lib/priceBook";
import { toCsv } from "@/lib/csv";
import { matchesQuery } from "@/lib/search";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import Dialog from "@/components/ui/Dialog";

export type PriceBookRow = {
  id: number; partNumber: string; vendor: string; isOem: boolean; priceCents: number; url: string; note: string;
};

type GridRow = { partNumber: string; vendor: string; price: string; oem: string; url: string; note: string };

const COLUMNS = [
  { key: "partNumber", label: "Part number", width: 140 },
  { key: "vendor", label: "Vendor", width: 130 },
  { key: "price", label: "Price", width: 80 },
  { key: "oem", label: "OEM", width: 50 },
  { key: "url", label: "Link", width: 150 },
  { key: "note", label: "Note", width: 150 },
] as const;

const blank = (): GridRow => ({ partNumber: "", vendor: "", price: "", oem: "", url: "", note: "" });
const filled = (r: GridRow) => !!(r.partNumber.trim() && r.vendor.trim() && r.price.trim());
const oemish = (s: string) => /^(y|yes|oem|true|1)$/i.test(s.trim());

/**
 * The house price book: every vendor's price for a part number, side by side.
 * Same spreadsheet entry as the rest of the catalog, and re-saving an existing
 * (PN, vendor) pair updates its price - pasting this quarter's quote sheet
 * over last quarter's is the maintenance path, not an error.
 */
export default function PriceBookCard({ prices, knownVendors }: {
  prices: PriceBookRow[];
  knownVendors: string[];
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<GridRow[]>([blank(), blank(), blank()]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [failures, setFailures] = useState<{ row: number; name: string; error: string }[]>([]);
  const [saved, setSaved] = useState("");
  const [pending, startTransition] = useTransition();

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const shown = needle
      ? prices.filter((p) => matchesQuery(filter, [p.partNumber, p.vendor]))
      : prices;
    // groupByPn keys by normalized PN; display the first row's spelling.
    return [...groupByPn(shown).values()].sort((a, b) => a[0].partNumber.localeCompare(b[0].partNumber));
  }, [prices, filter]);

  const setCell = (i: number, key: keyof GridRow, value: string) =>
    setRows((rs) => rs.map((r, n) => (n === i ? { ...r, [key]: value } : r)));

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
          if (col) (row as Record<string, string>)[col.key] = cell.trim();
        });
        out[ri] = row;
      });
      return out;
    });
  };

  /** "edit" = the row's values dropped into the grid; saving upserts in place. */
  const editRow = (p: PriceBookRow) => {
    const draft: GridRow = {
      partNumber: p.partNumber, vendor: p.vendor, price: centsToInput(p.priceCents),
      oem: p.isOem ? "OEM" : "", url: p.url, note: p.note,
    };
    setRows((rs) => {
      const already = rs.findIndex((r) =>
        normalizePn(r.partNumber) === normalizePn(p.partNumber) && r.vendor.trim().toLowerCase() === p.vendor.toLowerCase());
      if (already >= 0) return rs.map((r, i) => (i === already ? draft : r));
      const firstEmpty = rs.findIndex((r) => !r.partNumber.trim() && !r.vendor.trim() && !r.price.trim());
      if (firstEmpty >= 0) return rs.map((r, i) => (i === firstEmpty ? draft : r));
      return [...rs, draft];
    });
    setOpen(true);
  };

  const usable = rows.filter(filled);

  const save = () => {
    setError(""); setFailures([]); setSaved("");
    startTransition(async () => {
      const res = await addPartPrices(usable.map((r) => ({
        partNumber: r.partNumber, vendor: r.vendor, price: r.price,
        isOem: oemish(r.oem), url: r.url, note: r.note,
      })));
      if (res?.error) { setError(res.error); return; }
      setFailures(res.failures ?? []);
      const bits = [
        res.created ? `${res.created} added` : "",
        res.updated ? `${res.updated} updated` : "",
      ].filter(Boolean);
      setSaved(bits.join(", ") || "Nothing changed");
      const bad = new Set((res.failures ?? []).map((f) => f.row));
      setRows(bad.size ? usable.filter((_, i) => bad.has(i + 1)) : [blank(), blank(), blank()]);
      if (!bad.size) setOpen(false);
    });
  };

  const template = () => toCsv([
    COLUMNS.map((c) => c.label),
    ["228-35145-91", "Shimadzu", "129.00", "OEM", "", ""],
    ["228-35145-91", "Chrom Tech", "98.00", "", "https://chromtech.com/...", "min order 2"],
  ]);

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 4, gap: 8 }}>
        <div className="card-title">Price book</div>
        <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => setOpen(!open)}>
          {open ? "Cancel" : "+ Add prices"}
        </button>
      </div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
        OEM and third-party prices per part number. &quot;Request part&quot; on a maintenance job
        fills in the cheapest offer here (OEM wins ties), and part forms suggest these
        vendors. Prices only show where costs already do.
      </div>

      {open && (
        <Dialog open onClose={() => setOpen(false)} size="lg" title="Add prices"
          context="Paste from a spreadsheet. A PN + vendor already on file gets its price updated."
          footer={
            <>
              <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
              <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending || !usable.length}>
                {pending ? "Saving..." : `Save ${usable.length || ""} price${usable.length === 1 ? "" : "s"}`.replace("  ", " ")}
              </button>
            </>
          }>
          <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: 640 }}>
              <thead>
                <tr>
                  <th style={{ width: 26 }} />
                  {COLUMNS.map((c) => (
                    <th key={c.key} style={{ textAlign: "left", padding: "6px 6px", borderBottom: "1px solid var(--line)", fontSize: 11, color: "var(--slate)", width: c.width }}>
                      {c.label}{["partNumber", "vendor", "price"].includes(c.key) && " *"}
                    </th>
                  ))}
                  <th style={{ width: 30 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ background: filled(r) ? "#FBFDFF" : undefined }}>
                    <td className="mut" style={{ fontSize: 10, textAlign: "right", padding: "0 4px" }}>{i + 1}</td>
                    {COLUMNS.map((c, ci) => (
                      <td key={c.key} style={{ padding: 2, borderBottom: "1px solid var(--line)" }}>
                        <input value={r[c.key]} aria-label={`${c.label}, row ${i + 1}`}
                          list={c.key === "vendor" ? "price-vendors" : undefined}
                          placeholder={c.key === "oem" ? "OEM?" : c.key === "price" ? "129.95" : ""}
                          onChange={(e) => setCell(i, c.key, e.target.value)}
                          onPaste={(e) => onPaste(e, i, ci)}
                          style={{ width: "100%", fontSize: 12, padding: "3px 4px" }} />
                      </td>
                    ))}
                    <td style={{ padding: 2, borderBottom: "1px solid var(--line)" }}>
                      {rows.length > 1 && (
                        <button className="btn link" aria-label={`Remove row ${i + 1}`} style={{ color: "var(--t-bad-fg)", fontSize: 12 }}
                          onClick={() => setRows((rs) => rs.filter((_, n) => n !== i))}>×</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <datalist id="price-vendors">{knownVendors.map((v) => <option key={v} value={v} />)}</datalist>
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn sm" onClick={() => setRows((rs) => [...rs, blank()])}>＋ Row</button>
            <button className="btn sm" onClick={() => setRows((rs) => [...rs, ...Array.from({ length: 5 }, blank)])}>＋ 5</button>
            <a className="btn link" style={{ fontSize: 12 }}
              href={"data:text/csv;charset=utf-8," + encodeURIComponent(template())}
              download="price-book-template.csv">download template</a>
          </div>
          {failures.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--t-bad-fg)", marginTop: 8 }}>
              {failures.length} row{failures.length === 1 ? "" : "s"} still above:
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {failures.map((f) => <li key={f.row}>{f.name}: {f.error}</li>)}
              </ul>
            </div>
          )}
        </Dialog>
      )}
      {saved && <div style={{ fontSize: 12, color: "var(--t-good-fg)", fontWeight: 700, marginBottom: 8 }}>{saved} ✓</div>}

      {prices.length > 8 && (
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by PN or vendor"
          style={{ fontSize: 13, marginBottom: 10, maxWidth: 260 }} />
      )}

      {prices.length === 0 && !open && (
        <div className="mut" style={{ fontSize: 13 }}>No prices on file yet.</div>
      )}
      {groups.map((offers) => (
        <div key={normalizePn(offers[0].partNumber)} style={{ borderTop: "1px solid var(--line)", padding: "8px 0" }}>
          <div className="mono" style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{offers[0].partNumber}</div>
          {offers.map((p, i) => (
            <div key={p.id} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "2px 0", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13 }}>{p.vendor}</span>
              {p.isOem && <span className="pill accent">OEM</span>}
              <span style={{ fontSize: 13, fontWeight: 700, color: i === 0 ? "#085041" : undefined }}>{formatCents(p.priceCents)}</span>
              {p.url && <a href={p.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>order ↗</a>}
              {p.note && <span className="mut" style={{ fontSize: 12 }}>{p.note}</span>}
              <span style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
                <button className="btn link" style={{ fontSize: 11 }} onClick={() => editRow(p)}>edit</button>
                <button className="btn link" style={{ color: "var(--t-bad-fg)", fontSize: 11 }} disabled={pending}
                  onClick={async () => {
                    if (!(await confirmDialog({
                      title: `Remove ${p.vendor}'s ${formatCents(p.priceCents)} price for PN ${p.partNumber}?`,
                      action: "Remove price", tone: "bad",
                    }))) return;
                    startTransition(async () => {
                      const res = await deletePartPrice(p.id);
                      if (res?.error) setError(res.error);
                      else toast({ message: `Removed ${p.vendor}'s price for ${p.partNumber}` });
                    });
                  }}>remove</button>
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
