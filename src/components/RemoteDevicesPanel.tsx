"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { promptReason } from "@/lib/reason";
import { linkRemoteDevice, removeRemoteDevice, setRemoteConsent } from "@/app/actions";

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
 * The machine list and the button.
 *
 * Connect is a link to a page of ours, not a call that opens somebody else's
 * site in a new tab. That page mints the token and holds the session, which also
 * disposes of the popup-blocker dance this used to need.
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
  const [enrollOrg, setEnrollOrg] = useState(String(enrollOrgs[0]?.id ?? ""));

  return (
    <>
      {canEnroll && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>Enroll a machine</div>
          <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
            Pick whose machine it is. The installer registers a Windows service, so the PC comes back on its own
            after a reboot and nobody has to be sitting there afterwards.
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <select value={enrollOrg} onChange={(e) => setEnrollOrg(e.target.value)}
              aria-label="Organization to enroll the machine for" style={{ width: "auto", fontSize: 12 }}>
              {enrollOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            {/* A link, not a generated blob shown in place: the instructions and
                the downloads live on their own page, addressed by organization, so
                what you are looking at can never belong to a different client
                than the one named on it. */}
            <Link href={enrollOrg ? `/remote/enroll/${enrollOrg}` : "/remote"}
              className="btn sm accent" style={{ textDecoration: "none" }}>Installer and instructions</Link>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Machines</div>
        {devices.length === 0 && (
          <div className="mut" style={{ fontSize: 13 }}>
            Nothing enrolled yet. {canEnroll ? "Run the installer on a lab PC and it will appear here." : "Ask us to enroll a machine."}
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
                  <Link href={`/remote/${d.id}`} className="btn sm accent" style={{ textDecoration: "none" }}>
                    {d.consentMode === "consent" ? "Request session" : "Connect"}
                  </Link>
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
