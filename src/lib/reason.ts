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
