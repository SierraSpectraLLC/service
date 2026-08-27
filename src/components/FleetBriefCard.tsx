"use client";

import { useState, useTransition } from "react";
import { createFleetShare, emailFleetBrief, fleetBriefText } from "@/app/actions";
import { DEFAULT_LINK_DAYS, MAX_LINK_DAYS, addDaysIso } from "@/lib/dropShare";
import { MAX_RECIPIENTS } from "@/lib/fleetBrief";
import { Panel } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

/**
 * Tell a peer service company what this client runs.
 *
 * Three doors, one composer. Copy puts the text on the clipboard, Email sends
 * the same text as an email, and Share link hands over a page that shows the
 * same list live. They cannot disagree because none of them assembles anything
 * - the server composes once (lib/fleetBrief) and each door is a delivery.
 * That is the specific mistake this avoids: the EOD panel's copy button and its
 * mailer filtered different things, so the clipboard quietly carried lines the
 * email had been dropping.
 *
 * The text under the buttons is not reassurance, it is the answer to the first
 * question anybody sensible asks before sending a client's equipment list to a
 * competitor: what exactly is in this?
 */
export default function FleetBriefCard({ orgId, orgName, systems, today }: {
  orgId: number;
  orgName: string;
  systems: number;
  today: string;
}) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [to, setTo] = useState("");
  const [withLink, setWithLink] = useState(true);
  const [expiresOn, setExpiresOn] = useState(addDaysIso(today, DEFAULT_LINK_DAYS));
  const [preview, setPreview] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");

  const copy = () =>
    startTransition(async () => {
      setError("");
      const res = await fleetBriefText(orgId, note);
      if (res.error || !res.text) { setError(res.error ?? "Nothing to copy"); return; }
      // Shown as well as copied. A clipboard write that silently fails - and
      // they do, outside a secure context - would otherwise look like success.
      setPreview(res.text);
      try {
        await navigator.clipboard.writeText(res.text);
        toast({ message: `${res.systems} systems copied` });
      } catch {
        toast({ message: "Select the text below and copy it" });
      }
    });

  const send = () =>
    startTransition(async () => {
      setError("");
      const res = await emailFleetBrief(orgId, { to, note, withLink, expiresOn });
      if (res.error) { setError(res.error); return; }
      toast({ message: `Sent to ${res.sent} ${res.sent === 1 ? "address" : "addresses"}` });
      setTo("");
    });

  const share = () =>
    startTransition(async () => {
      setError("");
      const res = await createFleetShare(orgId, { label: `${orgName} fleet`, expiresOn });
      if (res.error || !res.token) { setError(res.error ?? "That didn't save"); return; }
      const url = `${window.location.origin}/share/${res.token}`;
      setLink(url);
      try { await navigator.clipboard.writeText(url); toast({ message: "Link copied" }); }
      catch { toast({ message: "Link ready below" }); }
    });

  return (
    <Panel
      title="Share this fleet"
      hint="For a peer service company. Equipment only - no prices, no notes, no contacts."
    >
      <div className="mut t-small" style={{ marginBottom: 10 }}>
        {systems === 0
          ? "No systems on file for this client yet."
          : `${systems} system${systems === 1 ? "" : "s"}, with their modules, models and serials, `
            + "plus which of them somebody already has a contract on."}
      </div>

      <label>A line of context</label>
      <input value={note} aria-label="Note" disabled={pending}
        placeholder="we cover the MS stack, they asked about the LCs"
        onChange={(e) => setNote(e.target.value)} />

      <div className="pf2" style={{ marginTop: 10 }}>
        <div>
          <label>Email it to</label>
          <input value={to} aria-label="Send to" disabled={pending}
            placeholder="peer@theirshop.com"
            onChange={(e) => setTo(e.target.value)} />
          <div className="field-hint">Up to {MAX_RECIPIENTS} addresses. Written into the record.</div>
        </div>
        <div>
          <label>A link stops working on</label>
          <input type="date" value={expiresOn} aria-label="Link expires on" disabled={pending}
            onChange={(e) => setExpiresOn(e.target.value)} />
          <div className="field-hint">At most {MAX_LINK_DAYS} days. Revocable any time.</div>
        </div>
      </div>

      <label className="t-small" style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
        <input type="checkbox" className="check" checked={withLink} disabled={pending}
          onChange={(e) => setWithLink(e.target.checked)} />
        include a link to the live list in the email
      </label>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <button className="btn" onClick={copy} disabled={pending || systems === 0}>Copy</button>
        <button className="btn accent" onClick={send} disabled={pending || systems === 0 || !to.trim()}>
          {pending ? "Working..." : "Email it"}
        </button>
        <button className="btn" onClick={share} disabled={pending || systems === 0}>Share link</button>
        {error && <span className="t-small" style={{ color: "var(--t-bad-fg)" }}>{error}</span>}
      </div>

      {link && (
        <div className="mut t-small mono" style={{ marginTop: 10, wordBreak: "break-all" }}>
          {link}
        </div>
      )}
      {preview && (
        <>
          <div className="dialog-section" style={{ marginTop: 12 }}>What gets sent</div>
          <textarea readOnly value={preview} rows={14} aria-label="The brief"
            className="mono t-small" style={{ width: "100%" }} />
        </>
      )}
    </Panel>
  );
}
