import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { messageThreads, threadMembers, messages } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { visibleDirectory } from "@/lib/directory";
import { messageableFrom, threadTitle } from "@/lib/messages";
import ThreadPanel from "@/components/ThreadPanel";

export const dynamic = "force-dynamic";

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const threadId = parseInt(id);
  if (isNaN(threadId)) notFound();
  const me = user.email.toLowerCase();

  // Membership IS the access rule - there is nothing else to check.
  const [seat] = await db.select().from(threadMembers)
    .where(and(eq(threadMembers.threadId, threadId), eq(threadMembers.email, me)));
  if (!seat || seat.leftAt) notFound();

  const [[thread], mem, msgs] = await Promise.all([
    db.select().from(messageThreads).where(eq(messageThreads.id, threadId)),
    db.select().from(threadMembers).where(eq(threadMembers.threadId, threadId)).orderBy(asc(threadMembers.id)),
    db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(asc(messages.createdAt)),
  ]);
  if (!thread) notFound();

  const directory = messageableFrom(await visibleDirectory(user), user.email);
  const here = new Set(mem.filter((m) => !m.leftAt).map((m) => m.email));

  return (
    <div className="container page">
      <div className="no-print" style={{ marginBottom: 10 }}>
        <Link href="/messages" className="mut" style={{ fontSize: 13, textDecoration: "none" }}>
          ← All messages
        </Link>
      </div>
      <ThreadPanel
        threadId={threadId}
        title={threadTitle(thread.title, mem.map((m) => ({
          email: m.email, name: m.name, orgName: m.orgName, leftAt: m.leftAt?.toISOString() ?? null,
        })), me)}
        named={!!thread.title.trim()}
        me={me}
        members={mem.map((m) => ({
          email: m.email, name: m.name || m.email, orgName: m.orgName,
          left: !!m.leftAt,
        }))}
        messages={msgs.map((m) => ({
          id: m.id, authorEmail: m.authorEmail, authorName: m.authorName || m.authorEmail,
          body: m.body, createdAt: m.createdAt.toISOString(),
          deletedAt: m.deletedAt?.toISOString() ?? null,
        }))}
        // People not already in the room, for adding somebody mid-conversation.
        addable={directory.filter((d) => !here.has(d.email.toLowerCase()))}
      />
    </div>
  );
}
