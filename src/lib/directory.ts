// Who there is to assign work to and @mention.
//
// This replaces a roster: a table of names typed into Settings by the owner,
// kept separate from the logins and drifting away from them the moment somebody
// joined, left or married. It answered "who can I tag" with a list that nobody
// was on and everybody had to be added to twice.
//
// A person is now a login. Every organization adds its own people - the house
// in Settings > Admin, an organization on its own page - and the directory is
// assembled from those. Which means somebody who can sign in can be tagged, and
// somebody who cannot, cannot, without anybody maintaining the correspondence.
//
// Scope is the whole point and it is not "everyone": a service provider and the
// clients it works for can see each other, because that is what makes a shared
// system a shared conversation. Two client organizations of the same provider
// cannot see each other at all.
//
// Nor does it stop at the workspace boundary. Two service companies can work one
// client's bench - Sierra on the LC-MS, Acme Engineering on the gas generator -
// and the moment a record is shared between them they are colleagues on it and
// have to be able to reach each other. That follows from the sharing itself:
// nobody adds the other company to their own organization list, because there is
// nothing to add. Whoever is a counterparty on a record you can see is somebody
// you can name.

import { eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  assets, assetShares, clientAllowlist, houseMembers, instruments, orgs, systemShares, users,
} from "@/db/schema";
import type { SessionUser } from "@/lib/authz";
import { isHouse } from "@/lib/houseRole";
import { readTenant, visibleOrgs, visibleSystemIds } from "@/lib/tenancy";
import { tenantOf } from "@/lib/tenants";

export type Member = {
  /** What a dropdown and an @mention say. Unique across the directory. */
  name: string;
  email: string;
  /** The organization they belong to, for grouping and disambiguation. */
  org: string;
};

/**
 * A name for somebody who has a login and has never set one.
 *
 * An email address in an assignee dropdown is a row nobody reads, so the local
 * part is turned into something person-shaped: `joe.vincent96` reads as "Joe
 * Vincent". A guess, and it stops being one the moment they set their own name,
 * which is the point of letting them.
 */
export function displayName(name: string | null | undefined, email: string): string {
  const given = (name ?? "").trim();
  if (given) return given;
  const local = (email.split("@")[0] ?? "").trim();
  const words = local.split(/[._+-]+/)
    // Trailing digits are almost always an address disambiguator, not a name.
    .map((w) => w.replace(/\d+$/, ""))
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1));
  return words.join(" ") || local || email;
}

/**
 * Which organizations' people this viewer may see.
 *
 * House staff see their whole tenant: the operator they work for and every
 * client of it, because they work on all of them. A client sees its own people
 * and the service provider's - the two sides of a shared system - and no other
 * client of that provider, who are strangers to them.
 *
 * A null tenant is platform staff, who see every tenant anyway.
 */
export function directoryOrgIds(
  viewer: { orgId: number | null; isHouse: boolean },
  all: { id: number; isOperator: boolean; tenant: number | null }[],
  myTenant: number | null,
  /** Organizations that are counterparties on a record this viewer can see. */
  collaborators: number[] = [],
): number[] {
  if (myTenant === null) return all.map((o) => o.id);
  const known = new Set(all.map((o) => o.id));
  const shared = collaborators.filter((id) => known.has(id));
  if (viewer.isHouse) {
    return [...new Set([...all.filter((o) => o.tenant === myTenant).map((o) => o.id), ...shared])];
  }
  const mine = all.filter((o) => o.id === viewer.orgId);
  const operator = all.filter((o) => o.isOperator && o.tenant === myTenant);
  return [...new Set([...[...mine, ...operator].map((o) => o.id), ...shared])];
}

type Raw = { name: string | null; email: string; org: string };

/**
 * The directory itself: deduplicated, disambiguated, ordered.
 *
 * Two rules earn their keep. One address is one person however many lists it
 * appears on - somebody can be staff of the operator and listed on a client -
 * and the entry that carries a real name wins. And a name that two people share
 * is qualified by organization: an assignee is stored as text and an @mention is
 * matched as text, so two bare "Chris"es would resolve to whichever came first
 * and silently notify the wrong one.
 */
export function buildDirectory(rows: Raw[], myOrg: string): Member[] {
  const byEmail = new Map<string, Raw>();
  for (const r of rows) {
    const key = r.email.trim().toLowerCase();
    if (!key) continue;
    const held = byEmail.get(key);
    if (!held || (!held.name?.trim() && r.name?.trim())) byEmail.set(key, { ...r, email: key });
  }

  const people = [...byEmail.values()].map((r) => ({
    name: displayName(r.name, r.email), email: r.email, org: r.org,
  }));
  const seen = new Map<string, number>();
  for (const p of people) seen.set(p.name.toLowerCase(), (seen.get(p.name.toLowerCase()) ?? 0) + 1);
  const named = people.map((p) => (seen.get(p.name.toLowerCase())! > 1 && p.org
    ? { ...p, name: `${p.name} (${p.org})` }
    : p));

  // Your own colleagues first: the people you assign work to most are the ones
  // you sit with, and they should not be halfway down an alphabetical list.
  return named.sort((a, b) =>
    Number(b.org === myOrg) - Number(a.org === myOrg)
    || a.org.localeCompare(b.org)
    || a.name.localeCompare(b.name));
}

