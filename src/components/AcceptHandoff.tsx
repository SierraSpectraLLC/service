"use client";

import { useState, useTransition } from "react";
import { acceptHandoff } from "@/app/actions";
import { companyProblems } from "@/lib/handoff";
import { DialogStatus } from "@/components/ui/Dialog";

/**
 * The conversion, and it asks for exactly one thing.
 *
 * A sign-up form is where this kind of offer dies. Everything else Ridgeline
 * needs is already known - the address came off the invitation, the client
 * came off the snapshot - so the only fact missing is what this company is
 * called, and asking for a password on top of it would be asking somebody to
 * commit before they have seen anything work.
 *
 * So: one field, one button, and the button says what actually happens. The
 * account arrives by email the way every other sign-in here does.
 */
export default function AcceptHandoff({ token, email, fromName }: {
  token: string;
  /** Fixed on the invitation. Shown, never editable - it is where the keys go. */
  email: string;
  fromName: string;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  const problem = companyProblems(name)[0] ?? null;

  const accept = () =>
    start(async () => {
      setError("");
      const res = await acceptHandoff(token, { companyName: name });
      if (res.error) { setError(res.error); return; }
      setDone(true);
    });

  if (done) {
    return (
      <div className="t-body">
        <b>{name} is on Ridgeline.</b>
        <div style={{ marginTop: 6 }}>
          The client is already in your workspace - the sites, the systems and the
          serials {fromName} had on file. We have sent a sign-in link to{" "}
          <span className="mono">{email}</span>; no password to choose.
        </div>
        <a className="btn accent" style={{ marginTop: 12, textDecoration: "none" }} href="/login">
          Sign in
        </a>
      </div>
    );
  }

  return (
    <>
      <label>Your company&apos;s name</label>
      <input value={name} aria-label="Your company's name" disabled={pending}
        placeholder="Your Instrument Service Co."
        onChange={(e) => setName(e.target.value)} />
      <div className="field-hint">
        It goes on your work orders, quotes and invoices. You can change it later.
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
        <button className="btn accent" onClick={accept} disabled={pending || !!problem}>
          {pending ? "Opening your workspace…" : "Accept the full client in Ridgeline"}
        </button>
        <DialogStatus error={error} problem={problem} ok="" />
      </div>
      <div className="mut t-meta" style={{ marginTop: 8 }}>
        Signs you in as <span className="mono">{email}</span> - the address {fromName} sent
        this to. No card, no password.
      </div>
    </>
  );
}
