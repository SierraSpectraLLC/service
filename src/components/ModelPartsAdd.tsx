"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { importParts } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import { PART_KINDS, PART_KIND_LABEL } from "@/lib/partCatalog";
import PartDialog, { type VendorPrice } from "./PartDialog";

type Row = { partNumber: string; name: string; kind: string };

const blank = (): Row => ({ partNumber: "", name: "", kind: "part" });
const filled = (r: Row) => !!r.partNumber.trim();

/**
 * File a part against the model you are already looking at.
 *
 * The gap, in the shop's words: "It makes my life easier if I can just add
 * them here - autoselect the system we've got selected too." The model's parts
 * tab could only say what was already filed and link out to the parts catalog,
 * where the first thing to do was find this model again in a list of 1,100 and
 * tick it. Adding six consumables to one LC meant six round trips and six
 * chances to tick the wrong one.
 *
 * THE SEED IS THE WHOLE POINT. Both doors open with Suits and Specific models
 * already set to this model and its module type, because that is the one fact
 * the page knows and the form was asking for anyway.
 *
 * One at a time opens the SAME dialog the parts catalog uses - the full form,
 * aliases, vendors, photos and all - rather than a smaller one that would drift
 * from it. Several at a time is a grid for the ordinary case, which is a page
 * of a vendor's list: numbers and names, one kind, all for this model.
 */
export default function ModelPartsAdd({
  assetType, model, assetTypes, modelsByType, prices, makers,
}: {
  /** The module type this model is, e.g. "LC System". */
  assetType: string;
  /** The model itself, e.g. "Prep 150 LC". */
  model: string;
  assetTypes: string[];
  modelsByType: Record<string, string[]>;
  prices?: VendorPrice[];
  makers?: string[];
}) {
  const router = useRouter();
  const [one, setOne] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  /** Suits and Specific models, answered from where the reader is standing. */
  const seed = { assetTypes: assetType ? [assetType] : [], models: [model] };

  const setCell = (i: number, key: keyof Row, value: string) =>
    setRows((rs) => (rs ?? []).map((r, n) => (n === i ? { ...r, [key]: value } : r)));

  /** Excel/Sheets paste, the same gesture the model grid takes. */
  const onPaste = (e: React.ClipboardEvent, atRow: number, atCol: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return;
    e.preventDefault();
    const cols: (keyof Row)[] = ["partNumber", "name", "kind"];
    const grid = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    setRows((rs) => {
      const out = [...(rs ?? [])];
      grid.forEach((cells, dr) => {
        const ri = atRow + dr;
        while (out.length <= ri) out.push(blank());
        const row = { ...out[ri]! };
        cells.forEach((cell, dc) => {
          const col = cols[atCol + dc];
          if (col) row[col] = cell.trim();
        });
        out[ri] = row;
      });
      return out;
    });
  };

  const usable = (rows ?? []).filter(filled);

  const saveMany = () => {
    setError("");
    startTransition(async () => {
      /* Through importParts rather than a loop of addCatalogPart: the upsert,
         the number-clash rules and the per-row problem list already live
         there, and a second write path would be a second set of them. Its
         `fits` and `models` columns are exactly the seed. */
      const res = await importParts(usable.map((r) => ({
        partNumber: r.partNumber, name: r.name, kind: r.kind,
        fits: assetType, models: model,
        manufacturer: "", mfrPartNumber: "", note: "",
        vendor: "", price: "", oem: "", leadDays: "", blindShip: "", overnight: "", url: "",
      })));
      if (res?.error) { setError(res.error); return; }
      const bad = res.problems ?? [];
      if (bad.length) {
        setError(bad.map((p) => `row ${p.line}${p.partNumber ? ` (${p.partNumber})` : ""}: ${p.problem}`).join("; "));
        return;
      }
      const n = (res.created ?? 0) + (res.updated ?? 0);
      toast({ message: `Filed ${n} part${n === 1 ? "" : "s"} against ${model}` });
      setRows(null);
      router.refresh();
    });
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginLeft: "auto" }}>
        <button className="btn sm primary" onClick={() => setOne(true)}>+ Part number</button>
        <button className="btn sm" onClick={() => setRows([blank(), blank(), blank()])}>+ Several</button>
      </div>

      {one && (
        <PartDialog seed={seed} assetTypes={assetTypes} modelsByType={modelsByType}
          prices={prices} makers={makers}
          onClose={() => setOne(false)} onSaved={() => router.refresh()} />
      )}

      {rows && (
        <div className="card" style={{ marginTop: 8 }}>
          <div className="mut t-meta" style={{ marginBottom: 8 }}>
            Every row is filed against <b>{model}</b>{assetType ? ` and ${assetType}` : ""}. Paste a
            column out of a vendor&apos;s list if you have one.
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  {["Part number", "What it is", "Kind"].map((h) => (
                    <th key={h} className="eyebrow" style={{ textAlign: "left", padding: "2px 4px" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ padding: 2 }}>
                      <input className="mono t-small" value={r.partNumber} style={{ width: 150 }}
                        aria-label={`Part number, row ${i + 1}`}
                        onPaste={(e) => onPaste(e, i, 0)}
                        onChange={(e) => setCell(i, "partNumber", e.target.value)} />
                    </td>
                    <td style={{ padding: 2 }}>
                      <input className="t-small" value={r.name} style={{ width: 210 }}
                        aria-label={`What it is, row ${i + 1}`}
                        onPaste={(e) => onPaste(e, i, 1)}
                        onChange={(e) => setCell(i, "name", e.target.value)} />
                    </td>
                    <td style={{ padding: 2 }}>
                      <select className="t-small" value={r.kind} style={{ width: "auto" }}
                        aria-label={`Kind, row ${i + 1}`}
                        onChange={(e) => setCell(i, "kind", e.target.value)}>
                        {PART_KINDS.map((k) => <option key={k} value={k}>{PART_KIND_LABEL[k]}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
            <button className="btn sm" disabled={pending}
              onClick={() => setRows([...(rows ?? []), blank(), blank(), blank()])}>＋ 3 rows</button>
            <span className="sp" />
            <span className="mut t-small">
              {usable.length ? `${usable.length} row${usable.length === 1 ? "" : "s"} ready` : "a part number is all a row needs"}
            </span>
            <button className="btn sm" onClick={() => { setRows(null); setError(""); }} disabled={pending}>Cancel</button>
            <button className="btn sm accent" onClick={saveMany} disabled={pending || !usable.length}>
              {pending ? "Filing..." : `File ${usable.length || ""}`}
            </button>
          </div>
          {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
        </div>
      )}
    </>
  );
}
