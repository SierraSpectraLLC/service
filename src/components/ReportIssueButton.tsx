"use client";

import { useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import { reportIssue } from "@/app/actions";

/**
 * One press when something is wrong.
 *
 * Everything that should follow a client saying "this is broken" follows from
 * here: the system is marked as needing maintenance, it moves into the queue of
 * whoever services it, a task exists to work from, the words land on the record
 * as a post either side can add to, and the people who fix things are told.
 *
 * Files upload before the report is filed, so a photo of an error dialog arrives
 * with it rather than after it - which is the difference between a report and a
 * conversation that starts "can you send a screenshot".
 */
const SEVERITIES = [
  { key: "Down", label: "Down", hint: "Not usable at all" },
  { key: "Degraded", label: "Something's wrong", hint: "Usable, but not right" },
  { key: "Question", label: "A question", hint: "Nothing is broken" },
] as const;

export default function ReportIssueButton({ instrumentId, externalId }: {
  instrumentId: number; externalId: string;
}) {
  const [open, setOpen] = useState(false);
  const [severity, setSeverity] = useState<string>("Degraded");
  const [summary, setSummary] = useState("");
  const [details, setDetails] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  const close = () => {
    setOpen(false); setError(""); setDone(false);
    setSummary(""); setDetails(""); setFiles([]); setSeverity("Degraded");
  };

  const submit = () => {
    setError("");
    startTransition(async () => {
      try {
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
        const res = await reportIssue(instrumentId, { severity, summary, details, files: uploaded });
        if (res?.error) { setError(res.error); return; }
        setDone(true);
      } catch (e) {
        setError((e as Error).message || "Couldn't send that.");
      } finally {
        setBusy("");
      }
    });
  };

  if (!open) {
    return (
      <button className="btn sm" style={{ flexShrink: 0, borderColor: "#E4B4B4", color: "#A32D2D" }}
        onClick={() => setOpen(true)}>Report a problem</button>
    );
  }

  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`Report a problem with ${externalId}`}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Report a problem</div>
          <span className="mut" style={{ fontSize: 12 }}>{externalId}</span>
          <button className="btn link" style={{ marginLeft: "auto", fontSize: 12 }} onClick={close}>close</button>
        </div>

        {done ? (
          <div>
            <div style={{ fontSize: 13, color: "#2E6B2E", fontWeight: 700, marginBottom: 6 }}>Sent ✓</div>
            <div className="mut" style={{ fontSize: 12.5, marginBottom: 12 }}>
              {externalId} is marked as needing maintenance and is in the service queue. Your note is on the
              system&apos;s discussion, so you can add to it there.
            </div>
            <button className="btn sm accent" onClick={close}>Done</button>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {SEVERITIES.map((s) => (
                <button key={s.key} type="button" onClick={() => setSeverity(s.key)}
                  className={severity === s.key ? "btn sm accent" : "btn sm"}
                  title={s.hint} style={{ flex: "1 1 100px" }}>{s.label}</button>
              ))}
            </div>

            <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>
              What&apos;s wrong?
            </label>
            <input value={summary} onChange={(e) => setSummary(e.target.value)} autoFocus
              placeholder="Lamp won't ignite" maxLength={160}
              style={{ width: "100%", fontSize: 13, marginBottom: 10 }} />

            <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>
              Anything else? <span className="mut" style={{ fontWeight: 400 }}>Optional</span>
            </label>
            <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={4}
              placeholder="Error code, when it started, what you were running"
              style={{ width: "100%", fontSize: 13, marginBottom: 10 }} />

            <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>
              Photos, screenshots or log files <span className="mut" style={{ fontWeight: 400 }}>Optional</span>
            </label>
            <input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 10))}
              style={{ fontSize: 12, marginBottom: files.length ? 6 : 12 }} />
            {files.length > 0 && (
              <div className="mut" style={{ fontSize: 11, marginBottom: 12 }}>
                {files.map((f) => f.name).join(", ")}
              </div>
            )}

            {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 10 }}>{error}</div>}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="btn sm accent" disabled={pending || !summary.trim()} onClick={submit}>
                {busy || (pending ? "Sending..." : "Send")}
              </button>
              <button className="btn sm" disabled={pending} onClick={close}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
