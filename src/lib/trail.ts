// Who opened what, and what broke while they were there.
//
// The ask was "log pages and clicks, I'm trying to find where the errors are",
// and the second half of that sentence is the design. CLICKS DO NOT FIND
// ERRORS. A DOM click record says a button was pressed; it does not say the
// action behind it threw, or what it threw, or on which route. At one row per
// press it also buries the rows that DO answer the question under a hundred
// times their number.
//
// So this records two things: the pages somebody opened, which is the
// breadcrumb trail before a failure, and every error thrown at them, which is
// the failure itself. Every meaningful click in this app ends in a page or an
// error anyway - those are its footprints.
//
// Pure, because the recorder, the reporter and the viewer all have to agree
// about what a route is and what may be kept.

/** page | error. Two kinds, two questions. */
export const TRAIL_KINDS = ["page", "error"] as const;
export type TrailKind = (typeof TRAIL_KINDS)[number];

export const isTrailKind = (v: string): v is TrailKind =>
  (TRAIL_KINDS as readonly string[]).includes(v);

/**
 * Who may read it. One address by default, the one that was asked for;
 * TRAIL_ADMINS overrides for an instance that is not this one.
 *
 * A list rather than a literal buried in a page, because the answer is needed
 * in three places and a second copy of it is a door somebody forgets to lock.
 * Note this gates READING. Recording covers everybody, which is the point.
 */
export const trailAdmins = (): string[] =>
  (process.env.TRAIL_ADMINS ?? "admin@ridgelinefield.com")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export const maySeeTrail = (email: string | null | undefined): boolean =>
  !!email && trailAdmins().includes(email.trim().toLowerCase());

/**
 * How long a row is worth keeping.
 *
 * Long enough to chase a bug somebody reports a fortnight late, short enough
 * that this never becomes a permanent record of where a client's staff spend
 * their day. A log with no end is a different product from a debugging tool.
 */
export const TRAIL_KEEP_DAYS = 30;

/**
 * Query parameters whose VALUES are somebody's words rather than the app's.
 *
 * A search box is the clearest case: "?q=Genentech" is a thing a person typed,
 * often a client's name, and it has no bearing on why a page threw. The key is
 * kept either way, so the trail can still say they were searching.
 */
const PRIVATE_PARAMS = ["q", "search", "email", "name", "token", "note", "reason"];

/**
 * The query, with the free-text stripped and the structure kept.
 *
 * "?stage=Refurbishment&q=agilent" becomes "stage=Refurbishment&q=…". Which
 * stage they were filtering by is exactly the sort of thing that explains a
 * crash; what they typed into a search box is not.
 */
export function safeQuery(search: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) return "";
  const out: string[] = [];
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const [k, ...rest] = pair.split("=");
    const key = decodeURIComponent(k);
    const value = decodeURIComponent(rest.join("="));
    if (!value) { out.push(key); continue; }
    out.push(`${key}=${PRIVATE_PARAMS.includes(key.toLowerCase()) ? "…" : value}`);
  }
  return out.join("&").slice(0, 300);
}

/**
 * The route with its ids generalised: /instruments/412 reads /instruments/:id.
 *
 * Because the question is "which PAGE is throwing", and a hundred rows for a
 * hundred instruments hide that they are one broken page. The exact path stays
 * on the row too - this is the grouping key, not a replacement for it.
 */
export function routeShape(path: string): string {
  return path
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) ? ":id" : seg.length >= 24 && !seg.includes(".") ? ":token" : seg))
    .join("/") || "/";
}

/** Room for a message and the top of a stack, and no room for a whole one. */
export const MESSAGE_MAX = 300;
export const DETAIL_MAX = 2000;

/** A browser string cut to the part that says which browser it was. */
export const shortUa = (ua: string): string => ua.trim().slice(0, 200);

export type TrailRow = {
  id: number;
  kind: string;
  email: string;
  role: string;
  orgName: string;
  viewingAs: string;
  route: string;
  query: string;
  message: string;
  detail: string;
  userAgent: string;
  at: Date;
};

/**
 * Errors grouped by the page and the message they share.
 *
 * The whole point of the viewer. One person hitting one bug fifteen times is
 * one bug; fifteen rows in a list reads as fifteen problems, and the actual
 * shape of the week - three bugs, one of them everywhere - is invisible.
 */
export type ErrorGroup = {
  key: string;
  route: string;
  message: string;
  count: number;
  people: string[];
  first: Date;
  last: Date;
  /** The fullest detail seen for this group, for the one that gets opened. */
  detail: string;
};

export function groupErrors(rows: TrailRow[]): ErrorGroup[] {
  const by = new Map<string, ErrorGroup>();
  for (const r of rows) {
    if (r.kind !== "error") continue;
    const route = routeShape(r.route);
    const key = `${route}|${r.message}`;
    const g = by.get(key);
    if (!g) {
      by.set(key, {
        key, route, message: r.message, count: 1,
        people: r.email ? [r.email] : [],
        first: r.at, last: r.at, detail: r.detail,
      });
      continue;
    }
    g.count++;
    if (r.email && !g.people.includes(r.email)) g.people.push(r.email);
    if (r.at < g.first) g.first = r.at;
    if (r.at > g.last) g.last = r.at;
    if (r.detail.length > g.detail.length) g.detail = r.detail;
  }
  // Most frequent first, then most recent - the thing hitting the most people
  // the most often is the thing to fix on a Monday morning.
  return [...by.values()].sort((a, b) => b.count - a.count || b.last.getTime() - a.last.getTime());
}

/** How many people, and how many pages, in a window. For the header line. */
export function trailSummary(rows: TrailRow[]): {
  people: number; pages: number; errors: number;
} {
  const people = new Set<string>();
  let pages = 0;
  let errors = 0;
  for (const r of rows) {
    if (r.email) people.add(r.email.toLowerCase());
    if (r.kind === "error") errors++;
    else pages++;
  }
  return { people: people.size, pages, errors };
}
