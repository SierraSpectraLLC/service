/**
 * Send an email via Resend. Shared by the daily digest and event notifications.
 *
 * `to` is a LIST on one message, not a message each: everybody sees who else
 * got it and a reply-all reaches all of them, which is what makes a digest a
 * conversation rather than five private copies of the same page. Anything that
 * must not show the other recipients has to be sent separately and knowingly.
 *
 * `headers` carries the threading pair when a caller wants consecutive sends
 * to land in one conversation - see lib/emailThread.
 */
export async function sendEmail(
  to: string[], subject: string, html: string,
  headers?: Record<string, string>,
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AUTH_RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM, to, subject, html,
      ...(headers && Object.keys(headers).length ? { headers } : {}),
    }),
  });
  if (!res.ok) throw new Error("Resend error: " + JSON.stringify(await res.json()));
}
