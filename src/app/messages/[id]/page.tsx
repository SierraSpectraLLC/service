import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { messageThreads, threadMembers, messages } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { visibleDirectory } from "@/lib/directory";
import { messageableFrom, threadTitle } from "@/lib/messages";
import ThreadPanel from "@/components/ThreadPanel";
import { RecordHero, type HeroStat } from "@/components/ui";

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

  const title = threadTitle(thread.title, mem.map((m) => ({
    email: m.email, name: m.name, orgName: m.orgName, leftAt: m.leftAt?.toISOString() ?? null,
  })), me);
  const active = mem.filter((m) => !m.leftAt);
  const said = msgs.filter((m) => !m.deletedAt);
  const heroStats: HeroStat[] = [
    { value: active.length, label: active.length === 1 ? "person" : "people" },
    { value: said.length, label: said.length === 1 ? "message" : "messages" },
  ];

  return (
    <div className="container page">
      <div className="crumb no-print">
        <Link href="/messages" style={{ textDecoration: "none", color: "inherit" }}>Messages</Link> › <b>Thread</b>
      </div>
      <RecordHero
        eyebrow="Conversation"
        title={title}
        meta={active.map((m) => (m.orgName ? `${m.name || m.email} (${m.orgName})` : m.name || m.email)).join(", ")}
        stats={heroStats}
      />
      <ThreadPanel
        threadId={threadId}
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
