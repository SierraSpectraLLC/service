"use client";

import Link from "next/link";
import { useTransition } from "react";
import { markNotificationRead, markAllNotificationsRead } from "@/app/actions";
import { NOTIFY_KINDS } from "@/lib/inbox";
import { DataTable, Dot, FacetStrip, Legend, PageHead, Toolbar } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

export type InboxItem = {
  id: number; kind: string; title: string; href: string;
  when: string;        // pre-formatted in shop time by the page
  read: boolean;
};

/**
 * The mail itself, and nothing else.
 *
 * The email switches used to sit under this list, which is how the account
 * menu came to point "Notifications & email" at a page of letters. They are a
 * preference, so they live in the account section now - see
 * components/NotificationPrefs. This page is what the system has told you.
 */
export default function InboxPanel({ items, filter }: {
  items: InboxItem[];
  /** From the URL (?kind=, ?unread=1), so a filtered inbox is a link. */
  filter: { kind?: string; unread?: string };
}) {
  const [pending, startTransition] = useTransition();
  const unread = items.filter((i) => !i.read).length;
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
      <PageHead title="Inbox" sub="What the system has told you."
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
        empty="Nothing yet."
      />
      <Legend items={[{ tone: "info", label: "unread" }]} />
      {/* Where the switches went. One line rather than the panel that used to
          live here: the preference is not part of reading the mail. */}
      <div className="mut t-small" style={{ marginTop: 12 }}>
        Which of these also email you is set in{" "}
        <Link href="/account/notifications">Account · Notifications</Link>.
      </div>
    </>
  );
}
