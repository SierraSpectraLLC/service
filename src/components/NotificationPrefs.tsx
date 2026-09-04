"use client";

import { useTransition } from "react";
import { setNotificationPref } from "@/app/actions";
import { notifyKindsFor } from "@/lib/inbox";
import DesktopAlerts from "@/components/DesktopAlerts";
import { Panel } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

/**
 * Which events reach you, and how.
 *
 * These switches used to live at the bottom of the inbox, under a hundred rows
 * of the mail they govern - and the account menu's "Notifications & email" link
 * pointed at that same inbox, so the word in the menu named the switches and
 * the page it opened was the letters. Mail is mail; this is the preference,
 * and it is a room of the account section now.
 *
 * Only the opt-OUTS are stored (no row means email is on), which is why every
 * box starts ticked for a new account - see lib/inbox.
 */
export default function NotificationPrefs({ prefs, role }: {
  prefs: { kind: string; emailOn: boolean }[];
  /**
   * The owner gets every switch, their staff every switch but the owner's
   * own, and a client only the kinds that can actually reach them. See
   * notifyKindsFor - a switch that can never do anything is not a neutral
   * extra row, it is a claim about this instance being read by somebody it
   * was not written for.
   */
  role: string;
}) {
  const [pending, startTransition] = useTransition();
  const emailOn = (kind: string) => prefs.find((p) => p.kind === kind)?.emailOn ?? true;

  return (
    <>
      <Panel title="Email" hint="Which kinds also email you. Everything still lands in your inbox either way.">
        {notifyKindsFor(role).map((k) => (
          <label key={k.kind} className="t-body" style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", cursor: "pointer" }}>
            <input type="checkbox" checked={emailOn(k.kind)} disabled={pending} className="check"
              onChange={(e) => {
                const on = e.target.checked;
                startTransition(async () => {
                  await setNotificationPref(k.kind, on);
                  toast({ message: `${k.label} emails ${on ? "on" : "off"}` });
                });
              }} />
            {k.label}
          </label>
        ))}
      </Panel>
      {/* The browser's own alerts, for when the tab is not the one in front.
          It belongs beside the email switches for the obvious reason: they are
          the same question asked about a different channel. */}
      <DesktopAlerts />
    </>
  );
}
