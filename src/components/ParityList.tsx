"use client";

import { useState, useTransition } from "react";
import { resolveDiff } from "@/app/actions";

type Diff = {
  id: number; externalId: string; field: string; sheetValue: string; dbValue: string;
  resolved: boolean; resolution: string; runAt: string;
};

const RESOLUTION_LABEL: Record<string, string> = {
  kept_ours: "Resolved - kept ours",
  accepted_sheet: "Resolved - accepted sheet",
  kept_ours_pushed: "Resolved - sheet updated",
  auto_cleared: "Cleared - no longer differs",
};

export default function ParityList({ diffs }: { diffs: Diff[] }) {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<number, string>>({});

  const resolve = (id: number, resolution: "kept_ours" | "accepted_sheet" | "kept_ours_pushed") =>
    startTransition(async () => {
      setErrors((e) => ({ ...e, [id]: "" }));
      const res = await resolveDiff(id, resolution);
      if (res?.error) setErrors((e) => ({ ...e, [id]: res.error! }));
    });

  if (!diffs.length) return <div className="mut" style={{ fontSize: 13 }}>No diffs recorded yet. The cron job runs hourly, or hit the endpoint manually to test.</div>;
  return (
    <>
      {diffs.map((d) => (
        <div key={d.id} className="card" style={{ borderColor: d.resolved ? "var(--line)" : "#F0C9A0", opacity: d.resolved ? 0.6 : 1, padding: 14 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="mono" style={{ fontWeight: 700, fontSize: 12, color: "var(--navy)" }}>{d.externalId}</span>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{d.field}</span>
            {d.resolved
              ? <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>{RESOLUTION_LABEL[d.resolution] || "Resolved"}</span>
              : <span className="pill" style={{ background: "#FAF0DC", color: "#8A5410" }}>Open</span>}
            <span className="mut" style={{ fontSize: 11, marginLeft: "auto" }}>{new Date(d.runAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 8, marginTop: 10 }}>
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px" }}>
              <div className="eyebrow">Their sheet</div>
              <div style={{ fontSize: 13 }}>{d.sheetValue}</div>
            </div>
            <div style={{ border: "1px solid var(--sky)", borderRadius: 8, padding: "8px 10px", background: "#F4FAFE" }}>
              <div className="eyebrow" style={{ color: "#1D6396" }}>Our record</div>
              <div style={{ fontSize: 13 }}>{d.dbValue}</div>
            </div>
          </div>
          {!d.resolved && (
            <>
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <button className="btn sm primary" disabled={pending} onClick={() => resolve(d.id, "kept_ours")}>Keep ours</button>
                {d.field !== "Row" && (
                  <button className="btn sm accent" disabled={pending} onClick={() => resolve(d.id, "kept_ours_pushed")}>
                    Keep ours + fix sheet
                  </button>
                )}
                <button className="btn sm" disabled={pending} onClick={() => resolve(d.id, "accepted_sheet")}>Accept sheet</button>
              </div>
              {errors[d.id] && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{errors[d.id]}</div>}
            </>
          )}
        </div>
      ))}
    </>
  );
}
