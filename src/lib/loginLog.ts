// Who is actually using the platform.
//
// The question this answers is a business one: a service company paying for a
// portal every month needs to know whether its engineers and its clients open
// it, and there was no way to tell. Sign-in mail used to be an accidental
// answer - the operator saw the codes go out - and the password path
// (lib/passwordAuth) silently removed even that.
//
// Two different numbers, kept apart on purpose, because conflating them is how
// a healthy account reads as dead:
//
//   SIGN-INS are doors opened. Sessions last a month (lib/sessionCookie), so
//   somebody who works here every single morning signs in about twelve times a
//   year. A low count is not disuse.
//
//   LAST SEEN is a page loaded. That is usage. It costs one write an hour per
//   person at most, which is why it is affordable to keep at all.
//
// Everything above the DB writers is pure, so the report can be tested without
// a database and reused by the page and the weekly email alike.

export type Method = "code" | "password";

/** How long a person may go unseen before each label applies. */
export const ACTIVE_DAYS = 7;
export const QUIET_DAYS = 30;

/** How stale `users.last_seen_at` may get before a page load rewrites it. */
export const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export const daysAgo = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

/**
 * A user-agent string, reduced to the only thing anybody reads it for: what
 * kind of machine that was. Full UA strings are forty words of vendor
 * boilerplate, and in a list of thirty people they are unreadable.
 */
export function shortAgent(ua: string): string {
  const s = (ua ?? "").toLowerCase();
  if (!s) return "";
  if (s.includes("ipad")) return "iPad";
  if (s.includes("iphone")) return "iPhone";
  if (s.includes("android")) return "Android";
  if (s.includes("macintosh") || s.includes("mac os")) return "Mac";
  if (s.includes("windows")) return "Windows";
  if (s.includes("cros")) return "ChromeOS";
  if (s.includes("linux")) return "Linux";
  return "";
}

/**
 * "3 hours ago", not a timestamp. Somebody scanning this list is asking "is
 * this person using it", and a date makes them do the subtraction themselves.
 */
export function sinceWords(then: Date | null | undefined, now: Date): string {
  if (!then) return "never";
  const mins = Math.floor((now.getTime() - then.getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 45) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${Math.round(days / 365)} years ago`;
}

export type Status = "active" | "quiet" | "dormant" | "never";

export const STATUS_LABEL: Record<Status, string> = {
  active: "Active",
  quiet: "Quiet",
  dormant: "Dormant",
  never: "Never signed in",
};

/**
 * Status from the LATER of the two signals. A person whose session is a week
 * old but who signed in this morning on a second device is active, and so is
 * one who has not signed in since June but has the portal open daily.
 */
export function statusOf(lastSeen: Date | null, lastLogin: Date | null, now: Date): Status {
  const at = [lastSeen, lastLogin].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0];
  if (!at) return "never";
  if (at >= daysAgo(now, ACTIVE_DAYS)) return "active";
  if (at >= daysAgo(now, QUIET_DAYS)) return "quiet";
  return "dormant";
}

export type Account = {
  email: string;
  name?: string | null;
  role?: string;
  orgName?: string;
  lastSeenAt?: Date | null;
  /** Do they have a password set - i.e. can they get in without any mail? */
  hasPassword?: boolean;
  /** Null for somebody invited who has never once signed in. */
  onboardedAt?: Date | null;
};

export type Event = {
  email: string;
  method: string;
  createdAt: Date;
  orgName?: string;
  role?: string;
  userAgent?: string;
  ip?: string;
};

export type PersonUsage = {
  email: string; name: string; role: string; orgName: string;
  lastSeenAt: Date | null; lastLoginAt: Date | null;
  logins7: number; logins30: number;
  /** Which doors they use, most-used first: "password", "code". */
  methods: string[];
  hasPassword: boolean;
  invitedNeverIn: boolean;
  status: Status;
};

/**
 * One row per person, joined case-blind on the email - the only identifier both
 * halves are guaranteed to share, since a login event outlives its account.
 * Sorted the way the question is asked: who was here most recently, with the
 * people who have never been here at the bottom rather than scattered.
 */
export function rollup(accounts: Account[], events: Event[], now: Date): PersonUsage[] {
  const key = (e: string) => e.trim().toLowerCase();
  const byEmail = new Map<string, PersonUsage>();

  const blank = (email: string): PersonUsage => ({
    email, name: "", role: "", orgName: "",
    lastSeenAt: null, lastLoginAt: null, logins7: 0, logins30: 0,
    methods: [], hasPassword: false, invitedNeverIn: false, status: "never",
  });

  for (const a of accounts) {
    const e = key(a.email);
    if (!e) continue;
    const row = byEmail.get(e) ?? blank(a.email.trim());
    row.name = a.name?.trim() || row.name;
    row.role = a.role || row.role;
    row.orgName = a.orgName || row.orgName;
    row.lastSeenAt = a.lastSeenAt ?? row.lastSeenAt;
    row.hasPassword = a.hasPassword ?? row.hasPassword;
    // Somebody on the access list with no account behind it has been given a
    // way in and never taken it. That is the most actionable line on the page.
    row.invitedNeverIn = a.onboardedAt === undefined ? row.invitedNeverIn : !a.onboardedAt;
    byEmail.set(e, row);
  }

  const week = daysAgo(now, ACTIVE_DAYS);
  const month = daysAgo(now, QUIET_DAYS);
  const methodCount = new Map<string, Map<string, number>>();

  for (const ev of events) {
    const e = key(ev.email);
    if (!e) continue;
    const row = byEmail.get(e) ?? blank(ev.email.trim());
    if (!row.lastLoginAt || ev.createdAt > row.lastLoginAt) row.lastLoginAt = ev.createdAt;
    if (ev.createdAt >= week) row.logins7++;
    if (ev.createdAt >= month) row.logins30++;
    row.role = row.role || ev.role || "";
    row.orgName = row.orgName || ev.orgName || "";
    const counts = methodCount.get(e) ?? new Map<string, number>();
    counts.set(ev.method, (counts.get(ev.method) ?? 0) + 1);
    methodCount.set(e, counts);
    byEmail.set(e, row);
  }

  for (const [e, row] of byEmail) {
    row.methods = [...(methodCount.get(e) ?? new Map())]
      .sort((a, b) => b[1] - a[1]).map(([m]) => m);
    // An event beats an empty account row: if they signed in, they have been in.
    if (row.lastLoginAt) row.invitedNeverIn = false;
    row.status = statusOf(row.lastSeenAt, row.lastLoginAt, now);
  }

  const when = (r: PersonUsage) =>
    Math.max(r.lastSeenAt?.getTime() ?? 0, r.lastLoginAt?.getTime() ?? 0);
  return [...byEmail.values()].sort((a, b) => when(b) - when(a) || a.email.localeCompare(b.email));
}

/** The one-line answer, for the top of the page and the subject of the email. */
export function usageSummary(rows: PersonUsage[]): {
  active: number; quiet: number; dormant: number; never: number; logins7: number;
} {
  return {
    active: rows.filter((r) => r.status === "active").length,
    quiet: rows.filter((r) => r.status === "quiet").length,
    dormant: rows.filter((r) => r.status === "dormant").length,
    never: rows.filter((r) => r.status === "never").length,
    logins7: rows.reduce((n, r) => n + r.logins7, 0),
  };
}

// The writers and the reads live in lib/loginLogData - this half is pure so the
// settings page's client component can share the exact vocabulary the server
// and the weekly email use, without dragging the database into the bundle.
