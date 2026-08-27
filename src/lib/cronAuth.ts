/**
 * The shared door for /api/cron/*.
 *
 * Every one of these routes had the check written inline as
 *
 *     if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
 *
 * which fails OPEN when the variable is unset: the template renders the literal
 * string "Bearer undefined", and any caller can send that header. What sits
 * behind these routes is not read-only - recurring raises invoices, dunning and
 * the digest and the outbox send mail to real customers, pm-generate writes
 * tasks - so the unset case has to mean "nobody", not "anybody who guesses".
 *
 * Failing closed costs nothing operationally. Vercel Cron sends this header
 * from CRON_SECRET, so with the variable set the behaviour is identical; with
 * it unset the platform sends no header at all and these routes were already
 * refusing every real cron request. The only caller the old form admitted was
 * one that typed the word "undefined".
 */
export function cronAuthorized(req: Request): boolean {
  const want = (process.env.CRON_SECRET ?? "").trim();
  if (!want) return false;
  return req.headers.get("authorization") === `Bearer ${want}`;
}
