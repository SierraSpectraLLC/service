"use client";

import Link from "next/link";
import { useTransition } from "react";
import { markNotificationRead, markAllNotificationsRead, setNotificationPref } from "@/app/actions";
import { NOTIFY_KINDS } from "@/lib/inbox";
import DesktopAlerts from "@/components/DesktopAlerts";
import { DataTable, Dot, FacetStrip, Legend, PageHead, Panel, Toolbar } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

export type InboxItem = {
  id: number; kind: string; title: string; href: string;
  when: string;        // pre-formatted in shop time by the page
  read: boolean;
};

export default function InboxPanel({ items, prefs, filter }: {
  items: InboxItem[];
  prefs: { kind: string; emailOn: boolean }[];
  /** From the URL (?kind=, ?unread=1), so a filtered inbox is a link. */
  filter: { kind?: string; unread?: string };
}) {
  const [pending, startTransition] = useTransition();
  const unread = items.filter((i) => !i.read).length;
  const emailOn = (kind: string) => prefs.find((p) => p.kind === kind)?.emailOn ?? true;
  const kindLabel = (k: string) => NOTIFY_KINDS.find((x) => x.kind === k)?.label ?? k;

  const activeKind = filter.kind ?? "";
  const unreadOnly = filter.unread === "1";
  const shown = items.filter((n) =>
    (!activeKind || n.kind === activeKind) && (!unreadOnly || !n.read));
  const href = (next: { kind?: string; unread?: string }) => {
    const merged = { kind: activeKind, unread: unreadOnly ? "1" : "", ...next };
    const p = new URLSearchParams();
    if (merged.kind) p.set("kind", merged.kind);
    if (merged.unread === "1") p.set("unread", "1");
    return `/inbox${p.size ? `?${p}` : ""}`;
  };
  const kindsPresent = [...new Set(items.map((n) => n.kind))];

  return (
    <>
      <PageHead title="Inbox"
        actions={unread > 0 && (
          <button className="btn sm" disabled={pending}
            onClick={() => startTransition(async () => {
              await markAllNotificationsRead();
              toast({ message: `Marked ${unread} notification${unread === 1 ? "" : "s"} read` });
            })}>
            Mark all read
          </button>
        )} />
      <Toolbar
        facets={
          <FacetStrip facets={[
            { key: "unread", label: "Unread", count: unread || undefined, on: unreadOnly, href: href({ unread: unreadOnly ? "" : "1" }) },
            ...kindsPresent.map((k) => ({
              key: k, label: kindLabel(k),
              count: items.filter((n) => n.kind === k).length,
              on: activeKind === k,
              href: href({ kind: activeKind === k ? "" : k }),
            })),
          ]} />
        }
      />
      <DataTable
        cols={[
          { key: "dot", label: "", width: "12px" },
          { key: "title", label: "Notification", width: "minmax(200px, 3fr)" },
          { key: "kind", label: "Kind", width: "minmax(110px, 1fr)", hideMobile: true },
          { key: "when", label: "When", width: "110px", align: "right" },
        ]}
        rows={shown.map((n) => ({
          key: n.id,
          cells: {
            dot: n.read ? null : <Dot tone="info" />,
            title: n.href ? (
              // Reading is a side effect of following the link, not a step
              // the user has to remember - fire it and let navigation go on.
              <Link href={n.href} className="t-body" style={{ textDecoration: "none", color: "inherit", fontWeight: n.read ? 400 : 700 }}
                onClick={() => { if (!n.read) markNotificationRead(n.id); }}>
                {n.title}
              </Link>
            ) : (
              <span className="t-body" style={{ fontWeight: n.read ? 400 : 700 }}>{n.title}</span>
            ),
            kind: <span className="mut">{kindLabel(n.kind)}</span>,
            when: <span className="mut">{n.when}</span>,
          },
        }))}
        empty="Nothing yet - assignments, discussion posts, access requests and empty-gas flags land here as well as in email"
      />
      <Legend items={[{ tone: "info", label: "unread" }]} />

      <DesktopAlerts />

      <Panel title="Email preferences"
        hint="Everything always lands in this inbox; these only control which kinds also email you.">
        {NOTIFY_KINDS.map((k) => (
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
    </>
  );
}
