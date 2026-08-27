"use client";

import { useState, useTransition } from "react";
import { setDocScheme } from "@/app/actions";
import {
  DEFAULT_SCHEME, DOC_KINDS, DOC_LABEL, jobScoped, preview, templateProblems,
  type DocKind, type Scheme,
} from "@/lib/docNumber";
import { Panel } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

/**
 * How this shop numbers its paper.
 *
 * The whole feature is one idea a person has to be shown rather than told: a
 * template with {job} in it threads a job number through every document, so
 * one engagement's quote, invoices and purchase orders share a folder name and
 * each job's counter starts again at 1. A template without it counts that
 * document type across the whole workspace, which is the PO-1042 shape.
 *
 * So the preview is not decoration. It shows THREE examples for a reason - two
 * documents on one job and then the first on the next - because that third one
 * is where the difference between the two shapes becomes visible.
 */
export default function DocSchemeForm({ scheme }: { scheme: Scheme }) {
  const [pending, startTransition] = useTransition();
  const [base, setBase] = useState(scheme);
  const [draft, setDraft] = useState(scheme);

  const set = (kind: DocKind, template: string) =>
    setDraft({ ...draft, templates: { ...draft.templates, [kind]: template } });

  const problems = DOC_KINDS.flatMap((k) =>
    templateProblems(draft.templates[k]).map((p) => `${DOC_LABEL[k]}: ${p}`));
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const threaded = DOC_KINDS.some((k) => jobScoped(draft.templates[k]));

  const save = () =>
    startTransition(async () => {
      const res = await setDocScheme(draft);
      if (res?.error) { toast({ message: res.error }); return; }
      setBase(draft);
      toast({ message: "Saved - new documents take the new shape" });
    });

  return (
    <Panel
      title="Document numbers"
      hint="What a work order, quote, invoice and purchase order are called here. Nothing already issued is renamed."
    >
      <div className="mut t-small" style={{ marginBottom: 10 }}>
        <b>{"{seq}"}</b> is the running number and <b>{"{alpha}"}</b> the same counter as a
        letter. <b>{"{job}"}</b> is a job number shared by every document on one
        engagement - put it in and that document&apos;s counter starts again at 1 for each
        job. <b>{"{job:6}"}</b> pads it to six digits, so 30120 is written 030120.
      </div>

      {DOC_KINDS.map((kind) => {
        const rows = preview({ ...draft, jobStart: draft.jobStart }, kind);
        const bad = templateProblems(draft.templates[kind]);
        return (
          <div key={kind} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
            <span className="t-body" style={{ fontWeight: 600, minWidth: 120 }}>{DOC_LABEL[kind]}</span>
            <input className="mono t-small" style={{ width: 180 }} value={draft.templates[kind]}
              aria-label={`${DOC_LABEL[kind]} number`} disabled={pending}
              onChange={(e) => set(kind, e.target.value)} />
            {bad.length > 0
              ? <span className="t-small" style={{ color: "var(--t-bad-fg)" }}>{bad[0]}</span>
              : <span className="mut t-small mono">{rows.join("  ·  ")}</span>}
          </div>
        );
      })}

      {threaded && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "8px 0", borderTop: "1px solid var(--line)" }}>
          <span className="t-body" style={{ fontWeight: 600, minWidth: 120 }}>First job number</span>
          <input className="mono t-small" style={{ width: 110 }} inputMode="numeric"
            value={String(draft.jobStart)} aria-label="First job number" disabled={pending}
            onChange={(e) => setDraft({ ...draft, jobStart: parseInt(e.target.value, 10) || 0 })} />
          {/* Only until the first job exists. After that the next number is
              read off the documents themselves, which is why a workspace that
              already has 030212 on file carries on from there whatever this
              says. */}
          <span className="mut t-small">
            Where the counter starts. Once a job exists the next number comes from the
            documents, not from here.
          </span>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
        <button className="btn accent" disabled={pending || !dirty || problems.length > 0} onClick={save}>
          {pending ? "Saving..." : "Save"}
        </button>
        {dirty && (
          <button className="btn" disabled={pending} onClick={() => setDraft(base)}>Discard</button>
        )}
        <button className="btn link" disabled={pending} style={{ fontSize: 12 }}
          onClick={() => setDraft(DEFAULT_SCHEME)}>
          reset to the stock shape
        </button>
        {problems.length > 0 && (
          <span className="t-small" style={{ color: "var(--t-bad-fg)" }}>{problems[0]}</span>
        )}
      </div>

      <div className="mut t-meta" style={{ marginTop: 10 }}>
        Changing this renames nothing. Documents already on file keep the numbers they
        were issued under, and the counter reads only the ones that match - so an old
        shape cannot drag the new one somewhere odd.
      </div>
    </Panel>
  );
}
