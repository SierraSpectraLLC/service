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

/**
 * What the bar is holding, before Apply runs it.
 *
 * A field that is absent is left alone; a field present and empty CLEARS it
 * ("(no type)"). The two are different instructions and a single string could
 * not tell them apart, which is why the pickers stage into this rather than
 * into their own values.
 */
export type BulkDraft = {
  client?: string;
  category?: string;
  lead?: string;
  ownerOrgId?: number | null;
};

/** What the selection bar may set across the ticked systems. */
export type BulkOptions = {
  clients: string[];
  categories: string[];
  people: string[];
  /** Organizations a batch may be handed to. Empty hides the owner picker. */
  owners: { id: number; name: string; kind: string }[];
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
 * the lead, the owner, the archive. Twenty systems typed in one afternoon get
 * their category in one pick rather than twenty visits. Every change goes
 * through updateSystems, which runs each system through its own single-record
 * action - same check of who may edit it, same audit line.
 *
 * Nothing runs until Apply. The pickers STAGE - set the type and the lead and
 * the client, read the sentence the bar builds back, then commit - because a
 * picker that fires on choice makes three round trips out of one intention and
 * gives no moment to notice that the wrong four rows are ticked. One Apply is
 * one call, so a system gets one visit rather than three.
 *
 * Owner asks twice. Every other field here changes what a record SAYS and is
 * undone by setting it again; ownership changes who can OPEN it, and thirty-six
 * systems handed to the wrong organization is thirty-six records read by
 * people who should not have seen them. So when ownership is among the staged
 * changes, Apply names the organization, the count, and the consequence in
 * those words before anything runs.
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
  const [draft, setDraft] = useState<BulkDraft>({});
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
  const clear = () => { setPicked(new Set()); setDraft({}); setError(""); };

  /** One call across the ticked systems, with the outcome said in full. */
  const run = (patch: BulkDraft & { archived?: boolean }, did: string) => {
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
        toast({ message: `${did} on ${res.done} system${res.done === 1 ? "" : "s"}` });
      }
      clear();
      router.refresh();
    });
  };

  /**
   * A picker's choice, staged. "" is the picker's own "leave it alone"; "-" is
   * the explicit clear, which stages the empty value rather than nothing.
   */
  const stage = (key: "client" | "category" | "lead", raw: string) =>
    setDraft((d) => {
      const next = { ...d };
      if (raw === "") delete next[key]; else next[key] = raw === "-" ? "" : raw;
      return next;
    });
  const stageOwner = (raw: string) =>
    setDraft((d) => {
      const next = { ...d };
      if (raw === "") delete next.ownerOrgId;
      else next.ownerOrgId = raw === "-" ? null : parseInt(raw, 10);
      return next;
    });
  /** What a picker shows: "-" for a staged clear, the value, else nothing. */
  const shown = (v: string | undefined) => (v === undefined ? "" : v === "" ? "-" : v);
  const ownerShown = draft.ownerOrgId === undefined ? "" : draft.ownerOrgId === null ? "-" : String(draft.ownerOrgId);
  const staged = Object.keys(draft).length > 0;
  const ownerName = (id: number) => options?.owners.find((o) => o.id === id)?.name ?? "the organization";

  /** The staged changes as a phrase, for the button, the toast and the log. */
  const said = (() => {
    const parts: string[] = [];
    if (draft.client !== undefined) parts.push(draft.client ? `client ${draft.client}` : "no client");
    if (draft.category !== undefined) parts.push(draft.category ? `type ${draft.category}` : "no type");
    if (draft.lead !== undefined) parts.push(draft.lead ? `lead ${draft.lead}` : "no lead");
    if (draft.ownerOrgId !== undefined) {
      parts.push(draft.ownerOrgId === null ? "house-stewarded" : `owner ${ownerName(draft.ownerOrgId)}`);
    }
    return parts.join(", ");
  })();

  const apply = async () => {
    if (!staged) return;
    const n = picked.size;
    const many = `${n} system${n === 1 ? "" : "s"}`;
    // The one field that changes who can OPEN a record asks again, naming what
    // it means - and it asks here, at the commit, where the count is final.
    if (draft.ownerOrgId !== undefined) {
      const name = draft.ownerOrgId === null ? null : ownerName(draft.ownerOrgId);
      if (!(await confirmDialog({
        title: name ? `Make ${name} the owner of ${many}?` : `Return ${many} to house stewardship?`,
        body: name
          ? `${name} will be able to open all ${n} - the record, its history and its files - and their editors decide who else gets access. Where a system's client label was naming the previous owner it follows to ${name}; a label somebody set by hand stays as it is. Each change is on the record's audit trail.`
          : `Ownership goes back to the house. The organizations that hold a share keep it - this changes who OWNS the ${many}, not who has been given access.`,
        action: name ? `Hand over ${many}` : `Return ${many}`,
      }))) return;
    }
    run(draft, `Set ${said}`);
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
          {/* Each picker holds its choice until Apply. They read "Set ..."
              while unset, so nothing looks staged that is not. */}
          <select value={shown(draft.client)} aria-label="Set the client" disabled={pending}
            className="t-small" style={pickerStyle} onChange={(e) => stage("client", e.target.value)}>
            <option value="">Set client...</option>
            {options.clients.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value="-">(no client)</option>
          </select>
          <select value={shown(draft.category)} aria-label="Set the type" disabled={pending}
            className="t-small" style={pickerStyle} onChange={(e) => stage("category", e.target.value)}>
            <option value="">Set type...</option>
            {options.categories.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value="-">(no type)</option>
          </select>
          <select value={shown(draft.lead)} aria-label="Set the lead" disabled={pending}
            className="t-small" style={pickerStyle} onChange={(e) => stage("lead", e.target.value)}>
            <option value="">Set lead...</option>
            {options.people.map((p) => <option key={p} value={p}>{p}</option>)}
            <option value="-">(unassigned)</option>
          </select>
          {options.owners.length > 0 && (
            <select value={ownerShown} aria-label="Set the owner" disabled={pending}
              className="t-small" style={pickerStyle} onChange={(e) => stageOwner(e.target.value)}>
              <option value="">Set owner...</option>
              {options.owners.map((o) => (
                <option key={o.id} value={o.id}>{o.name}{o.kind === "provider" ? " (provider)" : ""}</option>
              ))}
              <option value="-">(house-stewarded)</option>
            </select>
          )}
          <button className="btn sm accent" onClick={apply} disabled={pending || !staged}>
            {pending ? "Applying..." : `Apply to ${picked.size}`}
          </button>
          {/* Archiving is not one of the staged fields: it is the one change
              here that takes the systems off the working boards, so it keeps
              its own button and its own confirm rather than hiding inside a
              picker somebody set three changes ago. */}
          <button className="btn sm" style={{ marginLeft: "auto" }} disabled={pending}
            onClick={async () => {
              if (!(await confirmDialog({
                title: `Archive ${picked.size} system${picked.size === 1 ? "" : "s"}?`,
                body: "They keep all their history and can be restored any time. They leave the dashboard, EOD, and sheet parity.",
                action: `Archive ${picked.size}`,
              }))) return;
              run({ archived: true }, "Archived");
            }}>
            Archive {picked.size}
          </button>
          {/* The staged changes read back as a sentence, so Apply is pressed
              on something somebody has seen rather than remembered. */}
          {staged && (
            <div className="t-meta" style={{ flexBasis: "100%", color: "var(--t-info-fg)" }}>
              Apply will set {said} on {picked.size} system{picked.size === 1 ? "" : "s"}.
            </div>
          )}
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
