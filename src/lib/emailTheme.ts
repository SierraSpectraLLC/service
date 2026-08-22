// The one place an email gets its looks. Every mail the platform sends -
// notifications, the sign-in code, the daily digest, the client report -
// renders through emailShell(), so they all read as letters from the same
// product: card on a grey ground, navy accent, one wordmark, one footer.
//
// Email HTML is its own dialect: no stylesheet survives every client, so
// everything is inline; layout is tables because Outlook still renders with
// Word; the button is a padded cell rather than a styled anchor so the whole
// shape is clickable and survives dark-mode inversion. Pure functions, no
// imports - callers bring the brand, this brings the discipline.

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The app's palette, restated for mail. Keep in step with globals, not fashionable. */
export const EMAIL = {
  ink: "#172A4A",
  /**
   * Body copy inside a row, one step lighter than the navy headings - the
   * app's --ink. Navy on every line reads as a page of titles.
   */
  body: "#1E293B",
  muted: "#64748B",
  faint: "#94A3B8",
  border: "#E2E8F0",
  hairline: "#EDF1F6",
  ground: "#F4F6F9",
  panel: "#F7F9FC",
  card: "#FFFFFF",
  link: "#1D6396",
  font: "Helvetica,Arial,sans-serif",
  mono: "Menlo,Consolas,monospace",
};

/**
 * The call to action. A table, not an anchor with display:block - Outlook
 * ignores padding on anchors, and a button that is secretly a 12px text link
 * is the kind of nice that only works in the client you tested in.
 */
export const btn = (href: string, label: string): string => `
  <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin-top:14px;"><tr>
    <td bgcolor="${EMAIL.ink}" style="border-radius:8px;">
      <a href="${esc(href)}" style="display:inline-block;padding:10px 20px;font-family:${EMAIL.font};font-size:13px;font-weight:bold;color:#FFFFFF;text-decoration:none;border-radius:8px;">${esc(label)}</a>
    </td>
  </tr></table>`;

/**
 * Quoted human text - a message body, a note, a reason. Escapes its input:
 * this is the box freeform prose goes in, and freeform prose is exactly what
 * must never be trusted as markup. pre-wrap keeps the writer's line breaks.
 */
export const quote = (text: string): string => `
  <div style="border-left:3px solid #C7D2E0;background:${EMAIL.panel};border-radius:0 8px 8px 0;padding:8px 12px;margin:10px 0;white-space:pre-wrap;color:#334155;">${esc(text)}</div>`;

/** A secondary line under the point of the mail - context, not the message. */
export const mutedLine = (html: string): string =>
  `<div style="margin-top:10px;font-size:13px;color:${EMAIL.muted};">${html}</div>`;

/** The sign-in code, big enough to read across the room off a phone. */
export const codePanel = (code: string): string => `
  <div style="background:${EMAIL.panel};border:1px solid ${EMAIL.border};border-radius:10px;padding:16px;text-align:center;margin:14px 0;">
    <span style="font-family:${EMAIL.mono};font-size:32px;letter-spacing:8px;font-weight:bold;color:${EMAIL.ink};">${esc(code)}</span>
  </div>`;

/**
 * The envelope: ground, card, accent bar, header, body, footer. `body` and
 * `footer` are trusted HTML from our own composers; everything that ever
 * carries user text (brand, tagline, preheader) is escaped here.
 *
 * The preheader is the line inbox list views show after the subject - without
 * one they show the first text they find, which for a table layout is
 * whatever cell wins. Hidden in the mail itself.
 */
export function emailShell(opts: {
  brand: string;
  logoUrl?: string;
  tagline?: string;
  preheader?: string;
  body: string;
  footer?: string;
  /** Card width. Notifications read best narrow; tabular reports need more. */
  width?: number;
}): string {
  const width = opts.width ?? 560;
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:${EMAIL.ground};">
  ${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(opts.preheader)}</div>` : ""}
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${EMAIL.ground}">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:${width}px;background:#FFFFFF;border:1px solid ${EMAIL.border};border-radius:12px;">
        <tr><td style="height:4px;font-size:0;line-height:0;border-radius:12px 12px 0 0;background:${EMAIL.ink};">&nbsp;</td></tr>
        <tr><td style="padding:18px 24px 14px;border-bottom:1px solid ${EMAIL.hairline};">
          ${opts.logoUrl ? `<img src="${esc(opts.logoUrl)}" alt="" style="height:30px;max-width:160px;object-fit:contain;display:block;margin-bottom:6px;" />` : ""}
          <div style="font-family:${EMAIL.font};font-weight:bold;font-size:13px;letter-spacing:1px;color:${EMAIL.ink};">${esc(opts.brand.toUpperCase())}</div>
          ${opts.tagline ? `<div style="font-family:${EMAIL.font};font-size:12px;color:${EMAIL.muted};margin-top:2px;">${esc(opts.tagline)}</div>` : ""}
        </td></tr>
        <tr><td style="padding:18px 24px 22px;font-family:${EMAIL.font};font-size:14px;line-height:1.6;color:${EMAIL.ink};">
          ${opts.body}
        </td></tr>
        ${opts.footer ? `<tr><td style="padding:12px 24px 16px;border-top:1px solid ${EMAIL.hairline};font-family:${EMAIL.font};font-size:11px;line-height:1.6;color:${EMAIL.faint};">
          ${opts.footer}
        </td></tr>` : ""}
      </table>
    </td></tr>
  </table>
</body></html>`;
}
