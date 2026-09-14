"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateSystems } from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import Dot from "@/components/ui/Dot";
import Id from "@/components/ui/Id";
import { toast } from "@/components/ui/Toast";
import type { Tone } from "@/lib/tones";

export type SystemRegistryRow = {
  id: number;
  externalId: string;
  /** What the system is, already worded by the page - its assets, or the model. */
  label: string;
  /** Whose it is - the owning organization's name, or the client text when nobody on the platform owns it. */
  owner: string;
  /** What kind of system it is - the shop's own grouping ("LC-MS", "GC"). */
  category: string;
  model: string;
  location: string;
  lead: string;
  /** Where the system stands - the dot's tone, and the word when it is not in the fleet. */
  stateTone: Tone;
  stateWord: string | null;
  /** The first stage the system sits in, coloured by the tenant's stage_defs. */
  stage: { name: string; bg: string; fg: string } | null;
  moreStages: number;
};

/** What the selection bar may set across the ticked systems. */
export type BulkOptions = {
  clients: string[];
  categories: string[];
  people: string[];
};

const COLUMNS = ["System", "ID", "Model", "Location", "Lead", "Stage"];

/**
 * The systems registry, in the asset registry's clothes: a real table grouped
 * by what the machines are - or, on request, by whose they are.
 *
 * Grouping rather than showing the column is the point - a registry is read
 * by going to the LC-MS section, and "LC-MS" repeated down a column carries no
 * information. The count in each heading is what tells you how many of a
 * kind are on the books. By type is the default because it is what the asset
 * registry does, and two lists read the same way should section the same
 * way; by owner is the toggle, and the page keeps the choice in the URL.
 * Within a group, systems keep the page's order, which is by ID. The owner
 * heading is lib/systemRegistry.systemOwnerName, not the free-text client: a
 * system LabZen owns with a blank label was heading a "(no client)" group
 * while its own page said LabZen.
 *
 * Checkboxes, as the asset registry has them, for the changes that are made
 * to a batch rather than to a system: the client the work is for, the type,
 * the lead, the archive. Twenty systems typed in one afternoon get their
 * category in one pick rather than twenty visits. Every change goes through
 * updateSystems, which runs each system through its own single-record action
 * - same check of who may edit it, same audit line. Ownership is deliberately
 * not here: it grants sight of the record, and that is decided one at a time.
 *
 * The dot carries the system's state and the page renders the Legend for it;
 * the row's one pill is its stage.
 */
