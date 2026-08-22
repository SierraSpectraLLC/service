"use client";

import { useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import { reportIssue, requestPm } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { PM_WINDOWS } from "@/lib/pmRequest";

/**
 * One button: ask the service team for something.
 *
 * It used to be two - "Report a problem" and "Request maintenance" - sitting
 * side by side and asking somebody to classify their own situation before they
 * had said anything. From the client's side it is one act: a choice, a
 * sentence, send. Which of the four they pick decides what follows, and only
 * then does the form differ - a fault carries evidence and a severity, upkeep
 * carries a horizon and touches no schedule (see requestPm).
 *
 * Files upload before the report is filed, so a photo of an error dialog arrives
 * with it rather than after it - which is the difference between a report and a
 * conversation that starts "can you send a screenshot".
 */
const PM = "pm";

const NEEDS = [
  { key: "Down", label: "Down", hint: "Not usable at all" },
  { key: "Degraded", label: "Something's wrong", hint: "Usable, but not right" },
  { key: "Question", label: "A question", hint: "Nothing is broken" },
  { key: PM, label: "Request PM", hint: "Planned maintenance, nothing is wrong" },
] as const;

export default function ClientRequest({ instrumentId, externalId, nextPm }: {
  instrumentId: number; externalId: string;
  /** What the calendar already says, so a request isn't made blind. */
  nextPm?: string;
}) {
  const [open, setOpen] = useState(false);
  // What they are asking for, and - once they ask for upkeep - how soon.
  const [choice, setChoice] = useState<string>("Degraded");
  const [pmWindow, setPmWindow] = useState<string>("month");
  const [summary, setSummary] = useState("");
  const [details, setDetails] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState<"" | "filed" | "already">("");
  // The work order the ask opened. It is the thing to quote on the phone, so it
  // is shown once, here, rather than only being findable later.
  const [number, setNumber] = useState("");
  const [pending, startTransition] = useTransition();

  const isPm = choice === PM;
  const title = "Request service";
  // The first unmet requirement, in plain words, live in the footer.
  const problem = !isPm && !summary.trim() ? "say what's wrong" : null;

  const close = () => {
    setOpen(false); setError(""); setDone(""); setNumber("");
    setSummary(""); setDetails(""); setFiles([]); setChoice("Degraded"); setPmWindow("month");
  };

  const submit = () => {
    setError("");
    startTransition(async () => {
      try {
        if (isPm) {
          setBusy("Sending...");
          const res = await requestPm(instrumentId, { window: pmWindow, note: details });
          if (res?.error) { setError(res.error); return; }
          setNumber(res?.number ?? "");
          setDone(res?.already ? "already" : "filed");
          return;
        }
        // Uploaded first, and named in the report, so a partial failure is
        // visible here rather than being discovered as a report with no evidence.
        const uploaded: { fileName: string; url: string; size: number; kind: string }[] = [];
        for (const [i, f] of files.entries()) {
          setBusy(`Uploading ${i + 1} of ${files.length}...`);
          const blob = await upload(f.name, f, { access: "public", handleUploadUrl: "/api/upload" });
          uploaded.push({
            fileName: f.name, url: blob.url, size: f.size,
            kind: /\.(png|jpe?g|gif|webp|heic)$/i.test(f.name) ? "Photo" : "Other",
          });
        }
        setBusy("Sending...");
        const res = await reportIssue(instrumentId, { severity: choice, summary, details, files: uploaded });
        if (res?.error) { setError(res.error); return; }
        setNumber(res?.number ?? "");
        setDone("filed");
      } catch (e) {
        setError((e as Error).message || "Couldn't send that.");
      } finally {
        setBusy("");
      }
    });
  };

  if (!open) {
    return (
      <button className="btn sm" style={{ flexShrink: 0 }} onClick={() => setOpen(true)}>{title}</button>
    );
  }

  return (
    <Dialog open onClose={close} title={title} context={externalId}
      footer={done ? (
        <>
          <span className="dialog-status" />
          <button className="btn accent" onClick={close}>Done</button>
        </>
      ) : (
        <>
          <DialogStatus error={error} problem={problem} ok={busy} />
          <button className="btn" disabled={pending} onClick={close}>Cancel</button>
          <button className="btn accent" disabled={pending || !!problem} onClick={submit}>
            {isPm ? "Request a PM" : "Send to service"}
          </button>
        </>
      )}>
        {done ? (
          <div>
            <div className="t-body" style={{ color: "var(--t-good-fg)", fontWeight: 700, marginBottom: 6 }}>
              {done === "already" ? "Already asked ✓" : number ? `${number} opened ✓` : "Sent ✓"}
            </div>
            <div className="mut" style={{ fontSize: 12.5, marginBottom: 12 }}>
              {done === "already"
                ? `Maintenance is already requested for ${externalId} and it's with the service team. Your note is on the system's discussion.`
                : isPm
                  ? `${externalId} is in the service queue with your request on it. Follow ${number || "the work order"} under Work orders to see what's happening, and add to your note on the system's discussion.`
                  : `${externalId} is marked as needing maintenance and is in the service queue. Follow ${number || "the work order"} under Work orders to see what's happening, and add to your note on the system's discussion.`}
            </div>
          </div>
        ) : (
          <>
            <div className="dialog-section">What do you need</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {NEEDS.map((o) => (
                <button key={o.key} type="button" onClick={() => setChoice(o.key)}
                  className={choice === o.key ? "btn sm accent" : "btn sm"}
                  title={o.hint} style={{ flex: "1 1 100px" }}>{o.label}</button>
              ))}
            </div>

            {isPm ? (
              <>
                {/* How soon, asked only once upkeep is what they came for -
                    a horizon is meaningless against a broken instrument. */}
                <div className="dialog-section">How soon</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  {PM_WINDOWS.map((w) => (
                    <button key={w.key} type="button" onClick={() => setPmWindow(w.key)}
                      className={pmWindow === w.key ? "btn sm accent" : "btn sm"}
                      style={{ flex: "1 1 100px" }}>{w.label}</button>
                  ))}
                </div>
                {nextPm && <div className="mut t-small" style={{ marginBottom: 10 }}>{nextPm}</div>}
                <div className="dialog-section">Anything specific</div>
                <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={4} autoFocus
                  placeholder="Lamp is at 900 hours, and we'd like the column checked"
                  className="t-body" style={{ width: "100%", marginBottom: 12 }} />
              </>
            ) : (
              <>
                <div className="dialog-section">What&apos;s wrong</div>
                <input value={summary} onChange={(e) => setSummary(e.target.value)} autoFocus
                  placeholder="Lamp won't ignite" maxLength={160}
                  className="t-body" style={{ width: "100%", marginBottom: 10 }} />

                <label className="t-small" style={{ fontWeight: 700, display: "block", marginBottom: 4 }}>
                  Anything else? <span className="mut" style={{ fontWeight: 400 }}>Optional</span>
                </label>
                <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={4}
                  placeholder="Error code, when it started, what you were running"
                  className="t-body" style={{ width: "100%", marginBottom: 10 }} />

                <div className="dialog-section">Evidence</div>
                <label className="t-small" style={{ fontWeight: 700, display: "block", marginBottom: 4 }}>
                  Photos, screenshots or log files <span className="mut" style={{ fontWeight: 400 }}>Optional</span>
                </label>
                <input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 10))}
                  className="t-small" style={{ marginBottom: files.length ? 6 : 12 }} />
                {files.length > 0 && (
                  <div className="mut t-meta" style={{ marginBottom: 12 }}>
                    {files.map((f) => f.name).join(", ")}
                  </div>
                )}
              </>
            )}

          </>
        )}
    </Dialog>
  );
}
