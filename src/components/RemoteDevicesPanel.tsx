"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { confirmReasonText } from "@/components/ui/ConfirmDialog";
import { Dot, Legend, Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";
import { linkRemoteDevice, removeRemoteDevice, renameRemoteDevice, setRemoteConsent } from "@/app/actions";
import { deviceLabel, deviceSubLabel, needsNickname } from "@/lib/deviceName";

export type RemoteDevice = {
  id: number;
  /** The Windows hostname, as the engine reports it. */
  name: string;
  /** What somebody called it, or "" while it is still going by its hostname. */
  nickname: string;
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
      {/* Adding a machine belongs in this panel's header, not in a card of its
          own above it. The instructions live on their own page, addressed by
          organization, so what you are reading can never belong to a different
          client than the one named on it. */}
      <Panel title="Machines" count={devices.length}
        actions={canEnroll ? (
          <>
            <select value={enrollOrg} onChange={(e) => setEnrollOrg(e.target.value)}
              aria-label="Organization to enroll a machine for" style={{ width: "auto", fontSize: 12 }}>
              {enrollOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <Link href={enrollOrg ? `/remote/enroll/${enrollOrg}` : "/remote"}
              className="btn sm accent" style={{ textDecoration: "none" }}>Enroll a machine</Link>
          </>
        ) : undefined}>
        {devices.length === 0 && (
          <div className="mut" style={{ fontSize: 13 }}>
            No machines yet.{canEnroll ? "" : " Ask us to enroll one."}
          </div>
        )}

        {devices.map((d) => (
          <div key={d.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Dot tone={d.online ? "good" : "faint"} />
              <b style={{ fontSize: 13.5, color: "var(--navy)" }}>{deviceLabel(d.nickname, d.name)}</b>
              {/* Kept beside the nickname, never replaced by it: the nickname
                  finds the machine, the hostname proves it is the right one. */}
              {deviceSubLabel(d.nickname, d.name) && (
                <span className="mono mut" style={{ fontSize: 11 }}>{deviceSubLabel(d.nickname, d.name)}</span>
              )}
              {d.orgName && <span className="mut" style={{ fontSize: 12 }}>{d.orgName}</span>}
              {/* One pill: consent said up front beats everything - never
                  discovered after a click. */}
              {d.consentMode === "consent" ? (
                <Pill tone="warn" title={`Someone must approve at the machine: ${d.consentWhy}`}>
                  asks first · {d.consentWhy}
                </Pill>
              ) : !d.orgName ? (
                <Pill tone="warn">unassigned</Pill>
              ) : null}
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
                {/* Typed here rather than behind a dialog: naming a machine is a
                    two-second job somebody does while looking at the list. */}
                <input defaultValue={d.nickname} disabled={pending}
                  aria-label={`Name for ${d.name}`}
                  placeholder={needsNickname(d.nickname, d.name) ? "name it — e.g. Altis PC" : "no name"}
                  onBlur={(e) => {
                    if (e.target.value.trim() === d.nickname) return;
                    setError("");
                    startTransition(async () => {
                      const res = await renameRemoteDevice(d.id, e.target.value);
                      setError(res?.error ?? "");
                      if (!res?.error) toast({ message: `Renamed the machine${e.target.value.trim() ? ` to ${e.target.value.trim()}` : ""}` });
                    });
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  style={{ width: 170, fontSize: 11 }} />

                <select value={d.systemId ?? ""} disabled={pending} aria-label={`System ${d.name} drives`}
                  onChange={(e) => {
                    const v = e.target.value ? parseInt(e.target.value) : null;
                    setError("");
                    startTransition(async () => {
                      const res = await linkRemoteDevice(d.id, v);
                      setError(res?.error ?? "");
                      if (!res?.error) toast({ message: v === null ? "Unlinked the machine" : "Linked the machine to its system" });
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
                      if (!res?.error) toast({ message: "Saved the consent rule" });
                    });
                  }}
                  style={{ width: "auto", fontSize: 11 }}>
                  <option value="derive">consent follows custody</option>
                  <option value="always">always ask first</option>
                  <option value="never">never ask</option>
                </select>

                <button className="btn link" style={{ color: "#A32D2D", fontSize: 11, marginLeft: "auto" }} disabled={pending}
                  onClick={async () => {
                    const why = await confirmReasonText(
                      `Remove "${deviceLabel(d.nickname, d.name)}" from remote support? This forgets the machine here - the agent keeps `
                      + "running until somebody uninstalls it on the PC itself.",
                    );
                    if (!why) return;
                    setError("");
                    startTransition(async () => {
                      const res = await removeRemoteDevice(d.id, why);
                      setError(res?.error ?? "");
                      if (!res?.error) toast({ message: `Removed ${deviceLabel(d.nickname, d.name)}` });
                    });
                  }}>remove</button>
              </div>
            )}
          </div>
        ))}
        {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 10 }}>{error}</div>}
      </Panel>
      <Legend items={[{ tone: "good", label: "online" }, { tone: "faint", label: "offline" }]} />
    </>
  );
}
