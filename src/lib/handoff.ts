// Handing a client to a shop that is not on Ridgeline yet.
//
// The existing hand-off (lib/clientShare) can only address a workspace that
// already exists, because it picks from provider_links. That is exactly
// backwards for growth: the shops most worth reaching are the ones with no
// account, and the moment they are most persuadable is the moment somebody is
// trying to give them paying work.
//
// So an invite is the same frozen snapshot pointed at an EMAIL, opened through
// an unguessable link, and shown BLIND - the equipment, how many sites, which
// state, what the fee is, and not a word about who the client is. That is the
// honest shape as well as the persuasive one: the sender has not agreed to
// hand over their client's identity to a stranger who has not accepted
// anything, and a stranger has no business reading it.
//
// What converts is the last step rather than the pitch. Accepting does not
// drop somebody on a marketing page: it opens their workspace with the client
// already in it - the systems, the sites, the modules, the serials - so the
// first thing they ever see in Ridgeline is real work of theirs rather than an
// empty database and a data-entry job.
//
// Pure. Callers hand in the rows.

/** How long an invite stays open. */
export const HANDOFF_DAYS = 30;

/**
 * The states an invite can be in, from the SENDER's side.
 *
 * "Opened" earns its place: sent-and-ignored and sent-and-read-twice are
 * different outcomes and the difference decides whether somebody telephones.
 */
export const INVITE_STATES = ["sent", "opened", "accepted", "declined", "withdrawn", "expired"] as const;
export type InviteState = (typeof INVITE_STATES)[number];

export const INVITE_LABEL: Record<InviteState, string> = {
  sent: "Sent",
  opened: "They looked",
  accepted: "Joined",
  declined: "Declined",
  withdrawn: "Withdrawn",
  expired: "Expired",
};

export const INVITE_TONE: Record<InviteState, "good" | "warn" | "info" | "faint"> = {
  sent: "warn", opened: "info", accepted: "good",
  declined: "faint", withdrawn: "faint", expired: "faint",
};

export function inviteState(row: {
  status: string; openedAt: Date | null; expiresOn: string;
}, today: string): InviteState {
  if (row.status === "accepted") return "accepted";
  if (row.status === "declined") return "declined";
  if (row.status === "withdrawn") return "withdrawn";
  // Expiry is only ever about a door still standing open. A settled invite
  // keeps saying what it settled as, however long ago that was.
  if (row.expiresOn && row.expiresOn < today) return "expired";
  return row.openedAt ? "opened" : "sent";
}

/** Whether this link may still be walked through. */
export const inviteOpen = (s: InviteState): boolean => s === "sent" || s === "opened";

/**
 * The days left, for the one line on the page that creates any urgency at all.
 *
 * Deliberately the only pressure applied. A countdown clock over a decision
 * about taking on somebody's lab would be pressure about the wrong thing.
 */
export function daysLeft(expiresOn: string, today: string): number | null {
  if (!expiresOn || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) return null;
  const ms = Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

/**
 * What a company may be called when a stranger types it into the accept form.
 *
 * The same rules createOperator applies, said here so the public page can
 * refuse before it submits rather than after - and so the two cannot drift.
 */
export function companyProblems(name: string): string[] {
  const n = name.trim();
  if (!n) return ["What is your company called?"];
  if (n.length > 60) return ["That is longer than 60 characters"];
  return [];
}

/** A token is unguessable or it is nothing. Checked before any lookup. */
export const HANDOFF_TOKEN_MIN = 24;
export const looksLikeToken = (t: string): boolean =>
  typeof t === "string" && t.length >= HANDOFF_TOKEN_MIN && /^[A-Za-z0-9_-]+$/.test(t);

/**
 * The headline on the public page: what is being offered, in one line, with
 * nothing in it that identifies the client.
 *
 * Built from the blind summary the recipient of an ordinary blind offer
 * already sees, so a stranger and a tenant read the same sentence about the
 * same work - see clientShare.blindSummary.
 */
export function pitchLine(summary: string, operatorName: string): string {
  // Left as it comes. Lowercasing the whole thing to make it read as a
  // sentence turned "2 sites in CA" into "2 sites in ca" - and a state code
  // is the one part of this line somebody scans for.
  return `${operatorName} wants to hand you ${summary}`;
}
