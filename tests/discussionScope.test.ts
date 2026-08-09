import { describe, expect, it } from "vitest";
import { canSeePost, resolveRoom, roomThreadId, type PostScope, type Viewer } from "@/lib/discussionScope";

// A discussion leak is not recoverable - once one company has read another's
// working notes, no fix un-reads them. So the rules get locked down here in both
// directions: what must be shared stays shared, what must be private stays
// private even from the operator running the instance.

const HOUSE: Viewer = { isHouse: true, orgId: null };
const LABZEN: Viewer = { isHouse: false, orgId: 5 };
const ACME: Viewer = { isHouse: false, orgId: 7 };
const NO_ORG: Viewer = { isHouse: false, orgId: null };

const onSystem = (over: Partial<PostScope> = {}): PostScope => ({
  instrumentId: 42, authorOrgId: null, roomOrgId: null, audience: "all", ...over,
});
const general = (over: Partial<PostScope> = {}): PostScope => ({
  instrumentId: null, authorOrgId: null, roomOrgId: null, audience: "all", ...over,
});

describe("a shared system's thread", () => {
  it("shows shared posts to everyone who can see the system", () => {
    expect(canSeePost(HOUSE, onSystem())).toBe(true);
    expect(canSeePost(LABZEN, onSystem())).toBe(true);
    expect(canSeePost(ACME, onSystem({ authorOrgId: 5 }))).toBe(true);
  });

  it("keeps an organization's internal note inside that organization", () => {
    const labzenNote = onSystem({ authorOrgId: 5, audience: "internal" });
    expect(canSeePost(LABZEN, labzenNote)).toBe(true);
    expect(canSeePost(ACME, labzenNote)).toBe(false);
    // The whole point: the operator does not get to read it either.
    expect(canSeePost(HOUSE, labzenNote)).toBe(false);
  });

  it("keeps the operator's internal note inside the operator", () => {
    const houseNote = onSystem({ authorOrgId: null, audience: "internal" });
    expect(canSeePost(HOUSE, houseNote)).toBe(true);
    expect(canSeePost(LABZEN, houseNote)).toBe(false);
    expect(canSeePost(ACME, houseNote)).toBe(false);
  });
});

describe("the General board is rooms, not a square", () => {
  it("an organization reads its own room and no other", () => {
    expect(canSeePost(LABZEN, general({ roomOrgId: 5 }))).toBe(true);
    expect(canSeePost(LABZEN, general({ roomOrgId: 7 }))).toBe(false);
    // The operator's own board is not an organization's room.
    expect(canSeePost(LABZEN, general({ roomOrgId: null }))).toBe(false);
  });

  it("the operator sits in every room", () => {
    expect(canSeePost(HOUSE, general({ roomOrgId: 5 }))).toBe(true);
    expect(canSeePost(HOUSE, general({ roomOrgId: 7 }))).toBe(true);
    expect(canSeePost(HOUSE, general({ roomOrgId: null }))).toBe(true);
  });

  it("internal still wins inside a room", () => {
    // A client's internal note in their own room: theirs alone.
    expect(canSeePost(HOUSE, general({ roomOrgId: 5, authorOrgId: 5, audience: "internal" }))).toBe(false);
    expect(canSeePost(LABZEN, general({ roomOrgId: 5, authorOrgId: 5, audience: "internal" }))).toBe(true);
    // The operator's own aside in a client's room stays with the operator.
    expect(canSeePost(LABZEN, general({ roomOrgId: 5, authorOrgId: null, audience: "internal" }))).toBe(false);
  });

  it("a session with no organization reads nothing", () => {
    expect(canSeePost(NO_ORG, general({ roomOrgId: 5 }))).toBe(false);
    expect(canSeePost(NO_ORG, general({ roomOrgId: null }))).toBe(false);
    expect(canSeePost(NO_ORG, onSystem({ audience: "internal" }))).toBe(false);
  });
});

describe("posting into a room", () => {
  it("an organization can only post into its own room", () => {
    expect(resolveRoom(LABZEN, null, [5, 7])).toEqual({ ok: true, roomOrgId: 5 });
    expect(resolveRoom(LABZEN, 5, [5, 7])).toEqual({ ok: true, roomOrgId: 5 });
    expect(resolveRoom(LABZEN, 7, [5, 7])).toEqual({ ok: false });
    expect(resolveRoom(NO_ORG, null, [5, 7])).toEqual({ ok: false });
  });

  it("the operator picks a room, but not one that doesn't exist", () => {
    expect(resolveRoom(HOUSE, 7, [5, 7])).toEqual({ ok: true, roomOrgId: 7 });
    expect(resolveRoom(HOUSE, null, [5, 7])).toEqual({ ok: true, roomOrgId: null });
    expect(resolveRoom(HOUSE, 99, [5, 7])).toEqual({ ok: false });
  });
});

describe("read markers", () => {
  it("give each of the operator's rooms its own mark, and never collide with a system id", () => {
    expect(roomThreadId(HOUSE, null)).toBe(0);
    expect(roomThreadId(HOUSE, 5)).toBe(-5);
    // An organization has one room, so 0 keeps their existing mark working.
    expect(roomThreadId(LABZEN, 5)).toBe(0);
  });
});
