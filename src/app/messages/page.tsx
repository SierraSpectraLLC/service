import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { messageThreads, threadMembers, messages } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { visibleDirectory } from "@/lib/directory";
import { messageableFrom, threadTitle, unreadCount } from "@/lib/messages";
import { fmtWhen } from "@/lib/when";
import NewMessageButton from "@/components/NewMessageButton";

export const dynamic = "force-dynamic";

/**
 * Conversations between people, as opposed to the discussion on a system.
 *
 * The split is deliberate: "is the Altis fixed?" belongs on the Altis, where
 * the next engineer finds it, and "can you cover Tuesday?" belongs to the two
 * people it concerns. The second used to have to leave this app entirely.
 */
export default async function MessagesPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
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

  return (
    <div className="container page">
      <div className="page-head">
        <h1 className="page-title">Messages</h1>
        {totalUnread > 0 && (
          <span className="pill bad">
            {totalUnread} unread
          </span>
        )}
        <span className="page-actions"><NewMessageButton people={people} /></span>
        <p className="page-sub">
          Direct and small-group conversations with the people you work with. Anything about a
          particular system is better said on that system, where whoever picks it up next will find it.
        </p>
      </div>

      <div className="card">
        {rows.length === 0 && (
          <div className="empty">
            <b>No conversations yet</b>
            Message anyone at your organization, or anyone you share a system with.
          </div>
        )}
        {rows.map((r) => (
          <Link key={r.id} href={`/messages/${r.id}`} className="row-hover"
            style={{
              display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
              padding: "9px 4px", borderTop: "1px solid var(--line)",
              textDecoration: "none", color: "inherit",
            }}>
            <span style={{ fontSize: 13, fontWeight: r.unread ? 700 : 600, flex: "0 0 auto" }}>{r.title}</span>
            {r.members > 2 && (
              <span className="pill neutral">{r.members}</span>
            )}
            {r.unread > 0 && (
              <span className="pill bad">{r.unread} new</span>
            )}
            <span className="mut" style={{ fontSize: 12, flex: "1 1 200px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.lastWho ? `${r.lastWho}: ` : ""}{r.lastLine}
            </span>
            <span className="mut" style={{ fontSize: 11 }}>{r.when}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
