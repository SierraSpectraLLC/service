import { ImageResponse } from "next/og";
import { getBrand } from "@/lib/brand";
import { getAppearance } from "@/lib/appearanceData";
import { readableTextOn, tint } from "@/lib/theme";

/**
 * The card this site unfurls as.
 *
 * The landing page gets shared by paste - into Slack, into an email, into a
 * message to the colleague who actually owns the instrument - far more often
 * than anybody types the domain. Without this the paste renders as a bare
 * link with a title, which is the difference between a link that gets clicked
 * and one that scrolls past.
 *
 * Drawn per instance rather than committed as a PNG, for the same reason
 * nothing else in this app hardcodes a company: the name is in app_settings
 * and the colour is the operator's own pick (Settings > Configuration >
 * Appearance). A checked-in image would say "Ridgeline" on somebody else's
 * workspace, which is exactly the false statement lib/brand exists to stop.
 *
 * It sits in the (dashboard) group so it attaches to "/" and to nothing else
 * - route groups do not change the URL, and every other route on this
 * instance is behind a sign-in and has no business advertising a card.
 */
export const runtime = "nodejs";
/**
 * Dynamic for the same reason the page it belongs to is: the name and the
 * colour on this card come out of app_settings, which the owner edits in
 * Settings without a deploy. Prerendered, the build baked in whatever the
 * database said at build time - and a build has no database, so every
 * instance shipped a card reading the fallback name in the stock navy, for
 * good, until somebody redeployed.
 */
export const dynamic = "force-dynamic";
export const alt = "Every instrument, accounted for";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  // Never throws: getBrand and getAppearance both swallow their own failures
  // and hand back the stock name and colour, so a settings row that has not
  // landed yet costs the card its branding rather than its existence.
  const [brand, look] = await Promise.all([getBrand(), getAppearance()]);
  const fg = readableTextOn(look.headerColor);
  const dim = fg === "#FFFFFF" ? "rgba(255,255,255,0.72)" : "rgba(23,42,74,0.66)";

  return new ImageResponse(
    (
      <div style={{
        width: "100%", height: "100%", display: "flex", flexDirection: "column",
        justifyContent: "space-between", padding: "76px 84px",
        background: `linear-gradient(150deg, ${look.headerColor} 0%, ${tint(look.headerColor, fg === "#FFFFFF" ? 0.12 : 0.36)} 100%)`,
        color: fg, fontFamily: "sans-serif",
      }}>
        <div style={{
          display: "flex", fontSize: 26, fontWeight: 700, letterSpacing: 4,
          textTransform: "uppercase", color: dim,
        }}>
          {brand.name}
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 82, fontWeight: 800, letterSpacing: -2, lineHeight: 1.05 }}>
            Every instrument,
          </div>
          <div style={{ display: "flex", fontSize: 82, fontWeight: 800, letterSpacing: -2, lineHeight: 1.05 }}>
            accounted for
          </div>
          <div style={{ display: "flex", fontSize: 31, marginTop: 26, color: dim, lineHeight: 1.4, maxWidth: 900 }}>
            One record per machine - the work done on it, the parts that went in,
            and the people who own it.
          </div>
        </div>

        {/* The spectrum strip the app header wears, so the card and the page it
            opens are recognisably the same thing. */}
        <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden" }}>
          {["#172A4A", "#2B5F8F", "#5BA8D9", "#1D9E75", "#E8613C"].map((c) => (
            <div key={c} style={{ display: "flex", flex: 1, background: c }} />
          ))}
        </div>
      </div>
    ),
    size,
  );
}
