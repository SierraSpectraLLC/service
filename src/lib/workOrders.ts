// A work order: one job, from the ask to the close-out.
//
// The portal could already record everything a job is MADE of - tasks, hours,
// parts, files, a conversation - and had nowhere to say that those things were
// one job, or that it had finished. A client pressed "Request service", a task
// appeared dated today, and from then on the only evidence the request had ever
// been answered was somebody remembering to tick that task. There was no number
// to quote on the phone, no state to report, and nothing to close.
//
// So: a work order owns the job. It is opened by an ask (a client's, or ours),
// it holds the work rows that belong to it, it moves through a small set of
// states that both sides can read, and it is closed with a sentence saying what
// was done. That sentence is the thing the client sees months later.
//
// Everything here is pure. The states and who may move between them are worth
// reading in one place, and the alternative - the rules living inside a server
// action - is how a client ends up able to close their own unfinished job.

import { addDays } from "@/lib/pm";

export const WO_STATES = ["open", "active", "waiting", "resolved", "closed", "cancelled"] as const;
export type WoState = (typeof WO_STATES)[number];

export const WO_LABEL: Record<string, string> = {
  open: "Open",
  active: "In progress",
  // Deliberately not "Blocked". Waiting is usually on the client or on a part,
  // and telling somebody their job is blocked reads as a complaint.
  waiting: "Waiting",
  resolved: "Resolved",
  closed: "Closed",
  cancelled: "Cancelled",
};

export const WO_COLOR: Record<string, { bg: string; fg: string }> = {
  open: { bg: "#FAF0DC", fg: "#8A5410" },
  active: { bg: "#E7EFF8", fg: "#1D6396" },
  waiting: { bg: "#F4F6F9", fg: "#64748B" },
  resolved: { bg: "#E8F3EC", fg: "#2E6B2E" },
  closed: { bg: "#EEF1F5", fg: "#475569" },
  cancelled: { bg: "#F4F6F9", fg: "#94A3B8" },
};

export const isWoState = (s: string): s is WoState => (WO_STATES as readonly string[]).includes(s);

/** Work still to do. What somebody with a free afternoon picks from. */
export const woOpen = (s: string) => s === "open" || s === "active" || s === "waiting";
/** Filed, one way or the other. Nothing further is owed by anybody. */
export const woSettled = (s: string) => s === "closed" || s === "cancelled";
/**
 * Not filed yet - which is a wider set than "still to do", and the distinction
 * matters exactly once: a resolved order has had its work done but has not been
 * accepted, so it still belongs on a list and still takes yesterday's forgotten
 * hours. Closing it is what ends both.
 */
export const woLive = (s: string) => !woSettled(s);

/**
 * How urgent, in the words the client picked when they asked.
 *
 * The first three are exactly what the request form has always offered, kept
 * verbatim so a report filed last year and one filed today say the same word.
 * "Planned" is the fourth because a PM request is a job with a beginning and an
 * end like any other - it just isn't an emergency.
 *
 * `targetDays` is how long a job of that kind should take before it starts
 * looking late. It is a working expectation, not a contract: nothing enforces
 * it, it only decides what the list shows in red.
 */
export const WO_SEVERITIES = [
  { key: "Down", label: "Down", hint: "Not usable at all", targetDays: 0, rank: 0 },
  { key: "Degraded", label: "Something's wrong", hint: "Usable, but not right", targetDays: 3, rank: 1 },
  { key: "Question", label: "A question", hint: "Nothing is broken", targetDays: 5, rank: 2 },
  { key: "Planned", label: "Planned", hint: "Maintenance, nothing is wrong", targetDays: 30, rank: 3 },
] as const;

export type Severity = (typeof WO_SEVERITIES)[number]["key"];

export const severityOf = (s: string) =>
  WO_SEVERITIES.find((x) => x.key.toLowerCase() === s.trim().toLowerCase()) ?? WO_SEVERITIES[1];

/**
 * The day this job starts looking late, from the day it was asked for.
 *
 * A dead instrument is wanted today, which is what `targetDays: 0` says. Nobody
 * is expected to achieve it; the point is that a Down order is red the moment it
 * is a day old, and a planned one is not red for a month.
 */
export const targetDay = (severity: string, openedOn: string): string =>
  addDays(openedOn, severityOf(severity).targetDays);

