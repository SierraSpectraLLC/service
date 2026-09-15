/**
 * Where to go after signing in, when somebody arrived with somewhere to be.
 *
 * Only a path on this site: an absolute URL or a protocol-relative one would
 * make the sign-in page an open redirect, and the one caller that sets this -
 * the Stripe Connect callback, whose session may have lapsed while the owner
 * was on Stripe's site - only ever needs a path.
 */
export const safeNext = (next: string | undefined): string =>
  next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "";
