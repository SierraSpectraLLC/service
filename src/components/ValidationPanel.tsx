"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { fmtWhen } from "@/lib/when";
import {
  addValidationDoc, signValidationDoc, revokeValidationSignature,
  markValidationDocExecuted, deleteValidationDoc,
} from "@/app/actions";
import {
  DOC_TYPES, DOC_STATE_TONE, SIG_ROLES, STANDING_TONE,
  canApprove, canDelete, canExecute, expiryLabel, isProtocol, packageRows,
  type Standing,
} from "@/lib/gxp";

export type ValidationSig = {
  id: number; role: string; signerName: string; signerTitle: string; note: string;
  createdAt: string; revokedAt: string | null; revokeReason: string;
};
export type ValidationDocRow = {
  id: number; docType: string; title: string; state: string; version: number;
  supersedesId: number | null; attachmentId: number | null; reviewOn: string; note: string;
  createdBy: string; createdAt: string;
  signatures: ValidationSig[];
};
type FileOption = { id: number; fileName: string };

const emptyDraft = { docType: "", title: "", attachmentId: "" as string, reviewOn: "", note: "", supersedesId: null as number | null };

/**
 * The validation shelf: what a regulated system's package requires, what is on
 * file against each slot, and the lifecycle controls - approve, execute,
 * revise - with the ordering rules enforced by the server.
 *
 * The checklist IS the empty state: a missing OQ protocol renders as its own
 * row saying "missing", because the useful view of an incomplete package is
 * the holes, not a blank card.
 */
