import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { messageThreads, threadMembers, messages } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { visibleDirectory } from "@/lib/directory";
import { messageableFrom, threadTitle, unreadCount } from "@/lib/messages";
import { fmtWhen } from "@/lib/when";
import NewMessageButton from "@/components/NewMessageButton";
import { DataTable, Dot, FacetStrip, Legend, PageHead, Pill, Toolbar } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Conversations between people, as opposed to the discussion on a system.
 *
 * The split is deliberate: "is the Altis fixed?" belongs on the Altis, where
 * the next engineer finds it, and "can you cover Tuesday?" belongs to the two
 * people it concerns. The second used to have to leave this app entirely.
 */
export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ q?: string; unread?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { q = "", unread = "" } = await searchParams;
  const me = user.email.toLowerCase();

  const seats = await db.select().from(threadMembers)
    .where(and(eq(threadMembers.email, me), isNull(threadMembers.leftAt)));
  const threadIds = seats.map((s) => s.threadId);

  const [threads, allMembers, recent] = await Promise.all([
    threadIds.length
      ? db.select().from(messageThreads).where(inArray(messageThreads.id, threadIds))
          .orderBy(desc(messageThreads.lastMessageAt))
      : [],
    threadIds.length
      ? db.select().from(threadMembers).where(inArray(threadMembers.threadId, threadIds)).orderBy(asc(threadMembers.id))
      : [],
    // Every message in the reader's threads: the list needs the last line of
    // each and a count of what arrived since they looked. A shop with years of
    // history would page this; a conversation list is small by nature.
    threadIds.length
      ? db.select({
          id: messages.id, threadId: messages.threadId, authorEmail: messages.authorEmail,
          authorName: messages.authorName, body: messages.body, createdAt: messages.createdAt,
          deletedAt: messages.deletedAt,
        }).from(messages).where(inArray(messages.threadId, threadIds)).orderBy(asc(messages.createdAt))
      : [],
  ]);

  const people = messageableFrom(await visibleDirectory(user), user.email);

  const rows = threads.map((t) => {
    const mem = allMembers.filter((m) => m.threadId === t.id);
    const msgs = recent.filter((m) => m.threadId === t.id);
    const last = msgs[msgs.length - 1];
    const seat = seats.find((s) => s.threadId === t.id);
    return {
      id: t.id,
      title: threadTitle(t.title, mem.map((m) => ({
        email: m.email, name: m.name, orgName: m.orgName, leftAt: m.leftAt?.toISOString() ?? null,
      })), me),
      members: mem.filter((m) => !m.leftAt).length,
      unread: unreadCount(
        msgs.map((m) => ({ authorEmail: m.authorEmail, createdAt: m.createdAt.toISOString() })),
        seat?.lastReadAt?.toISOString() ?? null, me,
      ),
      lastLine: last ? (last.deletedAt ? "message taken back" : last.body) : "",
      lastWho: last ? (last.authorEmail.toLowerCase() === me ? "You" : last.authorName || last.authorEmail) : "",
      when: last ? fmtWhen(last.createdAt.toISOString()) : fmtWhen(t.createdAt.toISOString()),
    };
  });

  const totalUnread = rows.reduce((n, r) => n + r.unread, 0);
  const needle = q.trim().toLowerCase();
  const unreadOnly = unread === "1";
  const shown = rows.filter((r) =>
    (!unreadOnly || r.unread > 0)
    && (!needle || [r.title, r.lastWho, r.lastLine].join(" ").toLowerCase().includes(needle)));
  const href = (u: boolean) => {
    const p = new URLSearchParams();
    if (needle) p.set("q", needle);
    if (u) p.set("unread", "1");
    return `/messages${p.size ? `?${p}` : ""}`;
  };

  return (
    <div className="container page">
      <PageHead
        title="Messages"
        actions={<NewMessageButton people={people} />}
        sub="Direct and small-group conversations with the people you work with. Anything about a particular system is better said on that system, where whoever picks it up next will find it."
      />
      <Toolbar
        search={
          <form action="/messages">
            {unreadOnly && <input type="hidden" name="unread" value="1" />}
            <input name="q" defaultValue={q} placeholder="Person or conversation" aria-label="Search conversations" />
          </form>
        }
        facets={
          <FacetStrip facets={[
            { key: "unread", label: "Unread", count: totalUnread || undefined, on: unreadOnly, href: href(!unreadOnly) },
          ]} />
        }
      />
      <DataTable
        cols={[
          { key: "dot", label: "", width: "12px" },
          { key: "who", label: "Conversation", width: "minmax(140px, 1.2fr)" },
          { key: "last", label: "Last message", width: "minmax(180px, 2fr)", hideMobile: true },
          { key: "new", label: "", width: "70px" },
          { key: "when", label: "When", width: "90px", align: "right" },
        ]}
        rows={shown.map((r) => ({
          key: r.id,
          href: `/messages/${r.id}`,
          cells: {
            dot: r.unread > 0 ? <Dot tone="info" /> : null,
            who: (
              <span className="t-body" style={{ fontWeight: r.unread ? 700 : 600 }}>
                {r.title}
                {r.members > 2 && <span className="mut" style={{ fontWeight: 400 }}> · {r.members} people</span>}
              </span>
            ),
            last: (
              <span className="mut t-small" style={{ display: "block", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.lastWho ? `${r.lastWho}: ` : ""}{r.lastLine}
              </span>
            ),
            new: r.unread > 0 ? <Pill tone="bad">{r.unread} new</Pill> : null,
            when: <span className="mut t-meta">{r.when}</span>,
          },
        }))}
        empty="No conversations yet - message anyone at your organization, or anyone you share a system with"
      />
      <Legend items={[{ tone: "info", label: "unread" }]} />
    </div>
  );
}
