// What a client is shown, in their words, and how much of it.
//
// A client has been reading the staff board with the staff's things hidden:
// the same stage machinery, the same "Ours to move" seeded facet, the same
// header that says "Dashboard". The words are the shop's words - a client does
// not file a work order, they ask for help, and the work order is what the
// shop creates in response.
//
// Pure, because three surfaces have to agree about it: the landing decides
// which systems earn a card, the card decides what colour it is, and the
// sentence under it has to say the same thing as the colour. A second copy of
// any of those rules is a page that argues with itself.

import type { Tone } from "@/lib/tones";
import { BLOCKED_STAGE } from "@/lib/stages";

// ── What a system's state is, said to its owner ─────────────────────────────

/**
 * The states a client is told about, worst first.
 *
 * Deliberately NOT the stage list. Stages are how the shop tracks work through
 * a bench; this is the answer to "can I use it, and is anyone doing anything".
 * A system can be in three stages at once and still only be one of these.
 */
export const CLIENT_STATES = ["down", "attention", "blocked", "due", "ok"] as const;
export type ClientState = (typeof CLIENT_STATES)[number];

/**
 * The label, the tone, and how bad it is.
 *
 * The words come from WO_SEVERITIES, where they were already written for a
 * customer to read - "Not usable at all", "Usable, but not right". They are
 * repeated here rather than imported because these describe a SYSTEM and those
 * describe a work order, and the two lists will not always agree: a system with
 * no open work order at all can still be blocked or due.
 */
export const CLIENT_STATE: Record<ClientState, { label: string; tone: Tone; rank: number }> = {
  down: { label: "Down", tone: "bad", rank: 0 },
  attention: { label: "Usable, not right", tone: "warn", rank: 1 },
  blocked: { label: "Waiting on a part", tone: "warn", rank: 2 },
  due: { label: "Maintenance due", tone: "info", rank: 3 },
  ok: { label: "In service", tone: "good", rank: 4 },
};

export type SystemSignals = {
  /** Severity keys of the system's OPEN work orders. Closed ones say nothing. */
  openSeverities: string[];
  /** The system's current stages, as the shop tracks them. */
  stages: string[];
  /** A maintenance window is due or already past. */
  pmDue: boolean;
};

/**
 * One state per system, worst signal wins.
 *
 * Every input is something the app already records. Nothing here is inferred
 * from an absence: a system with no open work order and no due date is "In
 * service" because that is what the record says, not because we are guessing
 * it is healthy.
 */
export function clientState(s: SystemSignals): ClientState {
  const sev = s.openSeverities.map((x) => x.trim().toLowerCase());
  if (sev.includes("down")) return "down";
  if (sev.includes("degraded")) return "attention";
  // A blocked system is not necessarily unusable - it is work that has stopped.
  // It ranks below "usable, not right" because the client can still run it.
  if (s.stages.includes(BLOCKED_STAGE)) return "blocked";
  if (s.pmDue) return "due";
  return "ok";
}

/** Everything that is not "In service" earns a card. */
export const needsAttention = (state: ClientState): boolean => state !== "ok";

/** Worst first, so the card that matters is the card in the corner of the eye. */
export const bySeverity = (a: ClientState, b: ClientState): number =>
  CLIENT_STATE[a].rank - CLIENT_STATE[b].rank;

// ── Whose move it is ────────────────────────────────────────────────────────

/**
 * The queue, said to the client rather than about them.
 *
 * queueView() answers "mine or elsewhere" from whoever is asking. On the staff
 * board "mine" means the shop; here it means the client. The words have to flip
 * with it or a client reads "Ours to move" and reasonably assumes the shop
 * means itself - which is exactly what the board says to them today.
 */
export function moveLabel(yourMove: boolean, operatorName: string): string {
  return yourMove ? "Your move" : `With ${operatorName}`;
}

export const moveTone = (yourMove: boolean): Tone => (yourMove ? "warn" : "info");

/**
 * A QUEUE IS A POSITION, NOT AN OBLIGATION.
 *
 * This is the distinction the client surfaces got wrong. The queue answers who
 * HAS a system; it does not answer who owes a move. A shop that finishes a job
 * hands the system back - the queue arriving at the client with nothing
 * attached to it - and reading that as "they are waiting on you" turns every
 * completed job into a chore on somebody's list. Which is exactly what it did:
 * a system handed back in service, with no open work, was announced as
 * "Sierra Spectra is waiting on you".
 *
 * So possession only counts as a chore when something is actually pending: an
 * open job, work that has stopped, or maintenance that has fallen due. All
 * three are already in the state, which is why the state decides this.
 *
 * The known gap: a shop that parks a system with a written reason and opens
 * nothing gets no chore raised here. The reason still shows on the record, and
 * that is the better failure - a missed nudge costs a phone call, while
 * crying wolf on every finished job costs the list its credibility.
 */
export const queueNeedsThem = (state: ClientState): boolean => needsAttention(state);

/**
 * What the card's footer says about who holds this and whether it matters.
 *
 * Three outcomes, not two. "With them and fine" is a real answer and the one
 * the old code could not say: it tested `state === "ok" && !yourMove`, so a
 * healthy system the SHOP held read "Nothing pending" while a healthy system
 * the CLIENT held read "Your move" - the truth, inverted.
 */
