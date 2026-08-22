"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setCatalogGases } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import { GASES, GAS_SYMBOL } from "@/lib/stages";

export type GasEntry = {
  id: number;
  kind: string;        // 'category' | 'asset_type' | 'model'
  assetType: string;
  name: string;
  gases: string[];
};

const SECTIONS: { kind: string; title: string; blurb: string }[] = [
  { kind: "model", title: "Models", blurb: "An Altis needs nitrogen and argon wherever it lands - say it here once." },
  { kind: "asset_type", title: "Module types", blurb: "True of every unit of the type, whatever the model." },
  { kind: "category", title: "System types", blurb: "What the system itself needs plumbed, beyond its modules." },
];

/**
 * Which gases each kind of equipment needs.
 *
 * Adding a system used to mean typing its gases out again every time, and the
 * one nobody remembered to add is the one nobody notices is missing. Declared
 * here, the requirement lands on every system and unit that matches as it is
 * created - as "Not connected", because the catalog knows what is NEEDED and
 * cannot know what somebody has hooked up. That is the status the dashboard
 * already flags, so a new arrival shows a real to-do instead of a green tick
 * nobody earned.
 *
 * Existing records are never rewritten: a gas status set on the floor outranks
 * a default from a list.
 */
export default function CatalogGasCard({ entries }: { entries: GasEntry[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const toggle = (e: GasEntry, gas: string) => {
    const next = e.gases.some((g) => g.toLowerCase() === gas.toLowerCase())
      ? e.gases.filter((g) => g.toLowerCase() !== gas.toLowerCase())
      : [...e.gases, gas];
    setError("");
    startTransition(async () => {
      const res = await setCatalogGases(e.id, next);
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Saved the gas list for ${e.name}` });
      router.refresh();
    });
  };

  const declared = entries.filter((e) => e.gases.length);

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div className="card-title">Gas requirements</div>
        <span className="mut t-meta">
          {declared.length ? `${declared.length} declared` : "none declared yet"}
        </span>
        <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setOpen((v) => !v)}>
          {open ? "Done" : "Edit"}
        </button>
      </div>
      <div className="mut t-small" style={{ marginBottom: 8 }}>
        What each kind of equipment needs plumbed in. A system or unit created from now on gets
        these automatically, as <b>Not connected</b> until somebody hooks it up - so nothing has to
        be typed twice and nothing is quietly assumed to be connected.
      </div>

      {/* Closed: just what has been said, which is the useful summary. */}
      {!open && (
        declared.length === 0 ? (
          <div className="empty">
            <b>Nothing declared yet</b>
            Hit Edit and say what an Altis (or any LC-MS) needs - it stops being retyped on every
            system after that.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {declared.map((e) => (
              <div key={e.id} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
                <span className="t-body" style={{ fontWeight: 600 }}>{e.name}</span>
                <span className="mut t-meta">
                  {e.kind === "model" ? e.assetType : e.kind === "asset_type" ? "module type" : "system type"}
                </span>
                <span style={{ display: "flex", gap: 4, marginLeft: "auto", flexWrap: "wrap" }}>
                  {e.gases.map((g) => (
                    <span key={g} className="pill info">
                      {GAS_SYMBOL[g] ?? g}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )
      )}

      {/* Open: a filter, because the catalog is dozens of entries long and the
          one you came to set is a single row in it. Sections stay shut until
          asked for - a wall of every model with five buttons each is not a
          list anybody reads. */}
      {open && (
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by name - Altis, Mass Spec, LC-MS..." style={{ marginBottom: 4 }} />
      )}

      {open && SECTIONS.map((sec) => {
        const all = entries.filter((e) => e.kind === sec.kind);
        const rows = q.trim()
          ? all.filter((e) => `${e.name} ${e.assetType}`.toLowerCase().includes(q.trim().toLowerCase()))
          : all;
        // A filter that leaves a section empty should remove it, not leave three
        // headings explaining what isn't there.
        if (!all.length || (q.trim() && !rows.length)) return null;
        const set = all.filter((e) => e.gases.length).length;
        return (
          <details key={sec.kind} open={!!q.trim() || undefined} style={{ marginTop: 10 }}>
            <summary style={{ cursor: "pointer", display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span className="eyebrow">{sec.title}</span>
              <span className="mut t-meta">
                {q.trim() ? `${rows.length} of ${all.length}` : `${all.length}`}
                {set > 0 && ` · ${set} declared`}
              </span>
            </summary>
            <div className="mut t-meta" style={{ margin: "4px 0" }}>{sec.blurb}</div>
            {rows.length === 0 && <div className="mut t-small" style={{ padding: "4px 0" }}>Nothing matches.</div>}
            {rows.map((e) => (
              <div key={e.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                <span className="t-body" style={{ minWidth: 0, flex: "1 1 150px" }}>
                  {e.name}
                  {e.kind === "model" && e.assetType && <span className="mut t-meta"> · {e.assetType}</span>}
                </span>
                <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {GASES.map((g) => {
                    const on = e.gases.some((x) => x.toLowerCase() === g.toLowerCase());
                    return (
                      <button key={g} type="button" disabled={pending}
                        className={on ? "btn sm primary" : "btn sm"} style={{ fontSize: 11 }}
                        aria-pressed={on} onClick={() => toggle(e, g)}>
                        {GAS_SYMBOL[g] ?? g}
                      </button>
                    );
                  })}
                </span>
              </div>
            ))}
          </details>
        );
      })}

      {error &&<div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
