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

export type Audience = "all" | "internal";

export type PostScope = {
  /** Null = a General board post rather than one on a system. */
  instrumentId: number | null;
  /** The organization the author spoke for; null = the operator's own staff. */
  authorOrgId: number | null;
  /** General board only: whose room. Null = the operator's own board. */
  roomOrgId: number | null;
  audience: Audience;
};

export type Viewer = { isHouse: boolean; orgId: number | null };

/** Is the viewer part of the organization this post was written for? */
export function sameParty(v: Viewer, orgId: number | null): boolean {
  return v.isHouse ? orgId === null : orgId !== null && orgId === v.orgId;
}

/**
 * May this viewer read this post? Assumes the THREAD is already permitted - a
 * system nobody shared with you fails in lib/tenancy long before this, and this
 * function must never be used as the only gate on a system's posts.
 */
export function canSeePost(v: Viewer, p: PostScope): boolean {
  if (p.audience === "internal") return sameParty(v, p.authorOrgId);
  if (p.instrumentId === null) return v.isHouse || sameParty(v, p.roomOrgId);
  return true;
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
