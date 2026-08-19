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
// HOW TO ADD A BATCH: append entries at the TOP (newest first), each with a
// fresh unique key. Screenshots go in public/whatsnew/ (login-gated by the
// middleware like every other page - they show real UI). A viewer's marker is
// the newest key they have dismissed; everything above it is unseen.

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

/** Newest first. See HOW TO ADD A BATCH above. */
export const WHATS_NEW: WhatsNewEntry[] = [
  {
    key: "2026-08-19-advisory-maintenance",
    date: "2026-08-19",
    title: "Maintenance can be reference, not homework",
    body: "Reseller-owned systems keep every schedule - cadence, kit, last-done history - but nothing comes due: no tasks, no red, no queue moves. Toggle any system between \"on a schedule\" and \"reference only\" from its Maintenance card, any time.",
    image: "/whatsnew/advisory.png",
    audience: "staff",
  },
  {
    key: "2026-08-19-usage",
    date: "2026-08-19",
    title: "See who is actually using the portal",
    body: "Settings → Access → Usage shows everyone with a way in, graded active, quiet, dormant, or never signed in - including password sign-ins, which used to leave no trace. A first-ever sign-in pings you, and a Monday email sums up the week.",
    image: "/whatsnew/usage.png",
    href: "/settings/activity",
    audience: "owner",
  },
  {
    key: "2026-08-19-search",
    date: "2026-08-19",
    title: "Search half a serial, get the whole system",
    body: "Every search box now works the same way: each word can match a different field, and punctuation doesn't matter - \"sil40\" finds the SIL-40, and finds the system it's bolted to. Try a scrap of a serial number on the dashboard.",
    image: "/whatsnew/search.png",
    audience: "all",
  },
  {
    key: "2026-08-18-dispatch",
    date: "2026-08-18",
    title: "Dispatch while the phone is still warm",
    body: "Opening a work order now takes the engineer's name right on the intake form - the job lands in their queue and they get notified the moment it files. Down systems read red and sort first, and My systems shows each person their own plate.",
    image: "/whatsnew/dispatch.png",
    audience: "staff",
  },
  {
    key: "2026-08-17-model-pages",
    date: "2026-08-17",
    title: "Every model has a page now",
    body: "Click any model chip in the equipment catalog: photo, spec sheet, procedures, references, and parts in one place. Specs follow the unit onto system and asset pages, and a G6117A can copy its procedures straight from the G6117B.",
    image: "/whatsnew/model-pages.png",
    audience: "staff",
  },
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
