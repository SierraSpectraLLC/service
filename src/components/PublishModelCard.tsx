"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { setModelPublished, setModelSummary } from "@/app/actions";
import { MAX_SUMMARY, MIN_SUMMARY } from "@/lib/publicCatalog";

/**
 * Whether this model has a page on the open web, and the writing that earns
 * it one. The blockers arrive computed from the server - the same list the
 * action refuses on - so the card can explain the refusal before somebody
 * hits it rather than after.
 */
export default function PublishModelCard({ termId, modelName, published, slug, summary, blockers, warnings, siteUrl }: {
  termId: number;
  modelName: string;
  published: boolean;
  slug: string;
  summary: string;
  blockers: string[];
  warnings: string[];
  /** The instance's own address, for showing the live URL. Blank in local dev. */
  siteUrl: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(summary);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const path = `/equipment/${slug || "…"}`;

  const saveSummary = () => {
    setError(""); setNote("");
    startTransition(async () => {
      const res = await setModelSummary(termId, draft);
      if (res?.error) { setError(res.error); return; }
      setDirty(false);
      setNote("Summary saved");
      router.refresh();
    });
  };

  const toggle = (next: boolean) => {
    setError(""); setNote("");
    startTransition(async () => {
      const res = await setModelPublished(termId, next);
      if (res?.error) { setError(res.error); return; }
      setNote(next ? "Published - it'll be picked up on the next crawl" : "Taken down");
      router.refresh();
    });
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <div className="card-title">Public page</div>
        <span className={`pill ${published ? "good" : "neutral"}`} style={{ fontSize: 10 }}>{published ? "live" : "not published"}</span>
      </div>
      <div className="mut t-meta" style={{ marginBottom: 8 }}>
        A page anyone can find on the web: the specs, the part numbers, the kit contents and how often
        work comes round. Checklists, note text, prices and clients never appear on it.
      </div>

      <label>Summary <span className="mut" style={{ fontWeight: 400 }}>(what a person searching should read first)</span></label>
      <textarea value={draft} rows={4} maxLength={MAX_SUMMARY}
        onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
        placeholder={`What a ${modelName} is, what it's used for, what it's known for going wrong - in your own words. This is the part of the page that exists nowhere else.`}
        className="t-body" style={{ width: "100%", marginBottom: 4 }} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <span className="mut t-meta">
          {draft.trim().length}/{MAX_SUMMARY}
          {draft.trim().length < MIN_SUMMARY && ` · ${MIN_SUMMARY - draft.trim().length} more to publish`}
        </span>
        {dirty && (
          <button className="btn sm accent" onClick={saveSummary} disabled={pending}>
            {pending ? "Saving..." : "Save summary"}
          </button>
        )}
      </div>

      {blockers.length > 0 && !published && (
        <div className="t-small" style={{ padding: "8px 10px", borderRadius: 8, background: "#FAF0DC", color: "var(--t-warn-fg)", marginBottom: 8 }}>
          <b>Before this can go public:</b>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {blockers.map((b) => <li key={b}>{b}</li>)}
          </ul>
        </div>
      )}
      {warnings.length > 0 && blockers.length === 0 && !published && (
        <div className="mut t-meta" style={{ marginBottom: 8 }}>{warnings.join(" · ")}</div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {published ? (
          <>
            <button className="btn sm" onClick={() => toggle(false)} disabled={pending}>Take it down</button>
            <Link href={path} target="_blank" className="btn link" style={{ fontSize: 12 }}>
              {siteUrl ? `${siteUrl.replace(/^https?:\/\//, "")}${path}` : path} ↗
            </Link>
          </>
        ) : (
          <button className="btn sm accent" onClick={() => toggle(true)} disabled={pending || blockers.length > 0 || dirty}>
            {dirty ? "Save the summary first" : "Publish this page"}
          </button>
        )}
      </div>
      {note && <div className="t-small" style={{ color: "var(--t-good-fg)", fontWeight: 700, marginTop: 8 }}>{note} ✓</div>}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
