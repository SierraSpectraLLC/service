import { redirect } from "next/navigation";
import Link from "next/link";
import { and, asc, desc, eq, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { discussionPosts, instruments, discussionReads, appSettings } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { visibleSystemIds } from "@/lib/tenancy";
import { shopTime } from "@/lib/shopday";
import DiscussionPanel from "@/components/DiscussionPanel";

export const dynamic = "force-dynamic";

export default async function DiscussionsPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const canEdit = user.role !== "client_viewer";
  // System threads follow the same rule as the systems themselves.
  const visible = await visibleSystemIds(user);
  const mineSystems = visible === null ? undefined
    : visible.length ? inArray(discussionPosts.instrumentId, visible) : sql`false`;

  const [general, recent, insts, readRows, [settings]] = await Promise.all([
    db.select().from(discussionPosts).where(isNull(discussionPosts.instrumentId)).orderBy(asc(discussionPosts.createdAt)),
    db.select().from(discussionPosts).where(and(isNotNull(discussionPosts.instrumentId), mineSystems)).orderBy(desc(discussionPosts.createdAt)).limit(30),
    db.select({ id: instruments.id, externalId: instruments.externalId }).from(instruments)
      .where(visible === null ? undefined : visible.length ? inArray(instruments.id, visible) : sql`false`),
    db.select().from(discussionReads).where(and(eq(discussionReads.userEmail, user.email), eq(discussionReads.threadId, 0))),
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
  ]);
  // The General board is the house's shared room with the org the tracker
  // belongs to. Other organizations get their own systems' threads only, so
  // they never see cross-client chatter.
  const inGeneral = user.orgId === null || user.orgId === settings?.sheetOrgId;
  const seenGeneral = readRows[0]?.lastSeenAt;
  const newGeneral = general.filter((p) => p.authorEmail !== user.email && (!seenGeneral || p.createdAt > seenGeneral)).length;
  const label = new Map(insts.map((i) => [i.id, i.externalId]));

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      {inGeneral && (
        <DiscussionPanel
          instrumentId={null}
          posts={general.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() }))}
          canEdit={canEdit}
          newCount={newGeneral}
          title="General discussion"
          subtitle="Lab-wide topics."
        />
      )}

      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Recent system discussions</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>Tap through to reply on the system&apos;s page.</div>
        {recent.map((p) => (
          <Link key={p.id} href={`/instruments/${p.instrumentId}`} className="row-hover"
            style={{ display: "block", padding: "8px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit" }}>
            <div style={{ fontSize: 12 }}>
              <span className="mono" style={{ fontWeight: 700, color: "var(--navy)" }}>{label.get(p.instrumentId!) ?? "?"}</span>{" "}
              <b>{p.author}</b>{" "}
              <span className="mut" style={{ fontSize: 11 }}>{shopTime(p.createdAt)}</span>
            </div>
            <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.body}</div>
          </Link>
        ))}
        {recent.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No system discussions yet.</div>}
      </div>
    </div>
  );
}
