"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveProposalSections, saveProposalSystems, saveProposalTiers, updateProposal,
} from "@/app/actions";
import { formatCents } from "@/lib/money";
import {
  SECTION_KINDS, SECTION_KIND_LABEL, parseFeatures, tierMatrix, type Section, type Tier,
} from "@/lib/proposal";
import { Panel } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

export type SystemDraft = {
  instrumentId: number | null; name: string; model: string; note: string;
};
/** A system the client already has on file, offered rather than retyped. */
export type FleetOption = { id: number; label: string; model: string };

/**
 * The proposal, edited.
 *
 * Four sheets, each saved whole - the header, the systems, the tiers, the
 * sections - because each is a short list somebody works through in one
 * sitting and a per-row save would turn one document into forty writes.
 *
 * The document itself is next door, at /print. This screen is deliberately not
 * a preview: a builder that tries to look like the paper ends up being neither,
 * and the paper is one click away.
 */
export default function ProposalBuilder({
  proposalId, quoteId, header, systems, tiers, sections, fleet,
}: {
  proposalId: number;
  quoteId: number;
  header: { title: string; subtitle: string; pricingValid: string; recommendedTier: string };
  systems: SystemDraft[];
  tiers: Tier[];
  sections: Section[];
  /** The client's own systems, so "add a system" is a pick and not a retype. */
  fleet: FleetOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [h, setH] = useState(header);
  const [sys, setSys] = useState<SystemDraft[]>(systems);
  const [ts, setTs] = useState<Tier[]>(tiers);
  const [secs, setSecs] = useState<Section[]>(sections);
  const [openTier, setOpenTier] = useState<number | null>(null);
  const [openSec, setOpenSec] = useState<number | null>(null);

  const run = (fn: () => Promise<{ error?: string }>, ok: string) => start(async () => {
    const res = await fn();
    if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
    toast({ message: ok });
    router.refresh();
  });

  const matrix = tierMatrix(ts);

  return (
    <>
      <Panel title="The document" hint="What it is called, and how long the price holds.">
        <label htmlFor="pb-title">What it is called</label>
        <input id="pb-title" value={h.title} style={{ marginBottom: 8 }}
          onChange={(e) => setH({ ...h, title: e.target.value })} />
        <label htmlFor="pb-sub">The line under the title</label>
        <input id="pb-sub" value={h.subtitle} style={{ marginBottom: 8 }}
          placeholder="Sciex TripleTOF 6600 + Shimadzu UHPLC - Avance Biosciences, Houston TX"
          onChange={(e) => setH({ ...h, subtitle: e.target.value })} />
        <div className="pf2" style={{ marginBottom: 8 }}>
          <div>
            <label htmlFor="pb-valid">Pricing valid</label>
            <input id="pb-valid" value={h.pricingValid} placeholder="30 days from issue"
              onChange={(e) => setH({ ...h, pricingValid: e.target.value })} />
          </div>
          <div>
            <label htmlFor="pb-rec">What we recommend</label>
            <select id="pb-rec" value={h.recommendedTier}
              onChange={(e) => setH({ ...h, recommendedTier: e.target.value })}>
              <option value="">No tier in particular</option>
              {ts.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select>
          </div>
        </div>
        <div className="mut t-meta" style={{ marginBottom: 8 }}>
          The customer, the contact and the quote number come from the quote itself, so this
          document and its price can never disagree about who it is for.
        </div>
        <button className="btn sm accent" disabled={pending}
          onClick={() => run(() => updateProposal(proposalId, h), "Saved")}>
          {pending ? "Saving..." : "Save"}
        </button>
      </Panel>

      <Panel title="Covered systems" count={sys.length}
        hint="What the contract covers. The table on page one.">
        {sys.map((r, i) => (
          <div key={i} className="row-2" style={{ alignItems: "flex-start", padding: "4px 0", borderTop: "1px solid var(--line)" }}>
            <span className="mut t-small" style={{ width: 16, paddingTop: 8 }}>{i + 1}</span>
            <input value={r.name} placeholder="Sciex TripleTOF Mass Spectrometer"
              aria-label={`System ${i + 1} instrument`} style={{ flex: "2 1 180px" }}
              onChange={(e) => setSys(sys.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <input value={r.model} placeholder="TripleTOF 6600"
              aria-label={`System ${i + 1} model`} style={{ flex: "1 1 120px" }}
              onChange={(e) => setSys(sys.map((x, j) => (j === i ? { ...x, model: e.target.value } : x)))} />
            <input value={r.note} placeholder="ESI source; APCI familiarization included"
              aria-label={`System ${i + 1} notes`} style={{ flex: "2 1 180px" }}
              onChange={(e) => setSys(sys.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
            <button className="btn link t-meta" style={{ color: "var(--t-bad-fg)" }}
              aria-label={`Remove system ${i + 1}`}
              onClick={() => setSys(sys.filter((_, j) => j !== i))}>remove</button>
          </div>
        ))}
        <div className="row-2" style={{ marginTop: 8, flexWrap: "wrap" }}>
          <button className="btn sm"
            onClick={() => setSys([...sys, { instrumentId: null, name: "", model: "", note: "" }])}>
            ＋ System
          </button>
          {/* The client's own fleet. Adding a system they already have on file
              should be a pick: the name and model are already right, and a
              retyped model number is how a proposal covers a machine nobody
              can find in the record afterwards. */}
          {fleet.length > 0 && (
            <select aria-label="Add one of their systems" value=""
              onChange={(e) => {
                const hit = fleet.find((f) => String(f.id) === e.target.value);
                if (!hit) return;
                setSys([...sys, { instrumentId: hit.id, name: hit.label, model: hit.model, note: "" }]);
              }} style={{ width: "auto" }}>
              <option value="">Add one of theirs...</option>
              {fleet.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          )}
          <button className="btn sm accent" disabled={pending}
            onClick={() => run(() => saveProposalSystems(proposalId, sys), "Saved the systems")}>
            {pending ? "Saving..." : "Save systems"}
          </button>
        </div>
      </Panel>

      <Panel title="Coverage tiers" count={ts.length}
        hint="Priced side by side. The comparison table builds itself from these.">
        {ts.map((t, i) => (
          <div key={i} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
            <div className="row-2" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
              <input value={t.name} aria-label={`Tier ${i + 1} name`} style={{ flex: "1 1 140px" }}
                onChange={(e) => setTs(ts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input value={t.annualCents > 0 ? (t.annualCents / 100).toFixed(0) : ""}
                inputMode="decimal" placeholder="$ per year"
                aria-label={`${t.name || `Tier ${i + 1}`} annual investment`} style={{ flex: "0 1 130px" }}
                onChange={(e) => setTs(ts.map((x, j) => (j === i
                  ? { ...x, annualCents: Math.round((Number(e.target.value) || 0) * 100) } : x)))} />
              <span className="mut t-meta" style={{ flex: "1 1 auto" }}>
                {parseFeatures(t.features).length} feature rows
                {h.recommendedTier === t.key ? " · recommended" : ""}
              </span>
              <button className="btn link t-meta" onClick={() => setOpenTier(openTier === i ? null : i)}>
                {openTier === i ? "close" : "edit words"}
              </button>
              <button className="btn link t-meta" style={{ color: "var(--t-bad-fg)" }}
                aria-label={`Remove ${t.name || `tier ${i + 1}`}`}
                onClick={() => setTs(ts.filter((_, j) => j !== i))}>remove</button>
            </div>
            {openTier === i && (
              <div style={{ marginTop: 8 }}>
                <label htmlFor={`pb-t-best-${i}`}>Best for</label>
                <textarea id={`pb-t-best-${i}`} rows={2} value={t.bestFor} style={{ width: "100%", marginBottom: 8 }}
                  onChange={(e) => setTs(ts.map((x, j) => (j === i ? { ...x, bestFor: e.target.value } : x)))} />
                <label htmlFor={`pb-t-inc-${i}`}>Includes <span className="mut" style={{ fontWeight: 400 }}>(one per line)</span></label>
                <textarea id={`pb-t-inc-${i}`} rows={6} value={t.includes} style={{ width: "100%", marginBottom: 8 }}
                  onChange={(e) => setTs(ts.map((x, j) => (j === i ? { ...x, includes: e.target.value } : x)))} />
                <label htmlFor={`pb-t-not-${i}`}>Not included, billed separately</label>
                <textarea id={`pb-t-not-${i}`} rows={3} value={t.notIncluded} style={{ width: "100%", marginBottom: 8 }}
                  onChange={(e) => setTs(ts.map((x, j) => (j === i ? { ...x, notIncluded: e.target.value } : x)))} />
                <label htmlFor={`pb-t-feat-${i}`}>
                  Comparison column <span className="mut" style={{ fontWeight: 400 }}>(Label | Value, one per line)</span>
                </label>
                <textarea id={`pb-t-feat-${i}`} rows={8} value={t.features} className="mono t-small"
                  style={{ width: "100%" }}
                  onChange={(e) => setTs(ts.map((x, j) => (j === i ? { ...x, features: e.target.value } : x)))} />
              </div>
            )}
          </div>
        ))}
        <div className="row-2" style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={() => setTs([...ts, {
            key: "", name: "New tier", annualCents: 0, bestFor: "", includes: "", notIncluded: "", features: "",
          }])}>
            ＋ Tier
          </button>
          <button className="btn sm accent" disabled={pending}
            onClick={() => run(() => saveProposalTiers(proposalId, ts), "Saved the tiers")}>
            {pending ? "Saving..." : "Save tiers"}
          </button>
        </div>

        {/* What the client will actually compare, built the one way it is built
            - so a label typed differently in two tiers shows up here as two
            rows rather than on the paper in front of them. */}
        {ts.length > 1 && (
          <div style={{ marginTop: 12, overflowX: "auto" }}>
            <table className="t-small" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>{matrix.head.map((c, i) => (
                  <th key={i} style={{ textAlign: i === 0 ? "left" : "center", padding: "4px 8px", borderBottom: "2px solid var(--navy)" }}>{c}</th>
                ))}</tr>
              </thead>
              <tbody>
                {matrix.rows.map((r, i) => (
                  <tr key={i}>{r.map((c, j) => (
                    <td key={j} style={{ textAlign: j === 0 ? "left" : "center", padding: "4px 8px", borderBottom: "1px solid var(--line)" }}>{c}</td>
                  ))}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Sections" count={secs.length}
        hint="The document, in order. Four kinds render the rows above in their place.">
        {secs.map((s, i) => (
          <div key={i} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
            <div className="row-2" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
              <span className="mut t-small" style={{ width: 16 }}>{i + 1}</span>
              <input value={s.heading} aria-label={`Section ${i + 1} heading`} style={{ flex: "2 1 200px" }}
                onChange={(e) => setSecs(secs.map((x, j) => (j === i ? { ...x, heading: e.target.value } : x)))} />
              <select value={s.kind} aria-label={`Section ${i + 1} kind`} style={{ width: "auto" }}
                onChange={(e) => setSecs(secs.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}>
                {SECTION_KINDS.map((k) => <option key={k} value={k}>{SECTION_KIND_LABEL[k]}</option>)}
              </select>
              <button className="btn link t-meta" aria-label={`Move section ${i + 1} up`} disabled={i === 0}
                onClick={() => setSecs(swap(secs, i, i - 1))}>↑</button>
              <button className="btn link t-meta" aria-label={`Move section ${i + 1} down`} disabled={i === secs.length - 1}
                onClick={() => setSecs(swap(secs, i, i + 1))}>↓</button>
              <button className="btn link t-meta" onClick={() => setOpenSec(openSec === i ? null : i)}>
                {openSec === i ? "close" : "edit words"}
              </button>
              <button className="btn link t-meta" style={{ color: "var(--t-bad-fg)" }}
                aria-label={`Remove section ${i + 1}`}
                onClick={() => setSecs(secs.filter((_, j) => j !== i))}>remove</button>
            </div>
            {openSec === i && (
              <div style={{ marginTop: 8 }}>
                <textarea rows={10} value={s.body} style={{ width: "100%" }}
                  aria-label={`Section ${i + 1} words`}
                  onChange={(e) => setSecs(secs.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))} />
                <div className="mut t-meta" style={{ marginTop: 4 }}>
                  A line starting <b style={{ fontWeight: 700 }}>#</b> is a subheading,
                  one starting <b style={{ fontWeight: 700 }}>-</b> is a bullet, anything else is a
                  paragraph. A blank line ends whatever was running.
                  {s.kind !== "prose" && ` These words print above the ${SECTION_KIND_LABEL[s.kind]?.toLowerCase() ?? s.kind}.`}
                </div>
              </div>
            )}
          </div>
        ))}
        <div className="row-2" style={{ marginTop: 8 }}>
          <button className="btn sm"
            onClick={() => setSecs([...secs, { kind: "prose", heading: "New section", body: "" }])}>
            ＋ Section
          </button>
          <button className="btn sm accent" disabled={pending}
            onClick={() => run(() => saveProposalSections(proposalId, secs), "Saved the sections")}>
            {pending ? "Saving..." : "Save sections"}
          </button>
          <a className="btn sm" href={`/money/quotes/${quoteId}/proposal/print`}>Read it as paper</a>
        </div>
      </Panel>

      {ts.some((t) => t.annualCents === 0) && (
        <div className="mut t-meta" style={{ marginBottom: 12 }}>
          {ts.filter((t) => t.annualCents === 0).map((t) => t.name).join(", ")}
          {ts.filter((t) => t.annualCents === 0).length === 1 ? " has" : " have"} no price yet -
          the comparison table prints a dash there, and {formatCents(0)} is not an offer.
        </div>
      )}
    </>
  );
}

const swap = <T,>(list: T[], a: number, b: number): T[] => {
  const out = [...list];
  [out[a], out[b]] = [out[b], out[a]];
  return out;
};
