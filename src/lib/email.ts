/**
 * Send an email via Resend. Shared by the daily digest and event notifications.
 *
 * `to` is a LIST on one message, not a message each: everybody sees who else
 * got it and a reply-all reaches all of them, which is what makes a digest a
 * conversation rather than five private copies of the same page. Anything that
 * must not show the other recipients has to be sent separately and knowingly.
 *
 * `opts.headers` carries the threading pair when a caller wants consecutive
 * sends to land in one conversation - see lib/emailThread. `opts.from`
 * overrides the sending address for one KIND of mail; `opts.replyTo` says
 * where answers should go when that is not the address it was sent from.
 */
export async function sendEmail(
  to: string[], subject: string, html: string,
  opts: { headers?: Record<string, string>; from?: string; replyTo?: string } = {},
): Promise<void> {
  const headers = opts.headers;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AUTH_RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: opts.from?.trim() || process.env.EMAIL_FROM, to, subject, html,
      ...(opts.replyTo?.trim() ? { reply_to: opts.replyTo.trim() } : {}),
      ...(headers && Object.keys(headers).length ? { headers } : {}),
    }),
  });
  if (!res.ok) throw new Error("Resend error: " + JSON.stringify(await res.json()));
}

/**
 * Who the daily digest comes from.
 *
 * A separate address for a separate KIND of mail: sign-in links and a morning
 * report have nothing to do with each other, and giving the digest its own
 * sender lets recipients filter it, lets a subdomain carry its own sending
 * reputation, and stops a bounce on one from tarring the other. It has to be
 * an address on a domain verified in Resend - a subdomain is verified in its
 * own right - which is why it is environment rather than a setting somebody
 * could type into the app and silently break delivery with.
 *
 * Unset falls back to EMAIL_FROM, which is exactly how every instance behaved
 * before this existed.
 */
export const digestFrom = (): string | undefined =>
  process.env.DIGEST_EMAIL_FROM?.trim() || process.env.EMAIL_FROM;

/**
 * Where replies to the digest should land, when the sending address is not
 * somewhere anybody reads. Blank = replies go to the sender, which is right
 * only if that inbox is real - a digest whose replies bounce is a broadcast,
 * not the conversation the threading is there to keep.
 */
export const digestReplyTo = (): string | undefined =>
  process.env.DIGEST_REPLY_TO?.trim() || undefined;
