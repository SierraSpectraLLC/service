"use client";

/**
 * 21 CFR Part 11 discipline for destructive actions: confirm AND collect the
 * reason in one step, for the audit trail. Returns null when the user cancels
 * or leaves the reason blank (the server enforces it too).
 */
export function promptReason(what: string): string | null {
  const r = window.prompt(`${what}\n\nEnter a reason for this action (recorded in the audit trail):`);
  if (r === null) return null;
  const trimmed = r.trim();
  if (trimmed.length < 3) {
    window.alert("A reason of at least a few words is required - nothing was deleted.");
    return null;
  }
  return trimmed;
}

/**
 * Why a system is being blocked, asked at the moment of blocking.
 *
 * Deliberately not promptReason: this is not a destructive act needing an
 * audit alibi, it is the fact that makes a blocked system actionable, and it
 * is asked for that way. Pre-filled when re-wording an existing reason. The
 * server demands it too - see actions.toggleStage.
 */
export function promptBlockReason(existing = ""): string | null {
  const r = window.prompt(
    "Why is this system blocked, and what would clear it?\n\n"
    + "Shown on the system and in the daily digest until it is unblocked.\n"
    + 'e.g. "waiting on LabZen to approve the quote for the HED supply"',
    existing);
  if (r === null) return null;
  const trimmed = r.trim();
  if (trimmed.length < 4) {
    window.alert("A few words at least - what is it waiting on? Nothing was changed.");
    return null;
  }
  return trimmed;
}