/**
 * Who is trying to move a work order.
 *
 * "house" is staff of the company doing the work - us, on our own workspace.
 * "requester" is the organization that asked: the client whose instrument it is,
 * or whoever raised it. They are not one rank above and one below each other;
 * they can do genuinely different things, which is why this is not a role check.
 */
export type Mover = "house" | "requester";

/**
 * Which of the two this viewer is on this particular order, or neither.
 *
 * Neither is a real answer and a common one. A second service company invited
 * onto a client's system can read the order and add work to it - they are on the
 * job - but the job is not theirs to declare finished or to cancel, any more
 * than a subcontractor closes the main contractor's ticket. So they get no
 * moves, and the panel shows them none rather than showing buttons that refuse.
 *
 * `ownerOrgId` is the system's owning organization, and it counts as requester
 * even when the order names somebody else: an order raised by our own engineer
 * on a client's instrument is still that client's job to accept.
 */
export function moverOf(
  v: { isHouse: boolean; orgId: number | null; houseOrgId: number | null },
  wo: { tenantOrgId: number | null; orgId: number | null },
  ownerOrgId: number | null,
): Mover | null {
  // Staff of the company whose workspace this order lives in. Platform staff
  // carry houseOrgId null - "no restriction", same convention as readTenant -
  // and are the house EVERYWHERE. The strict === was a real bug: the moment
  // tenant stamping started writing real org ids onto orders, null === 2
  // failed and the platform owner lost every control on every job.
  if (v.isHouse) return v.houseOrgId === null || v.houseOrgId === wo.tenantOrgId ? "house" : null;
  if (v.orgId === null) return null;
  return v.orgId === wo.orgId || v.orgId === ownerOrgId ? "requester" : null;
}

/**
 * The states this one can be moved to, by this mover, and nothing else.
 *
 * The asymmetry is the whole point and worth stating plainly:
 *
 *   - Only the house can say a job is resolved. Declaring your own request
 *     finished is not a thing a customer should be able to do, and it is not a
 *     thing a customer wants to do either.
 *   - Either side can close a resolved one. We close it because the client has
 *     stopped replying; they close it because they are happy. Both are ordinary.
 *   - Either side can reopen. "It's doing it again" has to land on the original
 *     job, not on a second one with none of the history.
 *   - Only the requester can cancel their own ask outright, and only while
 *     nobody has started. Once work has been done there are hours against it,
 *     and cancelling would erase the reason they exist.
 */
export function woMoves(state: string, who: Mover): WoState[] {
  if (who === "house") {
    switch (state) {
      case "open": return ["active", "waiting", "resolved", "cancelled"];
      case "active": return ["waiting", "resolved", "cancelled"];
      case "waiting": return ["active", "resolved", "cancelled"];
      case "resolved": return ["closed", "active"];
      case "closed": return ["active"];
      case "cancelled": return ["open"];
      default: return [];
    }
  }
  switch (state) {
    case "open": return ["cancelled"];
    case "resolved": return ["closed", "active"];
    case "closed": return ["active"];
    default: return [];
  }
}

/**
 * May this move happen, and if not, why not in words somebody can act on.
 *
 * Refusals say what the mover can do instead wherever there is one, because
 * "not allowed" on a button somebody just pressed is the least useful sentence
 * in software.
 */
export function woMove(state: string, to: string, who: Mover):
{ ok: true; next: WoState } | { ok: false; error: string } {
  if (!isWoState(state)) return { ok: false, error: "That work order is in an unknown state." };
  if (!isWoState(to)) return { ok: false, error: `"${to}" is not a work order state.` };
  if (state === to) return { ok: false, error: `It is already ${WO_LABEL[to].toLowerCase()}.` };
  if (woMoves(state, who).includes(to)) return { ok: true, next: to };

  if (who === "requester") {
    if (to === "resolved") return { ok: false, error: "The service team marks work resolved." };
    if (to === "cancelled") {
      return { ok: false, error: woOpen(state)
        ? "Work has started on this one - ask the service team to close it instead."
        : "This one is already finished." };
    }
    return { ok: false, error: "That is the service team's to change." };
  }
  return { ok: false, error: `A ${WO_LABEL[state].toLowerCase()} work order can't go straight to ${WO_LABEL[to].toLowerCase()}.` };
}

