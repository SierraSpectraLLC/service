"use client";

import { useState, useTransition } from "react";
import { addVocabTerms, deleteVocabTerm, renameMaker } from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { makerUsageLine, type MakerRow } from "@/lib/makers";

/**
 * The manufacturer & vendor book: one list, referenced by every maker and
 * vendor field in the app. Renaming here sweeps the name across models,
 * systems, units, the part book and purchasing records in one action - the
 * replacement for the per-row "rename maker" links the catalog used to wear.
 *
 * Names seen in records but not yet defined are listed too (the shop's reality
 * always shows), with "add to book" to promote the spelling.
 */
export default function MakersCard({ makers }: { makers: MakerRow[] }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  const splitNames = (raw: string) => raw.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

  const add = () => {
    const names = splitNames(draft);
    if (!names.length) return;
    setError(""); setNote("");
    startTransition(async () => {
      const res = await addVocabTerms(names.map((name) => ({ kind: "maker", assetType: "", name })));
      if (res?.error) { setError(res.error); return; }
      if (res.failures?.length) setError(res.failures.map((f) => `${f.name}: ${f.error}`).join("; "));
      if (res.created) setDraft("");
    });
  };

  const rename = (m: MakerRow) => {
    const next = window.prompt(`Rename "${m.name}" everywhere - models, systems, units, parts, purchasing:`, m.name);
    if (next === null || !next.trim() || next.trim() === m.name) return;
    setError(""); setNote("");
    startTransition(async () => {
      const res = await renameMaker(m.name, next.trim());
      if (res?.error) { setError(res.error); return; }
      setNote(`"${m.name}" is now "${next.trim()}" on ${res.changed ?? 0} record${res.changed === 1 ? "" : "s"}`);
    });
  };

  const define = (m: MakerRow) => {
    setError(""); setNote("");
    startTransition(async () => {
      const res = await addVocabTerms([{ kind: "maker", assetType: "", name: m.name }]);
      if (res?.error || res.failures?.length) setError(res?.error ?? res.failures![0].error);
    });
  };

  const remove = async (m: MakerRow) => {
    if (m.id === null) return;
    if (!(await confirmDialog({
      title: `Remove "${m.name}" from the book?`,
      body: m.total
        ? `The ${m.total} record${m.total === 1 ? "" : "s"} naming it keep the name - it just stops being suggested.`
        : undefined,
      action: `Remove ${m.name}`, tone: "bad",
    }))) return;
    setError(""); setNote("");
    startTransition(async () => {
      const res = await deleteVocabTerm(m.id!);
      if (res?.error) setError(res.error);
      else toast({ message: `Removed ${m.name} from the book` });
    });
  };

  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 4 }}>Manufacturers &amp; vendors</div>
      <div className="mut" style={{ fontSize: 11, marginBottom: 10 }}>
        One list every maker and vendor field suggests from. Renaming here renames it everywhere it&apos;s recorded, in one go.
      </div>
      {makers.map((m) => (
        <div key={m.name.toLowerCase()} style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{m.name}</span>
          <span className="mut" style={{ fontSize: 11 }}>{makerUsageLine(m) || "not used yet"}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 10, flexShrink: 0 }}>
            <button className="btn link" style={{ fontSize: 11 }} disabled={pending} onClick={() => rename(m)}>rename</button>
            {m.id === null
              ? <button className="btn link" style={{ fontSize: 11 }} disabled={pending} title="Seen on records but not in the book yet" onClick={() => define(m)}>add to book</button>
              : <button className="btn link" style={{ fontSize: 11, color: "var(--t-bad-fg)" }} disabled={pending} onClick={() => remove(m)}>remove</button>}
          </span>
        </div>
      ))}
      {makers.length === 0 && (
        <div className="mut" style={{ fontSize: 12, marginBottom: 6 }}>Nothing yet - add the makers and vendors you deal with below.</div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap", borderTop: "1px solid var(--line)", paddingTop: 10 }}>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={draft.includes("\n") ? 4 : 1}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add(); }}
          placeholder='New makers/vendors - "Shimadzu", or one per line'
          style={{ flex: "1 1 200px", fontSize: 13, maxWidth: 300, resize: "vertical" }} />
        <button className="btn sm accent" onClick={add} disabled={pending || !draft.trim()}>
          {splitNames(draft).length > 1 ? `Add ${splitNames(draft).length} names` : "Add"}
        </button>
      </div>
      {note && <div style={{ fontSize: 12, color: "var(--t-good-fg)", fontWeight: 700, marginTop: 8 }}>{note} ✓</div>}
      {error && <div style={{ fontSize: 12, color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
