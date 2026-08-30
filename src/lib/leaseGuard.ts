// The lease a shipped system enforces on itself when it cannot reach us.
//
// Pure, like lib/fleetNotice and lib/deviceLockout, and for the sharper reason
// that this one runs on a machine we do not control and acts with nobody
// watching: the decision it makes had better be arguable in a test, because it
// will not be arguable in the field.
//
// ── What this is, and the wall it must keep ─────────────────────────────────
//
// deviceLockout stops a stolen machine that still phones home. It cannot touch
// one kept offline, which is what a careful thief does. This is the other half:
// a guard installed at the bench holds a signed lease with an expiry, renews
// silently whenever it can reach us, and acts on its own when the lease lapses.
// Offline is the whole point - everything it needs to decide is already on the
// machine before it ships.
//
// The wall is the same wall the rest of the fleet keeps: THIS FILE HAS NO MONEY
// FIELD, and none may be added. tests/leaseGuard pins the directive as
// invariant across every credit standing there is. The lease is renewed, or
// not, by a decision somebody makes and signs (lib/leaseGuardData) - never by a
// query against the invoice table. A slow accounts-payable department and a
// genuine default look identical to software; only a human can tell them apart,
// and only a human should be able to lock a customer's instrument.
//
// ── Fail-closed is the danger, so grace and warn-only are load-bearing ──────
//
// A dead-man's switch acts when it hears nothing, and the ordinary cause of
// hearing nothing is our own outage - a broken cron, an expired cert, a
// customer firewall change - not theft. Two mitigations live here rather than
// in policy:
//
//   * GRACE. A lapsed lease warns before it locks, so a normal outage produces
//     a notice and a phone number, not a locked lab.
//   * force: "notify". A lease can be ARMED without the lock ever engaging -
//     it only ever warns. This is how a system is run in the field for a while
//     to prove the guard is sound before anybody trusts it to lock, and it is
//     the safe default for arming.
//
// The model this is built for: we hold title until final payment, the lease is
// disclosed in the sale contract, and at sign-off the lease is RELEASED rather
// than left to expire. So the lock only ever bites a system we still own and
// have not been paid for - never a customer's property, because on the day it
// becomes theirs the lease is gone.

/**
 * How hard a lapsed lease acts. `notify` warns and never locks; `lock` ends the
 * desktop session once grace is spent. `notify` is the default because
 * fail-closed is the real hazard here (see the header) - a lease arms
 * warning-only, and letting it lock is a second, deliberate choice made once
 * the guard has proved sound in the field. It is the right rung while we still
 * hold title and have not been paid; the day title passes at final payment, the
 * lease is released outright, not left armed. There is deliberately no rung that
 * touches the disk or interrupts a run: see lib/leaseGuardCrypto for what the
 * agent is actually told to do, and why it is never more than a session lock.
 */
export type LeaseForce = "notify" | "lock";

/**
 * Everything the guard needs to decide, and NOTHING about money. The absence of
 * a financial field is the invariant, not an oversight - a balance wired in to
 * make a lock happen sooner would either be dead weight or a failing suite.
 */
export type LeaseFacts = {
  /** False when no lease has been armed - the ordinary state of most machines. */
  armed: boolean;
  /** When the current lease runs out. Null is treated as disarmed. */
  expiresAt: Date | null;
  /** Days of warning-only time after expiry before a `lock` lease may lock. */
  graceDays: number;
  /** Set once, forever, at sign-off. A released lease is terminal: the guard does nothing and should uninstall. */
  releasedAt: Date | null;
  force: LeaseForce;
};

export type LeaseState = "released" | "disarmed" | "current" | "grace" | "lapsed";

/** What the guard should do right now, and the state that explains why. */
export type LeaseDirective = {
  state: LeaseState;
  action: "nothing" | "warn" | "lock";
};

/** The lease length the UI offers by default. Seven days, and customizable. */
export const DEFAULT_LEASE_DAYS = 7;

/**
 * Warning-only days after expiry before a `lock` lease locks. Three by default:
 * enough that a long weekend of our own downtime is a notice rather than a
 * locked instrument, without being so long the lock is toothless. Customizable
 * alongside the lease length.
 */
