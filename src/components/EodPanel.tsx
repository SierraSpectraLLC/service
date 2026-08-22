"use client";

import { useRef, useState, useTransition } from "react";
import { saveEodUpdate, setEodSkip, sendEodEmail } from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";

/** One line on a client's report: a system, or a standalone asset. */
export type EodLine = {
  kind: "system" | "asset";
  id: number;
  externalId: string;
  label: string;
  systemUpdate: string;
  actionItem: string;
  skipped: boolean;
  written: boolean;
  suggestedUpdate: string;
  suggestedAction: string;
};
type Draft = { systemUpdate: string; actionItem: string };
type SaveState = "dirty" | "saving" | "saved";

const SEP = "-".repeat(50);
const AUTOSAVE_MS = 900;
const keyOf = (e: EodLine) => `${e.kind}:${e.id}`;
const targetOf = (e: EodLine) =>
  e.kind === "system" ? { instrumentId: e.id, assetId: null } : { instrumentId: null, assetId: e.id };

/**
 * One client's daily report: the work they own, the updates written on those
 * systems and assets today, and a send button aimed at their own recipients.
 * Lines can be edited here too, but the primary place to write one is the
 * system's or asset's own page - anything written there shows up here.
 */
export default function EodPanel({
  clientName, orgId, entries, dateMDY, readOnly = false, canSend = false, recipientCount = 0, sentInfo = "",
}: {
  clientName: string; orgId: number | null; entries: EodLine[]; dateMDY: string;
  readOnly?: boolean; canSend?: boolean; recipientCount?: number; sentInfo?: string;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(
    Object.fromEntries(entries.map((e) => [keyOf(e), { systemUpdate: e.systemUpdate, actionItem: e.actionItem }]))
  );
  const [status, setStatus] = useState<Record<string, SaveState>>({});
  const [copied, setCopied] = useState(false);
  const [sendMsg, setSendMsg] = useState("");
  const [showBlanks, setShowBlanks] = useState(false);
  const [pending, startTransition] = useTransition();

  // Autosave: debounce while typing, flush on blur. The ref keeps the timer
  // callbacks reading the latest draft, not the one they closed over.
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  const flush = (e: EodLine) => {
    const k = keyOf(e);
    if (timers.current[k]) { clearTimeout(timers.current[k]); delete timers.current[k]; }
    const d = draftsRef.current[k];
    if (!d) return;
    setStatus((s) => ({ ...s, [k]: "saving" }));
    startTransition(async () => {
      await saveEodUpdate(targetOf(e), d);
      // Typed again mid-flight? Stay dirty; the newer edit's timer saves it.
      setStatus((s) => (s[k] === "dirty" ? s : { ...s, [k]: "saved" }));
    });
  };

  const setDraft = (e: EodLine, patch: Partial<Draft>) => {
    const k = keyOf(e);
    setDrafts((d) => ({ ...d, [k]: { ...d[k], ...patch } }));
    setStatus((s) => ({ ...s, [k]: "dirty" }));
    if (timers.current[k]) clearTimeout(timers.current[k]);
    timers.current[k] = setTimeout(() => flush(e), AUTOSAVE_MS);
  };

  const hasText = (e: EodLine) => {
    const d = drafts[keyOf(e)];
    return !!(d?.systemUpdate || d?.actionItem);
  };
  const included = entries.filter((e) => !e.skipped);
  // Written first - that's what the email will actually carry.
  const filled = included.filter(hasText);
  const blanks = included.filter((e) => !hasText(e));
  const skipped = entries.filter((e) => e.skipped);

  // Fill only what's empty - a suggestion never overwrites something typed.
  const autofill = (e: EodLine) => {
    const d = drafts[keyOf(e)];
    setDraft(e, {
      systemUpdate: d.systemUpdate || e.suggestedUpdate,
      actionItem: d.actionItem || e.suggestedAction,
    });
  };
  const canAutofill = (e: EodLine) => {
    const d = drafts[keyOf(e)];
    return (!d?.systemUpdate && !!e.suggestedUpdate) || (!d?.actionItem && !!e.suggestedAction);
  };

  const emailText = [
    `${dateMDY} - Daily Updates`, "", SEP,
    ...filled.flatMap((e, i) => [
      `${e.kind === "system" ? "System" : "Unit"} ${i + 1}: ${e.label}`, "",
      `System Update: ${drafts[keyOf(e)]?.systemUpdate ?? ""}`,
      `Action Item: ${drafts[keyOf(e)]?.actionItem ?? ""}`, "", SEP,
    ]),
  ].join("\n");

  const copy = async () => {
    await navigator.clipboard.writeText(emailText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const send = async () => {
    if (!(await confirmDialog({
      title: `Email today's report to ${clientName}'s ${recipientCount} recipient${recipientCount === 1 ? "" : "s"}?`,
      body: sentInfo ? `Already ${sentInfo.toLowerCase()} - this sends it again.` : undefined,
      action: "Send report",
    }))) return;
    setSendMsg("");
    startTransition(async () => {
      const res = await sendEodEmail(orgId);
      setSendMsg(res?.error ? res.error : `Sent to ${res.sent} recipient${res.sent === 1 ? "" : "s"} ✓`);
    });
  };

  const saveLabel = (st: SaveState | undefined) =>
    st === "saving" ? "Saving..." : st === "saved" ? "Saved ✓" : st === "dirty" ? "Unsaved" : "";
  const anyUnsaved = Object.values(status).some((s) => s === "dirty" || s === "saving");

  const editable = (e: EodLine, num: number) => (
    <div key={keyOf(e)} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, marginBottom: 8, background: "#FAFBFD" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          {num > 0 ? `${e.kind === "system" ? "System" : "Unit"} ${num}: ` : ""}<span className="mono">{e.label}</span>
        </span>
        {e.kind === "asset" && <span className="pill neutral">unit</span>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span className="mut" style={{ fontSize: 11 }}>{saveLabel(status[keyOf(e)])}</span>
          {canAutofill(e) && (
            <button className="btn link" onClick={() => autofill(e)} disabled={pending} title="Draft from today's activity and open items">autofill</button>
          )}
          <button className="btn link" style={{ color: "#A32D2D" }} disabled={pending}
            onClick={() => startTransition(() => setEodSkip(targetOf(e), true))}>skip</button>
        </div>
      </div>
      <label style={{ fontSize: 11 }}>System Update</label>
      <textarea rows={2} value={drafts[keyOf(e)]?.systemUpdate ?? ""}
        onChange={(ev) => setDraft(e, { systemUpdate: ev.target.value })}
        onBlur={() => { if (status[keyOf(e)] === "dirty") flush(e); }}
        placeholder={e.suggestedUpdate || "What happened today"}
        style={{ marginBottom: 8, resize: "vertical" }} />
      <label style={{ fontSize: 11 }}>Action Item</label>
      <input value={drafts[keyOf(e)]?.actionItem ?? ""}
        onChange={(ev) => setDraft(e, { actionItem: ev.target.value })}
        onBlur={() => { if (status[keyOf(e)] === "dirty") flush(e); }}
        placeholder={e.suggestedAction || "Next step / what we need"} />
    </div>
  );

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <div className="card-title">{clientName}</div>
        <span className="mut" style={{ fontSize: 12 }}>{dateMDY}</span>
        {sentInfo && <span style={{ fontSize: 12, color: "#2E6B2E", fontWeight: 700 }}>{sentInfo} ✓</span>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {!readOnly && (
            <button className="btn sm accent" onClick={send} disabled={pending || anyUnsaved || !canSend || !filled.length}
              title={canSend ? `Emails ${clientName}'s recipients, with portal links per line` : `Add ${clientName}'s recipients in Settings first`}>
              {pending ? "..." : `Send to ${clientName}`}
            </button>
          )}
          <button className="btn sm primary" onClick={copy} disabled={!filled.length}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
      </div>
      {sendMsg && (
        <div style={{ fontSize: 12, marginBottom: 8, color: sendMsg.endsWith("✓") ? "#2E6B2E" : "#A32D2D" }}>{sendMsg}</div>
      )}
      {!canSend && !readOnly && (
        <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>No recipients set for {clientName} yet - add them in Settings.</div>
      )}

      {/* Read-only days never render the blanks, so their emptiness has to be
          said out loud - an empty card reads as a broken page. */}
      {filled.length === 0 && (readOnly || blanks.length === 0) && (
        <div className="mut" style={{ fontSize: 13 }}>
          {readOnly ? "Nothing was recorded for this client on this day." : "Nothing to report."}
        </div>
      )}

      {filled.map((e, i) => (readOnly ? (
        <div key={keyOf(e)} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, marginBottom: 8, background: "#FAFBFD" }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
            {e.kind === "system" ? "System" : "Unit"} {i + 1}: <span className="mono">{e.label}</span>
          </div>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <span className="eyebrow" style={{ marginRight: 6 }}>Update</span>{e.systemUpdate || <span className="mut">(blank)</span>}
          </div>
          <div style={{ fontSize: 13 }}>
            <span className="eyebrow" style={{ marginRight: 6 }}>Action</span>{e.actionItem || <span className="mut">(blank)</span>}
          </div>
        </div>
      ) : editable(e, i + 1)))}

      {!readOnly && blanks.length > 0 && (
        <>
          <button className="btn link" style={{ marginTop: 4 }} onClick={() => setShowBlanks((v) => !v)}>
            {showBlanks ? "Hide" : "Show"} {blanks.length} with nothing written yet
          </button>
          {showBlanks && <div style={{ marginTop: 8 }}>{blanks.map((e) => editable(e, 0))}</div>}
        </>
      )}

      {skipped.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
          <span className="mut" style={{ fontSize: 11 }}>Skipped:</span>
          {skipped.map((e) => (
            <span key={keyOf(e)} className="pill neutral" style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
              {e.externalId}
              {!readOnly && (
                <button className="btn link" style={{ fontSize: 10 }} disabled={pending}
                  onClick={() => startTransition(() => setEodSkip(targetOf(e), false))}>include</button>
              )}
            </span>
          ))}
        </div>
      )}

      {filled.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="mut" style={{ fontSize: 12, cursor: "pointer" }}>Email preview</summary>
          <pre style={{
            fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "#F5F7FA",
            border: "1px solid var(--line)", borderRadius: 8, padding: 12, margin: "8px 0 0",
          }}>{emailText}</pre>
        </details>
      )}
    </div>
  );
}
