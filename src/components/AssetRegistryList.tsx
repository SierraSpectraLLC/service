"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { promptReason } from "@/lib/reason";
import { removeAssets } from "@/app/actions";
import { duplicateIds } from "@/lib/assetDupe";
import Dot from "@/components/ui/Dot";
import { toast } from "@/components/ui/Toast";
import type { Tone } from "@/lib/tones";

export type RegistryRow = {
  id: number; kind: string; model: string; serial: string; manufacturer: string;
  owner: string; location: string;
  status: string; statusTone: Tone;
  /** Where it lives, already worded by the page. */
  whereLabel: string;
  /** The owning system's external id, lowercased - "" on the shelf. Match key. */
  systemKey: string;
};

const COLUMNS = ["Model", "Serial", "Manufacturer", "Owner", "Where", "Status"];

/**
 * The asset registry: a real table, grouped by what each unit IS.
 *
 * Grouping by type rather than showing a type column is the point - a registry
 * is read by going to the pumps, and a "Pump" chip repeated forty times down a
 * column carries no information. The count in each heading is what tells you
 * how deep the shelf is.
 *
 * Selecting is staff-only because deleting is: the checkboxes aren't rendered
 * for anyone else, and removeAssets re-checks regardless.
 *
 * "Select duplicates" is the cleanup tool for an import that ran before the
 * importer knew how to skip. It keeps the oldest of each matching group - the
 * record with the service history hanging off it - and ticks the rest.
 */
export default function AssetRegistryList({ rows, canSelect }: {
  rows: RegistryRow[];
  canSelect: boolean;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const dupes = useMemo(() => duplicateIds(rows), [rows]);
  const visibleDupes = useMemo(() => {
    const shown = new Set(rows.map((r) => r.id));
    return dupes.filter((id) => shown.has(id));
  }, [dupes, rows]);

  // One section per type, alphabetical, and within a section by model then
  // serial so identical units sit next to each other where a duplicate is
  // obvious to the eye as well as to duplicateIds.
  const groups = useMemo(() => {
    const by = new Map<string, RegistryRow[]>();
    for (const r of rows) {
      const k = r.kind || "(no type)";
      const list = by.get(k);
      if (list) list.push(r); else by.set(k, [r]);
    }
    return [...by.entries()]
      .map(([kind, list]) => ({
        kind,
        list: [...list].sort((a, b) => a.model.localeCompare(b.model) || a.serial.localeCompare(b.serial)),
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
  }, [rows]);

  const toggle = (id: number) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const toggleGroup = (list: RegistryRow[]) =>
    setPicked((cur) => {
      const next = new Set(cur);
      const all = list.every((r) => next.has(r.id));
      for (const r of list) { if (all) next.delete(r.id); else next.add(r.id); }
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
      } else {
        toast({ message: `Deleted ${res.deleted} asset record${res.deleted === 1 ? "" : "s"}` });
      }
      clear();
    });
  };

  const mut = { fontSize: 12, color: "var(--mut)" } as const;

  return (
    <div className={`reg${canSelect ? " selectable" : ""}`}>
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

      {rows.length > 0 && (
        <div className="reg-head">
          {canSelect && <span />}
          <span />
          {COLUMNS.map((c) => <span key={c}>{c}</span>)}
        </div>
      )}

      {groups.map(({ kind, list }) => {
        const allPicked = canSelect && list.every((r) => picked.has(r.id));
        return (
          <div key={kind}>
            <div className="reg-group">
              {canSelect && (
                <input type="checkbox" checked={allPicked} onChange={() => toggleGroup(list)} disabled={pending}
                  aria-label={`Select all ${list.length} ${kind}`}
                  style={{ width: 15, height: 15, flexShrink: 0 }} />
              )}
              <span className="reg-group-name">{kind}</span>
              <span className="reg-group-count">{list.length}</span>
            </div>

            {list.map((a, i) => {
              const on = picked.has(a.id);
              const isDupe = visibleDupes.includes(a.id);
              return (
                // The stripe is assigned here, not by nth-child: rows are
                // siblings of their group heading, so counting children would
                // land it on the wrong row. Selection beats both stripe and
                // hover, which is the right precedence.
                <div key={a.id} className={`reg-row row-hover${i % 2 ? " alt" : ""}`}
                  style={on ? { background: "#FDF4F4" } : undefined}
                  // The row is a div now (it holds a checkbox), but it still
                  // hover-highlights, so it has to actually be clickable -
                  // except on the controls inside it, which own their clicks.
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("input, a, button")) return;
                    router.push(`/assets/${a.id}`);
                  }}>
                  {canSelect && (
                    <input type="checkbox" checked={on} onChange={() => toggle(a.id)} disabled={pending}
                      aria-label={`Select ${a.kind} ${a.model}${a.serial ? ` SN ${a.serial}` : ""}`}
                      style={{ width: 15, height: 15 }} />
                  )}
                  <span title={a.status}><Dot tone={a.statusTone} /></span>
                  <span className="reg-cell">
                    <Link href={`/assets/${a.id}`} style={{ fontSize: 13, fontWeight: 700, textDecoration: "none", color: "inherit" }}>
                      {a.model || <span className="mut">(no model)</span>}
                    </Link>
                    {/* Text, not a second pill: the row's one pill is its status. */}
                    {isDupe && (
                      <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: "var(--t-warn-fg)" }}
                        title="Matches an earlier row: same serial, or same type/model/owner/location on the same system">
                        dupe?
                      </span>
                    )}
                  </span>
                  <span className="reg-cell mono" style={mut}>{a.serial || "—"}</span>
                  <span className="reg-cell" style={mut}>{a.manufacturer || "—"}</span>
                  <span className="reg-cell" style={mut}>{a.owner || "—"}</span>
                  <span className="reg-cell" style={mut}>{a.whereLabel}</span>
                  <span>
                    <span className={`pill ${a.statusTone}`}>{a.status}</span>
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
      {rows.length === 0 && (
        <div className="empty" style={{ marginTop: 8 }}>
          <b>No assets match</b>
          Adjust the filters above, or add the first unit with “+ New asset”.
        </div>
      )}
    </div>
  );
}
