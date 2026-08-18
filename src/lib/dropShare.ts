// Links that let somebody without a login touch the store.
//
// Two kinds, opposite directions. A DROP link lets an outsider put files IN -
// the technician at an air-gapped instrument who has the data and no account.
// A SHARE link lets an outsider take named files OUT. Both are bearer tokens:
// the URL is the credential, exactly like a for-sale listing's, so everything
// here is about the two things that keep a bearer token honest - it expires,
// and it can be killed.
//
// Pure. The routes and actions hand in rows; these decide what they mean.

export type LinkLike = {
  /** YYYY-MM-DD, the last day it works. Blank never happens - creation requires one. */
  expiresOn: string;
  revokedAt: Date | string | null;
};

export type LinkState = "active" | "expired" | "revoked";

/**
 * Revoked beats expired: "you turned this off" and "this ran out" call for
 * different sentences, and a link revoked in anger should not read as having
 * quietly lapsed.
 */
export function linkState(link: LinkLike, today: string): LinkState {
  if (link.revokedAt !== null) return "revoked";
  return link.expiresOn < today ? "expired" : "active";
}

export const linkUsable = (link: LinkLike, today: string) => linkState(link, today) === "active";

export const MAX_LINK_DAYS = 90;
export const DEFAULT_LINK_DAYS = 14;

/**
 * A validated expiry, or why not.
 *
 * Bounded above because a bearer URL that works for a year is a password
 * written on a wall: the whole design is that these are short-lived. Today is
 * allowed - "just for the afternoon" is the commonest real case.
 */
export function cleanExpiry(raw: string, today: string): { error: string } | { expiresOn: string } {
  const v = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: "Pick a date" };
  if (v < today) return { error: "That date is already past" };
  const cap = addDaysIso(today, MAX_LINK_DAYS);
  if (v > cap) return { error: `Links last ${MAX_LINK_DAYS} days at most` };
  return { expiresOn: v };
}

export function addDaysIso(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** What a link is called in a list when nobody named it. */
export function linkLabel(link: { label: string; expiresOn: string }): string {
  return link.label.trim() || `Link until ${link.expiresOn}`;
}

/** Bounded free text, so a label is a label and not a pasted document. */
export const cleanLabel = (raw: string) => raw.trim().replace(/\s+/g, " ").slice(0, 80);

/**
 * How a link's remaining life reads in a list. Days, because that is the unit
 * somebody deciding "is this still fine to leave open" thinks in.
 */
export function linkLine(link: LinkLike, today: string): string {
  const state = linkState(link, today);
  if (state === "revoked") return "revoked";
  if (state === "expired") return `expired ${link.expiresOn}`;
  if (link.expiresOn === today) return "expires today";
  const days = Math.round((Date.parse(`${link.expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"} left`;
}
