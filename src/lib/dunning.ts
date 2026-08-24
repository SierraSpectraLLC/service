// The ladder: what happens, and when, when a bill goes unpaid.
//
// It is DATA. Seven rungs with an offset from the due date, an action, a
// channel and which escalation contact it addresses - because the shape of a
// collections process is a policy decision an operator should be able to read
// in one screen, not a sequence buried in a cron job.
//
// Two rules the rungs encode that are easy to get wrong:
//
//   Rung two and up address a NEW PERSON. Sending the fourth reminder to the
//   contact who has ignored the first three is how an invoice ages out. The
//   lab manager gets the nudges; the AP desk gets the statement; the owner
//   gets the letter. Who those people are is per-org, in billingPolicy.
//
//   A broken promise SKIPS A RUNG. Somebody said the check was going out and
//   it did not; the next contact is the next one up, not another polite note
//   to the same desk. That is the whole reason promises are worth recording.
//
// Nothing here sends anything or reads a database. nextAction is handed the
// invoice's standing, the policy and the log, and returns what is due.

import { formatCents } from "@/lib/money";
import type { BillingPolicy } from "@/lib/billingPolicy";
import type { Tone } from "@/lib/tones";

/** How a rung reaches somebody. Drives the copy, not the transport. */
export type Channel = "email" | "statement" | "letter" | "call" | "export";

export type Rung = {
  key: string;
  /** Days from the DUE date. Negative is before it; 0 is the day itself. */
  offsetDays: number;
  /** The imperative, as it reads in the ladder view. */
  action: string;
  channel: Channel;
  /**
   * Which of billingPolicy.escalation this rung addresses. -1 means the
   * ordinary billing contact - the person who has been getting the mail.
   */
  contactIndex: number;
  /** One line of why this rung exists, shown under it. */
  why: string;
};

/**
 * Seven rungs, from a nudge to a packet. The offsets are the commercial
 * ordinary: a reminder a week in, the due date itself, a statement at two
 * weeks past, a fee and a phone call at a month, then people with authority.
 */
export const LADDER: Rung[] = [
  {
    key: "nudge", offsetDays: -7, action: "Nudge if unopened or unpaid",
    channel: "email", contactIndex: -1,
    why: "Most late invoices are late because nobody opened them.",
  },
  {
    key: "due", offsetDays: 0, action: "Due today",
    channel: "email", contactIndex: -1,
    why: "The last quiet reminder before it is late.",
  },
  {
    key: "statement", offsetDays: 15, action: "Statement and reminder to the AP desk",
    channel: "statement", contactIndex: 0,
    why: "AP pays from statements, not from invoices they were never sent.",
  },
  {
    key: "fee", offsetDays: 30, action: "Post the late fee and make a call",
    channel: "call", contactIndex: 0,
    why: "A charge nobody mentions on the phone is a charge nobody pays.",
  },
  {
    key: "owner", offsetDays: 45, action: "Owner letter",
    channel: "letter", contactIndex: 1,
    why: "Not back to the contact who has already ignored you three times.",
  },
  {
    key: "final", offsetDays: 60, action: "Final notice and credit hold",
    channel: "letter", contactIndex: 2,
    why: "The last rung that is still a conversation.",
  },
  {
    key: "refer", offsetDays: 90, action: "Agency packet or small-claims prep",
    channel: "export", contactIndex: 2,
    why: "Exported, not hosted. The invoice leaves the ladder marked referred.",
  },
];

export const RUNG_BY_KEY: Record<string, Rung> =
  Object.fromEntries(LADDER.map((r) => [r.key, r]));

export const CHANNEL_LABEL: Record<Channel, string> = {
  email: "Email", statement: "Statement", letter: "Letter",
  call: "Phone call", export: "Export",
};

export const CHANNEL_TONE: Record<Channel, Tone> = {
  email: "info", statement: "info", letter: "warn", call: "warn", export: "bad",
};

/** The day a rung comes due for an invoice with this due date. */
export const rungDate = (dueOn: string, r: Rung): string => {
  if (!dueOn) return "";
  const t = Date.parse(`${dueOn}T00:00:00Z`);
  if (!Number.isFinite(t)) return "";
  return new Date(t + r.offsetDays * 86400000).toISOString().slice(0, 10);
};

