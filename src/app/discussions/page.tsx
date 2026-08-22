import { redirect } from "next/navigation";
import { and, asc, desc, eq, isNull, isNotNull, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { discussionPosts, instruments, discussionReads, orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { forTenant, readTenant, visibleOrgs, visibleSystemIds } from "@/lib/tenancy";
import { canSeePost, roomThreadId, type Audience } from "@/lib/discussionScope";
import { getBrand } from "@/lib/brand";
import { shopTime } from "@/lib/shopday";
import { fmtWhen } from "@/lib/when";
import DiscussionPanel from "@/components/DiscussionPanel";
import { visibleDirectory } from "@/lib/directory";
import { DataTable, Dot, PageHead, Pill } from "@/components/ui";

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

  // The rooms as a conversation list - the same shape as /messages: who,
  // the last line said, what is new, when.
  const roomRows = rooms.map((r) => {
    const posts = readable.filter((p) => p.roomOrgId === r.orgId);
    const last = posts[posts.length - 1];
    return {
      ...r,
      unread: unreadIn(r.orgId),
      lastWho: last ? (last.authorEmail === user.email ? "You" : last.author) : "",
      lastLine: last?.body ?? "",
      when: last ? fmtWhen(last.createdAt.toISOString()) : "",
      on: r.orgId === active?.orgId,
    };
  });

  return (
    <div className="container page">
      <PageHead title="Discussions"
        sub="Each organization has one private room with the operator; anything about a particular system belongs on that system." />
      {/* Only the operator has more than one room, so only they get the list. */}
      {rooms.length > 1 && (
        <DataTable
          cols={[
            { key: "dot", label: "", width: "12px" },
            { key: "who", label: "Room", width: "minmax(140px, 1.2fr)" },
            { key: "last", label: "Last post", width: "minmax(180px, 2fr)", hideMobile: true },
            { key: "new", label: "", width: "70px" },
            { key: "when", label: "When", width: "90px", align: "right" },
          ]}
          rows={roomRows.map((r) => ({
            key: r.orgId ?? "own",
            href: r.orgId === null ? "/discussions" : `/discussions?room=${r.orgId}`,
            cells: {
              dot: r.unread > 0 ? <Dot tone="info" /> : null,
              who: <span style={{ fontSize: 13.5, fontWeight: r.on ? 800 : 700 }}>{r.name}</span>,
              last: r.lastLine
                ? <span className="mut t-small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                    <b style={{ fontWeight: 600 }}>{r.lastWho}:</b> {r.lastLine}
                  </span>
                : <span className="mut t-small">nothing said yet</span>,
              new: r.unread > 0 ? <Pill tone="info">{r.unread} new</Pill> : null,
              when: <span className="mut" style={{ fontSize: 11.5 }}>{r.when}</span>,
            },
          }))}
          empty="No rooms"
        />
      )}

      {active ? (
        <DiscussionPanel
          people={await visibleDirectory(user)}
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
          <div className="mut t-body">
            Your sign-in isn&apos;t attached to an organization yet, so you have no general room.
          </div>
        </div>
      )}

      <div className="section-head" style={{ marginTop: 16 }}>
        <span className="section-name">Recent system discussions</span>
        <span className="mut t-small" style={{ marginLeft: 8 }}>Tap through to reply on the system&apos;s page.</span>
      </div>
      <DataTable
        cols={[
          { key: "dot", label: "", width: "12px" },
          { key: "who", label: "System", width: "minmax(120px, 0.9fr)" },
          { key: "last", label: "Post", width: "minmax(200px, 2.2fr)" },
          { key: "when", label: "When", width: "110px", align: "right" },
        ]}
        rows={visibleRecent.slice(0, 30).map((p) => ({
          key: p.id,
          href: `/instruments/${p.instrumentId}`,
          cells: {
            dot: p.audience === "internal" ? <Dot tone="warn" /> : null,
            who: <span className="mono t-small" style={{ fontWeight: 700, color: "var(--navy)" }}>{label.get(p.instrumentId!) ?? "?"}</span>,
            last: (
              <span style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                <b>{p.author}</b>{p.audience === "internal" ? <> <Pill tone="warn">internal</Pill></> : null} · {p.body}
              </span>
            ),
            when: <span className="mut" style={{ fontSize: 11.5 }}>{shopTime(p.createdAt)}</span>,
          },
        }))}
        empty="No system discussions yet"
      />
    </div>
  );
}
