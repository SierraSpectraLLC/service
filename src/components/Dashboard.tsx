"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { boardAttention, boardTone } from "@/lib/boardRow";
import PickOrAdd from "./PickOrAdd";
import CatalogSelect from "./CatalogSelect";
import { createInstrument } from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { DataTable, Dot, FacetStrip, Id, Legend, PageHead, Panel, Toolbar } from "@/components/ui";
import type { DataRow } from "@/components/ui/DataTable";
import { toast } from "@/components/ui/Toast";
import { matchesQuery } from "@/lib/search";

type StageDefLite = { name: string; bg: string; fg: string };

type Row = {
  id: number; externalId: string; client: string; category: string; label: string; priority: number; lead: string;
  stages: string[]; notes: string; openParts: number; gasIssues: string[];
  /** Expired / expiring dated documents - regulated (GxP) systems only. */
  docIssues: string[];
  overdue: number; assetIssues: string[]; missingFromSheet: boolean; lastActivity: string;
  /** Days in "Waiting / blocked", or null when it is not blocked. */
  blockedDays: number | null;
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

/** Stage chips keep their per-tenant colors from stage_defs - the one sanctioned hex pill. */
const StagePill = ({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) => (
  <span className="pill" style={{ background: bg, color: fg }}>{children}</span>
);

export default function Dashboard({ data, stageDefs, people, clients, categories, canEdit, isStaff, showShipping, ownerView = false, myQueueHref = "/work", initial }: {
  data: Row[]; stageDefs: StageDefLite[]; people: string[];
  clients: string[]; categories: string[]; canEdit: boolean; isStaff: boolean;
  /**
   * Whether this reader has an owner view to switch to.
   *
   * The two pages are the same person's two questions - what is the shop doing
   * today, and how is the business doing - so the way between them belongs on
   * the page rather than in the nav. It was a top-level nav word, which put a
   * permanent link to a page most staff cannot open in a row everybody reads.
   */
  ownerView?: boolean;
  /** Ship-pipeline tile: the shop and reseller accounts; clutter for lab clients. */
  showShipping: boolean;
  myQueueHref?: string;
  /** Filter state from the URL, so a filtered board can be shared and reloaded. */
  initial?: { q?: string; f?: string; sort?: string };
}) {
  const router = useRouter();
  const stageNames = stageDefs.map((d) => d.name);
  const stageColor = (name: string) => stageDefs.find((d) => d.name === name) ?? { bg: "#EEF1F5", fg: "#475569" };
  // No filter in the URL means the board opens on OUR side of the split -
  // the systems whose move is ours. "f=none" is a deliberately cleared filter
  // and stays cleared; anything else is the shared link it always was.
  const [selected, setSelected] = useState<string[]>(() => (
    initial?.f == null ? ["Ours to move"]
    : initial.f === "none" ? []
    : initial.f.split("|").filter(Boolean)));
  const [filterOpen, setFilterOpen] = useState(false);
  const [q, setQ] = useState(initial?.q ?? "");
  const [sortBy, setSortBy] = useState<"default" | "owner" | "id">(
    initial?.sort === "owner" || initial?.sort === "id" ? initial.sort : "default");
  const [showNew, setShowNew] = useState(false);
  const [draft, setDraft] = useState({ externalId: "", client: "", category: "", priority: "", lead: "" });
  const [pending, startTransition] = useTransition();

  // The URL mirrors the filter state (debounced for typing), so the filtered
  // board is a link. replace, not push: filtering is not ten history entries.
  //
  // Never while the search box has the caret, though. A route change re-runs
  // the server component under a focused field, and on a phone that is a
  // dropped keyboard - at a 300ms debounce, one per character, because nobody
  // thumbs faster than that. The board still filters live off local state; it
  // is only the ADDRESS that waits for the field to be let go, which `typing`
  // tracks. Everything else (facets, sort) is a tap and syncs immediately.
  const first = useRef(true);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (typing) return;
    const t = setTimeout(() => {
      const p = new URLSearchParams();
      if (q.trim()) p.set("q", q.trim());
      p.set("f", selected.length ? selected.join("|") : "none");
      if (sortBy !== "default") p.set("sort", sortBy);
      const s = p.toString();
      router.replace(s ? `/?${s}` : "/", { scroll: false });
    }, 300);
    return () => clearTimeout(t);
  }, [q, selected, sortBy, router, typing]);

  // "Docs expiring" appears only when some visible system could raise it -
  // a fleet with no regulated systems never sees the filter at all.
  const FLAGS = [...(data.some((i) => i.mine) ? ["Mine"] : []), "Down / urgent", "Ours to move", "With someone else", "Overdue tasks", "Awaiting parts", "Gas attention", "Asset attention",
    ...(data.some((i) => i.docIssues.length > 0) ? ["Docs expiring"] : []),
    ...(isStaff ? ["Not on sheet"] : [])];
  const LEADS = [...new Set(data.map((i) => i.lead).filter(Boolean))].sort();
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
    const flagSel = selected.filter((f) => !stageNames.includes(f) && !f.startsWith("lead:"));
    if (stageSel.length) list = list.filter((i) => stageSel.some((s) => i.stages.includes(s)));
    if (leadSel.length) list = list.filter((i) => leadSel.includes(i.lead));
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

  // Counted inside the active filter, so the tiles describe the board being
  // looked at - except "With someone else", which is the other half of the
  // ours/not-ours split and would read 0 under the default filter.
  const counts = {
    total: filtered.length,
    down: filtered.filter((i) => i.down).length,
    blocked: filtered.filter((i) => i.stages.includes("Waiting / blocked")).length,
    waiting: filtered.filter((i) => i.openParts > 0).length,
    gas: filtered.filter((i) => i.gasIssues.length > 0).length,
    shipped: filtered.filter((i) => i.stages.includes("Shipped") || i.stages.includes("Waiting to ship")).length,
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
      toast({ message: `Created ${draft.externalId.trim()}` });
      setDraft({ externalId: "", client: "", category: "", priority: "", lead: "" });
      router.push(`/instruments/${id}`);
    });
  };

  const toRow = (i: Row): DataRow => {
    const attn = boardAttention(i);
    return {
      key: i.id,
      href: `/instruments/${i.id}`,
      cells: {
        dot: <Dot tone={boardTone(i)} />,
        id: <Id>{i.externalId}</Id>,
        system: (
          <span style={{ minWidth: 0, display: "block" }}>
            <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {i.label || <span className="mut">No assets listed yet</span>}
            </span>
            <span className="mut t-meta">
              {i.client}{i.category ? ` · ${i.category}` : ""} · P{i.priority}
              {i.lead ? ` · ${i.lead}` : ""}
              {!i.queueMine && <> · with <b>{i.queueWith}</b>{i.queueReason ? ` · ${i.queueReason}` : ""}</>}
            </span>
          </span>
        ),
        stage: i.stages.length ? (
          <span style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
            <StagePill bg={stageColor(i.stages[0]).bg} fg={stageColor(i.stages[0]).fg}>{i.stages[0]}</StagePill>
            {i.stages.length > 1 && <span className="mut t-meta">+{i.stages.length - 1}</span>}
          </span>
        ) : null,
        attn: attn.length
          ? <span className="mut t-small">{attn.join(" · ")}</span>
          : null,
      },
    };
  };

  return (
    <div className="container">
      <PageHead title="Dashboard"
        actions={(ownerView || canEdit) && (
          <>
            {ownerView && (
              <Link className="btn sm" href="/owner">Switch to owner view</Link>
            )}
            {canEdit && (
              <button className="btn sm primary" onClick={() => setShowNew(true)}>+ New instrument</button>
            )}
          </>
        )} />
      <div className="metric-grid" style={{ marginBottom: 14 }}>
        {([
          [filtered.length === data.length ? "Total systems" : "Systems in this filter",
            filtered.length === data.length
              ? counts.total
              : <>{counts.total}<span className="mut" style={{ fontSize: 13, fontWeight: 400 }}> of {data.length}</span></>,
            "var(--navy)"],
          // The one number that overrides every other on this screen.
          ["Down", counts.down, "#A32D2D"],
          // Reads as "how much of the board isn't ours to move" - the number
          // this whole axis exists to make visible.
          ["With someone else", counts.parked, "#8A5410"],
          ["Waiting / blocked", counts.blocked, "#A32D2D"],
          ["Awaiting parts", counts.waiting, "#8A5410"],
          ["Gas attention", counts.gas, "#A33A1A"],
          ...(showShipping ? [["Ship queue + shipped", counts.shipped, "#085041"]] : []),
        ] as [string, React.ReactNode, string][]).map(([label, n, color]) => (
          <div key={label} className="card" style={{ padding: "12px 14px", marginBottom: 0 }}>
            <div className="mut t-small">{label}</div>
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
        <Panel title="My systems" count={mine.length}
          actions={
            <>
              {mine.length > MINE_SHOWN && (
                <button className="btn link"
                  onClick={() => setSelected((s) => (s.includes("Mine") ? s : [...s, "Mine"]))}>
                  all {mine.length} on the board →
                </button>
              )}
              <Link href={myQueueHref} className="btn link">my work orders →</Link>
            </>
          }>
          {mine.slice(0, MINE_SHOWN).map((i) => (
            <Link key={i.id} href={`/instruments/${i.id}`} className="row-hover"
              style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", padding: "6px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit" }}>
              {i.down && <Dot tone="bad" label="down" />}
              <Id>{i.externalId}</Id>
              <span className="t-body" style={{ flex: "1 1 200px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {i.label || <span className="mut">No assets listed yet</span>}
              </span>
              {i.mineNote && <span className="mut" style={{ fontSize: 12 }}>{i.mineNote}</span>}
            </Link>
          ))}
        </Panel>
      )}

      <Toolbar
        search={
          <input value={q} onChange={(e) => setQ(e.target.value)}
            onFocus={() => setTyping(true)} onBlur={() => setTyping(false)}
            placeholder="ID, module, serial, client, stage..." aria-label="Search the board" />
        }
        facets={
          <FacetStrip
            facets={FLAGS.map((f) => ({
              key: f,
              label: flagState(f) === "out" ? `not ${f}` : f,
              count: data.filter((i) => matchesFlag(i, f)).length || undefined,
              on: flagState(f) !== "",
            }))}
            onToggle={toggleFilter}
          />
        }
        actions={
          <>
            <div style={{ position: "relative" }}>
              <button className="btn sm" onClick={() => setFilterOpen((v) => !v)}>
                Stage / lead{selected.some((f) => stageNames.includes(f) || f.startsWith("lead:")) ? " ✓" : ""} {filterOpen ? "▴" : "▾"}
              </button>
              {filterOpen && (
                <>
                  <div onClick={() => setFilterOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 20 }} />
                  <div style={{
                    position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 21, background: "#fff",
                    border: "1px solid var(--line)", borderRadius: 10, boxShadow: "0 8px 24px rgba(23,42,74,0.14)",
                    padding: "10px 14px", minWidth: 220, maxHeight: "60vh", overflowY: "auto",
                  }}>
                    <div className="eyebrow" style={{ marginBottom: 4 }}>Stage</div>
                    {stageNames.map((s) => (
                      <label key={s} className="t-body" style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
                        <input type="checkbox" checked={selected.includes(s)} onChange={() => toggleFilter(s)}
                          style={{ width: 15, height: 15, accentColor: "var(--coral)" }} />
                        {s}
                      </label>
                    ))}
                    {LEADS.length > 0 && (
                      <>
                        <div className="eyebrow" style={{ margin: "10px 0 4px" }}>Lead</div>
                        {LEADS.map((l) => (
                          <label key={l} className="t-body" style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
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
            <select value={sortBy} aria-label="Sort the board"
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="t-small" style={{ width: "auto" }}>
              <option value="default">Urgency</option>
              <option value="owner">Owner</option>
              <option value="id">System ID</option>
            </select>
          </>
        }
      />
      {/* Stage and lead selections (and exclusions) as removable chips - the
          strip above only carries the flags. */}
      {selected.some((f) => stageNames.includes(f) || f.startsWith("lead:") || f.startsWith("!")) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", margin: "0 0 10px" }}>
          {selected.filter((f) => stageNames.includes(f) || f.startsWith("lead:") || f.startsWith("!")).map((f) => {
            const no = f.startsWith("!");
            const key = no ? f.slice(1) : f;
            return (
              <button key={f} className={`pill ${no ? "bad" : "accent"}`} title={no ? "Hiding these - click to clear" : "Remove filter"}
                onClick={() => setSelected((sx) => sx.filter((x) => x !== f))}
                style={{ border: "none", cursor: "pointer" }}>
                {no ? "not " : ""}{key.startsWith("lead:") ? key.slice(5) : key} ×
              </button>
            );
          })}
        </div>
      )}

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
              <span className="mut t-small">Lead:</span>
              <select value={draft.lead} onChange={(e) => setDraft({ ...draft, lead: e.target.value })} className="t-small" style={{ width: "auto" }}>
                <option value="">-</option>
                {people.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          )}
        </Dialog>
      )}

      <DataTable
        cols={[
          { key: "dot", label: "", width: "12px" },
          { key: "id", label: "ID", width: "90px" },
          { key: "system", label: "System", width: "minmax(200px, 2fr)" },
          { key: "stage", label: "Stage", width: "minmax(120px, 0.9fr)", hideMobile: true },
          { key: "attn", label: "Attention", width: "minmax(140px, 1fr)", hideMobile: true },
        ]}
        rows={filtered.map(toRow)}
        empty="No instruments match. Clear the filter or search."
      />
      <Legend items={[
        { tone: "bad", label: "down" },
        { tone: "warn", label: "needs attention" },
        { tone: "neutral", label: "ours to move" },
        { tone: "faint", label: "with someone else" },
      ]} />
      {!canEdit && <div className="mut t-small" style={{ marginTop: 10 }}>Read-only access.</div>}
    </div>
  );
}
