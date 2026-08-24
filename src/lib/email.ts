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
 *
 * `opts.text` makes the message multipart/alternative: the same content as
 * plain text, for clients that refuse HTML, for a screen reader in text mode,
 * and for the spam scorers that treat an HTML-only mail as a smell. Generated
 * from the same data as the HTML by the composer, never hand-kept.
 */
export async function sendEmail(
  to: string[], subject: string, html: string,
  opts: { headers?: Record<string, string>; from?: string; replyTo?: string; text?: string } = {},
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
      ...(opts.text?.trim() ? { text: opts.text } : {}),
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
 * Where replies land, when the sending address is not somewhere anybody reads.
 *
 * This matters more than it looks, because of how the sending domain is set
 * up. Mail goes out from a subdomain that exists to SEND - it carries its own
 * reputation, and the only MX Resend puts on it is a bounce collector. Nothing
 * delivers a human's reply there. So an address that is perfect as a From is
 * a dead letter box as a To, and "reply all" on a report that went to five
 * people at a client bounces for all five at once.
 *
 * Naming a real inbox here is what turns a broadcast back into a conversation,
 * which is the whole point of threading the editions together.
 *
 * Blank = replies go to the sender, which is right only when that address is
 * itself a mailbox somebody reads.
 *
 * DIGEST_REPLY_TO is the older name, kept because instances are already set
 * with it; it was scoped to the digest when the digest was the only broadcast
 * this app sent. The EOD report is the same kind of mail and wants the same
 * inbox, so the general name leads.
 */
export const replyToAddress = (): string | undefined =>
  process.env.REPLY_TO?.trim() || process.env.DIGEST_REPLY_TO?.trim() || undefined;

/** @deprecated Use replyToAddress - one concept, one function. */
export const digestReplyTo = replyToAddress;
