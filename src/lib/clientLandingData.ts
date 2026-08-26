import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { pmSchedules, quotes } from "@/db/schema";
import { asStatementRow, invoicesForOrg } from "@/lib/invoiceData";
import { invoiceView, isOpen } from "@/lib/statement";
import { quoteStanding } from "@/lib/quotes";
import { formatCents } from "@/lib/money";
import {
  clientState, isStalled, medianDays, rankTodos, PM_BADLY_OVERDUE_DAYS, STALE_ANSWER_DAYS,
  type ClientState, type ClientTodo,
} from "@/lib/clientView";
import { ageDays, getStageSince } from "@/lib/stageAges";
import { BLOCKED_STAGE } from "@/lib/stages";
import { daysBetween } from "@/lib/finance";

/**
 * What the shop is waiting on this client for, gathered from every part of the
 * relationship that can raise something.
 *
 * The staff have a screen that says whose move each system is. A client has had
 * none - so a quote sat unanswered for a fortnight, a PM window went unbooked,
 * and an invoice went past terms, with nobody ever told they were the reason.
 * Every source here is something the app already records; what was missing was
 * anywhere that added them up and pointed the sentence the other way.
 */
export async function clientTodos(opts: {
  orgId: number;
  today: string;
  /** Systems this viewer can see, already scoped. */
  systems: { id: number; externalId: string; queueMine: boolean; queueReason: string }[];
  /** Ids of the systems above, for the maintenance read. */
  systemIds: number[];
}): Promise<ClientTodo[]> {
  const { orgId, today, systems, systemIds } = opts;

  const [quoteRows, invoiceRows, pmRows] = await Promise.all([
    db.select().from(quotes).where(eq(quotes.orgId, orgId)),
    invoicesForOrg(orgId),
    systemIds.length
      ? db.select({
          id: pmSchedules.id, instrumentId: pmSchedules.instrumentId,
          title: pmSchedules.title, nextDue: pmSchedules.nextDue, paused: pmSchedules.paused,
        }).from(pmSchedules)
          .where(and(inArray(pmSchedules.instrumentId, systemIds), lte(pmSchedules.nextDue, today)))
          .orderBy(asc(pmSchedules.nextDue))
      : Promise.resolve([]),
  ]);

  const todos: ClientTodo[] = [];

  // A quote nobody has answered. The lines are re-read rather than trusting a
  // stored total, the same way approval prices it.
  for (const q of quoteRows) {
    if (quoteStanding(q, today) !== "awaiting") continue;
    const days = daysBetween(q.sentOn || q.createdAt.toISOString().slice(0, 10), today);
    todos.push({
      key: `quote-${q.id}`,
      tone: days >= STALE_ANSWER_DAYS ? "bad" : "warn",
      title: `Approve or decline quote ${q.number}`,
      detail: q.title || "Work priced and waiting on your answer",
      href: `/orders/q/${q.id}`,
      days,
      action: "Review quote",
    });
  }

  // Money past the terms they agreed to.
  for (const f of invoiceRows) {
    const v = invoiceView(asStatementRow(f), today);
    if (!isOpen(v) || v.daysLate <= 0) continue;
    todos.push({
      key: `invoice-${f.row.id}`,
      tone: "bad",
      title: `Pay invoice ${f.row.number}`,
      detail: `${formatCents(v.balanceCents)} · ${v.daysLate} day${v.daysLate === 1 ? "" : "s"} past terms`,
      href: `/orders/i/${f.row.id}`,
      days: v.daysLate,
      action: "Pay now",
    });
  }

  // Maintenance that has fallen due and needs a window from their side. One
  // row for all of it: eleven separate "book a visit" lines is a list nobody
  // works through.
  const live = pmRows.filter((p) => !p.paused);
  if (live.length > 0) {
    const oldest = live[0];
    const worst = daysBetween(oldest.nextDue, today);
    todos.push({
      key: "pm",
      // Amber while it is merely due; red once it has been due long enough
      // that the interval it was protecting has been missed outright.
      tone: worst >= PM_BADLY_OVERDUE_DAYS ? "bad" : "warn",
      title: live.length === 1
        ? `Book a maintenance window for ${nameOf(systems, oldest.instrumentId)}`
        : `Confirm maintenance windows for ${live.length} instruments`,
      detail: live.length === 1
        ? `${oldest.title || "Scheduled maintenance"} · due ${oldest.nextDue}`
        : `Oldest fell due ${oldest.nextDue}`,
      href: live.length === 1 && oldest.instrumentId !== null
        ? `/instruments/${oldest.instrumentId}` : "/work",
      days: worst,
      action: "Pick a date",
    });
  }

  // A system parked in their queue: the shop has stopped because it is waiting
  // on them, and the reason is whatever whoever parked it wrote down.
  for (const s of systems) {
    if (!s.queueMine) continue;
    todos.push({
      key: `queue-${s.id}`,
      tone: "warn",
      title: `${s.externalId} is waiting on you`,
      detail: s.queueReason || "Work is paused until you come back on this one",
      href: `/instruments/${s.id}`,
      action: "Open",
    });
  }

  return rankTodos(todos);
}

