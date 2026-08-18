import { describe, it, expect } from "vitest";
import { emailShell, btn, quote, codePanel, mutedLine, esc } from "@/lib/emailTheme";

describe("btn", () => {
  it("escapes both the href and the label", () => {
    const html = btn(`https://x.test/a?b=1&c="q"`, `Open <QQQ-6> & friends`);
    expect(html).toContain("https://x.test/a?b=1&amp;c=&quot;q&quot;");
    expect(html).toContain("Open &lt;QQQ-6&gt; &amp; friends");
    expect(html).not.toContain("<QQQ-6>");
  });

  it("is a table cell, not a styled anchor", () => {
    // Outlook drops padding on anchors; the cell carries the button shape.
    expect(btn("https://x.test", "Go")).toContain("<table");
  });
});

describe("quote", () => {
  it("escapes freeform prose", () => {
    expect(quote(`<script>alert(1)</script>`)).toContain("&lt;script&gt;");
  });

  it("keeps the writer's line breaks", () => {
    const html = quote("line one\nline two");
    expect(html).toContain("white-space:pre-wrap");
    expect(html).toContain("line one\nline two");
  });
});

describe("codePanel", () => {
  it("carries the code verbatim in monospace", () => {
    const html = codePanel("481 022");
    expect(html).toContain("481 022");
    expect(html).toContain("Menlo");
  });
});

describe("emailShell", () => {
  it("escapes brand, tagline and preheader", () => {
    const html = emailShell({ brand: `A&B "Labs"`, tagline: "<i>daily</i>", preheader: "1 < 2", body: "" });
    expect(html).toContain("A&amp;B &quot;LABS&quot;");
    expect(html).toContain("&lt;i&gt;daily&lt;/i&gt;");
    expect(html).toContain("1 &lt; 2");
  });

  it("uppercases the wordmark and passes the body through as HTML", () => {
    const html = emailShell({ brand: "Baseline", body: "<b>hello</b>" });
    expect(html).toContain("BASELINE");
    expect(html).toContain("<b>hello</b>");
  });

  it("hides the preheader and omits the div when there is none", () => {
    expect(emailShell({ brand: "B", preheader: "peek", body: "" })).toContain("display:none");
    expect(emailShell({ brand: "B", body: "" })).not.toContain("display:none");
  });

  it("shows the logo only when a URL is given", () => {
    expect(emailShell({ brand: "B", logoUrl: "https://x.test/l.png", body: "" })).toContain(`<img src="https://x.test/l.png"`);
    expect(emailShell({ brand: "B", body: "" })).not.toContain("<img");
  });

  it("honours the width option, defaulting narrow", () => {
    expect(emailShell({ brand: "B", body: "" })).toContain("max-width:560px");
    expect(emailShell({ brand: "B", body: "", width: 680 })).toContain("max-width:680px");
  });

  it("renders a footer row only when there is a footer", () => {
    expect(emailShell({ brand: "B", body: "", footer: "Sent by B." })).toContain("Sent by B.");
    expect(emailShell({ brand: "B", body: "" })).not.toContain("border-top");
  });

  it("mutedLine wraps trusted HTML without escaping it", () => {
    expect(mutedLine(`<a href="x">y</a>`)).toContain(`<a href="x">y</a>`);
  });

  it("esc handles all four specials", () => {
    expect(esc(`&<>"`)).toBe("&amp;&lt;&gt;&quot;");
  });
});