/** Who this rung is addressed to, falling back down the list then to billing. */
export function contactFor(r: Rung, p: BillingPolicy): { name: string; role: string; email?: string } | null {
  if (r.contactIndex < 0) return null;
  // Falling back to the LAST named escalation rather than to the ordinary
  // contact: an operator who named two people meant those two to handle the
  // hard end, and dropping back to the lab manager for a final notice undoes
  // the whole point of escalating.
  return p.escalation[r.contactIndex] ?? p.escalation[p.escalation.length - 1] ?? null;
}

export type DunningLogEntry = { rung: string; sentOn: string };

export type LadderStep = {
  rung: Rung;
  dueOn: string;
  /** done | now | ahead - what the ladder view draws. */
  state: "done" | "now" | "ahead";
  sentOn: string;
  contact: { name: string; role: string; email?: string } | null;
};

/**
 * The whole ladder for one invoice, each rung marked.
 *
 * "now" is every rung whose day has come and which has not been sent - more
 * than one when an invoice has been ignored for a while, which is honest: it
 * says what is owed, not merely the next thing.
 */
export function ladderFor(input: {
  dueOn: string;
  today: string;
  policy: BillingPolicy;
  log: DunningLogEntry[];
  /** A promise broken since the last rung skips the next one. See below. */
  promiseBroken?: boolean;
}): LadderStep[] {
  const sent = new Map(input.log.map((e) => [e.rung, e.sentOn]));
  const steps = LADDER.map((rung) => {
    const dueOn = rungDate(input.dueOn, rung);
    const sentOn = sent.get(rung.key) ?? "";
    const state: LadderStep["state"] = sentOn
      ? "done"
      : dueOn && dueOn <= input.today ? "now" : "ahead";
    return { rung, dueOn, state, sentOn, contact: contactFor(rung, input.policy) };
  });
  if (!input.promiseBroken) return steps;

  // A broken promise moves the conversation up a rung.
  //
  // The rung it skips is the one that WOULD have been sent - the furthest one
  // due, which is what nextAction acts on - and the rung above it becomes due
  // whatever the calendar says. Skipping the earliest missed rung instead
  // would change nothing, because the furthest one is still what gets sent.
  let last = -1;
  for (let i = 0; i < steps.length; i++) if (steps[i].state === "now") last = i;
  if (last < 0) return steps;

  // The skip escalates by exactly ONE rung, and only onto a rung that has not
  // already been climbed. Promoting blindly re-opened a rung whose
  // dunning_events row already existed, and the cron sent the owner letter
  // every hour for the rest of the month. Hunting further up the ladder is no
  // better: if the next rung is already sent then there is nothing to escalate
  // to today, and the answer is to wait for the calendar rather than to leap
  // to a final notice three weeks early.
  const next = last + 1;
  steps[last] = { ...steps[last], state: "ahead" };
  if (next < steps.length && steps[next].state !== "done") {
    steps[next] = { ...steps[next], state: "now" };
  }
  return steps;
}

/**
 * The one rung to act on right now, or null when nothing is due.
 *
 * The FURTHEST due rung, not the earliest: an invoice that has been ignored
 * for fifty days needs the owner letter, and working back through three
 * reminders it should have had is theatre.
 */
export function nextAction(input: Parameters<typeof ladderFor>[0]): LadderStep | null {
  const now = ladderFor(input).filter((s) => s.state === "now");
  return now.length ? now[now.length - 1] : null;
}

/** Has this invoice been referred - off the ladder for good? */
export const isReferred = (log: DunningLogEntry[]): boolean =>
  log.some((e) => e.rung === "refer");

// ---------------------------------------------------------------------------
// The fee.
// ---------------------------------------------------------------------------

export type FeeQuote = {
  amountCents: number;
  /** The sentence that gets stored on the row and shown before posting. */
  basis: string;
  /** Why no fee is due, when there is none. Empty when there is one. */
  blocked: string;
};

export const NO_FEE = (blocked: string): FeeQuote => ({ amountCents: 0, basis: "", blocked });

