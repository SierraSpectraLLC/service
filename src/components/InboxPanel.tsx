"use client";

import Link from "next/link";
import { useTransition } from "react";
import { markNotificationRead, markAllNotificationsRead, setNotificationPref } from "@/app/actions";
import { NOTIFY_KINDS } from "@/lib/inbox";

export type InboxItem = {
  id: number; kind: string; title: string; href: string;
  when: string;        // pre-formatted in shop time by the page
  read: boolean;
};

export default function InboxPanel({ items, prefs }: {
  items: InboxItem[];
  prefs: { kind: string; emailOn: boolean }[];
}) {
  const [pending, startTransition] = useTransition();
  const unread = items.filter((i) => !i.read).length;
  const emailOn = (kind: string) => prefs.find((p) => p.kind === kind)?.emailOn ?? true;

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10, gap: 8 }}>
          <div className="card-title">Inbox</div>
          {unread > 0 && (
            <>
              <span className="pill" style={{ background: "#FDECEC", color: "#A32D2D" }}>{unread} unread</span>
              <button className="btn sm" style={{ marginLeft: "auto" }} disabled={pending}
                onClick={() => startTransition(async () => { await markAllNotificationsRead(); })}>
                Mark all read
              </button>
            </>
          )}
        </div>

        {items.length === 0 && (
          <div className="mut" style={{ fontSize: 13 }}>
            Nothing yet. Assignments, discussion posts, access requests and empty-gas
            flags land here as well as in email.
          </div>
        )}
        {items.map((n) => {
          const body = (
            <span style={{ fontSize: 13, fontWeight: n.read ? 400 : 700 }}>{n.title}</span>
          );
          return (
            <div key={n.id} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "7px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
              <span aria-hidden style={{
                width: 7, height: 7, borderRadius: 999, flex: "0 0 auto", alignSelf: "center",
                background: n.read ? "transparent" : "var(--accent, #1D6396)",
              }} />
              {n.href ? (
                // Reading is a side effect of following the link, not a step
                // the user has to remember - fire it and let navigation go on.
                <Link href={n.href} style={{ textDecoration: "none", color: "inherit" }}
                  onClick={() => { if (!n.read) markNotificationRead(n.id); }}>
                  {body}
                </Link>
              ) : body}
              <span className="mut" style={{ fontSize: 12, marginLeft: "auto" }}>{n.when}</span>
            </div>
          );
        })}
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Email preferences</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Everything always lands in this inbox; these only control which kinds also email you.
        </div>
        {NOTIFY_KINDS.map((k) => (
          <label key={k.kind} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={emailOn(k.kind)} disabled={pending} style={{ width: 15, height: 15 }}
              onChange={(e) => startTransition(async () => { await setNotificationPref(k.kind, e.target.checked); })} />
            {k.label}
          </label>
        ))}
      </div>
    </>
  );
}
