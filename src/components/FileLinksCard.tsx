"use client";

import { useState, useTransition } from "react";
import { createDropLink, revokeDropLink, revokeShareLink } from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { addDaysIso, DEFAULT_LINK_DAYS, linkLine, MAX_LINK_DAYS } from "@/lib/dropShare";

export type StoreLink = {
  id: number;
  kind: "drop" | "share";
  label: string;
  token: string;
  expiresOn: string;
  revokedAt: string | null;
  /** drop: uploads received. share: files it names. */
  count: number;
  /** drop only: the folder uploads land in. */
  folderName?: string;
};

/**
 * The store's open doors, in one place.
 *
 * Drop links let outsiders put files IN; share links let them take named
 * files OUT. Both are bearer URLs, so the list exists for one reason above
 * the others: seeing what is currently open, and closing it. Creation lives
 * here too (for drop links - shares are made from a selection), targeting
 * whatever folder is open, because "where will these land" should be answered
 * by where you are standing.
 */
export default function FileLinksCard({ links, storeOrgId, openFolderId, openFolderName, today, canManage }: {
  links: StoreLink[];
  storeOrgId: number | null;
  openFolderId: number | null;
  openFolderName: string;
  today: string;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [making, setMaking] = useState(false);
  const [label, setLabel] = useState("");
  const [expiresOn, setExpiresOn] = useState(addDaysIso(today, DEFAULT_LINK_DAYS));
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  const live = links.filter((l) => l.revokedAt === null && l.expiresOn >= today);
  if (!canManage && !links.length) return null;

  const urlOf = (l: StoreLink) => `${window.location.origin}/${l.kind}/${l.token}`;

  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn link" style={{ fontSize: 12, fontWeight: 700 }} onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} Links {live.length > 0 && <span className="mut" style={{ fontWeight: 400 }}>({live.length} open)</span>}
        </button>
        {canManage && (
          <button className="btn sm" onClick={() => { setMaking((v) => !v); setOpen(true); setError(""); }}>
            {making ? "Cancel" : "⇩ Receive files..."}
          </button>
        )}
        {!open && live.length > 0 && (
          <span className="mut" style={{ fontSize: 11 }}>
            {/* Even folded, the fact that doors are open stays on screen. */}
            outsiders can currently {live.some((l) => l.kind === "drop") ? "send you files" : ""}
            {live.some((l) => l.kind === "drop") && live.some((l) => l.kind === "share") ? " and " : ""}
            {live.some((l) => l.kind === "share") ? "read shared files" : ""}
          </span>
        )}
      </div>

      {making && (
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap", marginTop: 8, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#FAFBFD" }}>
          <div style={{ flex: "1 1 180px" }}>
            <label>Who is it for?</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80}
              placeholder='e.g. "Sam at LabZen - G-010 data"' style={{ fontSize: 12 }} />
          </div>
          <div>
            <label>Works until <span className="mut" style={{ fontWeight: 400 }}>(max {MAX_LINK_DAYS} days)</span></label>
            <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)}
              min={today} max={addDaysIso(today, MAX_LINK_DAYS)} style={{ fontSize: 12, width: "auto" }} />
          </div>
          <button className="btn sm accent" disabled={pending}
            onClick={() => startTransition(async () => {
              const res = await createDropLink(storeOrgId, openFolderId, { label, expiresOn });
              if (res?.error || !res.token) { setError(res?.error ?? "Failed"); return; }
              setMaking(false); setLabel(""); setError("");
            })}>
            Create link
          </button>
          <div className="mut" style={{ fontSize: 10.5, flexBasis: "100%" }}>
            Anyone with the link can send files{openFolderName ? <> into <b style={{ fontWeight: 700 }}>{openFolderName}</b></> : " into your storage"} -
            no account needed. You&apos;re notified when something arrives, and you can kill the link below at any time.
          </div>
        </div>
      )}

      {open && links.map((l) => {
        const state = linkLine({ expiresOn: l.expiresOn, revokedAt: l.revokedAt }, today);
        const dead = l.revokedAt !== null || l.expiresOn < today;
        return (
          <div key={`${l.kind}${l.id}`} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", padding: "6px 0", borderTop: "1px solid var(--line)", opacity: dead ? 0.55 : 1 }}>
            <span className={`pill ${l.kind === "drop" ? "good" : "info"}`}>
              {l.kind === "drop" ? "⇩ receive" : "⇧ share"}
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 0 }}>{l.label || `Link until ${l.expiresOn}`}</span>
            <span className="mut" style={{ fontSize: 11 }}>
              {state}
              {l.kind === "drop"
                ? `${l.folderName ? ` · into ${l.folderName}` : ""}${l.count ? ` · ${l.count} received` : " · nothing yet"}`
                : ` · ${l.count} file${l.count === 1 ? "" : "s"}`}
            </span>
            {!dead && (
              <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button className="btn link" style={{ fontSize: 11 }}
                  onClick={() => {
                    void navigator.clipboard?.writeText(urlOf(l));
                    setCopiedId(l.id); setTimeout(() => setCopiedId(null), 1500);
                  }}>{copiedId === l.id ? "copied ✓" : "copy link"}</button>
                <button className="btn link" style={{ fontSize: 11, color: "var(--t-bad-fg)" }} disabled={pending}
                  onClick={async () => {
                    if (!(await confirmDialog({
                      title: "Kill this link?",
                      body: "Anyone holding it loses access immediately.",
                      action: "Kill link", tone: "bad",
                    }))) return;
                    startTransition(async () => {
                      const res = await (l.kind === "drop" ? revokeDropLink(l.id) : revokeShareLink(l.id));
                      setError(res?.error ?? "");
                      if (!res?.error) toast({ message: "Killed the link" });
                    });
                  }}>revoke</button>
              </span>
            )}
          </div>
        );
      })}
      {open && links.length === 0 && (
        <div className="mut" style={{ fontSize: 12, padding: "6px 0" }}>
          No links yet. &ldquo;Receive files&rdquo; makes one an outsider can send files through;
          selecting files and pressing Share makes one they can read.
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--t-bad-fg)", marginTop: 4 }}>{error}</div>}
    </div>
  );
}
