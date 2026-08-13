"use client";

import { useCallback, useEffect, useState } from "react";
import { browseCloud, disconnectCloud } from "@/app/actions";
import {
  itemNote, pushCrumb, ROOT, truncateTo, type CloudItem, type Crumb,
} from "@/lib/cloudItems";

/**
 * Somebody's own OneDrive and SharePoint, from inside the studio.
 *
 * The point is the round trip it removes: find the file in a browser tab,
 * download it, find it again in a file dialog, upload it. Here it is one list
 * and one click, and the bytes go Microsoft-to-browser without touching this
 * app's storage or counting against anybody's quota.
 *
 * Only folders and PDFs are listed. Everything else is left out rather than
 * greyed out - this is a place to find a PDF, and a list padded with
 * spreadsheets is the file dialog somebody came here to avoid.
 */
export default function CloudBrowser({ account, brokenReason, onAdd, onPickFolder }: {
  /** The connected account, or "" for none yet. */
  account: string;
  /** Set when Microsoft has refused the connection - it needs remaking, not retrying. */
  brokenReason: string;
  onAdd: (item: CloudItem) => void;
  /** Make the folder somebody is standing in the destination for a finished packet. */
  onPickFolder?: (driveId: string, folderId: string, name: string) => void;
}) {
  const [trail, setTrail] = useState<Crumb[]>([ROOT]);
  const [items, setItems] = useState<CloudItem[]>([]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const here = trail[trail.length - 1];

  const load = useCallback(async (crumb: Crumb, q: string) => {
    setBusy(true);
    setError("");
    const res = await browseCloud(crumb.driveId, crumb.id, q);
    setItems(res.items ?? []);
    setError(res.error ?? "");
    setBusy(false);
  }, []);

  useEffect(() => {
    if (!account || brokenReason) return;
    void load(here, searching);
  }, [account, brokenReason, here, searching, load]);

  if (!account || brokenReason) {
    return (
      <div style={{ marginTop: 10 }}>
        {brokenReason && <div style={{ fontSize: 11, color: "#A32D2D", marginBottom: 6 }}>{brokenReason}</div>}
        <a href="/api/cloud/connect" className="btn sm" style={{ textDecoration: "none" }}>
          {brokenReason ? "Connect again" : "Connect OneDrive"}
        </a>
        {!brokenReason && (
          <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
            Sign in with your work account to pull PDFs straight out of OneDrive or SharePoint.
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        <span className="mut" style={{ fontSize: 11 }}>{account}</span>
        <button className="btn link" style={{ fontSize: 11, marginLeft: "auto" }} disabled={busy}
          onClick={() => { void disconnectCloud().then(() => location.reload()); }}>disconnect</button>
      </div>

      <input value={query} disabled={busy}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") setSearching(query.trim()); }}
        placeholder="Search your files, or press Enter"
        style={{ fontSize: 12, marginBottom: 6 }} />

      {searching ? (
        <div style={{ display: "flex", gap: 6, alignItems: "baseline", marginBottom: 4 }}>
          <span className="mut" style={{ fontSize: 11 }}>results for &ldquo;{searching}&rdquo;</span>
          <button className="btn link" style={{ fontSize: 11 }}
            onClick={() => { setQuery(""); setSearching(""); }}>back to folders</button>
        </div>
      ) : (
        // Crumbs rather than a path string: a driveItem is addressed by its id,
        // and two shared libraries can both hold a folder called /Reports/2026.
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", alignItems: "baseline", marginBottom: 4 }}>
          {trail.map((c, i) => (
            <span key={c.id} style={{ fontSize: 11 }}>
              {i > 0 && <span className="mut"> / </span>}
              {i === trail.length - 1
                ? <span className="mut">{c.name}</span>
                : <button className="btn link" style={{ fontSize: 11 }}
                  onClick={() => setTrail((t) => truncateTo(t, c.id))}>{c.name}</button>}
            </span>
          ))}
        </div>
      )}

      {/* Saving into the folder you are looking at, rather than choosing a path
          twice. Not offered on a search, where "here" is not a place. */}
      {onPickFolder && !searching && (
        <button className="btn link" style={{ fontSize: 11, marginBottom: 4 }} disabled={busy}
          onClick={() => onPickFolder(here.driveId, here.id, here.name)}>
          save finished packets into {here.name}
        </button>
      )}

      {error && <div style={{ fontSize: 11, color: "#A32D2D", marginBottom: 6 }}>{error}</div>}

      <div className="pdf-srclist">
        {busy && <div className="mut" style={{ fontSize: 12, padding: "6px 0" }}>Loading...</div>}
        {!busy && items.length === 0 && !error && (
          <div className="mut" style={{ fontSize: 12, padding: "6px 0" }}>
            {searching ? "No PDFs match." : "No folders or PDFs here."}
          </div>
        )}
        {!busy && items.map((i) => (
          <div key={`${i.driveId}:${i.id}`}
            style={{ display: "flex", gap: 6, alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
            {i.isFolder ? (
              <button className="btn link" style={{ fontSize: 12, fontWeight: 700, flexShrink: 0 }}
                onClick={() => { setQuery(""); setSearching(""); setTrail((t) => pushCrumb(t, i)); }}>open</button>
            ) : (
              <button className="btn link" style={{ fontSize: 12, fontWeight: 700, flexShrink: 0 }}
                onClick={() => onAdd(i)}>+ add</button>
            )}
            <span style={{ fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={i.name}>
              {i.isFolder ? "📁 " : ""}{i.name}
            </span>
            <span className="mut" style={{ fontSize: 11, marginLeft: "auto", flexShrink: 0 }}>{itemNote(i)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
