// Who may read a discussion post. Thread scope (can you see this system at all?)
// is lib/tenancy's job; this module answers the narrower question tenancy cannot:
// two organizations on the same system still have things to say that are not
// each other's business.
//
// The rules, in full:
//   - A post marked `internal` is the author's organization's own note. Nobody
//     outside it reads it, and that includes the operator - "internal" would be
//     worthless if the house could read every word of it.
//   - A post marked `all` is shared with everyone who can see the thread it
//     sits on, which is exactly the point of a shared system.
//   - The General board is not one room. Each organization has its own room with
//     the operator; the operator sits in every room and has one of its own.
//     Without that, a general post by one client would be readable by every
//     other client on the instance.
//
// "The house" is a COMPANY here, not a role, and that is the part worth reading
// twice. When one service company ran the instance, staff meant the house and
// `isHouse` was enough. Two service companies can now work the same client's
// systems - Sierra on the LC-MS, Acme on the gas generator - and both of them
// are staff. Comparing roles would have handed each of them the other's internal
// notes and every room on the other's General board, in the exact configuration
// the product is sold for. So a house viewer carries WHICH house, a post carries
// which workspace it was written in, and the two have to match.

export type Audience = "all" | "internal";

export type PostScope = {
  /** Null = a General board post rather than one on a system. */
  instrumentId: number | null;
  /** The organization the author spoke for; null = a service company's own staff. */
  authorOrgId: number | null;
  /**
   * The workspace the post was written in. For a staff post this is WHICH
   * service company said it - the thing that makes "internal" mean something on
   * an instance with more than one. Null on posts written before the column
   * existed; callers resolve those to the instance's root operator, which is
   * who wrote them, because there was nobody else.
   */
  tenantOrgId: number | null;
  /** General board only: whose room. Null = a service company's own board. */
  roomOrgId: number | null;
  audience: Audience;
};

export type Viewer = {
  isHouse: boolean;
  orgId: number | null;
  /** Which service company they are staff of. Null for anyone who is not staff. */
  houseOrgId: number | null;
};

/** Is the viewer part of the organization this post was written for? */
export function sameParty(v: Viewer, orgId: number | null): boolean {
  return v.isHouse ? orgId === null : orgId !== null && orgId === v.orgId;
}

/**
 * Did this viewer's own side write this post?
 *
 * For a client, their organization. For staff, their own service company AND no
 * other - a second operator reading a system shared in to them is a provider on
 * it, not its house, and an internal note is not addressed to them.
 */
export function wroteIt(v: Viewer, p: Pick<PostScope, "authorOrgId" | "tenantOrgId">): boolean {
  if (p.authorOrgId !== null) return !v.isHouse && v.orgId === p.authorOrgId;
  if (!v.isHouse) return false;
  // A staff post with no workspace recorded is unattributable. Refusing it is
  // the safe direction: the alternative shows one company's notes to another,
  // and the backfill exists so this should never be a live row.
  return v.houseOrgId !== null && v.houseOrgId === p.tenantOrgId;
}

/**
 * May this viewer read this post? Assumes the THREAD is already permitted - a
 * system nobody shared with you fails in lib/tenancy long before this, and this
 * function must never be used as the only gate on a system's posts.
 */
export function canSeePost(v: Viewer, p: PostScope): boolean {
  if (p.audience === "internal") return wroteIt(v, p);
  if (p.instrumentId === null) return inRoom(v, p);
  return true;
}

/**
 * Does this viewer sit in this General room?
 *
 * A service company sits in every room ON ITS OWN BOARD and in none of another
 * company's - its rooms are with its own clients. An organization sits in its
 * own room only.
 */
export function inRoom(v: Viewer, p: Pick<PostScope, "roomOrgId" | "tenantOrgId">): boolean {
  if (v.isHouse) return v.houseOrgId !== null && v.houseOrgId === p.tenantOrgId;
  return p.roomOrgId !== null && p.roomOrgId === v.orgId;
}

/**
 * Which room a General post belongs in, and whether the viewer may put it there.
 * An organization has exactly one room - its own - so it cannot post into
 * another's; the operator picks. Returns null when the target is not allowed,
 * which callers must treat as "not found" rather than defaulting to a room.
 */
export function resolveRoom(
  v: Viewer,
  requested: number | null,
  knownOrgIds: number[],
): { ok: true; roomOrgId: number | null } | { ok: false } {
  if (v.isHouse) {
    if (requested === null) return { ok: true, roomOrgId: null };
    return knownOrgIds.includes(requested) ? { ok: true, roomOrgId: requested } : { ok: false };
  }
  if (v.orgId === null) return { ok: false };
  // An org's own room, whether or not it bothered to name it.
  if (requested !== null && requested !== v.orgId) return { ok: false };
  return { ok: true, roomOrgId: v.orgId };
}

/**
 * The read-marker id for a General room. 0 is "my own room" - an organization
 * has only one, and for the operator it is their own board - so existing marks
 * keep working; the operator's marks for other rooms are the negated org id,
 * which can never collide with a system's id.
 */
export function roomThreadId(v: Viewer, roomOrgId: number | null): number {
  if (roomOrgId === null) return 0;
  return v.isHouse ? -roomOrgId : 0;
}

/**
 * Who a non-internal post on a system actually reaches, as one sentence.
 *
 * The service company is on every system in its own workspace whether or not
 * anybody wrote that down - it is the house. But it can ALSO hold an explicit
 * share, which is ordinary: a system it does not own, one handed to a client,
 * one it was given edit rights on. Listing the implicit membership and the
 * explicit row separately produced "this goes to Sierra Spectra, LabZen, Sierra
 * Spectra", which reads like a bug because it is one.
 *
 * Names are compared case-blind and the first spelling wins, since the two come
 * from different places - one from the instance's branding, one from the orgs
 * table - and may not agree about capitals.
 */
export function audienceLine(operatorName: string, shareNames: string[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of [operatorName, ...shareNames]) {
    const n = name.trim();
    const key = n.toLowerCase();
    if (!n || seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out.join(", ");
}