const nameOf = (
  systems: { id: number; externalId: string }[], id: number | null,
): string => systems.find((s) => s.id === id)?.externalId ?? "an instrument";

/**
 * The sentence under a card: what is wrong, what is being done, and when.
 *
 * Assembled from the same signals the state came from, so the colour and the
 * words can never disagree. Deliberately plain: no stage names, no severity
 * keys, no internal identifiers a client would have to look up.
 */
export function whySentence(input: {
  state: ClientState;
  /** The worst open work order on this system, if any. */
  openWo: { number: string; title: string } | null;
  blockedDays: number | null;
  blockReason: string;
  pmDue: string;
  openParts: number;
  lastVisit: string;
}): string {
  const { state, openWo, blockedDays, blockReason, pmDue, openParts } = input;
  const job = openWo ? ` ${openWo.title || openWo.number} is open.` : "";

  if (state === "down") {
    return `Not usable at the moment.${job}`
      + (openParts > 0 ? ` ${openParts} part${openParts === 1 ? " is" : "s are"} on order.` : "");
  }
  if (state === "attention") {
    return `Usable, but not working the way it should.${job}`
      + (openParts > 0 ? ` ${openParts} part${openParts === 1 ? " is" : "s are"} on order.` : "");
  }
  if (state === "blocked") {
    const age = blockedDays && blockedDays > 0 ? ` for ${blockedDays} day${blockedDays === 1 ? "" : "s"}` : "";
    return blockReason
      ? `Work is paused${age}: ${blockReason}`
      : `Work is paused${age} while we wait on something.`;
  }
  if (state === "due") {
    return `Running normally. Scheduled maintenance fell due ${pmDue} and needs a window from you.`;
  }
  return input.lastVisit
    ? `Running normally. Last visit ${input.lastVisit}.`
    : "Running normally.";
}

/** The state of one system, from the signals the board already computed. */
export function stateOf(row: {
  down: boolean;
  openSeverities: string[];
  stages: string[];
  pmDue: boolean;
}): ClientState {
  // `down` on the board already folds in an asset marked Down, which an open
  // work order's severity does not know about - so it is checked first rather
  // than being re-derived from the severities alone.
  if (row.down) return "down";
  return clientState({
    openSeverities: row.openSeverities,
    stages: row.stages,
    pmDue: row.pmDue,
  });
}

// ── Reseller mode ───────────────────────────────────────────────────────────

/**
 * Where a reseller's units are, and how long they have been there.
 *
 * A lab's question is "can I use it". A reseller's is "is it moving" - their
 * units are inventory heading for a sale, not benches that have to stay up,
 * and stages.ts says as much where it calls "In service" a resting state
 * rather than a step. So the landing counts positions in a process and reports
 * how long each one typically takes, and the exception is a unit that has
 * stopped rather than a unit that is down.
 */
export type PipelineStage = {
  stage: string;
  count: number;
  /** Null when nothing is in this stage - never 0, which would read as instant. */
  medianDays: number | null;
  /** Something in here has sat long enough to be a problem. */
  hot: boolean;
};

export type StalledUnit = {
  id: number;
  externalId: string;
  label: string;
  stage: string;
  days: number;
  reason: string;
};