export default function SystemRegistryList({ rows, empty, groupBy = "category", canSelect = false, options }: {
  rows: SystemRegistryRow[];
  /** What to say when there is nothing to show, worded by the page. */
  empty: React.ReactNode;
  /** What the section headings are: the system's type (default) or its owner. */
  groupBy?: "category" | "owner";
  /** Editors get the checkboxes; the action re-checks per system regardless. */
  canSelect?: boolean;
  options?: BulkOptions;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const by = new Map<string, SystemRegistryRow[]>();
  for (const r of rows) {
    const k = groupBy === "owner" ? r.owner || "(no owner)" : r.category || "(no type)";
    const list = by.get(k);
    if (list) list.push(r); else by.set(k, [r]);
  }
  const groups = [...by.entries()].sort(([a], [b]) => a.localeCompare(b));

  const toggle = (id: number) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const toggleGroup = (list: SystemRegistryRow[]) =>
    setPicked((cur) => {
      const next = new Set(cur);
      const all = list.every((r) => next.has(r.id));
      for (const r of list) { if (all) next.delete(r.id); else next.add(r.id); }
      return next;
    });
  const clear = () => setPicked(new Set());

  /** One change across the ticked systems, with the outcome said in full. */
  const apply = (patch: Parameters<typeof updateSystems>[1], said: string) => {
    const ids = [...picked];
    if (!ids.length) return;
    setError("");
    startTransition(async () => {
      const res = await updateSystems(ids, patch);
      if (res?.error) { setError(res.error); return; }
      const bad = res.failures ?? [];
      if (bad.length) {
        const name = (id: number) => rows.find((r) => r.id === id)?.externalId ?? `#${id}`;
        setError(`${res.done} changed, ${bad.length} not: ${bad.map((f) => `${name(f.id)} - ${f.error}`).join("; ")}`);
      } else {
        toast({ message: `${said} on ${res.done} system${res.done === 1 ? "" : "s"}` });
      }
      clear();
      router.refresh();
    });
  };

  // Selection column first, then the dot, then the six columns: the system's
  // name leads, the stage pill needs room for "Maintenance due", and the rest
  // share what is left.
  const tracks = `${canSelect ? "18px " : ""}12px minmax(160px, 1.6fr) 90px minmax(100px, 1fr) minmax(90px, 1fr) minmax(90px, 0.8fr) minmax(140px, 1fr)`;
  const pickerStyle = { width: "auto" } as const;

  return (
    <div className={`reg${canSelect ? " selectable" : ""}`} style={{ ["--reg-cols" as string]: tracks }}>
      {canSelect && picked.size > 0 && options && (
        <div style={{
          display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
          padding: "8px 12px", marginTop: 8, borderRadius: 8,
          background: "var(--t-info-bg)", border: "1px solid var(--line)",
        }}>
          <b className="t-body" style={{ color: "var(--t-info-fg)" }}>{picked.size} selected</b>
          <button className="btn sm" onClick={clear} disabled={pending}>Clear</button>
          {/* Each picker applies on choice, as the record's own pickers do.
              They read "Set ..." until chosen, so nothing looks preselected. */}
          <select value="" aria-label="Set the client" disabled={pending} className="t-small" style={pickerStyle}
            onChange={(e) => { if (e.target.value !== "") apply({ client: e.target.value === "-" ? "" : e.target.value }, e.target.value === "-" ? "Cleared the client" : `Set the client to ${e.target.value}`); }}>
            <option value="">Set client...</option>
            {options.clients.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value="-">(no client)</option>
          </select>
          <select value="" aria-label="Set the type" disabled={pending} className="t-small" style={pickerStyle}
            onChange={(e) => { if (e.target.value !== "") apply({ category: e.target.value === "-" ? "" : e.target.value }, e.target.value === "-" ? "Cleared the type" : `Set the type to ${e.target.value}`); }}>
            <option value="">Set type...</option>
            {options.categories.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value="-">(no type)</option>
          </select>
          <select value="" aria-label="Set the lead" disabled={pending} className="t-small" style={pickerStyle}
            onChange={(e) => { if (e.target.value !== "") apply({ lead: e.target.value === "-" ? "" : e.target.value }, e.target.value === "-" ? "Cleared the lead" : `Assigned ${e.target.value}`); }}>
            <option value="">Set lead...</option>
            {options.people.map((p) => <option key={p} value={p}>{p}</option>)}
            <option value="-">(unassigned)</option>
          </select>
          <button className="btn sm" style={{ marginLeft: "auto" }} disabled={pending}
            onClick={async () => {
              if (!(await confirmDialog({
                title: `Archive ${picked.size} system${picked.size === 1 ? "" : "s"}?`,
                body: "They keep all their history and can be restored any time. They leave the dashboard, EOD, and sheet parity.",
                action: `Archive ${picked.size}`,
              }))) return;
              apply({ archived: true }, "Archived");
            }}>
            {pending ? "Working..." : `Archive ${picked.size}`}
          </button>
        </div>
      )}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}

      {rows.length > 0 && (
        <div className="reg-head">
          {canSelect && <span />}
          <span />
          {COLUMNS.map((c) => <span key={c}>{c}</span>)}
        </div>
      )}

      {groups.map(([heading, list]) => {
        const allPicked = canSelect && list.every((r) => picked.has(r.id));
        return (
          <div key={heading}>
            <div className="reg-group">
              {canSelect && (
                <input type="checkbox" checked={allPicked} onChange={() => toggleGroup(list)} disabled={pending}
                  aria-label={`Select all ${list.length} under ${heading}`} style={{ flexShrink: 0 }} />
              )}
              <span className="reg-group-name">{heading}</span>
              <span className="reg-group-count">{list.length}</span>
            </div>

            {list.map((s, i) => {
              const on = picked.has(s.id);
              return (
                // The stripe is assigned here, not by nth-child: rows are siblings
                // of their group heading, so counting children would land it on
                // the wrong row. The whole row opens the system, as the asset rows
                // do - except the checkbox, which owns its click.
                <div key={s.id} className={`reg-row row-hover${i % 2 ? " alt" : ""}`}
                  style={on ? { background: "var(--t-info-bg)", cursor: "pointer" } : { cursor: "pointer" }}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("input, a, button")) return;
                    router.push(`/instruments/${s.id}`);
                  }}>
                  {canSelect && (
                    <input type="checkbox" checked={on} onChange={() => toggle(s.id)} disabled={pending}
                      aria-label={`Select ${s.externalId}`} />
                  )}
                  <span title={s.stateWord ?? "In the fleet"}><Dot tone={s.stateTone} /></span>
                  <span className="reg-cell">
                    <Link href={`/instruments/${s.id}`} className="t-body" style={{ fontWeight: 700, textDecoration: "none", color: "inherit" }}>
                      {s.label || <span className="mut">No assets listed</span>}
                    </Link>
                    {/* Text, not a second pill: the row's one pill is its stage. */}
                    {s.stateWord && (
                      <span className="t-meta" style={{ marginLeft: "var(--sp-1)", fontWeight: 700, color: `var(--t-${s.stateTone}-fg)` }}>
                        {s.stateWord}
                      </span>
                    )}
                  </span>
                  <span className="reg-cell"><Id dim>{s.externalId}</Id></span>
                  <span className="reg-cell mut t-small">{s.model || "-"}</span>
                  <span className="reg-cell mut t-small">{s.location || "-"}</span>
                  <span className="reg-cell mut t-small">{s.lead || "unassigned"}</span>
                  <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    {s.stage
                      ? <span className="pill" style={{ background: s.stage.bg, color: s.stage.fg }}>{s.stage.name}</span>
                      : <span className="mut t-small">-</span>}
                    {s.moreStages > 0 && <span className="mut t-meta">+{s.moreStages}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}

      {rows.length === 0 && (
        <div className="empty" style={{ marginTop: 8 }}>{empty}</div>
      )}
    </div>
  );
}
