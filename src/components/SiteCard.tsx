"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { setSystemSite } from "@/app/actions";
import { addressLine, siteLabel } from "@/lib/sites";

export type SiteOption = { id: number; name: string; address: string; archived: boolean };

/**
 * Where this instrument is, and what a tech needs to know before driving there.
 *
 * The access notes are shown in full and in a colour, because they are the thing
 * somebody is looking for at 7am with a van full of parts: which garage, what it
 * costs, which door, who to ask for. Everything else on this card is reference;
 * that part is the reason it exists.
 */
export default function SiteCard({ instrumentId, siteId, options, site, ownerOrgId, canEdit }: {
  instrumentId: number;
  siteId: number | null;
  /** The owner's sites, already narrowed by lib/sites.sitesFor. */
  options: SiteOption[];
  /** The full record for the current site, when there is one. */
  site: { name: string; address: string; accessNotes: string; contactName: string; contactPhone: string } | null;
  ownerOrgId: number | null;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const pick = (value: string) => {
    setError("");
    startTransition(async () => {
      const res = await setSystemSite(instrumentId, value === "" ? null : parseInt(value));
      if (res?.error) { setError(res.error); return; }
      setEditing(false);
    });
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <div className="card-title">Site</div>
        {canEdit && options.length > 0 && (
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => { setEditing(!editing); setError(""); }}>
            {editing ? "Cancel" : site ? "Change" : "Set"}
          </button>
        )}
      </div>

      {site ? (
        <>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{siteLabel(site)}</div>
          {site.address && <div className="mut" style={{ fontSize: 12 }}>{addressLine(site.address)}</div>}
          {(site.contactName || site.contactPhone) && (
            <div className="mut" style={{ fontSize: 11.5, marginTop: 2 }}>
              {[site.contactName, site.contactPhone].filter(Boolean).join(" · ")}
            </div>
          )}
          {site.accessNotes && (
            <div style={{
              fontSize: 12.5, marginTop: 8, padding: "7px 10px", borderRadius: 6,
              background: "#FAF0DC", color: "#8A5410", whiteSpace: "pre-wrap",
            }}>
              {site.accessNotes}
            </div>
          )}
        </>
      ) : (
        <div className="mut" style={{ fontSize: 12.5 }}>
          {options.length === 0
            ? ownerOrgId === null
              ? "House-stewarded, so there is no client site to put it at."
              : "Nobody has recorded a site for this system's owner yet."
            : "Not assigned to a site."}
        </div>
      )}

      {editing && (
        <div style={{ marginTop: 8 }}>
          <select value={siteId === null ? "" : String(siteId)} disabled={pending}
            onChange={(e) => pick(e.target.value)} aria-label="Site">
            <option value="">Not at a recorded site</option>
            {options.map((o) => (
              <option key={o.id} value={String(o.id)}>
                {siteLabel(o)}{o.archived ? " (closed)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}

      {canEdit && ownerOrgId !== null && (
        <div className="mut no-print" style={{ fontSize: 11, marginTop: 8 }}>
          Sites are kept on the{" "}
          <Link href={`/settings/organizations/${ownerOrgId}`} style={{ color: "var(--navy)" }}>
            owner&apos;s settings page
          </Link>.
        </div>
      )}
    </div>
  );
}
