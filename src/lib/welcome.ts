// The first minute of somebody's first sign-in.
//
// Before this, a new person's first sight of the portal was a dashboard that
// called them by the front of their email address, emailed them about everything
// by default, and gave them no way in if mail ever stopped arriving. Every one of
// those was fixable on some other page they had no reason to visit.
//
// So a login with no `onboarded_at` is sent to /welcome once: their name, what
// they want to be told about, and a password if they want one. It is asked once
// and never again - the stamp is a timestamp, so "when did they join" is
// answerable, and clearing it is how somebody is asked to look again.

/** Where a request should go, or "" to let it through. */
export type Diversion = string;

/**
 * Paths that must work for somebody who has not finished setting up.
 *
 * The welcome page itself, obviously. Signing out, because being unable to leave
 * a form is a trap. And the authorized file proxy, because the page they were
 * sent from may be rendering a logo or an avatar and a redirected image is a
 * broken image, not a redirect anybody sees.
 */
const OPEN = ["/welcome", "/login"];

/**
 * Does this request get diverted to the welcome step?
 *
 * Deliberately not a middleware rule: middleware runs at the edge and cannot ask
 * the database whether this person has been through it. This is the decision
 * itself, kept pure so both halves - "who needs it" and "which paths are exempt"
 * - can be tested without a browser.
 */
export function welcomeRedirect(
  signedIn: boolean,
  onboardedAt: Date | null,
  pathname: string,
): Diversion {
  if (!signedIn || onboardedAt !== null) return "";
  if (pathname.startsWith("/api/")) return "";
  // Exact, or a real child. "/welcomers" is not "/welcome", and a bare prefix
  // test that thought it was would be a hole in the only gate this has.
  if (OPEN.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return "";
  return "/welcome";
}

/** Where somebody lands after signing in: the form, or the work. */
export const landingFor = (onboardedAt: Date | null): string =>
  (onboardedAt === null ? "/welcome" : "/");
