"use client";

import { useState, useTransition } from "react";
import { promptReason } from "@/lib/reason";
import {
  connectRemoteDevice, enrollRemoteDevice, linkRemoteDevice, removeRemoteDevice, setRemoteConsent,
} from "@/app/actions";

export type RemoteDevice = {
  id: number;
  name: string;
  orgName: string;
  platform: string;
  lastSeen: string;
  online: boolean;
  systemId: number | null;
  systemLabel: string;
  consentMode: "unattended" | "consent";
  consentWhy: string;
  consentOverride: boolean | null;
  canConnect: boolean;
  refusal: string;
  canManage: boolean;
};

/**
 * The machine list and the button. Two things it is careful about:
 *
 * Connect opens a new tab, and the tab has to be opened inside the click's own
 * transition or a popup blocker eats it - so the URL comes back from the action
 * and is opened immediately, never after an await the browser can't attribute
 * to the click.
 *
 * A machine that needs consent says so BEFORE you press anything, with the
 * reason. Discovering that somebody has to be at the far end after clicking is
 * how a support call turns into a phone call.
 */
export default function RemoteDevicesPanel({ devices, systems, enrollOrgs, canEnroll, stale }: {
  devices: RemoteDevice[];
  systems: { id: number; label: string }[];
  enrollOrgs: { id: number; name: string }[];
  canEnroll: boolean;
  stale: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [installer, setInstaller] = useState("");
  const [enrollOrg, setEnrollOrg] = useState(String(enrollOrgs[0]?.id ?? ""));

  const connect = async (d: RemoteDevice) => {
    setError(""); setBusy(d.id);
    try {
      const res = await connectRemoteDevice(d.id);
      if (res?.error) { setError(res.error); return; }
      if (res?.url) window.open(res.url, "_blank", "noopener");
    } catch (e) {
      setError((e as Error).message || "Couldn't open a session.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {canEnroll && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>Enrol a machine</div>
          <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
            Generates a one-time installer for that organization. Run it once on the lab PC - it installs as a
            Windows service, so it survives a reboot and nobody has to be sitting there afterwards.
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <select value={enrollOrg} onChange={(e) => setEnrollOrg(e.target.value)}
              aria-label="Organization to enrol the machine for" style={{ width: "auto", fontSize: 12 }}>
              {enrollOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <button className="btn sm accent" disabled={pending || !enrollOrg}
              onClick={() => {
                setError(""); setInstaller("");
                startTransition(async () => {
                  const res = await enrollRemoteDevice(parseInt(enrollOrg));
                  if (res?.error) setError(res.error);
                  else if (res?.url) setInstaller(res.url);
                });
              }}>Get installer link</button>
          </div>
          {installer && (
            <div style={{ marginTop: 10, fontSize: 12 }}>
              <a href={installer} target="_blank" rel="noreferrer" className="mono" style={{ overflowWrap: "anywhere" }}>{installer}</a>
              <div className="mut" style={{ marginTop: 6, fontSize: 11 }}>
                Expires in 24 hours; treat it like a password. Windows will warn that the installer is
                unrecognised - that is expected until the agent is code-signed, and the two-click bypass is safe
                because you are the one running it.
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Machines</div>
        {devices.length === 0 && (
          <div className="mut" style={{ fontSize: 13 }}>
            Nothing enrolled yet. {canEnroll ? "Use the installer above on a lab PC and it will appear here." : "Ask us to enrol a machine."}
          </div>
        )}

        {devices.map((d) => (
          <div key={d.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span aria-hidden style={{
                width: 9, height: 9, borderRadius: 999, flexShrink: 0,
                background: d.online ? "#2E6B2E" : "#94A3B8",
              }} />
              <b style={{ fontSize: 13.5, color: "var(--navy)" }}>{d.name}</b>
              {d.orgName && <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>{d.orgName}</span>}
              {!d.orgName && <span className="pill" style={{ background: "#FAF0DC", color: "#8A5410" }}>unassigned</span>}
              {/* Said up front, with the reason - never discovered after a click. */}
              {d.consentMode === "consent" && (
                <span className="pill" style={{ background: "#FAF0DC", color: "#8A5410" }}
                  title={`Someone must approve at the machine: ${d.consentWhy}`}>
                  asks first · {d.consentWhy}
                </span>
              )}
              <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                {d.canConnect ? (
                  <button className="btn sm accent" disabled={busy !== null} onClick={() => void connect(d)}>
                    {busy === d.id ? "Opening..." : d.consentMode === "consent" ? "Request session" : "Connect"}
                  </button>
                ) : d.refusal ? (
                  <span className="mut" style={{ fontSize: 11, maxWidth: 220 }}>{d.refusal}</span>
                ) : null}
              </span>
            </div>

            <div className="mut" style={{ fontSize: 11, marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <span>{d.platform}</span>
              <span>
                {d.online ? (stale ? "was online at last contact" : "online") : d.lastSeen ? `last seen ${d.lastSeen}` : "never checked in"}
              </span>
              {d.systemLabel && <span>on {d.systemLabel}</span>}
            </div>

            {d.canManage && (
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 7 }}>
                <select value={d.systemId ?? ""} disabled={pending} aria-label={`System ${d.name} drives`}
                  onChange={(e) => {
                    const v = e.target.value ? parseInt(e.target.value) : null;
                    setError("");
                    startTransition(async () => {
                      const res = await linkRemoteDevice(d.id, v);
                      setError(res?.error ?? "");
                    });
                  }}
                  style={{ width: "auto", maxWidth: 240, fontSize: 11 }}>
                  <option value="">not linked to a system</option>
                  {systems.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>

                <select
                  value={d.consentOverride === null ? "derive" : d.consentOverride ? "always" : "never"}
                  disabled={pending} aria-label={`Consent for ${d.name}`}
                  onChange={(e) => {
                    setError("");
                    const mode = e.target.value as "derive" | "always" | "never";
                    startTransition(async () => {
                      const res = await setRemoteConsent(d.id, mode);
                      setError(res?.error ?? "");
                    });
                  }}
                  style={{ width: "auto", fontSize: 11 }}>
                  <option value="derive">consent follows custody</option>
                  <option value="always">always ask first</option>
                  <option value="never">never ask</option>
                </select>

                <button className="btn link" style={{ color: "#A32D2D", fontSize: 11, marginLeft: "auto" }} disabled={pending}
                  onClick={() => {
                    const why = promptReason(
                      `Remove "${d.name}" from remote support? This forgets the machine here - the agent keeps `
                      + "running until somebody uninstalls it on the PC itself.",
                    );
                    if (!why) return;
                    setError("");
                    startTransition(async () => {
                      const res = await removeRemoteDevice(d.id, why);
                      setError(res?.error ?? "");
                    });
                  }}>remove</button>
              </div>
            )}
          </div>
        ))}
        {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 10 }}>{error}</div>}
      </div>
    </>
  );
}
