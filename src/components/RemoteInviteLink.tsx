"use client";

import { useState, useTransition } from "react";
import { enrollRemoteDevice } from "@/app/actions";

/**
 * The 24-hour link for somebody without an account here.
 *
 * Deliberately generated on demand rather than rendered with the page: it is a
 * capability with an expiry, so it should start counting when you actually mean
 * to hand it over. The organization it belongs to is stated next to it, because
 * this is the one thing worth checking before pasting it into an email.
 */
export default function RemoteInviteLink({ orgId, orgName }: { orgId: number; orgName: string }) {
  const [pending, startTransition] = useTransition();
  const [link, setLink] = useState("");
  const [error, setError] = useState("");

  return (
    <div>
      <button className="btn sm" disabled={pending}
        onClick={() => {
          setError(""); setLink("");
          startTransition(async () => {
            const res = await enrollRemoteDevice(orgId);
            if (res?.error) setError(res.error);
            else if (res?.url) setLink(res.url);
          });
        }}>{pending ? "Building..." : "Build a 24-hour link"}</button>

      {link && (
        <div className="t-small" style={{ marginTop: 10 }}>
          <div className="mut t-meta" style={{ marginBottom: 3 }}>enrolls into {orgName}</div>
          <a href={link} target="_blank" rel="noreferrer" className="mono"
            style={{ overflowWrap: "anywhere" }}>{link}</a>
        </div>
      )}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