export const DEFAULT_GRACE_DAYS = 3;

/** Guard rails on what the UI may set, so nobody arms a zero-day lease by accident. */
export const LEASE_DAYS_MIN = 1;
export const LEASE_DAYS_MAX = 365;
export const GRACE_DAYS_MIN = 0;
export const GRACE_DAYS_MAX = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where the lease stands, from the facts and the clock alone. */
export function leaseState(f: LeaseFacts, now: Date): LeaseState {
  if (f.releasedAt !== null) return "released";
  if (!f.armed || f.expiresAt === null) return "disarmed";
  const t = now.getTime();
  if (t < f.expiresAt.getTime()) return "current";
  if (t < f.expiresAt.getTime() + Math.max(0, f.graceDays) * DAY_MS) return "grace";
  return "lapsed";
}

/**
 * What the guard does about that state.
 *
 * Only a `lapsed` lease under `force: "lock"` ever locks. Everything else is
 * silence or a warning - which is what keeps an armed-but-warn-only machine, or
 * one merely inside its grace window, from locking a lab that has done nothing
 * wrong.
 */
export function leaseDirective(f: LeaseFacts, now: Date): LeaseDirective {
  const state = leaseState(f, now);
  if (state === "grace") return { state, action: "warn" };
  if (state === "lapsed") return { state, action: f.force === "lock" ? "lock" : "warn" };
  return { state, action: "nothing" };
}

/**
 * The line shown on the machine. Carries the contact, because a system that has
 * locked itself in a lab at 5pm needs to say who to call, not just that it is
 * unhappy. Never mentions money - the reader may be a customer mid-dispute, and
 * the guard's job is to get a phone call started, not to argue the invoice.
 */
export function leaseMessage(contact: string, action: "warn" | "lock"): string {
  const call = contact.trim() ? ` Call ${contact.trim()}.` : "";
  return action === "lock"
    ? `This system is operating under a supplier lease that has not been renewed, and its session has been locked.${call}`
    : `This system is operating under a supplier lease that needs renewal.${call}`;
}

// ── Renewal: the decision that actually applies the leverage ────────────────
//
// A guard renews silently whenever it reaches us, or it would lapse constantly
// and lock working labs - so renewal is granted BY DEFAULT. That means the
// online case is covered by simply refusing to renew: a machine we decline to
// re-lease keeps checking in and still lapses when its current lease runs out.
//
// Refusal has exactly two causes, and NEITHER is a balance:
//
//   * the machine is offline - nothing to refuse; it lapses on its own. This is
//     the theft-kept-dark case the whole guard exists for.
//   * a human SUSPENDED renewal - a recorded decision with a name and a reason
//     (lib/leaseGuardData). This is the lever, and pulling it is the deliberate
//     act that "unpaid past terms" might prompt - decided by a person, never
//     wired to the invoice table. The money-invariant test depends on this
//     function taking no money.

export type RenewalFacts = {
  armed: boolean;
  releasedAt: Date | null;
  /** Set by a human to stop re-leasing this machine. Null = renew normally. */
  suspendedAt: Date | null;
};

/**
 * What the guard's check-in is answered with. `grant` issues a fresh full lease;
 * `deny` leaves the machine to lapse; `released` tells it to stand down and
 * uninstall; `disarmed` means no lease is in force.
 */
export type RenewalDecision = "grant" | "deny" | "released" | "disarmed";

export function renewalDecision(f: RenewalFacts): RenewalDecision {
  if (f.releasedAt !== null) return "released";
  if (!f.armed) return "disarmed";
  if (f.suspendedAt !== null) return "deny";
  return "grant";
}

/** Clamp a customized lease length into the allowed range. */
export function clampLeaseDays(days: number): number {
  return Math.min(LEASE_DAYS_MAX, Math.max(LEASE_DAYS_MIN, Math.round(days)));
}

/** Clamp a customized grace window into the allowed range. */
export function clampGraceDays(days: number): number {
  return Math.min(GRACE_DAYS_MAX, Math.max(GRACE_DAYS_MIN, Math.round(days)));
}
