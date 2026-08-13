import { redirect } from "next/navigation";
import Link from "next/link";
import { and, asc, desc, eq, isNull, isNotNull, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { discussionPosts, instruments, discussionReads, orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { forTenant, readTenant, visibleOrgs, visibleSystemIds } from "@/lib/tenancy";
import { canSeePost, roomThreadId, type Audience } from "@/lib/discussionScope";
import { getBrand } from "@/lib/brand";
import { shopTime } from "@/lib/shopday";
import DiscussionPanel from "@/components/DiscussionPanel";

export const dynamic = "force-dynamic";

/**
 * The General board is a set of private rooms, not a lobby. Each organization
 * has one room - theirs with the operator - and the operator has a room of its
 * own plus a seat in all the others. A client can therefore never read another
 * client's general chatter, which a single shared board made unavoidable.
 *
 * System threads follow their systems, and each post inside one follows its own
 * audience, so an internal note never appears here either.
 */
export default async function DiscussionsPage({ searchParams }: { searchParams: Promise<{ room?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const canEdit = user.role !== "client_viewer";
  const isHouseUser = user.role === "owner" || user.role === "staff";
  // Which house, not just "a house": two service companies on one instance are
  // both staff, and each other's rooms are none of their business.
  const myTenant = readTenant(user);
  const viewer = { isHouse: isHouseUser, orgId: user.orgId, houseOrgId: isHouseUser ? myTenant : null };

  const visible = await visibleSystemIds(user);
  const mineSystems = visible === null ? undefined
    : visible.length ? inArray(discussionPosts.instrumentId, visible) : sql`false`;

  const [general, recent, insts, marks, orgRows, brand] = await Promise.all([
    // Scoped to this workspace. Unscoped, the General board handed one service
    // company every room on another's - canSeePost refuses them now, but a query
    // that reads them at all is one filter away from leaking them again.
    db.select().from(discussionPosts)
      .where(and(isNull(discussionPosts.instrumentId), forTenant(discussionPosts.tenantOrgId, myTenant)))
      .orderBy(asc(discussionPosts.createdAt)),
    db.select().from(discussionPosts).where(and(isNotNull(discussionPosts.instrumentId), mineSystems)).orderBy(desc(discussionPosts.createdAt)).limit(60),
    db.select({ id: instruments.id, externalId: instruments.externalId }).from(instruments)
      .where(visible === null ? undefined : visible.length ? inArray(instruments.id, visible) : sql`false`),
    // Room markers only: 0 is the viewer's own room, negatives are the
    // operator's markers for each organization's room.
    db.select().from(discussionReads)
      .where(and(eq(discussionReads.userEmail, user.email), lte(discussionReads.threadId, 0))),
    visibleOrgs(user),
    getBrand(),
  ]);

  const readable = general.filter((p) => canSeePost(viewer, { ...p, audience: p.audience as Audience }));
  const ownRoomName = `${brand.operatorName} (internal)`;
  // The rooms this viewer may sit in. An organization has exactly one.
  const rooms = isHouseUser
    ? [{ orgId: null as number | null, name: ownRoomName }, ...orgRows.map((o) => ({ orgId: o.id as number | null, name: o.name }))]
    : user.orgId === null ? [] : [{ orgId: user.orgId as number | null, name: orgRows.find((o) => o.id === user.orgId)?.name ?? "your organization" }];

  const { room: roomParam } = await searchParams;
  const wanted = roomParam && /^\d+$/.test(roomParam) ? parseInt(roomParam) : null;
  const active = rooms.find((r) => r.orgId === wanted) ?? rooms[0];

  const unreadIn = (orgId: number | null) => {
    const mark = marks.find((m) => m.threadId === roomThreadId(viewer, orgId))?.lastSeenAt;
    return readable.filter((p) => p.roomOrgId === orgId && p.authorEmail !== user.email && (!mark || p.createdAt > mark)).length;
  };

  const partyName = (orgId: number | null) =>
    orgId === null ? brand.operatorName : orgRows.find((o) => o.id === orgId)?.name ?? "a former organization";
  const visibleRecent = recent.filter((p) => canSeePost(viewer, { ...p, audience: p.audience as Audience }));
  const label = new Map(insts.map((i) => [i.id, i.externalId]));

  return (
    <div className="container page">
      {/* Only the operator has more than one room, so only they get a picker. */}
      {rooms.length > 1 && (
        <div className="card" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span className="mut" style={{ fontSize: 12, marginRight: 4 }}>Room</span>
          {rooms.map((r) => {
            const on = r.orgId === active?.orgId;
            const unread = unreadIn(r.orgId);
            return (
              <Link key={r.orgId ?? "own"} href={r.orgId === null ? "/discussions" : `/discussions?room=${r.orgId}`}
                className={on ? "btn sm accent" : "btn sm"} style={{ textDecoration: "none" }}>
                {r.name}{unread > 0 ? ` (${unread})` : ""}
              </Link>
            );
          })}
        </div>
      )}

      {active ? (
        <DiscussionPanel
          instrumentId={null}
          threadId={roomThreadId(viewer, active.orgId)}
          roomOrgId={active.orgId}
          posts={readable.filter((p) => p.roomOrgId === active.orgId).map((p) => ({
            ...p, createdAt: p.createdAt.toISOString(),
            authorParty: partyName(p.authorOrgId), internal: p.audience === "internal",
          }))}
          canEdit={canEdit}
          newCount={unreadIn(active.orgId)}
          partyName={isHouseUser ? brand.operatorName : active.name}
          sharedWith={active.orgId === null ? `${brand.operatorName} only` : `${brand.operatorName} and ${active.name}`}
          title={active.orgId === null ? `${brand.operatorName} board` : `${brand.operatorName} × ${active.name}`}
          subtitle={active.orgId === null
            ? `Anything not tied to one system. ${brand.operatorName} staff only - no client reads this room.`
            : `Anything not tied to one system. Just ${brand.operatorName} and ${active.name} - no other organization reads this room.`}
        />
      ) : (
        <div className="card">
          <div className="mut" style={{ fontSize: 13 }}>
            Your sign-in isn&apos;t attached to an organization yet, so you have no general room.
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Recent system discussions</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>Tap through to reply on the system&apos;s page.</div>
        {visibleRecent.slice(0, 30).map((p) => (
          <Link key={p.id} href={`/instruments/${p.instrumentId}`} className="row-hover"
            style={{ display: "block", padding: "8px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit" }}>
            <div style={{ fontSize: 12 }}>
              <span className="mono" style={{ fontWeight: 700, color: "var(--navy)" }}>{label.get(p.instrumentId!) ?? "?"}</span>{" "}
              <b>{p.author}</b>{" "}
              <span className="mut" style={{ fontSize: 11 }}>{shopTime(p.createdAt)}</span>
              {p.audience === "internal" && (
                <>{" "}<span className="pill" style={{ background: "#FAF0DC", color: "#8A5410" }}>internal</span></>
              )}
            </div>
            <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.body}</div>
          </Link>
        ))}
        {visibleRecent.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No system discussions yet.</div>}
      </div>
    </div>
  );
}
