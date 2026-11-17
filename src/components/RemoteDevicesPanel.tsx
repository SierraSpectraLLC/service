"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { choiceDialog, confirmReason } from "@/components/ui/ConfirmDialog";
import { Dot, Legend, Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";
import { linkRemoteDevice, reassignRemoteDevice, removeRemoteDevice, renameRemoteDevice, setRemoteConsent } from "@/app/actions";
import { deviceLabel, deviceSubLabel, needsNickname } from "@/lib/deviceName";
import DeviceManage, { type OpenHold, type OpenLease, type OpenLockout, type OpenNotice } from "@/components/DeviceManage";

export type RemoteDevice = {
  id: number;
  /** The Windows hostname, as the engine reports it. */
  name: string;
  /** What somebody called it, or "" while it is still going by its hostname. */
  nickname: string;
  /** The organization that owns it - the device group it sits in on the host. */
  orgId: number | null;
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
  /** The open repossession notice, if the machine carries one. */
  notice: OpenNotice | null;
  /** The open engineering hold, if it is held. */
  hold: OpenHold | null;
  canPostNotice: boolean;
  canRaiseHold: boolean;
  /** When the machine was last successfully told, in shop time. */
  noticePushed: string;
  /** The engine's words when the last attempt failed, else "". */
  noticeError: string;
  /** The open theft lockout, if the machine is under one. */
  lockout: OpenLockout | null;
  canLock: boolean;
  lease: OpenLease | null;
  canManageLease: boolean;
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
  /**
   * The organizations this person may enroll a machine for - and so the ones a
   * machine may be handed to, since both are the same capability: deciding
   * whose device group a PC sits in. Empty for anyone who may do neither.
   */
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
              aria-label="Organization to enroll a machine for" className="t-small" style={{ width: "auto" }}>
              {enrollOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <Link href={enrollOrg ? `/remote/enroll/${enrollOrg}` : "/remote"}
              className="btn sm accent" style={{ textDecoration: "none" }}>Enroll a machine</Link>
          </>
        ) : undefined}>
        {devices.length === 0 && (
          <div className="mut t-body">
            No machines yet.{canEnroll ? "" : " Ask us to enroll one."}
          </div>
        )}

        {devices.map((d) => (
          <div key={d.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Dot tone={d.online ? "good" : "faint"} />
              <b style={{ fontSize: 14, color: "var(--navy)" }}>{deviceLabel(d.nickname, d.name)}</b>
              {/* Kept beside the nickname, never replaced by it: the nickname
                  finds the machine, the hostname proves it is the right one. */}
              {deviceSubLabel(d.nickname, d.name) && (
                <span className="mono mut t-meta">{deviceSubLabel(d.nickname, d.name)}</span>
              )}
              {d.orgName && <span className="mut t-small">{d.orgName}</span>}
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
                  <span className="mut t-meta" style={{ maxWidth: 220 }}>{d.refusal}</span>
                ) : null}
              </span>
            </div>

            <div className="mut t-meta" style={{ marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
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
                  placeholder={needsNickname(d.nickname, d.name) ? "name it - e.g. Altis PC" : "no name"}
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
                  className="t-meta" style={{ width: 170 }} />

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
                  className="t-meta" style={{ width: "auto", maxWidth: 240 }}>
                  <option value="">not linked to a system</option>
                  {systems.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>

                {/* Whose machine it is. A pick here moves it between device
                    groups on the support host, which is what makes it visible
                    to one client and not another - so, unlike the two beside
                    it, it asks first and takes a reason. */}
                {enrollOrgs.length > 0 && (
                  <select value={d.orgId ?? ""} disabled={pending} aria-label={`Owner of ${d.name}`}
                    onChange={async (e) => {
                      const next = enrollOrgs.find((o) => String(o.id) === e.target.value);
                      if (!next || next.id === d.orgId) return;
                      const label = deviceLabel(d.nickname, d.name);
                      // Cancelling leaves the select where it was: React puts a
                      // controlled select back to its value after the handler.
                      const why = await confirmReason({
                        title: `Hand "${label}" to ${next.name}?`,
                        context: d.orgName ? `now ${d.orgName}` : "not assigned to anyone",
                        body: `It moves into ${next.name}'s device group on the support host. `
                          + `${next.name}'s people with remote access can then reach it`
                          + `${d.orgName ? `, and ${d.orgName}'s no longer can` : ""}. `
                          + "Its link to a system stays only if the new owner owns that system.",
                        action: "Hand over", tone: "primary",
                      });
                      if (!why) return;
                      setError("");
                      startTransition(async () => {
                        const res = await reassignRemoteDevice(d.id, next.id, why);
                        setError(res?.error ?? "");
                        if (!res?.error) {
                          toast({ message: `${label} now belongs to ${next.name}${res.unlinked ? " - unlinked from its system" : ""}` });
                        }
                      });
                    }}
                    className="t-meta" style={{ width: "auto", maxWidth: 200 }}>
                    {d.orgId === null && <option value="">not assigned</option>}
                    {enrollOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                )}

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
                  className="t-meta" style={{ width: "auto" }}>
                  <option value="derive">consent follows custody</option>
                  <option value="always">always ask first</option>
                  <option value="never">never ask</option>
                </select>

                <button className="btn link" style={{ color: "var(--t-bad-fg)", marginLeft: "auto" }} disabled={pending}
                  onClick={async () => {
                    const label = deviceLabel(d.nickname, d.name);
                    const title = `Remove "${label}" from remote support?`;
                    // The machine is deleted on the support host as well as
                    // here; a row forgotten here alone is back on the next
                    // page load. What that cannot do is stop an agent that is
                    // still installed from enrolling itself again - so a
                    // machine that is online right now is offered the choice
                    // of having its agent uninstall itself first. One that is
                    // offline cannot be told, and is not offered a promise the
                    // host cannot keep.
                    let why: string | null;
                    let uninstall = false;
                    if (d.online && !stale) {
                      const answer = await choiceDialog({
                        title, action: "Remove", tone: "bad", label: "Reason",
                        placeholder: "Recorded in the audit trail", hint: "A few words, kept with the record of this action.",
                        body: "It is removed here and on the support host. An agent left installed on the PC enrolls "
                          + "the machine again the next time it checks in.",
                        choiceLabel: "The agent on the PC",
                        choices: [
                          { value: "keep", label: "Leave it installed", note: "the machine comes back when it next checks in" },
                          { value: "uninstall", label: "Tell it to uninstall itself first", note: "remote access to this PC ends for good" },
                        ],
                      });
                      why = answer ? answer.value : null;
                      uninstall = answer?.choice === "uninstall";
                    } else {
                      why = await confirmReason({
                        title, action: "Remove", tone: "bad",
                        body: "It is removed here and on the support host. If an agent is still installed on the PC, "
                          + "it enrolls the machine again the next time it checks in - remove it then while it is "
                          + "online to have the agent uninstall itself.",
                      });
                    }
                    if (!why) return;
                    setError("");
                    startTransition(async () => {
                      const res = await removeRemoteDevice(d.id, why, uninstall);
                      setError(res?.error ?? "");
                      if (!res?.error) toast({ message: `Removed ${label}${uninstall ? " and told its agent to uninstall" : ""}` });
                    });
                  }}>remove</button>
              </div>
            )}

            <DeviceManage
              deviceId={d.id}
              label={deviceLabel(d.nickname, d.name)}
              consentMode={d.consentMode}
              consentWhy={d.consentWhy}
              notice={d.notice}
              hold={d.hold}
              canPostNotice={d.canPostNotice}
              canRaiseHold={d.canRaiseHold}
              noticePushed={d.noticePushed}
              noticeError={d.noticeError}
              lockout={d.lockout}
              canLock={d.canLock}
              lease={d.lease}
              canManageLease={d.canManageLease}
            />
          </div>
        ))}
        {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 10 }}>{error}</div>}
      </Panel>
      <Legend items={[{ tone: "good", label: "online" }, { tone: "faint", label: "offline" }]} />
    </>
  );
}