export function standingPill(
  state: ClientState, yourMove: boolean, operatorName: string,
): { label: string; tone: Tone } {
  if (!yourMove) return { label: `With ${operatorName}`, tone: "info" };
  return queueNeedsThem(state)
    ? { label: "Your move", tone: "warn" }
    // Theirs, and nothing is pending on it. Back from service is the ordinary
    // way a system ends up here.
    : { label: "Nothing pending", tone: "good" };
}

// ── How much to show ────────────────────────────────────────────────────────

/**
 * Above this many systems, cards stop being a list and become a wall.
 *
 * Four instruments is a page you read; thirty-four is a page you search. The
 * rule is that ATTENTION scales and INVENTORY does not - the exception list
 * stays roughly one screen at any account size, and only the collapsed summary
 * behind it grows.
 */
export const CARD_EVERYTHING_MAX = 8;

export type Density = "cards" | "grouped";

/**
 * Which shape this account gets.
 *
 * More than one site groups regardless of count: a manager standing in Hayward
 * has no use for a San Diego card, and two sites is already two contexts even
 * at six instruments. The override exists because account size is a proxy and
 * proxies are wrong sometimes - a four-instrument account in three buildings
 * wants grouping, and a fourteen-instrument teaching lab in one room does not.
 */
export function density(opts: {
  systems: number;
  /** Distinct non-empty site names across the account. */
  sites: number;
  /** An account-level choice, when somebody has made one. */
  override?: Density | null;
}): Density {
  if (opts.override === "cards" || opts.override === "grouped") return opts.override;
  if (opts.sites > 1) return "grouped";
  return opts.systems > CARD_EVERYTHING_MAX ? "grouped" : "cards";
}

/** The sites an account spans, in a stable order, blanks dropped. */
export function sitesOf(systems: { site?: string | null }[]): string[] {
  const seen = new Set<string>();
  for (const s of systems) {
    const name = (s.site ?? "").trim();
    if (name) seen.add(name);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// ── What is waiting on the client ───────────────────────────────────────────

/**
 * One thing the client has to do, from whichever part of the relationship
 * raised it.
 *
 * The mirror of the staff standing line. The shop has a page that says whose
 * move each system is; the client has had no equivalent, so a quote sat
 * unanswered for fourteen days without anybody being told they were the reason.
 */
export type ClientTodo = {
  key: string;
  /** How overdue this is: red is costing them, amber is going to. */
  tone: "bad" | "warn";
  title: string;
  detail: string;
  href: string;
  /** Days it has been theirs, when that is known. */
  days?: number;
  /** The words on the button that ends it. */
  action: string;
};

/** A quote unanswered this long has stopped being considered. */
export const STALE_ANSWER_DAYS = 10;

/**
 * Maintenance this far past due has missed the interval it was protecting,
 * rather than merely being late for it.
 */
export const PM_BADLY_OVERDUE_DAYS = 30;

/** Red first, then longest-waiting: the thing they have held longest, first. */
export function rankTodos(list: ClientTodo[]): ClientTodo[] {
  const weight = (t: ClientTodo) => (t.tone === "bad" ? 0 : 1);
  return [...list].sort((a, b) => weight(a) - weight(b) || (b.days ?? 0) - (a.days ?? 0));
}

// ── The record, as its owner reads it ───────────────────────────────────────

/**
 * The panels a client sees on their own instrument.
 *
 * An allow-list rather than a deny-list on purpose: a panel added later is
 * invisible to a client until somebody decides it should not be, which is the
 * safe direction for a surface that shows another company their machine.
 *
 * What is left out is left out because it is the shop's working memory, not
 * because it is secret. Internal tasks are how an engineer breaks a job into
 * steps; hours are what the shop pays itself; the daily update is a note to
 * tomorrow's engineer; the activity log is every field anybody ever edited. A
 * client reading those learns nothing they can act on and quite a lot about
 * how the sausage is made.
 */
export const CLIENT_PANELS = [
  "queue", "system", "assets", "site", "workorders", "maintenance",
  "parts", "photos", "validation", "files", "reference", "discussion",
] as const;

export const clientMaySee = (key: string): boolean =>
  (CLIENT_PANELS as readonly string[]).includes(key);

/**
 * The contexts, named for what a client came to find rather than for how the
 * shop files it. "Configuration" is a word about a database; "What it is" is
 * the question somebody actually has.
 */
export const CLIENT_GROUP_LABEL: Record<string, string> = {
  now: "Now",
  work: "Work",
  maintenance: "Maintenance",
  config: "What it is",
  files: "Documents",
  history: "History",
};

// ── Reseller mode ───────────────────────────────────────────────────────────

/**
 * A reseller's units are not benches that must stay up - they are inventory
 * moving toward a sale, and stages.ts already says so: "In service" is "a
 * resting state rather than a step". So the question is not "is it usable",
 * it is "is it moving", and the exception is a unit that has stopped.
 */
export const STALLED_DAYS = 30;

export const isStalled = (stage: string, days: number): boolean =>
  stage === BLOCKED_STAGE ? days >= STALLED_DAYS : false;

/**
 * Median, because one unit stuck on a discontinued board for 200 days would
 * drag a mean into uselessness and hide that everything else moved in a week.
 */
export function medianDays(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
