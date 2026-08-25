"use client";

import { useState, useTransition } from "react";
import { setCalendarFeed } from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Panel } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

/**
 * The subscription door: this same calendar inside Google/Apple/Outlook.
 *
 * A subscribed phone calendar cannot sign in, so the URL itself is the
 * credential - which is why it is owner-only, generated on purpose, and
 * rotated by generating again (the old URL dies with the old token).
 */
export default function CalendarFeedCard({ token }: { token: string }) {
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);
  const url = token
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/calendar?token=${token}`
    : "";

  const generate = (rotating: boolean) =>
    startTransition(async () => {
      if (rotating && !(await confirmDialog({
        title: "Rotate the feed link?",
        body: "Every calendar subscribed to the old link stops updating. Share the new one with the crew.",
        action: "Rotate it", tone: "bad",
      }))) return;
      const res = await setCalendarFeed(true);
      if (res?.error) { toast({ message: res.error }); return; }
      toast({ message: rotating ? "New link - the old one is dead" : "Feed is on - copy the link below" });
    });

  return (
    <Panel title="Subscribe on your phone"
      hint="A read-only feed of this calendar for Google Calendar, Apple Calendar or Outlook. The link is the key - share it with the crew, nobody else.">
      {token ? (
        <>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input readOnly value={url} className="mono t-small" style={{ flex: "1 1 260px" }}
              onFocus={(e) => e.target.select()} aria-label="Calendar feed URL" />
            <button className="btn sm" disabled={pending}
              onClick={async () => {
                await navigator.clipboard.writeText(url).catch(() => {});
                setCopied(true); setTimeout(() => setCopied(false), 2000);
              }}>{copied ? "Copied" : "Copy"}</button>
            <button className="btn sm" disabled={pending} onClick={() => generate(true)}>Rotate</button>
            <button className="btn sm" disabled={pending}
              onClick={() => startTransition(async () => {
                if (!(await confirmDialog({
                  title: "Turn the feed off?",
                  body: "Every subscribed calendar goes quiet until a new link is made.",
                  action: "Turn it off", tone: "bad",
                }))) return;
                const res = await setCalendarFeed(false);
                if (res?.error) toast({ message: res.error });
                else toast({ message: "Feed off - the link is dead" });
              })}>Turn off</button>
          </div>
          <div className="mut t-meta" style={{ marginTop: 6 }}>
            In Google Calendar: Other calendars → + → From URL. Phones refresh feeds on their own
            schedule - hours, not minutes.
          </div>
        </>
      ) : (
        <button className="btn sm accent" disabled={pending} onClick={() => generate(false)}>
          {pending ? "Creating..." : "Create the feed link"}
        </button>
      )}
    </Panel>
  );
}