export async function pipelineFor(rows: {
  id: number; externalId: string; stages: string[]; blockedReason: string;
  /** Written directly when a system is blocked, whatever the event log holds. */
  blockedSince: Date | null;
}[], label: (id: number) => string): Promise<{
  stages: PipelineStage[];
  stalled: StalledUnit[];
}> {
  const ids = rows.map((r) => r.id);
  const since = ids.length ? await getStageSince(ids) : new Map();
  const now = new Date();

  /**
   * How long this unit has been in this stage.
   *
   * The stage-event log is the general answer, but blocking writes its own
   * column - and blocked age is the one this page acts on, so it reads the
   * column first rather than depending on a log that may not have been
   * running when the unit stopped.
   */
  const blockedAt = new Map(rows.map((r) => [r.id, r.blockedSince]));
  const ageIn = (id: number, stage: string): number | null => {
    if (stage === BLOCKED_STAGE) {
      const at = blockedAt.get(id);
      if (at) return ageDays(at, now);
    }
    const at = since.get(id)?.get(stage);
    return at ? ageDays(at, now) : null;
  };

  const stages: PipelineStage[] = PIPELINE_STAGES.map((stage) => {
    const inIt = rows.filter((r) => r.stages.includes(stage));
    const ages = inIt.map((r) => ageIn(r.id, stage)).filter((d): d is number => d !== null);
    return {
      stage,
      count: inIt.length,
      medianDays: medianDays(ages),
      // Only the blocked column goes red on age: thirty days IN refurbishment
      // is ordinary work, thirty days BLOCKED is a unit nobody is moving.
      hot: stage === BLOCKED_STAGE && ages.some((d) => isStalled(stage, d)),
    };
  });

  const stalled: StalledUnit[] = rows
    .flatMap((r) => {
      const stage = r.stages.find((x) => x === BLOCKED_STAGE);
      if (!stage) return [];
      const days = ageIn(r.id, stage);
      if (days === null || !isStalled(stage, days)) return [];
      return [{
        id: r.id, externalId: r.externalId, label: label(r.id), stage, days,
        reason: r.blockedReason || "Work has stopped and no reason was recorded.",
      }];
    })
    .sort((a, b) => b.days - a.days);

  return { stages, stalled };
}

/**
 * The stages that are a PIPELINE. "In service" and "Maintenance due" are what a
 * unit does after it is sold and belong to a lab's story, not a reseller's;
 * "Shipped" is the exit, counted but never a column to work.
 */
export const PIPELINE_STAGES = [
  "Intake", "Refurbishment", "System setup", "Checkout",
  "Applications", "Sign-off", BLOCKED_STAGE, "Waiting to ship",
] as const;

/**
 * What a reseller has to decide, on top of the quotes and invoices every
 * account has.
 *
 * Their waiting-on-you is mostly release gates: Checkout and Sign-off are the
 * stages where the OWNER says a unit may move on, so a unit sitting in one is
 * sitting on them, not on the shop.
 */
export function resellerTodos(input: {
  stalled: StalledUnit[];
  atGate: { id: number; externalId: string; stage: string }[];
  toShip: { id: number; externalId: string }[];
}): ClientTodo[] {
  const out: ClientTodo[] = [];

  for (const u of input.stalled) {
    out.push({
      key: `stalled-${u.id}`,
      tone: "bad",
      title: `Decide on ${u.externalId}`,
      detail: `Blocked ${u.days} days · ${u.reason}`,
      href: `/instruments/${u.id}`,
      days: u.days,
      action: "Decide",
    });
  }

  // One row per gate rather than per unit: three units at Checkout is one
  // sitting to do, and three lines nobody works through.
  for (const gate of ["Checkout", "Sign-off"]) {
    const list = input.atGate.filter((u) => u.stage === gate);
    if (list.length === 0) continue;
    out.push({
      key: `gate-${gate}`,
      tone: "warn",
      title: list.length === 1
        ? `Sign off ${list[0].externalId} at ${gate}`
        : `Sign off ${list.length} units at ${gate}`,
      detail: list.map((u) => u.externalId).join(", "),
      href: list.length === 1 ? `/instruments/${list[0].id}` : "/",
      action: "Review",
    });
  }

  if (input.toShip.length > 0) {
    out.push({
      key: "ship",
      tone: "warn",
      title: input.toShip.length === 1
        ? `Confirm shipping for ${input.toShip[0].externalId}`
        : `Confirm shipping for ${input.toShip.length} units`,
      detail: "Passed sign-off and waiting on a destination",
      href: input.toShip.length === 1 ? `/instruments/${input.toShip[0].id}` : "/",
      action: "Confirm",
    });
  }

  return out;
}
