import { redirect } from "next/navigation";
import Link from "next/link";
import { asc, desc, isNull, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { discussionPosts, instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { shopTime } from "@/lib/shopday";
import DiscussionPanel from "@/components/DiscussionPanel";

export const dynamic = "force-dynamic";

export default async function DiscussionsPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const isStaff = user.role === "owner" || user.role === "staff";

  const [general, recent, insts] = await Promise.all([
    db.select().from(discussionPosts).where(isNull(discussionPosts.instrumentId)).orderBy(asc(discussionPosts.createdAt)),
    db.select().from(discussionPosts).where(isNotNull(discussionPosts.instrumentId)).orderBy(desc(discussionPosts.createdAt)).limit(30),
    db.select({ id: instruments.id, externalId: instruments.externalId }).from(instruments),
  ]);
  const label = new Map(insts.map((i) => [i.id, i.externalId]));

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <DiscussionPanel
        instrumentId={null}
        posts={general.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() }))}
        isStaff={isStaff}
        title="General discussion"
        subtitle="Lab-wide topics."
      />

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