export default function ValidationPanel({ instrumentId, docs, requiredTypes, files, standing, isStaff, today }: {
  instrumentId: number;
  docs: ValidationDocRow[];
  /** From the catalog - the package this equipment owes. */
  requiredTypes: string[];
  /** This system's attachments, for linking a doc to its file. */
  files: FileOption[];
  standing: Standing | null;
  isStaff: boolean;
  today: string;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [signing, setSigning] = useState<number | null>(null);
  const [sigDraft, setSigDraft] = useState({ role: "Approved", signerName: "", signerTitle: "", note: "" });
  const [openDoc, setOpenDoc] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const rows = packageRows(requiredTypes, docs);
  const history = (d: ValidationDocRow): ValidationDocRow[] => {
    // Walk the supersedes chain down from a current doc.
    const out: ValidationDocRow[] = [];
    let cur = d.supersedesId;
    while (cur !== null) {
      const prev = docs.find((x) => x.id === cur);
      if (!prev) break;
      out.push(prev);
      cur = prev.supersedesId;
    }
    return out;
  };

  const openAdd = (docType = "", supersedes: ValidationDocRow | null = null) => {
    setDraft(supersedes
      ? { docType: supersedes.docType, title: supersedes.title, attachmentId: "", reviewOn: supersedes.reviewOn, note: "", supersedesId: supersedes.id }
      : { ...emptyDraft, docType });
    setError("");
    setAdding(true);
  };

  const save = () => {
    setError("");
    startTransition(async () => {
      const res = await addValidationDoc(instrumentId, {
        docType: draft.docType, title: draft.title,
        attachmentId: draft.attachmentId ? parseInt(draft.attachmentId) : null,
        reviewOn: draft.reviewOn, note: draft.note, supersedesId: draft.supersedesId,
      });
      if (res?.error) { setError(res.error); return; }
      setAdding(false);
    });
  };

  const sign = (docId: number) => {
    setError("");
    startTransition(async () => {
      const res = await signValidationDoc(docId, sigDraft);
      if (res?.error) { setError(res.error); return; }
      setSigning(null);
      setSigDraft({ role: "Approved", signerName: "", signerTitle: "", note: "" });
    });
  };

  const renderDoc = (d: ValidationDocRow, indent = false) => {
    const open = openDoc === d.id;
    const active = d.signatures.filter((x) => x.revokedAt === null);
    const st = DOC_STATE_TONE[d.state] ?? DOC_STATE_TONE.Draft;
    return (
      <div key={d.id} style={{ marginLeft: indent ? 18 : 0, borderTop: "1px solid var(--line)", padding: "6px 0", opacity: d.state === "Superseded" ? 0.65 : 1 }}>
        <div className="row-hover" onClick={() => setOpenDoc(open ? null : d.id)}
          style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", cursor: "pointer" }}>
          <span className={`pill ${st}`}>{d.state}</span>
          <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0 }}>{d.title}</span>
          <span className="mut" style={{ fontSize: 11 }}>v{d.version}</span>
          {d.attachmentId !== null && (
            <a href={`/api/files/${d.attachmentId}`} target="_blank" rel="noreferrer"
              onClick={(e) => e.stopPropagation()} style={{ fontSize: 11 }}>file</a>
          )}
          {d.reviewOn && (
            <span className={`pill ${d.reviewOn < today ? "bad" : "neutral"}`} title={`Review by ${d.reviewOn}`}>{d.reviewOn < today ? `review ${expiryLabel(d.reviewOn, today).replace("expired", "overdue")}` : `review ${d.reviewOn}`}</span>
          )}
          {active.length > 0 && (
            <span className="mut" style={{ fontSize: 11, marginLeft: "auto" }}>
              {active.map((x) => `${x.role}: ${x.signerName}`).join(" · ")}
            </span>
          )}
          <span className="mut" style={{ fontSize: 12 }}>{open ? "▾" : "▸"}</span>
        </div>

        {open && (
          <div style={{ padding: "6px 0 2px", fontSize: 12 }}>
            {d.note && <div className="mut" style={{ marginBottom: 6 }}>{d.note}</div>}
            {d.signatures.map((x) => (
              <div key={x.id} style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap", textDecoration: x.revokedAt ? "line-through" : "none", color: x.revokedAt ? "var(--mut)" : "inherit" }}>
                <b>{x.role}</b>
                <span>{x.signerName}{x.signerTitle ? `, ${x.signerTitle}` : ""}</span>
                <span className="mut">{fmtWhen(x.createdAt)}</span>
                {x.note && <span className="mut">- {x.note}</span>}
                {x.revokedAt && <span style={{ color: "var(--t-bad-fg)", textDecoration: "none" }}>withdrawn: {x.revokeReason}</span>}
                {isStaff && !x.revokedAt && d.state !== "Superseded" && (
                  <button className="btn link" style={{ textDecoration: "none" }} onClick={async () => {
                    const reason = await confirmReason({
                      title: `Withdraw the ${x.role} signature of ${x.signerName}?`,
                      body: "The withdrawal is kept in the record.",
                      action: "Withdraw", tone: "bad",
                    });
                    if (!reason) return;
                    startTransition(async () => {
                      const res = await revokeValidationSignature(x.id, reason);
                      if (res?.error) setError(res.error);
                    });
                  }}>withdraw</button>
                )}
              </div>
            ))}
            {d.signatures.length === 0 && <div className="mut">No signatures yet.</div>}

            {isStaff && d.state !== "Superseded" && (
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                {signing === d.id ? (
                  <>
                    <select value={sigDraft.role} onChange={(e) => setSigDraft({ ...sigDraft, role: e.target.value })}
                      style={{ width: "auto", fontSize: 12 }} aria-label="Signing role">
                      {SIG_ROLES.filter((r) => r !== "Approved" || canApprove(d)).map((r) => <option key={r}>{r}</option>)}
                    </select>
                    <input value={sigDraft.signerName} onChange={(e) => setSigDraft({ ...sigDraft, signerName: e.target.value })}
                      placeholder="Type your full name to sign" style={{ width: "auto", flex: "1 1 160px", fontSize: 12 }} />
                    <input value={sigDraft.signerTitle} onChange={(e) => setSigDraft({ ...sigDraft, signerTitle: e.target.value })}
                      placeholder="Title (optional)" style={{ width: "auto", flex: "1 1 110px", fontSize: 12 }} />
                    <button className="btn sm accent" disabled={pending || sigDraft.signerName.trim().length < 2}
                      onClick={() => sign(d.id)}>{pending ? "Signing..." : "Sign"}</button>
                    <button className="btn sm" onClick={() => setSigning(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button className="btn sm" onClick={() => { setSigning(d.id); setSigDraft({ role: canApprove(d) ? "Approved" : "Reviewed", signerName: "", signerTitle: "", note: "" }); }}>
                      Sign
                    </button>
                    {canExecute(d) && (
                      <button className="btn sm" title="This approved protocol has been run - the readings and reports are the evidence"
                        onClick={() => startTransition(async () => {
                          const res = await markValidationDocExecuted(d.id);
                          if (res?.error) setError(res.error);
                        })}>Mark executed</button>
                    )}
                    <button className="btn sm" onClick={() => openAdd("", d)}
                      title="File a revision - this version becomes Superseded and stays on the record">New version</button>
                    {canDelete(d, active.length) && (
                      <button className="btn link" style={{ color: "var(--t-bad-fg)" }} onClick={async () => {
                        const reason = await confirmReason({
                          title: `Remove draft "${d.title}"?`,
                          body: "Only unsigned drafts can be removed.",
                          action: "Remove", tone: "bad",
                        });
                        if (!reason) return;
                        startTransition(async () => {
                          const res = await deleteValidationDoc(d.id, reason);
                          if (res?.error) setError(res.error);
                        });
                      }}>Remove</button>
                    )}
                  </>
                )}
              </div>
            )}

            {history(d).map((h) => renderDoc(h, true))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <div className="card-title">Validation</div>
        {standing && (
          <span className={`pill ${STANDING_TONE[standing.tone]}`} title={standing.reasons.join("; ")}>
            {standing.label}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <Link href={`/instruments/${instrumentId}/binder`} className="btn sm">Audit binder</Link>
          {isStaff && <button className="btn sm accent" onClick={() => openAdd()}>+ Document</button>}
        </span>
      </div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
        The paper behind the qualification. Protocols are approved before they run, reports after;
        revisions supersede instead of replacing, so every approved version stays on the record.
      </div>

      {adding && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 10, marginBottom: 10, background: "#FAFBFD" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <div style={{ flex: "1 1 150px" }}>
              <label>Type *</label>
              <select value={draft.docType} disabled={draft.supersedesId !== null}
                onChange={(e) => setDraft({ ...draft, docType: e.target.value })}>
                <option value="">-</option>
                {DOC_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ flex: "2 1 200px" }}>
              <label>Title *</label>
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder='e.g. "OQ Protocol - Altis / LC-MS, SOP-041"' />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <div style={{ flex: "2 1 180px" }}>
              <label>File</label>
              <select value={draft.attachmentId} onChange={(e) => setDraft({ ...draft, attachmentId: e.target.value })}>
                <option value="">none - paper master or filed later</option>
                {files.map((f) => <option key={f.id} value={f.id}>{f.fileName}</option>)}
              </select>
              <div className="mut" style={{ fontSize: 11, marginTop: 2 }}>
                Upload under Attachments first, then link it here.
              </div>
            </div>
            <div>
              <label>Review by</label>
              <input type="date" value={draft.reviewOn} onChange={(e) => setDraft({ ...draft, reviewOn: e.target.value })}
                style={{ width: "auto" }} />
            </div>
          </div>
          <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            placeholder="Note (optional)" style={{ fontSize: 12, marginBottom: 8 }} />
          {draft.supersedesId !== null && (
            <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
              Filing this supersedes the current version - it stays on the record under its own number.
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm accent" disabled={pending || !draft.docType || !draft.title.trim()} onClick={save}>
              {pending ? "Filing..." : draft.supersedesId !== null ? "File revision" : "File document"}
            </button>
            <button className="btn sm" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}

      {rows.length === 0 && (
        <div className="empty">
          <b>No package declared</b>
          Declare what this equipment owes (IQ/OQ/PQ protocols, reports) on the catalog -
          Settings → Catalog → Validation packages - or file documents directly with + Document.
        </div>
      )}

      {rows.map((r) => (
        <div key={r.docType} style={{ marginTop: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span className="eyebrow">{r.docType}</span>
            {r.required && !r.satisfied && (
              <span className="pill bad">
                {r.docs.length ? "not approved yet" : "missing"}
              </span>
            )}
            {!r.required && <span className="mut" style={{ fontSize: 11 }}>beyond the declared package</span>}
            {isStaff && r.docs.length === 0 && (
              <button className="btn link" style={{ marginLeft: "auto" }} onClick={() => openAdd(r.docType)}>file it</button>
            )}
          </div>
          {r.docs.map((d) => renderDoc(d))}
        </div>
      ))}

      {error && <div style={{ fontSize: 12, color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
