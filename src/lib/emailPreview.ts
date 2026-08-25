/**
 * Previewing an email means looking at the email.
 *
 * The old previews re-rendered the content in the app's own web styles, which
 * answered a question nobody asked: they showed what the data says, not what
 * the mail client will do with it. A digest that wraps badly on a phone, a
 * table that Outlook widens, a preheader that leaks into the body - none of
 * that is visible in a page that never renders the actual HTML.
 *
 * So: the exact bytes, in an iframe, at the two widths that matter. 600px is
 * the card's own width (a desktop client, a webmail reading pane); 320px is
 * the narrowest phone still in use, where a fixed-width table would force a
 * horizontal scroll and give the game away.
 */
import { esc } from "@/lib/emailTheme";

/** Desktop card width, then the narrowest phone worth surviving. */
export const PREVIEW_WIDTHS = [600, 320] as const;

/**
 * A standalone preview page: what would be sent, to whom, and the mail itself
 * rendered twice. Used by the digest preview route, which has no React shell
 * to sit inside.
 */
export function previewPage(opts: {
  subject: string;
  to: string[];
  html: string;
  /** One line of context: which edition this is, and whether it would send. */
  note: string;
}): string {
  const frames = PREVIEW_WIDTHS.map((w) => `
    <div style="flex:0 0 auto;">
      <div style="font:12px/1.4 Helvetica,Arial,sans-serif;color:#64748B;margin:0 0 6px;">${w}px</div>
      <iframe title="Email at ${w}px" srcdoc="${esc(opts.html)}" sandbox
        style="width:${w}px;max-width:100%;height:1400px;border:1px solid #E2E8F0;border-radius:8px;background:#fff;"></iframe>
    </div>`).join("");
  const recipients = opts.to.length ? opts.to.join(", ") : "nobody - no recipients configured";
  return `<!doctype html>
<html lang="en-US"><head><meta charset="utf-8"><title>Email preview</title></head>
<body style="margin:0;background:#F4F6F9;font-family:Helvetica,Arial,sans-serif;">
  <div style="background:#172A4A;color:#FFFFFF;font-size:12px;line-height:1.6;padding:10px 16px;">
    Preview - nothing has been sent. ${esc(opts.note)}<br/>
    <b>Subject:</b> ${esc(opts.subject)}<br/>
    <b>To:</b> ${esc(recipients)}
  </div>
  <div style="display:flex;gap:24px;padding:20px 16px;align-items:flex-start;overflow-x:auto;">${frames}</div>
</body></html>`;
}
