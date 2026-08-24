// "Money, whose move" - the internal digest's one money section.
//
// INTERNAL EDITION ONLY. The partner edition gains nothing: a client sees
// their own money through their own portal token and nowhere else, and a
// digest that goes to five people at a lab is not a place to put a balance.
// tests/digestMoney.test.ts asserts the partner output carries no currency at
// all, because that rule is one bad merge away from being untrue.
//
// Every line names whose move it is, in the language the rest of the digest
// already uses. Unbilled closed work is OURS. An unanswered dispute is ours -
// somebody asked a question and nobody replied. A broken promise is theirs
// first and ours the morning after. That framing is the whole point: a list of
// numbers tells you how much, and this tells you what to do before lunch.
//
// Pure. The composer hands in rows.

import { formatCents } from "@/lib/money";
import { EMAIL, esc } from "@/lib/emailTheme";
import { TONE_HEX } from "@/lib/tones";

export type MoneyLine = {
  /** "Ours" or the client's name - whose move it is. */
  whose: string;
  /** Ours reads as a job to do; theirs as a thing to wait on or chase. */
  ours: boolean;
  text: string;
};

export type MoneyInput = {
  unbilled: { number: string; orgName: string; daysClosed: number; valueCents: number }[];
  brokenPromises: { number: string; orgName: string; byName: string; promisedOn: string; daysPast: number; payableCents: number }[];
  openDisputes: { number: string; orgName: string; reason: string; daysOpen: number; disputedCents: number; restCents: number }[];
  overdue: { number: string; orgName: string; daysLate: number; balanceCents: number }[];
  onHold: { orgName: string; balanceCents: number; oldestDaysLate: number }[];
  staleQuotes: { number: string; orgName: string; daysLeft: number; valueCents: number; views: number }[];
};

/** How many days before an unbilled closed job is worth a line of its own. */
export const UNBILLED_AFTER_DAYS = 2;

/**
 * The lines, in the order somebody should act on them: what we have not
 * billed, what we have not answered, what they have not paid.
 *
 * Unbilled work leads because it is the only one of the four that is entirely
 * within our own control, and because it is the leak nobody notices - an
 * invoice never raised does not appear on any aging report.
 */
export function moneyLines(m: MoneyInput): MoneyLine[] {
  const out: MoneyLine[] = [];

  for (const j of m.unbilled.filter((x) => x.daysClosed >= UNBILLED_AFTER_DAYS)) {
    out.push({
      whose: "Ours", ours: true,
      text: `${j.number} closed ${j.daysClosed} day${j.daysClosed === 1 ? "" : "s"} ago, `
        + `${formatCents(j.valueCents)} unbilled - ${j.orgName}`,
    });
  }

  for (const d of m.openDisputes) {
    out.push({
      whose: "Ours", ours: true,
      text: `${d.number} disputed ${d.daysOpen} day${d.daysOpen === 1 ? "" : "s"}: "${d.reason}". `
        + `Answer it - the other ${formatCents(d.restCents)} is still aging.`,
    });
  }

  for (const p of m.brokenPromises) {
    out.push({
      whose: p.orgName, ours: false,
      text: `promised ${p.number} by ${p.promisedOn}; ${p.daysPast} day${p.daysPast === 1 ? "" : "s"} past. `
        + `Whose move: theirs, then ours by the next rung.`,
    });
  }

  for (const o of m.overdue) {
    out.push({
      whose: o.orgName, ours: false,
      text: `${o.number} is ${o.daysLate} day${o.daysLate === 1 ? "" : "s"} past due, ${formatCents(o.balanceCents)}.`,
    });
  }

  for (const q of m.staleQuotes) {
    out.push({
      whose: q.orgName, ours: false,
      text: `${q.number} unanswered, ${formatCents(q.valueCents)}`
        + `${q.views > 0 ? `, viewed ${q.views === 1 ? "once" : `${q.views} times`}` : ", never opened"}`
        + ` - ${q.daysLeft <= 0 ? "expired" : `expires in ${q.daysLeft} day${q.daysLeft === 1 ? "" : "s"}`}.`,
    });
  }

  for (const h of m.onHold) {
    out.push({
      whose: "Ours", ours: true,
      text: `${h.orgName} is on credit hold - ${formatCents(h.balanceCents)} open, oldest ${h.oldestDaysLate} days. `
        + `New work opens on hold until it clears or somebody overrides it.`,
    });
  }
  return out;
}

/** The section as it appears in the internal email. Empty when there is nothing. */
export function renderMoneySection(m: MoneyInput): string {
  const lines = moneyLines(m);
  if (!lines.length) return "";
  const total = m.unbilled.reduce((n, j) => n + j.valueCents, 0)
    + m.overdue.reduce((n, o) => n + o.balanceCents, 0);

  return `
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-top:18px;">
    <tr><td style="padding:10px 0 6px;border-top:2px solid ${EMAIL.ink};">
      <span style="font-family:${EMAIL.font};font-size:13px;font-weight:bold;color:${EMAIL.ink};letter-spacing:.3px;">
        MONEY, WHOSE MOVE
      </span>
      <span style="font-family:${EMAIL.font};font-size:12px;color:${EMAIL.muted};">
        &nbsp;${esc(formatCents(total))} between unbilled work and money past due
      </span>
    </td></tr>
    ${lines.map((l) => `
    <tr><td style="padding:6px 0;border-top:1px solid ${EMAIL.hairline};font-family:${EMAIL.font};font-size:13px;color:${EMAIL.body};">
      <span style="display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:700;background:${
        l.ours ? TONE_HEX.warn.bg : TONE_HEX.neutral.bg
      };color:${l.ours ? TONE_HEX.warn.fg : TONE_HEX.neutral.fg};">${esc(l.whose)}</span>
      &nbsp;${esc(l.text)}
    </td></tr>`).join("")}
  </table>`;
}

/** The plain-text twin, for the text alternative. */
export function renderMoneyText(m: MoneyInput): string[] {
  const lines = moneyLines(m);
  if (!lines.length) return [];
  return ["", "MONEY, WHOSE MOVE", "", ...lines.map((l) => `  ${l.whose} - ${l.text}`)];
}
