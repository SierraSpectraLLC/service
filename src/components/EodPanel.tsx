"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deleteOffSystemWork, logOffSystemWork, saveEodUpdate, setEodInternal, setEodSkip, sendEodEmail,
} from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import EmailPreview from "@/components/ui/EmailPreview";
import Dialog from "@/components/ui/Dialog";
import { Field, Panel } from "@/components/ui";

/**
 * One line on a client's report: a system, a standalone asset, or work that
 * happened off the board entirely - a call taken, a question answered.
 */
export type EodLine = {
  kind: "system" | "asset" | "offsystem";
  id: number;
  externalId: string;
  label: string;
  systemUpdate: string;
  actionItem: string;
  skipped: boolean;
  /** Written for our own bench: kept here, kept out of the client's report. */
  internal: boolean;
  written: boolean;
  suggestedUpdate: string;
  suggestedAction: string;
  /** offsystem only: who did it, and how long it took. */
  person?: string;
  minutes?: number;
};
type Draft = { systemUpdate: string; actionItem: string };
type SaveState = "dirty" | "saving" | "saved";

const SEP = "-".repeat(50);
const AUTOSAVE_MS = 900;
const keyOf = (e: EodLine) => `${e.kind}:${e.id}`;
/**
 * How to address this line when writing to it. Off-system work has no record
 * behind it, so it is addressed by its own row id; everything else by what it
 * is about.
 */
const targetOf = (e: EodLine) =>
  e.kind === "offsystem" ? { instrumentId: null, assetId: null, eodId: e.id }
    : e.kind === "system" ? { instrumentId: e.id, assetId: null }
      : { instrumentId: null, assetId: e.id };

/** The word for this line in the report, and on this page. */
const nounOf = (e: EodLine) =>
  e.kind === "system" ? "System" : e.kind === "asset" ? "Unit" : "Support";

/** "Bill · 30 min", or as much of it as was filled in. */
const bylineOf = (e: EodLine) =>
  [e.person, e.minutes ? `${e.minutes} min` : ""].filter(Boolean).join(" · ");

/**
 * A blank log, with the person pre-filled to whoever is typing.
 *
 * Not empty: the overwhelmingly common case is logging your own call, and a
 * required picker that starts unset makes everybody answer a question they
 * had already answered by being signed in. `me` only survives if it is
 * somebody the directory actually knows - a name that fails the same check
 * the server applies would just fail at save.
 */
/** The directory as a picker: organizations in the order they arrived, people sorted. */
function byOrg(people: { name: string; org: string }[]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const p of people) {
    const key = p.org || "Unassigned";
    groups.set(key, [...(groups.get(key) ?? []), p.name]);
  }
  return [...groups].map(([org, names]) => [org, names.sort((a, b) => a.localeCompare(b))]);
}

const blankLog = (me: string, known: Set<string>) => ({
  title: "", person: known.has(me) ? me : "", minutes: "", systemUpdate: "", actionItem: "",
});

/**
 * One client's daily report: the work they own, the updates written on those
 * systems and assets today, and a send button aimed at their own recipients.
 * Lines can be edited here too, but the primary place to write one is the
 * system's or asset's own page - anything written there shows up here.
 */
