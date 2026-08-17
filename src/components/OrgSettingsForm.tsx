"use client";

import { useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import {
  setOrgAppearance, updateEodRecipients, addClientAccess, removeClientAccess,
  setClientAccessRole, setClientSeesAgreements, removeOrg, setSheetOrg, setOrgStorageLimit, setOrgRemoteAccess,
} from "@/app/actions";
import { isValidHex, readableTextOn } from "@/lib/theme";
import { promptReason } from "@/lib/reason";
import { STORAGE_TIERS, type Quota } from "@/lib/storage";
import StorageMeter from "@/components/StorageMeter";

const MAX_LOGO_BYTES = 1024 * 1024; // a header logo, not a tune file

type Entry = { id: number; entry: string; canEdit: boolean; canSeeAgreements: boolean };

/**
 * One organization's own settings page. It serves two audiences with the same
 * controls: the platform owner configuring any organization, and an
 * organization's own editors configuring theirs. Which of the two you are
 * decides what renders - `isOwner` gates the operator-level pieces (roles,
 * report recipients, sheet sync, removal) rather than hiding them behind a
 * second page that would drift from this one.
 */
export default function OrgSettingsForm({ org, people, platformName, isOwner, showRecipients, showSheetSync, showRemote = false }: {
  org: {
    id: number; name: string; kind: string; themeColor: string; logoUrl: string;
    eodRecipients: string; systems: number; isOperator: boolean; isSheetOrg: boolean;
    storageLimitMb: number; quota: Quota;
    remoteAccessEnabled: boolean; remoteDevices: number;
  };
  /** Whether the instance has the remote-support module on at all. */
  showRemote?: boolean;
  people: Entry[];
  platformName: string;
  isOwner: boolean;
  showRecipients: boolean;
  showSheetSync: boolean;
}) {
  const [pending, startTransition] = useTransition();

  // Appearance
  const [color, setColor] = useState(org.themeColor || "#172A4A");
  const [useDefault, setUseDefault] = useState(!org.themeColor);
  const [logo, setLogo] = useState(org.logoUrl);
  const [lookError, setLookError] = useState("");
  const [lookSaved, setLookSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const effective = useDefault ? "#172A4A" : color;
  const fg = isValidHex(effective) ? readableTextOn(effective) : "#fff";

  const pickLogo = async (file: File) => {
    setLookError(""); setLookSaved(false);
    if (!/^image\/(png|jpeg|svg\+xml|webp)$/.test(file.type)) { setLookError("Logo must be a PNG, JPEG, SVG or WebP image"); return; }
    if (file.size > MAX_LOGO_BYTES) { setLookError("Logo must be under 1 MB"); return; }
    setUploading(true);
    try {
      const blob = await upload(`logos/${org.name}-${file.name}`, file, { access: "public", handleUploadUrl: "/api/upload" });
      setLogo(blob.url);
    } catch (e) {
      setLookError((e as Error).message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const saveLook = () => {
    setLookError(""); setLookSaved(false);
    startTransition(async () => {
      const res = await setOrgAppearance({ themeColor: useDefault ? "" : color, logoUrl: logo }, org.id);
      if (res?.error) setLookError(res.error);
      else setLookSaved(true);
    });
  };

  // Remote support tier
  const [remoteOn, setRemoteOn] = useState(org.remoteAccessEnabled);
  const [remoteMsg, setRemoteMsg] = useState("");

  // Storage ceiling
  const [limitMb, setLimitMb] = useState(org.storageLimitMb);
  const [limitMsg, setLimitMsg] = useState("");

  // Recipients
  const [recipients, setRecipients] = useState(org.eodRecipients);
  const [recipientsMsg, setRecipientsMsg] = useState("");
  const saveRecipients = () => {
    setRecipientsMsg("");
    startTransition(async () => {
      const res = await updateEodRecipients(org.id, recipients);
      setRecipientsMsg(res?.error ?? "Saved ✓");
    });
  };

  // People
  const [entry, setEntry] = useState("");
  const [role, setRole] = useState("viewer");
  const [peopleError, setPeopleError] = useState("");
  const [sent, setSent] = useState("");
  const invite = () => {
    const v = entry.trim();
    if (!v) return;
    setPeopleError(""); setSent("");
    startTransition(async () => {
      const res = await addClientAccess(v, org.id, role === "editor");
      if (res?.error) setPeopleError(res.error);
      else { setSent(v); setEntry(""); }
    });
  };

  const [dangerError, setDangerError] = useState("");

  return (
    <>
      <div className="card">
        <div className="card-title">People at {org.name}</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Everyone here signs in with their email - no passwords. An editor can change records they have edit
          access to; a viewer reads. A whole-domain entry lets anyone with that email address in, so only the
          platform owner can add or change one.
        </div>
        {people.map((r) => {
          const domain = r.entry.trim().startsWith("@");
          return (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 13 }}>{r.entry}</span>
              {domain && <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>whole domain</span>}
              {isOwner ? (
                <select value={r.canEdit ? "editor" : "viewer"} disabled={pending} aria-label={`Role for ${r.entry}`}
                  onChange={(e) => startTransition(async () => { await setClientAccessRole(r.id, e.target.value === "editor"); })}
                  style={{ width: "auto", fontSize: 11, padding: "1px 4px" }}>
                  <option value="viewer">viewer</option>
                  <option value="editor">editor</option>
                </select>
              ) : (
                <span className="pill" style={{ background: r.canEdit ? "#E5F3E5" : "#EEF1F5", color: r.canEdit ? "#2E6B2E" : "#475569" }}>
                  {r.canEdit ? "editor" : "viewer"}
                </span>
              )}
              {/* Seeing the systems and seeing what they cost are different
                  questions; one org has people on both sides of that line. */}
              {isOwner ? (
                <label style={{ display: "flex", alignItems: "center", gap: 4, margin: 0, fontSize: 11, fontWeight: 400, color: "var(--slate)", textTransform: "none", letterSpacing: 0 }}
                  title="Whether this person may read this organization's agreements - contract value, allowances, the signed paper">
                  <input type="checkbox" checked={r.canSeeAgreements} disabled={pending} style={{ width: 14, height: 14 }}
                    onChange={(e) => startTransition(async () => { await setClientSeesAgreements(r.id, e.target.checked); })} />
                  agreements
                </label>
              ) : r.canSeeAgreements ? (
                <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>agreements</span>
              ) : null}
              {(isOwner || !domain) && (
                <button className="btn link" style={{ marginLeft: "auto", color: "#A32D2D", fontSize: 11 }} disabled={pending}
                  onClick={() => {
                    if (!window.confirm(`Remove ${r.entry}? Anyone covered only by this entry is signed out immediately.`)) return;
                    setPeopleError("");
                    startTransition(() => removeClientAccess(r.id));
                  }}>remove</button>
              )}
            </div>
          );
        })}
        {people.length === 0 && (
          <div className="mut" style={{ fontSize: 12, padding: "6px 0" }}>Nobody here can sign in yet.</div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <input className="mono" value={entry} onChange={(e) => setEntry(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") invite(); }}
            placeholder={isOwner ? "jane@company.com or @company.com" : "colleague@company.com"}
            style={{ flex: "1 1 190px", fontSize: 13 }} />
          <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: "auto", fontSize: 12 }}>
            <option value="viewer">viewer</option>
            <option value="editor">editor</option>
          </select>
          <button className="btn sm accent" onClick={invite} disabled={pending || !entry.trim()}>
            {pending ? "Inviting..." : "Invite"}
          </button>
        </div>
        {sent && <div style={{ fontSize: 12, color: "#2E6B2E", marginTop: 6 }}>Invited {sent} - they got an email with a sign-in link.</div>}
        {peopleError && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{peopleError}</div>}
      </div>

      <div className="card">
        <div className="card-title">Workspace appearance</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Applies to everyone signing in as {org.name}. Nobody else&apos;s workspace changes.
        </div>

        {/* Live preview using the same color math as the real header. */}
        <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid var(--line)", marginBottom: 10 }}>
          <div style={{ background: effective, color: fg, display: "flex", alignItems: "center", gap: 10, padding: "10px 14px" }}>
            {logo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt={`${org.name} logo`} style={{ height: 22, maxWidth: 100, objectFit: "contain" }} />
            )}
            <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: 0.3 }}>{platformName.toUpperCase()}</span>
            <span style={{ fontSize: 11, opacity: 0.75 }}>{platformName} × {org.name}</span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, fontSize: 12, fontWeight: 400, color: "var(--ink)" }}>
            <input type="checkbox" checked={useDefault} style={{ width: "auto" }}
              onChange={(e) => { setUseDefault(e.target.checked); setLookSaved(false); }} />
            Default look
          </label>
          {!useDefault && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, fontSize: 12, fontWeight: 400, color: "var(--ink)" }}>
              Header color
              <input type="color" value={isValidHex(color) ? color : "#172A4A"}
                onChange={(e) => { setColor(e.target.value); setLookSaved(false); }}
                style={{ width: 34, height: 28, padding: 2, border: "1px solid var(--line)", borderRadius: 6, background: "#fff", cursor: "pointer" }} />
            </label>
          )}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) pickLogo(f); }} />
          <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? "Uploading..." : logo ? "Replace logo" : "Add logo"}
          </button>
          {logo && <button className="btn link" onClick={() => { setLogo(""); setLookSaved(false); }}>remove logo</button>}
          <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {lookSaved && <span className="mut" style={{ fontSize: 12 }}>Saved.</span>}
            <button className="btn sm accent" onClick={saveLook} disabled={pending || uploading}>
              {pending ? "Saving..." : "Save appearance"}
            </button>
          </span>
        </div>
        {lookError && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{lookError}</div>}
      </div>

      {isOwner && showRecipients && (
        <div className="card">
          <div className="card-title">Daily report</div>
          <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
            Where {org.name}&apos;s daily update goes. Comma-separated; empty means no report is sent for them.
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input className="mono" value={recipients}
              onChange={(e) => { setRecipients(e.target.value); setRecipientsMsg(""); }}
              placeholder="nobody - no report is sent" style={{ flex: "1 1 220px", fontSize: 12 }} />
            <button className="btn sm" onClick={saveRecipients} disabled={pending || recipients === org.eodRecipients}>Save</button>
          </div>
          {recipientsMsg && (
            <div style={{ fontSize: 12, marginTop: 6, color: recipientsMsg === "Saved ✓" ? "#2E6B2E" : "#A32D2D" }}>{recipientsMsg}</div>
          )}
        </div>
      )}

      {isOwner && showRemote && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>Remote support</div>
          <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
            Lets {org.name}&apos;s own editors connect to their machines. Ours is unaffected.{" "}
            {org.remoteDevices > 0
              ? `${org.remoteDevices} machine${org.remoteDevices === 1 ? "" : "s"} enrolled.`
              : "No machines enrolled."}
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button className={`btn sm${remoteOn ? "" : " accent"}`} disabled={pending}
              onClick={() => {
                const next = !remoteOn;
                setRemoteOn(next); setRemoteMsg("");
                startTransition(async () => {
                  const res = await setOrgRemoteAccess(org.id, next);
                  if (res?.error) { setRemoteOn(!next); setRemoteMsg(res.error); }
                });
              }}>
              {remoteOn ? "Turn client access off" : "Turn client access on"}
            </button>
            <span className="pill" style={{ background: remoteOn ? "#E5F3E5" : "#EEF1F5", color: remoteOn ? "#2E6B2E" : "#475569" }}>
              {remoteOn ? "their editors can connect" : "support only"}
            </span>
          </div>
          {remoteMsg && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{remoteMsg}</div>}
        </div>
      )}

      {isOwner && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>File storage</div>
          <StorageMeter quota={org.quota} hint={`${org.name}'s own shelf plus the files on every system and unit they own.`} />
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
            <select value={STORAGE_TIERS.some((t) => t.mb === limitMb) ? String(limitMb) : "custom"}
              aria-label={`File storage limit for ${org.name}`} style={{ width: "auto", fontSize: 12 }}
              onChange={(e) => { if (e.target.value !== "custom") { setLimitMb(parseInt(e.target.value)); setLimitMsg(""); } }}>
              {STORAGE_TIERS.map((t) => <option key={t.mb} value={t.mb}>{t.label}</option>)}
              {!STORAGE_TIERS.some((t) => t.mb === limitMb) && <option value="custom">{limitMb} MB (custom)</option>}
            </select>
            <input value={String(limitMb)} inputMode="numeric" aria-label="Limit in megabytes"
              onChange={(e) => { setLimitMb(Math.max(0, parseInt(e.target.value.replace(/\D/g, "")) || 0)); setLimitMsg(""); }}
              style={{ width: 90, fontSize: 12 }} />
            <span className="mut" style={{ fontSize: 11 }}>MB · 0 = no limit</span>
            <button className="btn sm" disabled={pending || limitMb === org.storageLimitMb}
              onClick={() => {
                setLimitMsg("");
                startTransition(async () => {
                  const res = await setOrgStorageLimit(org.id, limitMb);
                  setLimitMsg(res?.error ?? "Saved ✓");
                });
              }}>Save</button>
          </div>
          {limitMsg && (
            <div style={{ fontSize: 12, marginTop: 6, color: limitMsg === "Saved ✓" ? "#2E6B2E" : "#A32D2D" }}>{limitMsg}</div>
          )}
        </div>
      )}

      {isOwner && (
        <div className="card">
          <div className="card-title">Operator controls</div>
          <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
            {org.isOperator
              ? `${org.name} operates this instance, so it is named on sign-off packets and reports.`
              : `${org.name} is one of the organizations on this instance.`}
          </div>
          {/* Offered to clients, and always to whoever is currently syncing: an
              organization switched from client to provider while named here would
              otherwise take the only control with it. */}
          {showSheetSync && (org.kind === "client" || org.isSheetOrg) && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13 }}>Google Sheet tracker</span>
              {org.isSheetOrg ? (
                <>
                  <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>syncing with {org.name}</span>
                  {/* The way back out. Setting the tracker was reversible in the
                      action all along; there was simply no control for it, so the
                      first organization named here became permanent. */}
                  <button className="btn sm" style={{ marginLeft: "auto" }} disabled={pending}
                    onClick={() => {
                      if (!window.confirm(
                        `Stop syncing the tracker sheet with ${org.name}? Their systems stay exactly as they are `
                        + "- only the sheet stops being read and written.",
                      )) return;
                      startTransition(async () => { await setSheetOrg(null); });
                    }}>stop syncing</button>
                </>
              ) : (
                <button className="btn sm" disabled={pending}
                  onClick={() => startTransition(async () => { await setSheetOrg(org.id); })}>
                  use {org.name}&apos;s sheet
                </button>
              )}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13 }}>Remove this organization</span>
            <span className="mut" style={{ fontSize: 11 }}>
              {people.length} sign-in{people.length === 1 ? "" : "s"} stop working, access to {org.systems} system
              {org.systems === 1 ? "" : "s"} ends. The systems and their history are untouched.
            </span>
            <button className="btn sm" style={{ marginLeft: "auto", color: "#A32D2D" }} disabled={pending}
              onClick={() => {
                const reason = promptReason(
                  `Remove ${org.name}?${org.isOperator ? " It operates this instance - reports and packets lose their operator name." : ""} Their ${people.length} sign-in entr${people.length === 1 ? "y" : "ies"} stop working and they lose access to ${org.systems} system${org.systems === 1 ? "" : "s"}.`
                );
                if (!reason) return;
                setDangerError("");
                startTransition(async () => {
                  const res = await removeOrg(org.id, reason);
                  if (res?.error) setDangerError(res.error);
                  // This page is about an organization that no longer exists.
                  else window.location.assign("/settings/organizations");
                });
              }}>remove</button>
          </div>
          {dangerError && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{dangerError}</div>}
        </div>
      )}
    </>
  );
}
