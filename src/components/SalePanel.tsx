"use client";

import { useState, useTransition } from "react";
import { setForSale } from "@/app/actions";

/**
 * Resale controls, shown only to the system's owner (or staff). The listing
 * URL is public by design - hand it to prospective buyers; it goes dead the
 * moment the system is taken off the market.
 */
export default function SalePanel({ instrumentId, forSale, saleNote, listingToken }: {
  instrumentId: number; forSale: boolean; saleNote: string; listingToken: string;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(saleNote);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const url = listingToken && typeof window !== "undefined" ? `${window.location.origin}/listing/${listingToken}` : "";

  return (
    <>
      <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>Resale</div>
      {!forSale && !editing && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="mut" style={{ fontSize: 12 }}>Not for sale.</span>
          <button className="btn link" onClick={() => setEditing(true)}>List for sale...</button>
        </div>
      )}
      {(forSale || editing) && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px" }}>
          {forSale && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
              <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>For sale</span>
              {url && (
                <>
                  <a href={url} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 11 }}>{url.replace(/^https?:\/\//, "")}</a>
                  <button className="btn link" onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                    {copied ? "copied" : "copy link"}
                  </button>
                </>
              )}
            </div>
          )}
          <div className="mut" style={{ fontSize: 11, marginBottom: 6 }}>
            The listing is public - no sign-in needed. It shows the system&apos;s makeup, completed work, parts fitted,
            and only the files marked &quot;show on listing&quot;. Location, client, notes and pricing never appear.
          </div>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder='Public blurb, e.g. "Refurbished 2025, new pump seals, full checkout passed. Contact sales@..."'
            style={{ resize: "vertical", fontSize: 13, marginBottom: 6 }} />
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 6 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn sm accent" disabled={pending}
              onClick={() => {
                setError("");
                startTransition(async () => {
                  const res = await setForSale(instrumentId, true, note);
                  if (res?.error) setError(res.error);
                  else setEditing(false);
                });
              }}>{pending ? "Saving..." : forSale ? "Update listing" : "Publish listing"}</button>
            {forSale ? (
              <button className="btn sm" disabled={pending}
                onClick={() => {
                  if (!window.confirm("Take this system off the market? The listing link stops working immediately.")) return;
                  startTransition(async () => {
                    const res = await setForSale(instrumentId, false, note);
                    if (res?.error) setError(res.error);
                  });
                }}>End listing</button>
            ) : (
              <button className="btn link" onClick={() => setEditing(false)}>cancel</button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
