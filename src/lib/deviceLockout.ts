// Locking a stolen system out of itself.
//
// Pure, like lib/fleetNotice and for the same reason. This is the sharpest
// thing the product can do to a machine, so the decision to do it should be
// arguable in a test rather than only in production.
//
// ── Why this is a third thing, and not a rung on the other two ──────────────
//
// lib/fleetNotice has two acts and a wall between them: a repossession notice
// INFORMS, a safety hold ADVISES, and money never touches the customer's
// machine because lib/credit already withholds our labour, which is the
// sharper and more defensible lever.
//
// A theft lockout does not fit either. It is not commercial - an unpaid
// invoice is a dispute with a customer who still owns their instrument, and
// nothing here may ever be reachable from one. It is not engineering - there
// is no fault. It is an assertion that a specific machine is not where it is
// supposed to be, and the justification is a REPORT somebody filed, not a
// balance somebody owes.
//
// So it takes its own fact bag with no financial field, exactly as SafetyFacts
// does, and tests/deviceLockout pins the decision as invariant under every
// credit standing. The wall is the same wall.
//
// ── The reference is the point ──────────────────────────────────────────────
//
// A lockout will not compute without a `reference`: a police report number, an
// insurance claim, an RMA, a case number - something that exists outside this
// application and that somebody had to file. That is deliberate friction, and
// it is the whole reason this cannot quietly become a collections tool. A
// balance is a number our own software produced; a crime reference is not.
//
// ── What it actually achieves, which is less than it sounds ─────────────────
//
// See lib/remote.pushLockoutTo. Briefly: it forces a logged-in session off and
// keeps doing so, so a thief without the Windows password cannot use the
// desktop. It does not survive the machine staying offline, the agent being
// uninstalled, the disk being wiped or the drive being pulled, and it does
// nothing to somebody who has the password. It is a deterrent and a recovery
// aid. It is not a kill switch, and anybody relying on it as one has been
// misled - which is why `reach` says so in words the UI prints.
import type { ConsentMode } from "@/lib/remoteAccess";

/**
 * Why a machine is being locked out. NO financial field appears here and none
 * may be added: the separation test pins this decision as invariant across
 * credit standing, so a balance wired in would either be dead weight or a
 * failing suite.
 */
export type LockoutFacts = {
  /**
   * The thing filed outside this app - a police report, a claim, an RMA. No
   * reference, no lockout. See the header: this is the friction on purpose.
   */
  reference: string;
  /** Who made the call. Same rule as a notice or a hold: no name, no act. */
  decidedBy: string;
  /** Who the finder should call. A locked machine with no number is a brick. */
  contact: string;
  /**
   * notify   - say it on screen, change nothing
   * logoff   - say it, and end the desktop session, repeatedly
   * shutdown - say it, and power the machine off
   */
  force: "notify" | "logoff" | "shutdown";
};

/** What the agent is asked to do to a machine that should not be in use. */
export type LockoutPlan = {
  /** Shown on screen. Carries the contact, because recovery beats denial. */
  text: string;
  /** False for `notify`. True once the session is to be ended. */
  endsSession: boolean;
  /** True only for `shutdown`. */
  powersOff: boolean;
};

/**
 * The lockout, or nothing.
 *
 * Three things must be present: a reference, a name, and a contact. The
 * contact is required rather than optional - unlike a safety hold, where the
 * machine's own operator already knows who we are. A stolen machine is being
 * read by a stranger, possibly an honest one, and the single most useful thing
 * on that screen is a phone number that gets it home.
 */
export function lockoutPlan(f: LockoutFacts): LockoutPlan | null {
  const reference = f.reference.trim();
  const contact = f.contact.trim();
  if (!reference || !f.decidedBy.trim() || !contact) return null;
  return {
    text: `This system is reported stolen and has been locked by its supplier.`
      + ` Reference ${reference}. Call ${contact}.`,
    endsSession: f.force !== "notify",
    powersOff: f.force === "shutdown",
  };
}

/**
 * Whether custody weakens a lockout. It does not, and this function exists to
 * say so where somebody would otherwise reach for fleetNotice.permitted by
 * habit.
 *
 * That function degrades a safety lock on a machine that has shipped or changed
 * hands, because such a machine is the customer's and locking it reaches past
 * what we sell. A lockout inverts every term of that argument: a shipped system
 * is precisely the case this is for, and the claim is not that the machine is
 * ours to control but that it is not where its owner - customer or us - agreed
 * it would be. Degrading here would disable the feature exactly when it is
 * wanted.
 */
export function lockoutSurvivesCustody(_mode: ConsentMode): boolean {
  return true;
}

/**
 * What a lockout honestly reaches, for printing next to the button.
 *
 * Written here rather than in the component because it is a statement about
 * the mechanism, and the mechanism is not the UI's to describe.
 */
export const LOCKOUT_REACH =
  "Ends the desktop session whenever the machine is online and checks in, so somebody without "
  + "the Windows password cannot use it. It cannot reach a machine that stays offline, and it "
  + "does not survive the agent being removed, the disk being wiped or the drive being pulled. "
  + "Treat it as a deterrent and a way home, not as a kill switch.";
