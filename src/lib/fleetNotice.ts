// What a lab PC says on its own screen, and when it says nothing.
//
// Pure on purpose, like lib/remoteAccess and lib/credit, and for the same
// reason: this module decides what a customer sees on the machine that runs
// their instrument, so it is worth being able to argue with in a test.
//
// ── Two notices, and they must never become one ─────────────────────────────
//
// A REPOSSESSION notice is a commercial act. It is posted by a person, against
// a named invoice, with an approver's name on it, and it INFORMS. It never
// blocks, never locks, never interrupts. Its whole job is to be undeniable.
//
// A SAFETY hold is an engineering act. It is raised by an engineer against a
// fault, and it ADVISES - do not start new runs, here is who to call. At its
// sharpest rung it may lock a session, and then only when the machine is
// confirmed idle.
//
// They share this file and nothing else. `safetyNotice` cannot see money: it
// takes SafetyFacts, which has no financial field, and the test asserts its
// output is identical across every credit standing there is. That test is the
// invariant. If somebody one day passes a balance into the safety path to make
// a lock happen faster, the suite says so.
//
// ── Why there is no payment lock at all ─────────────────────────────────────
//
// Because lib/credit already answers this, and answers it better. A client who
// owes money goes on credit hold: no engineer is assigned and no job starts.
// That is a service company withholding its own labour, which is both the
// sharper lever and the defensible one. Locking the instrument instead reaches
// past what we sell and into what the customer runs - possibly mid-acquisition,
// on OEM software we did not write and cannot ask whether it is busy. The debt
// is the same size either way; only the blast radius differs.
//
// So: money withholds OUR work (lib/credit). Money never touches THEIR machine.
import type { ConsentMode } from "@/lib/remoteAccess";

// ── Repossession ────────────────────────────────────────────────────────────

/**
 * A posted repossession notice. Its existence is the decision - there is no
 * threshold in this file that posts one, deliberately. A balance crossing a
 * number is how you end up telling a hospital its GC belongs to somebody else
 * because an AP clerk was on holiday.
 */
export type RepoFacts = {
  /** Blank when nothing is posted, which is the ordinary state. */
  noticeText: string;
  /** The name on the decision. A notice without one does not render - see below. */
  approvedBy: string;
  /** Louder rungs, all of them still non-blocking. */
  rung: "notice" | "prominent" | "at_login";
};

// ── Safety ──────────────────────────────────────────────────────────────────

/**
 * An engineering hold. NO financial field appears here and none may be added:
 * the separation test pins the safety decision as invariant across credit
 * standing, so a money field would either be dead weight or a failing suite.
 */
export type SafetyFacts = {
  /** What is wrong, in engineering terms. Blank when nothing is held. */
  reason: string;
  /** Who decided. Same rule as repo: no name, no notice. */
  decidedBy: string;
  /** Who to call. Advice with no phone number is just an alarm. */
  contact: string;
  /**
   * advise  - say it, change nothing
   * hold    - say it louder: do not start new runs
   * lock    - may lock the SESSION, and only at confirmed idle (see below)
   */
  effect: "advise" | "hold" | "lock";
};

/**
 * What the agent is told to do. One shape for both kinds so the client stays
 * dumb: it renders what it is given and decides nothing.
 */
export type Notice = {
  kind: "repo" | "safety";
  /** Held to a rendering the agent cannot make modal. See `blocking`. */
  text: string;
  contact: string;
  /**
   * Always false for repo, and false for every safety rung but `lock`. The
   * agent honours `true` only when it can also confirm the machine is idle;
   * this flag is permission, not instruction.
   */
  mayLockAtIdle: boolean;
};

/** Nothing to say. */
export const QUIET: Notice[] = [];

/**
 * The repossession line, or nothing.
 *
 * Unsigned notices do not render. Not a formality - a notice that appears with
 * nobody's name behind it is one nobody has to defend, and this is the exact
 * feature that should be hard to post by accident.
 */
export function repoNotice(f: RepoFacts): Notice | null {
  if (!f.noticeText.trim() || !f.approvedBy.trim()) return null;
  return { kind: "repo", text: f.noticeText.trim(), contact: "", mayLockAtIdle: false };
}

/**
 * The safety line, or nothing. Takes no money and never will.
 *
 * `mayLockAtIdle` is the only path in this product to anything that stops a
 * person using a machine, and it is three doors deep: an engineer raised it, an
 * engineer chose the `lock` rung, and the agent must then confirm idle itself.
 * When the agent cannot tell, it does not lock - deferring costs a morning,
 * locking mid-run costs a sequence.
 */
export function safetyNotice(f: SafetyFacts): Notice | null {
  if (!f.reason.trim() || !f.decidedBy.trim()) return null;
  const lead = f.effect === "advise" ? "" : "Do not start new runs. ";
  return {
    kind: "safety",
    text: `${lead}${f.reason.trim()}`,
    contact: f.contact.trim(),
    mayLockAtIdle: f.effect === "lock",
  };
}

/**
 * Everything this device should show, in the order it should show it.
 *
 * Safety leads. A machine that is both faulty and behind on its bill is a
 * machine whose fault is the more urgent sentence, and burying it under a
 * collections notice would be a poor way to find that out.
 *
 * The two arguments are separate rather than one merged fact bag so that no
 * caller can accidentally derive one from the other - the type system does
 * half the work the separation test does.
 */
export function noticesFor(repo: RepoFacts | null, safety: SafetyFacts | null): Notice[] {
  const out: Notice[] = [];
  const s = safety && safetyNotice(safety);
  const r = repo && repoNotice(repo);
  if (s) out.push(s);
  if (r) out.push(r);
  return out;
}

/**
 * Whether a device may be told anything at all right now.
 *
 * A machine under `consent` mode belongs to somebody else - it shipped, or it
 * changed hands (lib/remoteAccess.consentModeFor). We still post notices to it,
 * because a repossession notice on a machine we have already handed over is the
 * only case where one makes sense at all, and a safety advisory is worth more
 * there than anywhere.
 *
 * What consent mode does change is the lock: we do not lock the session of a
 * machine that is no longer in our shop without a human at the far end having
 * agreed to a session in the first place. The rung stays available for a bench
 * unit; on a customer's floor it degrades to advice.
 */
export function permitted(notices: Notice[], mode: ConsentMode): Notice[] {
  if (mode === "unattended") return notices;
  return notices.map((n) => (n.mayLockAtIdle ? { ...n, mayLockAtIdle: false } : n));
}
