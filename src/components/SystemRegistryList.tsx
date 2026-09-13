import Link from "next/link";
import Dot from "@/components/ui/Dot";
import Id from "@/components/ui/Id";
import type { Tone } from "@/lib/tones";

export type SystemRegistryRow = {
  id: number;
  externalId: string;
  /** What the system is, already worded by the page - its assets, or the model. */
  label: string;
  client: string;
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

const COLUMNS = ["System", "ID", "Model", "Location", "Lead", "Stage"];

/**
 * The systems registry, in the asset registry's clothes: a real table grouped
 * by whose the machines are.
 *
 * Grouping by client rather than showing a client column is the point - a
 * registry is read by going to the lab, and a client's name repeated down a
 * column carries no information. The count in each heading is what tells you
 * how many machines a client has on the books. Within a client, systems keep
 * the page's order, which is by ID.
 *
 * No checkboxes: deleting a system is not a bulk job, so there is nothing to
 * select. The dot carries the system's state and the page renders the Legend
 * for it; the row's one pill is its stage.
 */
export default function SystemRegistryList({ rows, empty }: {
  rows: SystemRegistryRow[];
  /** What to say when there is nothing to show, worded by the page. */
  empty: React.ReactNode;
}) {
  const by = new Map<string, SystemRegistryRow[]>();
  for (const r of rows) {
    const k = r.client || "(no client)";
    const list = by.get(k);
    if (list) list.push(r); else by.set(k, [r]);
  }
  const groups = [...by.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Dot, then the six columns: the system's name leads, the stage pill needs
  // room for "Maintenance due", and the rest share what is left.
  const tracks = "12px minmax(160px, 1.6fr) 90px minmax(100px, 1fr) minmax(90px, 1fr) minmax(90px, 0.8fr) minmax(140px, 1fr)";

  return (
    <div className="reg" style={{ ["--reg-cols" as string]: tracks }}>
      {rows.length > 0 && (
        <div className="reg-head">
          <span />
          {COLUMNS.map((c) => <span key={c}>{c}</span>)}
        </div>
      )}

      {groups.map(([client, list]) => (
        <div key={client}>
          <div className="reg-group">
            <span className="reg-group-name">{client}</span>
            <span className="reg-group-count">{list.length}</span>
          </div>

          {list.map((s, i) => (
            // The stripe is assigned here, not by nth-child: rows are siblings
            // of their group heading, so counting children would land it on
            // the wrong row. The whole row is the link, as the asset rows are.
            <Link key={s.id} href={`/instruments/${s.id}`}
              className={`reg-row row-hover${i % 2 ? " alt" : ""}`}
              style={{ textDecoration: "none", color: "inherit" }}>
              <span title={s.stateWord ?? "In the fleet"}><Dot tone={s.stateTone} /></span>
              <span className="reg-cell">
                <span className="t-body" style={{ fontWeight: 700 }}>
                  {s.label || <span className="mut">No assets listed</span>}
                </span>
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
            </Link>
          ))}
        </div>
      ))}

      {rows.length === 0 && (
        <div className="empty" style={{ marginTop: 8 }}>{empty}</div>
      )}
    </div>
  );
}