/**
 * What may be charged on an invoice today, and the sentence explaining it.
 *
 * Computed on what the client is actually being ASKED for - the balance less
 * anything under dispute. Charging interest on a line somebody has raised a
 * fair question about is how a $340 argument becomes a lost client.
 *
 * Simple interest, never compound: a fee posted last month is not itself
 * charged interest this month. Compounding a late charge on a service invoice
 * is both unusual commercially and impossible to explain on the phone.
 */
export function feeFor(input: {
  policy: BillingPolicy;
  dueOn: string;
  today: string;
  /** What the reminders may ask for - see lib/billing.payableNow. */
  payableCents: number;
  /** Basis when the policy says parts only. */
  partsCents?: number;
  /** Fees already posted and not waived, so a month is not charged twice. */
  postedOn?: string[];
}): FeeQuote {
  const p = input.policy;
  if (p.feeType === "none") return NO_FEE("No late fee under this client's policy.");
  if (!input.dueOn) return NO_FEE("This invoice has no due date to charge from.");
  if (input.payableCents <= 0) return NO_FEE("Nothing is being asked for on this invoice.");

  const daysLate = Math.round(
    (Date.parse(`${input.today}T00:00:00Z`) - Date.parse(`${input.dueOn}T00:00:00Z`)) / 86400000,
  );
  const past = daysLate - p.graceDays;
  if (past <= 0) {
    return NO_FEE(daysLate <= 0
      ? "This invoice is not late yet."
      : `Inside the ${p.graceDays}-day grace period - ${p.graceDays - daysLate} day${p.graceDays - daysLate === 1 ? "" : "s"} to go.`);
  }

  const base = p.appliesTo === "parts" ? Math.max(0, input.partsCents ?? 0) : input.payableCents;
  if (base <= 0) return NO_FEE("The policy charges on parts, and there are none being asked for.");

  if (p.feeType === "flat") {
    // One flat charge per late period, and the period is a month: posting a
    // flat fee every time somebody opens the page is not a policy.
    const months = Math.floor(past / 30) + 1;
    if ((input.postedOn ?? []).length >= months) {
      return NO_FEE(`The flat charge for this period has already been posted.`);
    }
    return {
      amountCents: p.flatCents,
      basis: `Flat late charge of ${formatCents(p.flatCents)}, ${daysLate} days past due after a ${p.graceDays}-day grace period.`,
      blocked: "",
    };
  }

  // Interest accrues by the day at a monthly rate, then only the part not yet
  // charged is posted - so a fee posted at day 45 and another at day 75 add up
  // to the same as one at day 75.
  const monthly = p.rateBpsMonthly / 10000;
  const accrued = Math.round((base * monthly * past) / 30);
  const already = (input.postedOn ?? []).length
    ? Math.round((base * monthly * Math.max(0, daysLate - p.graceDays - 30)) / 30)
    : 0;
  const amount = Math.max(0, accrued - already);
  if (amount <= 0) return NO_FEE("Nothing further has accrued since the last charge.");
  return {
    amountCents: amount,
    basis: `${(p.rateBpsMonthly / 100).toFixed(2)}% per month on ${formatCents(base)}`
      + `${p.appliesTo === "parts" ? " of parts" : " undisputed"}, ${past} day${past === 1 ? "" : "s"}`
      + ` past the ${p.graceDays}-day grace period.`,
    blocked: "",
  };
}

// ---------------------------------------------------------------------------
// Promises.
// ---------------------------------------------------------------------------

export type PromiseRow = { promisedOn: string; byName: string; keptOn: string | null };

/** Promised, the day has come and gone, and nothing arrived. */
export const promiseBroken = (p: PromiseRow, today: string): boolean =>
  !p.keptOn && !!p.promisedOn && p.promisedOn < today;

/**
 * The one sentence the digest says the morning after. Null when nothing is
 * broken - the digest must not manufacture a line to have something to say.
 */
export function brokenPromiseLine(rows: PromiseRow[], today: string, invoiceNumber: string): string | null {
  const broken = rows.filter((p) => promiseBroken(p, today))
    .sort((a, b) => a.promisedOn.localeCompare(b.promisedOn));
  const p = broken[0];
  if (!p) return null;
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${p.promisedOn}T00:00:00Z`)) / 86400000);
  return `${p.byName || "They"} promised ${invoiceNumber} by ${p.promisedOn}`
    + ` - ${days} day${days === 1 ? "" : "s"} past the promise.`;
}
