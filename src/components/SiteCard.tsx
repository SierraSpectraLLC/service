"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { setSystemSite } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import { addressLine, siteLabel } from "@/lib/sites";

export type SiteOption = { id: number; name: string; address: string; archived: boolean };

/**
 * Where this instrument is, and what a tech needs to know before driving there.
 *
 * The access notes print in full - which garage, what it costs, which door, who
 * to ask for - but as ordinary text. They used to sit in an amber block, which
 * read as a warning about the site rather than as directions to it, and a page
 * that colours its reference material has nothing left for its actual alarms.
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
      toast({ message: value === "" ? "Cleared the site" : "Moved the system to the site" });
      setEditing(false);
    });
  };

  return (
    <div className="card">
      <div className="row-2" style={{ alignItems: "baseline", marginBottom: 4 }}>
        <div className="card-title">Site</div>
        {canEdit && options.length > 0 && (
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => { setEditing(!editing); setError(""); }}>
            {editing ? "Cancel" : site ? "Change" : "Set"}
          </button>
        )}
      </div>

      {site ? (
        <>
          <div className="t-body" style={{ fontWeight: 700 }}>{siteLabel(site)}</div>
          {site.address && <div className="mut t-small">{addressLine(site.address)}</div>}
          {(site.contactName || site.contactPhone) && (
            <div className="mut t-small" style={{ marginTop: 2 }}>
              {[site.contactName, site.contactPhone].filter(Boolean).join(" · ")}
            </div>
          )}
          {site.accessNotes && (
            <div style={{ marginTop: 8 }}>
              <div className="eyebrow" style={{ marginBottom: 2 }}>Getting in</div>
              <div className="t-small" style={{ whiteSpace: "pre-wrap" }}>{site.accessNotes}</div>
            </div>
          )}
        </>
      ) : (
        <div className="mut t-small">
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
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}

      {canEdit && ownerOrgId !== null && (
        <div className="mut no-print t-meta" style={{ marginTop: 8 }}>
          Sites are kept on the{" "}
          <Link href={`/settings/organizations/${ownerOrgId}`} style={{ color: "var(--navy)" }}>
            owner&apos;s settings page
          </Link>.
        </div>
      )}
    </div>
  );
}
