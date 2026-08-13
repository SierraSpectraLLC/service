"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { browseCloud, disconnectCloud } from "@/app/actions";
import {
  crumbKey, isPlaces, itemNote, pushCrumb, ROOT, truncateTo, type CloudItem, type Crumb,
} from "@/lib/cloudItems";

/**
 * Somebody's own OneDrive, Teams and SharePoint, browsed from inside the portal.
 *
 * The point is the round trip it removes: find the file in a browser tab,
 * download it, find it again in a file dialog, upload it. Here it is one list
 * and one click.
 *
 * Used in two places that want different things from it, which is what the props
 * are for. Files owns the CONNECTION - it is where documents live, so connecting
 * an outside store is a filing decision made once - and lists everything, since
 * the library takes any file. The studio borrows the connection to pull a PDF
 * straight into the working set, so it shows no connect or disconnect chrome and
 * lists only what it can open.
 */
export default function CloudBrowser({
  account, brokenReason, onAdd, onPickFolder, manage = false, pdfOnly = true,
  addLabel = "+ add", disabled = false,
}: {
  /** The connected account, or "" for none yet. */
  account: string;
  /** Set when Microsoft has refused the connection - it needs remaking, not retrying. */
  brokenReason: string;
  onAdd: (item: CloudItem) => void;
  /** Make the folder somebody is standing in the destination for a finished packet. */
  onPickFolder?: (driveId: string, folderId: string, name: string) => void;
  /** Owns the connection: shows the account, connect and disconnect. One page should. */
  manage?: boolean;
  /** Hide everything that is not a PDF. The studio can open nothing else. */
  pdfOnly?: boolean;
  addLabel?: string;
  disabled?: boolean;
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
    const res = await browseCloud(crumb.driveId, crumb.id, q, pdfOnly);
    setItems(res.items ?? []);
    setError(res.error ?? "");
    setBusy(false);
  }, [pdfOnly]);

  useEffect(() => {
    if (!account || brokenReason) return;
    void load(here, searching);
  }, [account, brokenReason, here, searching, load]);

  // Not connected, or connected and refused. Only the page that owns the
  // connection offers to make it; anywhere else says where that page is, so
  // there is one door rather than two that can disagree about the account.
  if (!account || brokenReason) {
    if (!manage) {
      return (
        <div className="mut" style={{ fontSize: 11, marginTop: 10 }}>
          {brokenReason || "No outside account is connected."}{" "}
          <Link href="/documents">Connect one in Files</Link> to pull documents straight in.
        </div>
      );
    }
    return (
      <div style={{ marginTop: 10 }}>
        {brokenReason && <div style={{ fontSize: 11, color: "#A32D2D", marginBottom: 6 }}>{brokenReason}</div>}
        <a href="/api/cloud/connect" className="btn sm" style={{ textDecoration: "none" }}>
          {brokenReason ? "Connect again" : "Connect OneDrive"}
        </a>
        {!brokenReason && (
          <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
            Sign in with your work account to reach OneDrive, Teams and SharePoint from here.
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      {manage && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
          <span className="mut" style={{ fontSize: 11 }}>{account}</span>
          <button className="btn link" style={{ fontSize: 11, marginLeft: "auto" }} disabled={busy}
            onClick={() => { void disconnectCloud().then(() => location.reload()); }}>disconnect</button>
        </div>
      )}

      {/* A search runs against one store. At the top of the trail there is no
          store yet - the list is OneDrive, shared items and each Team - so the
          box would have to either lie about its reach or quietly search only the
          personal drive, which is the bug this whole screen came from. */}
      {!isPlaces(here) && (
        <input value={query} disabled={busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setSearching(query.trim()); }}
          placeholder={`Search ${trail[1]?.name ?? "your files"}, or press Enter`}
          style={{ fontSize: 12, marginBottom: 6 }} />
      )}

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
            <span key={crumbKey(c)} style={{ fontSize: 11 }}>
              {i > 0 && <span className="mut"> / </span>}
              {i === trail.length - 1
                ? <span className="mut">{c.name}</span>
                : <button className="btn link" style={{ fontSize: 11 }}
                  onClick={() => setTrail((t) => truncateTo(t, crumbKey(c)))}>{c.name}</button>}
            </span>
          ))}
        </div>
      )}

      {/* Saving into the folder you are looking at, rather than choosing a path
          twice. Not offered on a search, where "here" is not a place. */}
      {onPickFolder && !searching && !isPlaces(here) && (
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
            {searching ? (pdfOnly ? "No PDFs match." : "Nothing matches.")
              : isPlaces(here) ? "Nothing to browse."
                : pdfOnly ? "No folders or PDFs here." : "Nothing here."}
          </div>
        )}
        {!busy && items.map((i) => (
          <div key={`${i.driveId}:${i.id}:${i.name}`}
            style={{ display: "flex", gap: 6, alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
            {i.isFolder ? (
              <button className="btn link" style={{ fontSize: 12, fontWeight: 700, flexShrink: 0 }}
                onClick={() => { setQuery(""); setSearching(""); setTrail((t) => pushCrumb(t, i)); }}>open</button>
            ) : (
              <button className="btn link" style={{ fontSize: 12, fontWeight: 700, flexShrink: 0 }}
                disabled={disabled} onClick={() => onAdd(i)}>{addLabel}</button>
            )}
            <span style={{ fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={i.name}>
              {i.isFolder ? "📁 " : ""}{i.name}
            </span>
            {/* A store has no item count worth printing - "My files · 0 items"
                reads as empty when it is simply not a folder anybody counted. */}
            {!isPlaces(here) && (
              <span className="mut" style={{ fontSize: 11, marginLeft: "auto", flexShrink: 0 }}>{itemNote(i)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
