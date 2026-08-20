// "What's new in Baseline" - the changelog the platform shows its own users.
//
// Features ship in batches here, and the person who built them is not the
// person who has to notice them: Bill signs in on a Tuesday and the search box
// quietly does more than it did on Friday. This is the card that says so, once,
// with a picture - and never again after it is dismissed.
//
// Entries are code, not database rows, on purpose. They ship in the same
// commit as the feature they describe, the screenshot lives in /public
// beside them, and the history is the git history. There is no admin UI to
// forget to fill in.
//
// HOW TO ADD A BATCH: docs/WHATS_NEW_GUIDE.md is the full recipe. Short
// version: append entries at the TOP (newest first), each with a fresh unique
// key; screenshots go in public/whatsnew/ (login-gated by the middleware like
// every other page - they show real UI). A viewer's marker is the newest key
// they have dismissed; everything above it is unseen.

export type WhatsNewAudience = "all" | "staff" | "owner";

export type WhatsNewEntry = {
  /** Stable unique id. Never reuse or rename one - it is what "seen" points at. */
  key: string;
  /** When it shipped, YYYY-MM-DD, shown on the card. */
  date: string;
  title: string;
  /** One to three sentences, benefit first. Plain text. */
  body: string;
  /** Path under /public, e.g. "/whatsnew/search.png". Optional but worth it. */
  image?: string;
  /** Where to go try it. Optional. */
  href?: string;
  /** Who the card is for. Owner-only machinery never teases a client. */
  audience: WhatsNewAudience;
};

/**
 * Newest first. Empty right now, on purpose: the batch that shipped with the
 * feature was dismissed before launch, and entries from here on are the
 * operator's own words. The full recipe is docs/WHATS_NEW_GUIDE.md; the short
 * version is the template below.
 */
export const WHATS_NEW: WhatsNewEntry[] = [
  // {
  //   key: "2026-09-01-my-change",          // unique, never reused
  //   date: "2026-09-01",
  //   title: "One line that names the change",
  //   body: "Two or three sentences, benefit first. What can I do now that I couldn't?",
  //   image: "/whatsnew/my-change.png",     // optional - file in public/whatsnew/
  //   href: "/somewhere",                   // optional "Take a look" link
  //   audience: "staff",                    // "all" | "staff" | "owner"
  // },
];

/** May this role see this entry? Staff cards are for staff and the owner. */
export function audienceAllows(audience: WhatsNewAudience, role: string): boolean {
  if (audience === "all") return true;
  if (audience === "staff") return role === "staff" || role === "owner";
  return role === "owner";
}

/**
 * The cards this viewer has not dismissed yet, newest first.
 *
 * `seenKey` is the newest key the viewer dismissed. Everything strictly newer
 * is unseen; a blank or unrecognized marker (their first visit, or an entry
 * later removed) means everything on the list. Filtering by audience happens
 * AFTER the cut, so a client's marker still advances past staff-only cards
 * they were never shown.
 */
export function unseenFor(entries: WhatsNewEntry[], role: string, seenKey: string): WhatsNewEntry[] {
  const cut = entries.findIndex((e) => e.key === seenKey);
  const fresh = cut === -1 ? entries : entries.slice(0, cut);
  return fresh.filter((e) => audienceAllows(e.audience, role));
}

/** What dismissing right now should record: the newest key that exists. */
export const latestKey = (entries: WhatsNewEntry[]): string => entries[0]?.key ?? "";
