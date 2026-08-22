"use client";

import { useState, useTransition } from "react";
import { resolveDiff } from "@/app/actions";
import { fmtWhen } from "@/lib/when";
import { DataTable, Id, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

type Diff = {
  id: number; externalId: string; field: string; sheetValue: string; dbValue: string;
  resolved: boolean; resolution: string; runAt: string;
};

const RESOLUTION_LABEL: Record<string, string> = {
  kept_ours: "kept ours",
  accepted_sheet: "accepted sheet",
  kept_ours_pushed: "sheet updated",
  auto_cleared: "auto-cleared",
};

const when = (iso: string) => fmtWhen(iso);

export default function ParityList({ diffs, showHistory = false }: { diffs: Diff[]; showHistory?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<number, string>>({});

  const resolve = (id: number, resolution: "kept_ours" | "accepted_sheet" | "kept_ours_pushed") =>
    startTransition(async () => {
      setErrors((e) => ({ ...e, [id]: "" }));
      const res = await resolveDiff(id, resolution);
      if (res?.error) setErrors((e) => ({ ...e, [id]: res.error! }));
      else toast({
        message: resolution === "kept_ours" ? "Kept our value"
          : resolution === "accepted_sheet" ? "Accepted the sheet's value"
          : "Kept ours and updated the sheet",
      });
    });

  const open = diffs.filter((d) => !d.resolved);
  const history = diffs.filter((d) => d.resolved);

  // One card per system, its field mismatches inside - not one card per diff.
  const groups: { externalId: string; items: Diff[] }[] = [];
  for (const d of open) {
    const g = groups.find((x) => x.externalId === d.externalId);
    if (g) g.items.push(d);
    else groups.push({ externalId: d.externalId, items: [d] });
  }

  if (!diffs.length) {
    return <div className="mut" style={{ fontSize: 13 }}>No diffs recorded yet. The cron job runs hourly.</div>;
  }

  return (
    <>
      {!showHistory && open.length === 0 && (
        <div className="card" style={{ padding: 14 }}>
          <span style={{ fontSize: 13, color: "#2E6B2E", fontWeight: 700 }}>✓ No open mismatches.</span>
        </div>
      )}

      {!showHistory && groups.map((g) => (
        <div key={g.externalId} className="card" style={{ padding: 14 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="mono" style={{ fontWeight: 700, fontSize: 13, color: "var(--navy)" }}>{g.externalId}</span>
            <span className="mut" style={{ fontSize: 12 }}>{g.items.length} mismatch{g.items.length === 1 ? "" : "es"}</span>
          </div>
          {g.items.map((d) => (
            <div key={d.id} style={{ borderTop: "1px solid var(--line)", marginTop: 10, paddingTop: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{d.field === "Row" ? "Row presence" : d.field}</span>
                <span className="mut" style={{ fontSize: 11, marginLeft: "auto" }}>{when(d.runAt)}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "48px 1fr", gap: "3px 8px", fontSize: 13, marginBottom: 8 }}>
                <span className="eyebrow" style={{ alignSelf: "start", paddingTop: 2 }}>Sheet</span>
                <span>{d.sheetValue || <span className="mut">(blank)</span>}</span>
                <span className="eyebrow" style={{ alignSelf: "start", paddingTop: 2, color: "#1D6396" }}>Ours</span>
                <span style={{ color: "#1D6396" }}>{d.dbValue || <span className="mut">(blank)</span>}</span>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn sm primary" disabled={pending} onClick={() => resolve(d.id, "kept_ours")}>Keep ours</button>
                {/* Row diffs can be pushed only in the "we have it, they don't" direction: add the row. */}
                {(d.field !== "Row" || d.sheetValue === "(missing from sheet)") && (
                  <button className="btn sm accent" disabled={pending} onClick={() => resolve(d.id, "kept_ours_pushed")}>
                    {d.field === "Row" ? "Add to sheet" : "Keep ours + fix sheet"}
                  </button>
                )}
                <button className="btn sm" disabled={pending} onClick={() => resolve(d.id, "accepted_sheet")}>
                  {d.field === "Row" && d.sheetValue === "(missing from sheet)" ? "Just acknowledge" : "Accept sheet"}
                </button>
              </div>
              {errors[d.id] && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{errors[d.id]}</div>}
            </div>
          ))}
        </div>
      ))}

      {showHistory && (
        <DataTable
          cols={[
            { key: "id", label: "System", width: "90px" },
            { key: "field", label: "Field", width: "minmax(110px, 1fr)" },
            { key: "how", label: "Resolved", width: "130px" },
            { key: "when", label: "When", width: "110px", align: "right" },
          ]}
          rows={history.map((d) => ({
            key: d.id,
            cells: {
              id: <Id>{d.externalId}</Id>,
              field: <span title={`Sheet: ${d.sheetValue}\nOurs: ${d.dbValue}`}>{d.field === "Row" ? "Row presence" : d.field}</span>,
              how: (
                <Pill tone={d.resolution === "auto_cleared" ? "neutral" : "good"}>
                  {RESOLUTION_LABEL[d.resolution] || "resolved"}
                </Pill>
              ),
              when: <span className="mut">{when(d.runAt)}</span>,
            },
          }))}
          empty="Nothing resolved yet"
        />
      )}
    </>
  );
}
