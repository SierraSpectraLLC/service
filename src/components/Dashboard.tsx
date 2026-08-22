"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import PickOrAdd from "./PickOrAdd";
import CatalogSelect from "./CatalogSelect";
import { createInstrument } from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { matchesQuery } from "@/lib/search";

type StageDefLite = { name: string; bg: string; fg: string };

type Row = {
  id: number; externalId: string; client: string; category: string; label: string; priority: number; lead: string;
  stages: string[]; notes: string; openParts: number; gasIssues: string[];
  /** Expired / expiring dated documents - regulated (GxP) systems only. */
  docIssues: string[];
  overdue: number; assetIssues: string[]; missingFromSheet: boolean; lastActivity: string;
  /** One string per module: type, maker, model, serial. Searchable, not shown. */
  assetText: string[];
  /** An open Down work order, or a unit on it marked Down. Reads red, sorts first. */
  down: boolean;
  /** Mine: I lead it, or work on it is assigned to me. `mineNote` says which. */
  mine: boolean;
  mineNote: string;
  // Whose move it is. Parked rows stay on the board but read as somebody
  // else's, and "Ours to move" filters them away.
  queueMine: boolean; queueWith: string; queueReason: string;
};

const Pill = ({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) => (
  <span className="pill" style={{ background: bg, color: fg }}>{children}</span>
);

export default function Dashboard({ data, stageDefs, people, clients, categories, canEdit, isStaff, showShipping, myQueueHref = "/work" }: {
  data: Row[]; stageDefs: StageDefLite[]; people: string[];
  clients: string[]; categories: string[]; canEdit: boolean; isStaff: boolean;
  /** Ship-pipeline tile: the shop and reseller accounts; clutter for lab clients. */
  showShipping: boolean;
  myQueueHref?: string;
}) {
  const router = useRouter();
  const stageNames = stageDefs.map((d) => d.name);
  const stageColor = (name: string) => stageDefs.find((d) => d.name === name) ?? { bg: "#EEF1F5", fg: "#475569" };
  const [selected, setSelected] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sortBy, setSortBy] = useState<"default" | "owner" | "id">("default");
  const [showNew, setShowNew] = useState(false);
  const [draft, setDraft] = useState({ externalId: "", client: "", category: "", priority: "", lead: "" });
  const [pending, startTransition] = useTransition();

  // "Docs expiring" appears only when some visible system could raise it -
  // a fleet with no regulated systems never sees the filter at all.
  const FLAGS = [...(data.some((i) => i.mine) ? ["Mine"] : []), "Down / urgent", "Ours to move", "With someone else", "Overdue tasks", "Awaiting parts", "Gas attention", "Asset attention",
    ...(data.some((i) => i.docIssues.length > 0) ? ["Docs expiring"] : []),
    ...(isStaff ? ["Not on sheet"] : [])];
  const LEADS = [...new Set(data.map((i) => i.lead).filter(Boolean))].sort();
  const CATS = [...new Set(data.map((i) => i.category).filter(Boolean))].sort();
  const catKey = (c: string) => `cat:${c}`;
  const leadKey = (l: string) => `lead:${l}`;
  /**
   * Flags cycle: off -> include -> EXCLUDE -> off, an exclusion stored as
   * "!Flag". One mechanism rather than a second list of "Not ..." flags, which
   * would double the menu and still miss whichever combination somebody wanted
   * - "hide what's in somebody else's queue" and "hide what isn't mine" are the
   * same control read twice.
   */
  const toggleFilter = (f: string) =>
    setSelected((s) => (
      s.includes(f) ? s.map((x) => (x === f ? `!${f}` : x))
      : s.includes(`!${f}`) ? s.filter((x) => x !== `!${f}`)
      : [...s, f]));
  /** "" | "in" | "out" - what state a flag is currently in. */
  const flagState = (f: string) => (selected.includes(f) ? "in" : selected.includes(`!${f}`) ? "out" : "");

  const matchesFlag = (i: Row, f: string) =>
    f === "Mine" ? i.mine
    : f === "Down / urgent" ? i.down
    : f === "Ours to move" ? i.queueMine
    : f === "With someone else" ? !i.queueMine
    : f === "Overdue tasks" ? i.overdue > 0
    : f === "Awaiting parts" ? i.openParts > 0
    : f === "Gas attention" ? i.gasIssues.length > 0
    : f === "Docs expiring" ? i.docIssues.length > 0
    : f === "Asset attention" ? i.assetIssues.length > 0
    : f === "Not on sheet" ? i.missingFromSheet
    : true;

  const filtered = useMemo(() => {
    let list = data;
    // Stages and leads each combine as OR within their group; flags combine as AND.
    const stageSel = selected.filter((f) => stageNames.includes(f));
    const leadSel = selected.filter((f) => f.startsWith("lead:")).map((f) => f.slice(5));
    const catSel = selected.filter((f) => f.startsWith("cat:")).map((f) => f.slice(4));
    const flagSel = selected.filter((f) => !stageNames.includes(f) && !f.startsWith("lead:") && !f.startsWith("cat:"));
    if (stageSel.length) list = list.filter((i) => stageSel.some((s) => i.stages.includes(s)));
    if (leadSel.length) list = list.filter((i) => leadSel.includes(i.lead));
    if (catSel.length) list = list.filter((i) => catSel.includes(i.category));
    for (const f of flagSel) {
      const no = f.startsWith("!");
      const key = no ? f.slice(1) : f;
      list = list.filter((i) => matchesFlag(i, key) !== no);
    }
    // lib/search decides what a match is, here and everywhere else: every term
    // must land somewhere, punctuation optional, and never across the seam
    // between two fields.
    if (q.trim()) {
      list = list.filter((i) => matchesQuery(q, [
        i.externalId, i.client, i.category, i.label, i.lead, i.notes,
        ...i.stages, ...i.gasIssues, ...i.assetIssues, ...i.docIssues,
        ...i.assetText,
        i.missingFromSheet ? "not on sheet" : "", i.lastActivity,
        i.queueMine ? "" : `with ${i.queueWith}`, i.queueReason,
      ]));
    }
    // An explicit sort is obeyed exactly: a person who asked to group by owner
    // does not want one row yanked out of its group for being urgent - it is
    // still red, and there is a Down filter for that. The DEFAULT is the one
    // that editorialises: worst first, then parked systems sink, because they
    // are not nothing but they are not this week's work either. Stable, so the
    // shop's own priority order survives inside every group.
    const by = (f: (r: Row) => string) => (a: Row, b: Row) => f(a).localeCompare(f(b));
    if (sortBy === "owner") return [...list].sort(by((r) => `${r.client || "~"}|`.toLowerCase()));
    if (sortBy === "id") return [...list].sort(by((r) => r.externalId.toLowerCase()));
    return [...list].sort((a, b) =>
      Number(b.down) - Number(a.down) || Number(b.queueMine) - Number(a.queueMine));
  }, [data, selected, q, sortBy]);

  // Worst first, then most overdue, then the shop's own priority - the order
  // somebody would actually work them.
  const MINE_SHOWN = 6;
  const mine = useMemo(() => data.filter((i) => i.mine).sort((a, b) =>
    Number(b.down) - Number(a.down) || b.overdue - a.overdue || a.priority - b.priority), [data]);

  const counts = {
    total: data.length,
    down: data.filter((i) => i.down).length,
    blocked: data.filter((i) => i.stages.includes("Waiting / blocked")).length,
    waiting: data.filter((i) => i.openParts > 0).length,
    gas: data.filter((i) => i.gasIssues.length > 0).length,
    shipped: data.filter((i) => i.stages.includes("Shipped") || i.stages.includes("Waiting to ship")).length,
    parked: data.filter((i) => !i.queueMine).length,
  };

  const submitNew = () => {
    if (!draft.externalId.trim()) return;
    startTransition(async () => {
      const id = await createInstrument({
        externalId: draft.externalId, client: draft.client, category: draft.category,
        priority: parseInt(draft.priority) || 99, lead: draft.lead,
      });
      setShowNew(false);
      setDraft({ externalId: "", client: "", category: "", priority: "", lead: "" });
      router.push(`/instruments/${id}`);
    });
  };

  return (
    <div className="container">
      <div className="metric-grid" style={{ marginBottom: 14 }}>
        {([
          ["Total systems", counts.total, "var(--navy)"],
          // The one number that overrides every other on this screen.
          ["Down", counts.down, "#A32D2D"],
          // Reads as "how much of the board isn't ours to move" - the number
          // this whole axis exists to make visible.
          ["With someone else", counts.parked, "#8A5410"],
          ["Waiting / blocked", counts.blocked, "#A32D2D"],
          ["Awaiting parts", counts.waiting, "#8A5410"],
          ["Gas attention", counts.gas, "#A33A1A"],
          ...(showShipping ? [["Ship queue + shipped", counts.shipped, "#085041"]] : []),
        ] as [string, number, string][]).map(([label, n, color]) => (
          <div key={label} className="card" style={{ padding: "12px 14px", marginBottom: 0 }}>
            <div style={{ fontSize: 12 }} className="mut">{label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color }}>{n}</div>
          </div>
        ))}
      </div>

      {/* The instruments that are MINE, without hiding the fleet: a card, not a
          tab - the shared picture stays on screen. Systems rather than tickets,
          because a day is planned by which machines you are touching, and the
          system page is where the job, the tasks and the history already are.
          A capped preview; "all N" is the same set as the Mine filter. */}
      {mine.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
            <div className="card-title">My systems</div>
            <span className="mut" style={{ fontSize: 11 }}>{mine.length}</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
              {mine.length > MINE_SHOWN && (
                <button className="btn link" style={{ fontSize: 11 }}
                  onClick={() => setSelected((s) => (s.includes("Mine") ? s : [...s, "Mine"]))}>
                  all {mine.length} on the board →
                </button>
              )}
              <Link href={myQueueHref} className="btn link" style={{ fontSize: 11 }}>my work orders →</Link>
            </span>
          </div>
          {mine.slice(0, MINE_SHOWN).map((i) => (
            <Link key={i.id} href={`/instruments/${i.id}`} className="row-hover"
              style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", padding: "6px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit" }}>
              {i.down && <Pill bg="#A32D2D" fg="#fff">DOWN</Pill>}
              <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--navy)" }}>{i.externalId}</span>
              <span style={{ fontSize: 13, flex: "1 1 200px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {i.label || <span className="mut">No assets listed yet</span>}
              </span>
              {i.mineNote && <span className="mut" style={{ fontSize: 11.5 }}>{i.mineNote}</span>}
            </Link>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <div style={{ position: "relative" }}>
          <button className="btn sm" onClick={() => setFilterOpen((v) => !v)} style={{
            borderRadius: 999,
            borderColor: selected.length ? "var(--navy)" : "var(--line)",
            background: selected.length ? "var(--navy)" : "#fff",
            color: selected.length ? "#fff" : "var(--mut)",
          }}>
            Filter by{selected.length ? ` (${selected.length})` : ""} {filterOpen ? "▴" : "▾"}
          </button>
          {filterOpen && (
            <>
              <div onClick={() => setFilterOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 20 }} />
              <div style={{
                position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 21, background: "#fff",
                border: "1px solid var(--line)", borderRadius: 10, boxShadow: "0 8px 24px rgba(23,42,74,0.14)",
                padding: "10px 14px", minWidth: 220, maxHeight: "60vh", overflowY: "auto",
              }}>
                <div className="eyebrow" style={{ marginBottom: 4 }}>Stage</div>
                {stageNames.map((s) => (
                  <label key={s} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={selected.includes(s)} onChange={() => toggleFilter(s)}
                      style={{ width: 15, height: 15, accentColor: "var(--coral)" }} />
                    {s}
                  </label>
                ))}
                <div className="eyebrow" style={{ margin: "10px 0 4px" }}>Flags</div>
                <div className="mut" style={{ fontSize: 10, marginBottom: 2 }}>click once to keep, twice to hide</div>
                {FLAGS.map((f) => {
                  const st = flagState(f);
                  return (
                    <button key={f} type="button" onClick={() => toggleFilter(f)} className="row-hover"
                      aria-pressed={st !== ""}
                      style={{
                        display: "flex", alignItems: "center", gap: 8, padding: "4px 2px", fontSize: 13,
                        cursor: "pointer", width: "100%", textAlign: "left", border: "none",
                        background: "none", borderRadius: 6,
                        color: st === "out" ? "#A32D2D" : "var(--ink)",
                      }}>
                      <span aria-hidden style={{
                        width: 15, height: 15, borderRadius: 4, flexShrink: 0, fontSize: 11, lineHeight: "15px",
                        textAlign: "center", fontWeight: 700,
                        border: st === "" ? "1px solid #C7D2E0" : "none",
                        background: st === "in" ? "var(--coral, #E2574C)" : st === "out" ? "#A32D2D" : "transparent",
                        color: "#fff",
                      }}>{st === "in" ? "✓" : st === "out" ? "−" : ""}</span>
                      <span style={{ textDecoration: st === "out" ? "line-through" : "none" }}>{f}</span>
                    </button>
                  );
                })}
                {LEADS.length > 0 && (
                  <>
                    <div className="eyebrow" style={{ margin: "10px 0 4px" }}>Lead</div>
                    {LEADS.map((l) => (
                      <label key={l} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 13, cursor: "pointer" }}>
                        <input type="checkbox" checked={selected.includes(leadKey(l))} onChange={() => toggleFilter(leadKey(l))}
                          style={{ width: 15, height: 15, accentColor: "var(--coral)" }} />
                        {l}
                      </label>
                    ))}
                  </>
                )}
                {selected.length > 0 && (
                  <button className="btn link" style={{ marginTop: 8 }} onClick={() => setSelected([])}>Clear all</button>
                )}
              </div>
            </>
          )}
        </div>
        {selected.map((f) => {
          const no = f.startsWith("!");
          const key = no ? f.slice(1) : f;
          return (
            <button key={f} className="pill" title={no ? "Hiding these - click to clear" : "Remove filter"}
              onClick={() => setSelected((sx) => sx.filter((x) => x !== f))}
              style={{
                background: no ? "#FBE9E9" : "#EDEBFA", color: no ? "#A32D2D" : "#4F45A3",
                border: "none", cursor: "pointer",
              }}>
              {no ? "− " : ""}{key.startsWith("lead:") ? key.slice(5) : key} ×
            </button>
          );
        })}
        <span style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: "auto" }}>
          <label className="mut" style={{ margin: 0, fontSize: 11 }} htmlFor="board-sort">Sort</label>
          <select id="board-sort" value={sortBy} aria-label="Sort the board"
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            style={{ width: "auto", fontSize: 12 }}>
            <option value="default">Urgency</option>
            <option value="owner">Owner</option>
            <option value="id">System ID</option>
          </select>
          {canEdit && (
            <button className="btn sm primary" onClick={() => setShowNew((v) => !v)}>
              {showNew ? "Cancel" : "+ New instrument"}
            </button>
          )}
        </span>
      </div>

      {showNew && (
        <Dialog open onClose={() => setShowNew(false)} title="New instrument"
          context="The system is named by the assets you add on its page."
          footer={
            <>
              <span className="dialog-status" />
              <button className="btn" onClick={() => setShowNew(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={submitNew} disabled={pending}>
                {pending ? "Creating..." : "Create instrument"}
              </button>
            </>
          }>
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div><label>System ID *</label><input value={draft.externalId} onChange={(e) => setDraft({ ...draft, externalId: e.target.value })} placeholder="G-012" /></div>
            <div>
              <label>Client</label>
              <PickOrAdd value={draft.client} options={clients} newLabel="+ New client..." placeholder="New client name"
                onChange={(client) => setDraft({ ...draft, client })} />
            </div>
            <div><label>Priority</label><input value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} placeholder="11" /></div>
          </div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Category</label>
              <CatalogSelect value={draft.category} options={categories} ariaLabel="System category"
                onChange={(category) => setDraft({ ...draft, category })}
                hint="Define system types in Settings → Catalog" />
            </div>
          </div>
          {people.length > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className="mut" style={{ fontSize: 12 }}>Lead:</span>
              <select value={draft.lead} onChange={(e) => setDraft({ ...draft, lead: e.target.value })} style={{ width: "auto", fontSize: 12 }}>
                <option value="">-</option>
                {people.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          )}
        </Dialog>
      )}

      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ID, module, serial, client, stage..." style={{ marginBottom: 12 }} />

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="grid-row eyebrow" style={{ padding: "9px 14px", borderBottom: "1px solid var(--line)" }}>
          <span>ID</span><span>System</span><span className="hide-m">Stages</span><span className="hide-m">Parts / gas</span>
        </div>
        {filtered.map((i, n) => (
          <Link key={i.id} href={`/instruments/${i.id}`} className={`grid-row row-hover${n % 2 ? " alt" : ""}`}
            style={{
              padding: "11px 14px", borderBottom: "1px solid var(--line)", fontSize: 13, textDecoration: "none",
              color: "inherit",
              // Down reads red and beats parked; parked reads as somebody
              // else's without being hidden.
              ...(i.down ? { background: "#FDF1F1", borderLeft: "3px solid #C94A4A", paddingLeft: 11 }
                : i.queueMine ? {} : { background: "#FCFAF5", borderLeft: "3px solid #E8C99B", paddingLeft: 11 }),
            }}>
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--navy)" }}>{i.externalId}</span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.label || <span className="mut">No assets listed yet</span>}</span>
              <span className="mut" style={{ fontSize: 11 }}>
                {i.client}{i.category ? ` · ${i.category}` : ""} · P{i.priority}
                {i.lead && <span style={{ color: "var(--navy)", fontWeight: 700 }}> · {i.lead}</span>}
                {i.missingFromSheet && <span style={{ color: "#A32D2D", fontWeight: 700 }}> · not on sheet</span>}
              </span>
              {!i.queueMine && (
                <span style={{ display: "block", fontSize: 11, color: "#8A5410" }}>
                  with <b>{i.queueWith}</b>
                  {i.queueReason ? ` · ${i.queueReason}` : ""}
                </span>
              )}
            </span>
            <span className="hide-m" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {i.stages.map((s) => (
                <Pill key={s} bg={stageColor(s).bg} fg={stageColor(s).fg}>{s}</Pill>
              ))}
            </span>
            <span className="hide-m" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {i.down && <Pill bg="#A32D2D" fg="#fff">DOWN</Pill>}
              {i.missingFromSheet && <Pill bg="#FBE9E9" fg="#A32D2D">not on sheet</Pill>}
              {i.overdue > 0 && <Pill bg="#FBE9E9" fg="#A32D2D">{i.overdue} overdue</Pill>}
              {i.assetIssues.map((x) => (
                <Pill key={x} bg={x.endsWith("down") ? "#FBE9E9" : "#FAF0DC"} fg={x.endsWith("down") ? "#A32D2D" : "#8A5410"}>{x}</Pill>
              ))}
              {i.openParts > 0 && <Pill bg="#FAF0DC" fg="#8A5410">{i.openParts} open</Pill>}
              {i.gasIssues.map((g) => (
                <Pill key={g} bg={g.endsWith("low") ? "#FAF0DC" : "#FBE9E9"} fg={g.endsWith("low") ? "#8A5410" : "#A32D2D"}>{g}</Pill>
              ))}
              {i.docIssues.map((d) => (
                <Pill key={d} bg={d.endsWith("expired") ? "#FBE9E9" : "#FAF0DC"} fg={d.endsWith("expired") ? "#A32D2D" : "#8A5410"}>{d}</Pill>
              ))}
              {!i.missingFromSheet && !i.overdue && i.assetIssues.length === 0 && i.openParts === 0 && i.gasIssues.length === 0 && i.docIssues.length === 0 && <span className="mut" style={{ fontSize: 12 }}>-</span>}
            </span>
          </Link>
        ))}
        {filtered.length === 0 && (
          <div className="mut" style={{ padding: 24, fontSize: 13, textAlign: "center" }}>No instruments match. Clear the filter or search.</div>
        )}
      </div>
      {!canEdit && <div className="mut" style={{ fontSize: 12, marginTop: 10 }}>Read-only access.</div>}
    </div>
  );
}
