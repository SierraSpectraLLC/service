import { describe, expect, it } from "vitest";
import {
  audienceLine, canSeePost, resolveRoom, roomThreadId, type PostScope, type Viewer,
} from "@/lib/discussionScope";

// A discussion leak is not recoverable - once one company has read another's
// working notes, no fix un-reads them. So the rules get locked down here in both
// directions: what must be shared stays shared, what must be private stays
// private even from the operator running the instance.

// Two service companies, both staff, both on the same client's bench: Sierra on
// the LC-MS, Acme Engineering on the gas generator. Everything below has to hold
// with both of them signed in.
const SIERRA = 1;
const ACME_ENG = 2;

const HOUSE: Viewer = { isHouse: true, orgId: null, houseOrgId: SIERRA };
const OTHER_HOUSE: Viewer = { isHouse: true, orgId: null, houseOrgId: ACME_ENG };
const LABZEN: Viewer = { isHouse: false, orgId: 5, houseOrgId: null };
const ACME: Viewer = { isHouse: false, orgId: 7, houseOrgId: null };
const NO_ORG: Viewer = { isHouse: false, orgId: null, houseOrgId: null };

const onSystem = (over: Partial<PostScope> = {}): PostScope => ({
  instrumentId: 42, authorOrgId: null, tenantOrgId: SIERRA, roomOrgId: null, audience: "all", ...over,
});
const general = (over: Partial<PostScope> = {}): PostScope => ({
  instrumentId: null, authorOrgId: null, tenantOrgId: SIERRA, roomOrgId: null, audience: "all", ...over,
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

  it("keeps it away from the OTHER service company on the same system", () => {
    // Two service companies work one client's bench, so the system is shared to
    // Acme Engineering and their staff can open the thread. They are a provider
    // on it, not its house: Sierra's internal note is not addressed to them.
    const sierraNote = onSystem({ authorOrgId: null, tenantOrgId: SIERRA, audience: "internal" });
    expect(canSeePost(OTHER_HOUSE, sierraNote)).toBe(false);
    // Shared posts still cross, which is the whole point of working together.
    expect(canSeePost(OTHER_HOUSE, onSystem({ tenantOrgId: SIERRA }))).toBe(true);
  });

  it("refuses an internal post nobody can attribute", () => {
    // A staff post with no workspace recorded predates the stamp. The backfill
    // gives every real row one; if a fresh one ever arrives without, refusing is
    // the safe direction - the alternative shows one company's notes to another.
    const orphan = onSystem({ authorOrgId: null, tenantOrgId: null, audience: "internal" });
    expect(canSeePost(HOUSE, orphan)).toBe(false);
    expect(canSeePost(OTHER_HOUSE, orphan)).toBe(false);
  });
});

describe("the General board is rooms, not a square", () => {
  it("an organization reads its own room and no other", () => {
    expect(canSeePost(LABZEN, general({ roomOrgId: 5 }))).toBe(true);
    expect(canSeePost(LABZEN, general({ roomOrgId: 7 }))).toBe(false);
    // The operator's own board is not an organization's room.
    expect(canSeePost(LABZEN, general({ roomOrgId: null }))).toBe(false);
  });

  it("a service company sits in every room on its own board", () => {
    expect(canSeePost(HOUSE, general({ roomOrgId: 5 }))).toBe(true);
    expect(canSeePost(HOUSE, general({ roomOrgId: 7 }))).toBe(true);
    expect(canSeePost(HOUSE, general({ roomOrgId: null }))).toBe(true);
  });

  it("and in none of another service company's", () => {
    // The leak this closes. Both are staff, so a role comparison put Acme
    // Engineering in every room Sierra has with every one of its clients.
    expect(canSeePost(OTHER_HOUSE, general({ roomOrgId: 5, tenantOrgId: SIERRA }))).toBe(false);
    expect(canSeePost(OTHER_HOUSE, general({ roomOrgId: null, tenantOrgId: SIERRA }))).toBe(false);
    expect(canSeePost(HOUSE, general({ roomOrgId: 5, tenantOrgId: ACME_ENG }))).toBe(false);
    // Each still reads its own.
    expect(canSeePost(OTHER_HOUSE, general({ roomOrgId: 5, tenantOrgId: ACME_ENG }))).toBe(true);
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

describe("who a shared post says it reaches", () => {
  it("names the service company once, however it got there", () => {
    // The bug somebody spotted on a system Sierra both houses AND holds an
    // explicit share on: "this goes to Sierra Spectra, LabZen, Sierra Spectra".
    expect(audienceLine("Sierra Spectra", ["LabZen", "Sierra Spectra"]))
      .toBe("Sierra Spectra, LabZen");
  });

  it("does not care how the two spellings capitalise", () => {
    // One comes from the instance's branding, the other from the orgs table.
    expect(audienceLine("Sierra Spectra", ["sierra spectra", "LabZen"]))
      .toBe("Sierra Spectra, LabZen");
  });

  it("keeps every organization that really is different", () => {
    expect(audienceLine("Sierra Spectra", ["LabZen", "Acme Engineering"]))
      .toBe("Sierra Spectra, LabZen, Acme Engineering");
  });

  it("is just the service company when nothing is shared", () => {
    expect(audienceLine("Sierra Spectra", [])).toBe("Sierra Spectra");
  });

  it("drops blanks rather than printing a stray comma", () => {
    expect(audienceLine("Sierra Spectra", ["", "  ", "LabZen"]))
      .toBe("Sierra Spectra, LabZen");
  });
});