export default function EodPanel({
  clientName, orgId, entries, dateMDY, writeOn = "", canSend = false, recipientCount = 0, sentInfo = "",
  emailSubject = "", emailHtml = "", recipients = [], people = [], me = "",
}: {
  clientName: string; orgId: number | null; entries: EodLine[]; dateMDY: string;
  /** Who there is to name, scoped by lib/directory - never a free-text roster. */
  people?: { name: string; org: string }[];
  /** The signed-in person, who did the work often enough to be the default. */
  me?: string;
  /**
   * The day these lines are about, when it is not today. Blank is today, which
   * is what every save meant before a past day could be written.
   *
   * Replaces a readOnly flag: a past day used to be unwritable, so "which day"
   * and "may I type" were the same question. They are not, and the date is the
   * one the save has to carry.
   */
  writeOn?: string;
  canSend?: boolean; recipientCount?: number; sentInfo?: string;
  /** The composed report, so the preview shows the bytes that would be sent. */
  emailSubject?: string; emailHtml?: string; recipients?: string[];
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(
    Object.fromEntries(entries.map((e) => [keyOf(e), { systemUpdate: e.systemUpdate, actionItem: e.actionItem }]))
  );
  const [status, setStatus] = useState<Record<string, SaveState>>({});
  const [copied, setCopied] = useState(false);
  const [sendMsg, setSendMsg] = useState("");
  const [showBlanks, setShowBlanks] = useState(false);
  const [logging, setLogging] = useState(false);
  // The names this panel may offer, and the same set the server will accept.
  const known = new Set(people.map((p) => p.name));
  const [log, setLog] = useState(() => blankLog(me, known));
  const [logErr, setLogErr] = useState("");
  const [pending, startTransition] = useTransition();
  // Logging and removing off-system work change the SET of lines, not the text
  // on one, so the panel has to re-read them. (Autosave deliberately does not -
  // see saveEodUpdate: revalidating on every typing pause re-fetches the page
  // under the caret.)
  const router = useRouter();

  // Autosave: debounce while typing, flush on blur. The ref keeps the timer
  // callbacks reading the latest draft, not the one they closed over.
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  /**
   * The draft for a line, falling back to what the server sent.
   *
   * `drafts` is seeded once at mount, so a line that appears AFTER mount - work
   * logged off-system from the dialog, or an update written on a system's own
   * page in another tab - had no entry in it. Everything downstream read that
   * absence as "nothing written", and a line with a paragraph on it filed
   * itself under "nothing written yet". Reading through to the entry fixes it
   * without resetting anything already typed here.
   */
  const draftOf = (e: EodLine): Draft =>
    drafts[keyOf(e)] ?? { systemUpdate: e.systemUpdate, actionItem: e.actionItem };

  const flush = (e: EodLine) => {
    const k = keyOf(e);
    if (timers.current[k]) { clearTimeout(timers.current[k]); delete timers.current[k]; }
    const d = draftsRef.current[k] ?? { systemUpdate: e.systemUpdate, actionItem: e.actionItem };
    setStatus((s) => ({ ...s, [k]: "saving" }));
    startTransition(async () => {
      const res = await saveEodUpdate(targetOf(e), d, writeOn || undefined);
      // A refusal used to be invisible here, which was survivable while every
      // save was for today and could not be refused. A backdated one can.
      if (res?.error) {
        setStatus((s) => ({ ...s, [k]: "dirty" }));
        toast({ message: res.error });
        return;
      }
      // Typed again mid-flight? Stay dirty; the newer edit's timer saves it.
      setStatus((s) => (s[k] === "dirty" ? s : { ...s, [k]: "saved" }));
    });
  };

  const setDraft = (e: EodLine, patch: Partial<Draft>) => {
    const k = keyOf(e);
    setDrafts((d) => ({ ...d, [k]: { ...(d[k] ?? { systemUpdate: e.systemUpdate, actionItem: e.actionItem }), ...patch } }));
    setStatus((s) => ({ ...s, [k]: "dirty" }));
    if (timers.current[k]) clearTimeout(timers.current[k]);
    timers.current[k] = setTimeout(() => flush(e), AUTOSAVE_MS);
  };

  const hasText = (e: EodLine) => {
    const d = draftOf(e);
    return !!(d.systemUpdate || d.actionItem);
  };
  const included = entries.filter((e) => !e.skipped);
  // Written first - that's what the email will actually carry.
  const filled = included.filter(hasText);
  const blanks = included.filter((e) => !hasText(e));
  const skipped = entries.filter((e) => e.skipped);

  // Fill only what's empty - a suggestion never overwrites something typed.
  const autofill = (e: EodLine) => {
    const d = draftOf(e);
    setDraft(e, {
      systemUpdate: d.systemUpdate || e.suggestedUpdate,
      actionItem: d.actionItem || e.suggestedAction,
    });
  };
  const canAutofill = (e: EodLine) => {
    const d = draftOf(e);
    return (!d.systemUpdate && !!e.suggestedUpdate) || (!d.actionItem && !!e.suggestedAction);
  };

  const emailText = [
    `${dateMDY} - Daily Updates`, "", SEP,
    ...filled.flatMap((e, i) => [
      `${nounOf(e)} ${i + 1}: ${e.label}${e.kind === "offsystem" && bylineOf(e) ? ` (${bylineOf(e)})` : ""}`, "",
      `${e.kind === "offsystem" ? "What happened" : "System Update"}: ${draftOf(e).systemUpdate}`,
      `Action Item: ${draftOf(e).actionItem}`, "", SEP,
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
      if (res?.error) { setSendMsg(res.error); return; }
      setSendMsg(`Sent to ${res.sent} recipient${res.sent === 1 ? "" : "s"} ✓`);
      toast({ message: `Sent the report to ${res.sent} recipient${res.sent === 1 ? "" : "s"}` });
    });
  };

  const saveLabel = (st: SaveState | undefined) =>
    st === "saving" ? "Saving..." : st === "saved" ? "Saved ✓" : st === "dirty" ? "Unsaved" : "";
  const anyUnsaved = Object.values(status).some((s) => s === "dirty" || s === "saving");

  const editable = (e: EodLine, num: number) => (
    <div key={keyOf(e)} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, marginBottom: 8, background: "#FAFBFD" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span className="t-body" style={{ fontWeight: 700 }}>
          {num > 0 ? `${nounOf(e)} ${num}: ` : ""}<span className="mono">{e.label}</span>
        </span>
        {e.kind === "asset" && <span className="pill neutral">unit</span>}
        {e.kind === "offsystem" && <span className="pill info">off-system</span>}
        {e.kind === "offsystem" && bylineOf(e) && <span className="mut t-meta">{bylineOf(e)}</span>}
        {e.internal && <span className="pill warn">internal only</span>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span className="mut t-meta">{saveLabel(status[keyOf(e)])}</span>
          {canAutofill(e) && (
            <button className="btn link" onClick={() => autofill(e)} disabled={pending} title="Draft from today's activity and open items">autofill</button>
          )}
          {/* Two different "not in the email": internal keeps the line on our
              own screens and off theirs; skip drops it from today entirely. */}
          <button className="btn link" disabled={pending}
            aria-label={`${e.internal ? "Include" : "Make internal"}: ${e.label}`}
            title={e.internal ? "Include it in the client's report" : "Keep this line off the client's report"}
            onClick={() => startTransition(async () => {
              await setEodInternal(targetOf(e), !e.internal);
              toast({ message: e.internal ? `${e.externalId} goes to the client` : `${e.externalId} is internal only` });
            })}>{e.internal ? "internal only" : "make internal"}</button>
          {e.kind === "offsystem" ? (
            // Delete, not skip: nothing underneath it to come back to.
            <button className="btn link" style={{ color: "var(--t-bad-fg)" }} disabled={pending}
              aria-label={`Remove ${e.label}`}
              onClick={async () => {
                if (!(await confirmDialog({
                  title: `Remove "${e.label}" from the day?`,
                  body: "It is not attached to a system, so nothing keeps a copy.",
                  action: "Remove",
                  tone: "bad",
                }))) return;
                startTransition(async () => {
                  const res = await deleteOffSystemWork(e.id);
                  toast({ message: res?.error ?? `Removed ${e.label}` });
                  router.refresh();
                });
              }}>remove</button>
          ) : (
            <button className="btn link" style={{ color: "var(--t-bad-fg)" }} disabled={pending}
              aria-label={`Skip ${e.externalId}`}
              onClick={() => startTransition(async () => {
                await setEodSkip(targetOf(e), true);
                toast({ message: `Skipped ${e.externalId}` });
              })}>skip</button>
          )}
        </div>
      </div>
      <Field label={e.kind === "offsystem" ? "What happened" : "System Update"}>
        <textarea rows={2} value={draftOf(e).systemUpdate}
          onChange={(ev) => setDraft(e, { systemUpdate: ev.target.value })}
          onBlur={() => { if (status[keyOf(e)] === "dirty") flush(e); }}
          placeholder={e.suggestedUpdate || (e.kind === "offsystem" ? "What was asked, and what you told them" : "What happened today")}
          style={{ resize: "vertical" }} />
      </Field>
      <Field label="Action Item">
        <input value={draftOf(e).actionItem}
          onChange={(ev) => setDraft(e, { actionItem: ev.target.value })}
          onBlur={() => { if (status[keyOf(e)] === "dirty") flush(e); }}
          placeholder={e.suggestedAction || "Next step / what we need"} />
      </Field>
    </div>
  );

  return (
    <Panel title={clientName}
      /* The date was decoration while a past day was read-only. It is now the
         thing that says where what you type is going, so a backdated panel
         says so in words rather than leaving the reader to notice a date. */
      hint={<>
        {dateMDY}
        {writeOn && <span style={{ color: "var(--t-warn-fg)", fontWeight: 700 }}> · writing this day, not today</span>}
        {sentInfo && <span style={{ color: "var(--t-good-fg)", fontWeight: 700 }}> · {sentInfo} ✓</span>}
      </>}
      actions={
        <>
          {!writeOn && (
            <button className="btn sm accent" onClick={send} disabled={pending || anyUnsaved || !canSend || !filled.length}
              title={canSend ? `Emails ${clientName}'s recipients, with portal links per line` : `Add ${clientName}'s recipients in Settings first`}>
              {pending ? "..." : `Send to ${clientName}`}
            </button>
          )}
          <button className="btn sm" onClick={() => { setLog(blankLog(me, known)); setLogErr(""); setLogging(true); }}
            title={`Something you did for ${clientName} that no system covers`}>
            + Log work
          </button>
          <button className="btn sm primary" onClick={copy} disabled={!filled.length}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </>
      }>
      {sendMsg && (
        <div className="t-small" style={{ marginBottom: 8, color: sendMsg.endsWith("✓") ? "#2E6B2E" : "#A32D2D" }}>{sendMsg}</div>
      )}
      {!canSend && !writeOn && (
        <div className="mut t-meta" style={{ marginBottom: 8 }}>No recipients set for {clientName} yet - add them in Settings.</div>
      )}

      {/* A past day usually has nothing on it at all, so its emptiness has to
          be said out loud - an empty card reads as a broken page. */}
      {filled.length === 0 && blanks.length === 0 && (
        <div className="mut t-body">
          {writeOn ? "Nothing was recorded for this client on this day." : "Nothing to report."}
        </div>
      )}

      {filled.map((e, i) => editable(e, i + 1))}

      {blanks.length > 0 && (
        <>
          <button className="btn link" style={{ marginTop: 4 }} onClick={() => setShowBlanks((v) => !v)}>
            {showBlanks ? "Hide" : "Show"} {blanks.length} with nothing written yet
          </button>
          {showBlanks && <div style={{ marginTop: 8 }}>{blanks.map((e) => editable(e, 0))}</div>}
        </>
      )}

      {skipped.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
          <span className="mut t-meta">Skipped:</span>
          {skipped.map((e) => (
            <span key={keyOf(e)} className="pill neutral" style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
              {e.externalId}
              <button className="btn link" style={{ fontSize: 10 }} disabled={pending}
                onClick={() => startTransition(async () => {
                  await setEodSkip(targetOf(e), false);
                  toast({ message: `Included ${e.externalId}` });
                })}>include</button>
            </span>
          ))}
        </div>
      )}

      <Dialog open={logging} onClose={() => setLogging(false)}
        title={`Log work done off-system${writeOn ? ` on ${dateMDY}` : ""}`}
        context={clientName}
        footer={
          <>
            <span className="dialog-status">
              {logErr || (log.title.trim()
                ? `Goes on ${clientName}'s report for today.`
                : "Say what the work was.")}
            </span>
            <button className="btn" onClick={() => setLogging(false)}>Cancel</button>
            <button className="btn accent" disabled={pending || !log.title.trim()}
              onClick={() => startTransition(async () => {
                const res = await logOffSystemWork(orgId, {
                  title: log.title, person: log.person,
                  minutes: parseInt(log.minutes, 10) || 0,
                  systemUpdate: log.systemUpdate, actionItem: log.actionItem,
                }, writeOn || undefined);
                if (res?.error) { setLogErr(res.error); return; }
                setLogging(false);
                toast({ message: `Logged "${log.title.trim()}"` });
                router.refresh();
              })}>
              {pending ? "..." : "Log it"}
            </button>
          </>
        }>
        <div className="mut t-small" style={{ marginBottom: 10 }}>
          For work with no system behind it - a call taken, a question answered,
          somebody talked through a problem. It joins today&apos;s report like any
          other line, and can be kept internal.
        </div>
        <Field label="What was it" hint="Shows as the line's heading" htmlFor="log-title">
          <input id="log-title" value={log.title} autoFocus
            onChange={(e) => setLog((l) => ({ ...l, title: e.target.value }))}
            placeholder="Phone support - tune report question" />
        </Field>
        <div className="row-2" style={{ gap: 10 }}>
          {/* A picker, not a text box. "Bill", "bill" and "Bill R." were three
              people to every report that counted by name, and the one thing
              they could never be was a link to an actual account. The list is
              lib/directory's, scoped to who this viewer may name, and grouped
              by organization so the shop's own people read as distinct from a
              client's. */}
          <Field label="Who did it" htmlFor="log-person"
            hint={people.length ? undefined : "Nobody to pick yet - add people in Settings."}>
            <select id="log-person" value={log.person} disabled={!people.length}
              onChange={(e) => setLog((l) => ({ ...l, person: e.target.value }))}>
              <option value="">Not recorded</option>
              {byOrg(people).map(([org, names]) => (
                <optgroup key={org} label={org}>
                  {names.map((n) => <option key={n} value={n}>{n}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Minutes" hint="For the record - it does not bill" htmlFor="log-minutes">
            <input id="log-minutes" value={log.minutes} inputMode="numeric"
              onChange={(e) => setLog((l) => ({ ...l, minutes: e.target.value.replace(/[^0-9]/g, "") }))}
              placeholder="30" />
          </Field>
        </div>
        <Field label="What happened" htmlFor="log-happened">
          <textarea id="log-happened" rows={3} value={log.systemUpdate} style={{ resize: "vertical" }}
            onChange={(e) => setLog((l) => ({ ...l, systemUpdate: e.target.value }))}
            placeholder="What was asked, and what you told them" />
        </Field>
        <Field label="Action Item" htmlFor="log-action">
          <input id="log-action" value={log.actionItem}
            onChange={(e) => setLog((l) => ({ ...l, actionItem: e.target.value }))}
            placeholder="Next step / what we need" />
        </Field>
      </Dialog>

      {filled.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="mut t-small" style={{ cursor: "pointer" }}>Email preview</summary>
          <div style={{ marginTop: 8 }}>
            {emailHtml
              ? <EmailPreview subject={emailSubject} html={emailHtml} to={recipients} />
              : <div className="mut t-small">Nothing written yet - the report has no lines to render.</div>}
          </div>
        </details>
      )}
    </Panel>
  );
}
