"use client";

import { PREVIEW_WIDTHS } from "@/lib/emailPreview";

/**
 * The real email, in an iframe, at the widths that decide whether it works:
 * the 600px card and a 320px phone. Not a restatement of the content in web
 * styles - the bytes that get sent, so what you approve is what they open.
 */
export default function EmailPreview({ subject, html, to }: {
  subject: string;
  html: string;
  /** Who it would go to. Empty renders as the warning it is. */
  to?: string[];
}) {
  return (
    <div>
      <div className="t-small" style={{ marginBottom: 2 }}><b>Subject:</b> {subject}</div>
      <div className="mut t-meta" style={{ marginBottom: 8 }}>
        <b>To:</b> {to?.length ? to.join(", ") : "nobody - no recipients configured"}
      </div>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", overflowX: "auto" }}>
        {PREVIEW_WIDTHS.map((w) => (
          <div key={w} style={{ flex: "0 0 auto" }}>
            <div className="mut t-meta" style={{ marginBottom: 4 }}>{w}px</div>
            <iframe title={`Email at ${w}px`} srcDoc={html} sandbox=""
              style={{ width: w, maxWidth: "100%", height: 900, border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }} />
          </div>
        ))}
      </div>
    </div>
  );
}