/**
 * Next work-order number, sequential on the highest already used.
 *
 * Same reasoning as PO numbers (lib/po): counting rows would hand out a number
 * twice the first time one is deleted, and a number quoted on the phone has to
 * mean one job forever. Numbers are per workspace, so two operators on the same
 * instance each count from their own 1000 and neither sees the other's.
 */
export function nextWoNumber(existing: string[], prefix = "WO-"): string {
  let top = 1000;
  for (const n of existing) {
    const m = n.match(/(\d+)\s*$/);
    if (m) top = Math.max(top, parseInt(m[1], 10));
  }
  return `${prefix}${top + 1}`;
}

export type WoLike = {
  number: string;
  title: string;
  severity: string;
  state: string;
  openedOn: string;      // YYYY-MM-DD
  assignee: string;
};

/** Days since it was asked for. Negative clock skew reads as 0, not as -1 day. */
export function ageDays(openedOn: string, today: string): number {
  const a = Date.parse(`${openedOn}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** Past the day its kind says it should have been answered, and still open. */
export const woLate = (wo: Pick<WoLike, "severity" | "state" | "openedOn">, today: string): boolean =>
  woOpen(wo.state) && targetDay(wo.severity, wo.openedOn) < today;

/**
 * The order a list of them should be read in: what is still owed, worst first.
 *
 * Late before on-time, then by severity, then oldest first - which is the order
 * somebody with an hour free should pick work off the top in. Settled orders sink
 * to the bottom newest-first, because down there the question is "what did we do
 * recently", not "what should I do next".
 */
export function sortWorkOrders<T extends Pick<WoLike, "severity" | "state" | "openedOn" | "number">>(
  list: T[], today: string,
): T[] {
  const key = (w: T) => [
    woOpen(w.state) ? 0 : 1,
    woLate(w, today) ? 0 : 1,
    severityOf(w.severity).rank,
  ];
  return [...list].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    // Oldest first while open (it has waited longest), newest first once settled.
    const dir = woOpen(a.state) ? 1 : -1;
    if (a.openedOn !== b.openedOn) return a.openedOn < b.openedOn ? -dir : dir;
    return a.number.localeCompare(b.number);
  });
}

/**
 * What a work order is waiting on, as the one line a list shows under its title.
 *
 * Assembled from what is actually there rather than from the state alone: "Open"
 * tells a client nothing, "Open · 3 days · nobody assigned" tells them exactly
 * what they wanted to know when they opened the page.
 */
export function woLine(
  wo: Pick<WoLike, "state" | "severity" | "openedOn" | "assignee">,
  today: string,
  counts: { tasks: number; done: number } = { tasks: 0, done: 0 },
): string {
  const bits: string[] = [WO_LABEL[wo.state] ?? wo.state];
  if (woOpen(wo.state)) {
    const days = ageDays(wo.openedOn, today);
    bits.push(days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`);
    if (woLate(wo, today)) bits.push("late");
    if (counts.tasks > 0) bits.push(`${counts.done}/${counts.tasks} done`);
    bits.push(wo.assignee ? wo.assignee : "unassigned");
  }
  return bits.join(" · ");
}

/**
 * The close-out sentence, which is what the record keeps.
 *
 * A job closed with nothing written on it is the commonest way service history
 * turns into a list of dates, so the summary is required to close - but what
 * WENT INTO it is counted here rather than retyped, since the tasks and the
 * hours are already on the order and nobody should have to add them up by hand.
 */
export function closeLine(
  summary: string,
  did: { tasks: number; minutes: number; parts: number },
): string {
  const s = summary.trim();
  const bits: string[] = [];
  if (did.tasks) bits.push(`${did.tasks} task${did.tasks === 1 ? "" : "s"}`);
  if (did.minutes) bits.push(`${(did.minutes / 60).toFixed(1)}h`);
  if (did.parts) bits.push(`${did.parts} part${did.parts === 1 ? "" : "s"}`);
  return bits.length ? `${s} (${bits.join(", ")})` : s;
}

/**
 * Whether this order can still take new work rows hung off it.
 *
 * A settled order is a record. Logging today's hours against a job that closed
 * in March is nearly always a misclick, and letting it through would quietly
 * change what a closed record says happened. A resolved one is still open to it,
 * because "I forgot to log Tuesday" arrives after the work is done, not before.
 */
export const woAcceptsWork = (state: string) => woLive(state);