/**
 * Read the people of a set of organizations, or of every one when ids is null.
 *
 * One assembly for both callers so the NAMES cannot diverge: a directory that
 * offers "Chris (LabZen)" and a resolver that only knows "Chris" would accept an
 * assignment and then quietly notify nobody.
 */
async function assemble(ids: number[] | null, myOrgId: number | null): Promise<Member[]> {
  const orgRows = await db.select({ id: orgs.id, name: orgs.name }).from(orgs).catch(() => []);
  const name = new Map(orgRows.map((o) => [o.id, o.name]));
  const within = <T extends { orgId: number | null }>(rows: T[]) =>
    (ids === null ? rows : rows.filter((r) => r.orgId !== null && ids.includes(r.orgId)));

  const [staffRows, clientRows] = await Promise.all([
    db.select({ email: houseMembers.email, name: houseMembers.name, orgId: houseMembers.orgId })
      .from(houseMembers).where(ne(houseMembers.role, "none")).catch(() => []),
    db.select({ email: clientAllowlist.entry, orgId: clientAllowlist.orgId })
      .from(clientAllowlist).catch(() => []),
  ]);
  const staff = within(staffRows);
  const clients = within(clientRows);

  const emails = [...new Set([...staff, ...clients].map((r) => r.email.trim().toLowerCase()))]
    .filter(Boolean);
  // The name people set for themselves outranks whatever was typed when somebody
  // added them, which is usually nothing.
  const own = emails.length
    ? await db.select({ email: users.email, name: users.name }).from(users)
      .where(inArray(users.email, emails)).catch(() => [])
    : [];
  const chosen = new Map(own.map((u) => [u.email.trim().toLowerCase(), u.name]));
  const orgName = (id: number | null) => name.get(id ?? -1) ?? "";

  return buildDirectory([
    ...staff.map((r) => ({
      email: r.email, name: chosen.get(r.email.trim().toLowerCase()) || r.name, org: orgName(r.orgId),
    })),
    ...clients.map((r) => ({
      email: r.email, name: chosen.get(r.email.trim().toLowerCase()) ?? null, org: orgName(r.orgId),
    })),
  ], orgName(myOrgId));
}

/**
 * The organizations this viewer is actually working alongside.
 *
 * Read off the records rather than configured: for every system and unit they
 * can see, the workspace it belongs to and every organization it is shared with.
 * On their own tenant's records that is just their own clients, already covered.
 * On a record shared across the tenant line it is the other service company -
 * which is exactly who they need to be able to name, and exactly the thing
 * nobody should have to set up by hand.
 */
async function collaboratorOrgIds(user: SessionUser): Promise<number[]> {
  const systemIds = await visibleSystemIds(user);
  // Null is platform staff, who already get everybody.
  if (systemIds === null) return [];
  if (!systemIds.length) return [];
  const capped = systemIds.slice(0, 2000);
  const [owners, shares, unitShares] = await Promise.all([
    db.select({ tenantOrgId: instruments.tenantOrgId }).from(instruments)
      .where(inArray(instruments.id, capped)).catch(() => []),
    db.select({ orgId: systemShares.orgId }).from(systemShares)
      .where(inArray(systemShares.instrumentId, capped)).catch(() => []),
    // A unit can be shared on its own - one company services the generator on a
    // bench whose system belongs to another.
    db.select({ orgId: assetShares.orgId }).from(assetShares)
      .innerJoin(assets, eq(assetShares.assetId, assets.id))
      .where(inArray(assets.instrumentId, capped)).catch(() => []),
  ]);
  return [...new Set([
    ...owners.map((r) => r.tenantOrgId), ...shares.map((r) => r.orgId), ...unitShares.map((r) => r.orgId),
  ])].filter((id): id is number => id !== null);
}

/** The directory for one signed-in person, read from the logins that exist. */
export async function visibleDirectory(user: SessionUser): Promise<Member[]> {
  const [orgRows, collaborators] = await Promise.all([visibleOrgs(user), collaboratorOrgIds(user)]);
  const ids = directoryOrgIds(
    { orgId: user.orgId, isHouse: isHouse(user.role) },
    orgRows.map((o) => ({ id: o.id, isOperator: o.isOperator, tenant: tenantOf(o) })),
    readTenant(user),
    collaborators,
  );
  return ids.length ? assemble(ids, user.orgId) : [];
}

/**
 * Every login on the instance, named the same way the directory names them.
 *
 * Deliberately unscoped, and safe to be: this is only ever used to turn a name
 * already stored on a record into an inbox to notify. The action that accepted
 * the name is what decides whether it was allowed.
 */
export const namedLogins = (): Promise<Member[]> => assemble(null, null);

/** Just the names, which is what a picker and a mention parser want. */
export const directoryNames = (people: Member[]): string[] => people.map((p) => p.name);

/** The set of names an action may accept, for a field that stores one as text. */
export async function assignableNames(user: SessionUser): Promise<Set<string>> {
  return new Set(directoryNames(await visibleDirectory(user)));
}
