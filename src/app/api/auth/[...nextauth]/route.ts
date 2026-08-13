import { NextResponse, type NextRequest } from "next/server";
import { handlers } from "@/auth";
import { checkTryAllowed, clearAttempts, recordFailure } from "@/lib/loginGate";

/**
 * Auth.js's own routes, with a throttle in front of the one that takes a code.
 *
 * The credential in the sign-in email is six digits now, so somebody can read it
 * on their phone and type it at an instrument. Six digits is a million
 * combinations, which is a real credential only if guessing is expensive - and
 * Auth.js does not count wrong guesses. This does, at the only place that can:
 * in front of the callback, where every guess has to arrive whether it came from
 * our form, from the link, or from a script.
 *
 * The counters and the arithmetic live in lib/loginCode; this is the doorway.
 */
const isCodeCallback = (url: URL) =>
  url.pathname.endsWith("/callback/resend") && url.searchParams.has("token");

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  if (!isCodeCallback(url)) return handlers.GET(req);

  const email = (url.searchParams.get("email") ?? "").toLowerCase();
  const gate = await checkTryAllowed(email);
  if (!gate.allow) {
    return NextResponse.redirect(new URL(
      `/login?locked=${gate.retryAfterMinutes}`, url.origin,
    ));
  }

  const res = await handlers.GET(req);
  // Auth.js answers a bad or expired token with a redirect to its error page.
  // That redirect is the only signal it gives, so it is what a wrong guess is
  // counted from - and a right one clears the slate.
  const location = res.headers.get("location") ?? "";
  const refused = res.status >= 300 && res.status < 400 && /error=/i.test(location);
  if (refused && email) {
    const { locked } = await recordFailure(email);
    if (locked) {
      return NextResponse.redirect(new URL("/login?locked=15", url.origin));
    }
  } else if (!refused && email) {
    await clearAttempts(email);
  }
  return res;
}

export const POST = handlers.POST;
