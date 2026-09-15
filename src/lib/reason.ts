/**
 * 21 CFR Part 11 discipline: destroying or correcting a record requires a
 * stated reason, captured in the append-only audit trail alongside who and
 * when. Server-side so no client can skip it. Pure, and shared by every
 * action module that asks.
 */
export function requireReason(reason: string | undefined): string | { error: string } {
  const r = (reason ?? "").trim();
  if (r.length < 3) return { error: "A reason is required for this action (21 CFR 11)" };
  return r;
}
