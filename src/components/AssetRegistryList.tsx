"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { promptReason } from "@/lib/reason";
import { removeAssets } from "@/app/actions";
import { duplicateIds } from "@/lib/assetDupe";

export type RegistryRow = {
  id: number; kind: string; model: string; serial: string; owner: string; location: string;
  status: string; statusBg: string; statusFg: string;
  /** Where it lives, already worded by the page. */
  whereLabel: string;
  /** The owning system's external id, lowercased - "" on the shelf. Match key. */
  systemKey: string;
};

/**
 * The asset registry, with selection. Selecting is staff-only because deleting
 * is: the checkboxes simply aren't rendered for anyone else, and removeAssets
 * re-checks regardless.
 *
 * "Select duplicates" is the cleanup tool for an import that ran before the
 * importer knew how to skip. It keeps the oldest of each matching group - that's
 * the record with the service history hanging off it - and ticks the rest.
 */
export default function AssetRegistryList({ rows, canSelect }: {
  rows: RegistryRow[];
  canSelect: boolean;
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const dupes = useMemo(() => duplicateIds(rows), [rows]);
  const visibleDupes = useMemo(() => {
    const shown = new Set(rows.map((r) => r.id));
    return dupes.filter((id) => shown.has(id));
  }, [dupes, rows]);

  const toggle = (id: number) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const clear = () => setPicked(new Set());

  const remove = () => {
    const ids = [...picked];
    if (!ids.length) return;
    const why = promptReason(
      `Delete ${ids.length} asset record${ids.length === 1 ? "" : "s"}? Their history goes with them. This can't be undone.`,
    );
    if (!why) return;
    setError("");
    startTransition(async () => {
      const res = await removeAssets(ids, why);
      if (res?.error) { setError(res.error); return; }
      if (res.failures?.length) {
        setError(`${res.deleted} deleted, ${res.failures.length} could not be: ${res.failures.map((f) => `#${f.id} ${f.error}`).join("; ")}`);
      }
      clear();
    });
  };

  return (
    <>
      {canSelect && (visibleDupes.length > 0 || picked.size > 0) && (
        <div style={{
          display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
          padding: "8px 10px", marginTop: 8, borderRadius: 8,
          background: picked.size ? "#FDECEC" : "#FAF0DC",
          border: `1px solid ${picked.size ? "#F0BDBD" : "#F0C9A0"}`,
        }}>
          {picked.size > 0 ? (
            <>
              <b style={{ fontSize: 13, color: "#A32D2D" }}>{picked.size} selected</b>
              <button className="btn sm" onClick={clear} disabled={pending}>Clear</button>
              <button className="btn sm accent" style={{ marginLeft: "auto", background: "#A32D2D", borderColor: "#A32D2D" }}
                onClick={remove} disabled={pending}>
                {pending ? "Deleting..." : `Delete ${picked.size}`}
              </button>
            </>
          ) : (
            <>
              <span style={{ fontSize: 13, color: "#8A5410" }}>
                <b>{visibleDupes.length}</b> row{visibleDupes.length === 1 ? " looks" : "s look"} like duplicate
                {visibleDupes.length === 1 ? "" : "s"} of another.
              </span>
              <button className="btn sm" style={{ marginLeft: "auto" }}
                onClick={() => setPicked(new Set(visibleDupes))}>
                Select the {visibleDupes.length} duplicate{visibleDupes.length === 1 ? "" : "s"}
              </button>
            </>
          )}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}

      {rows.map((a) => {
        const on = picked.has(a.id);
        const isDupe = visibleDupes.includes(a.id);
        return (
          <div key={a.id} className="row-hover"
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "9px 4px",
              borderTop: "1px solid var(--line)", flexWrap: "wrap",
              background: on ? "#FDF4F4" : undefined,
            }}>
            {canSelect && (
              <input type="checkbox" checked={on} onChange={() => toggle(a.id)} disabled={pending}
                aria-label={`Select ${a.kind} ${a.model}${a.serial ? ` SN ${a.serial}` : ""}`}
                style={{ width: 15, height: 15, flexShrink: 0 }} />
            )}
            <Link href={`/assets/${a.id}`}
              style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}>
              <span title={a.status} style={{ width: 10, height: 10, borderRadius: "50%", background: a.statusFg, flexShrink: 0 }} />
              <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>{a.kind}</span>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{a.model || <span className="mut">(no model)</span>}</span>
              {a.serial && <span className="mono mut" style={{ fontSize: 12 }}>SN {a.serial}</span>}
              {a.owner && <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>{a.owner}</span>}
              {isDupe && (
                <span className="pill" style={{ background: "#FAF0DC", color: "#8A5410" }}
                  title="Matches an earlier row: same serial, or same type/model/owner/location on the same system">
                  possible duplicate
                </span>
              )}
              <span className="mut" style={{ fontSize: 12, marginLeft: "auto" }}>{a.whereLabel}</span>
              <span className="pill" style={{ background: a.statusBg, color: a.statusFg }}>{a.status}</span>
            </Link>
          </div>
        );
      })}
      {rows.length === 0 && <div className="mut" style={{ fontSize: 13, marginTop: 8 }}>No assets match.</div>}
    </>
  );
}
