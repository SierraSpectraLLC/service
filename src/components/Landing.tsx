import Link from "next/link";
import { PublicShell } from "@/components/ui";

/**
 * What the apex says to somebody with no account.
 *
 * The root path is two pages wearing one address: signed in it is the board,
 * signed out it is this. That split is why it lives in a component rather
 * than a route of its own - moving the dashboard off "/" would have meant
 * rewriting 42 redirect("/") calls, every one of which means "you do not
 * belong on that page, go home", and home is still the board for anyone with
 * a session.
 *
 * The library is the lead: a stranger who lands here is far likelier to want
 * a part number for the pump in front of them than a sales conversation, and
 * the pages that answer that are the ones search engines can see.
 */
export default function Landing({ brandName, tagline, catalogOn }: {
  brandName: string;
  tagline: string;
  catalogOn: boolean;
}) {
  return (
    <PublicShell brandName={brandName} tagline={tagline} width={720}
      title={`${brandName} keeps a lab's instruments accounted for`}
      sub="Every system, every module, every part that went into it - one record per machine, from intake to sign-off, shared with the people who own it.">
      <div className="card" style={{ padding: 18 }}>
        <div style={{ display: "grid", gap: 14 }}>
          {[
            ["One record per system", "Modules, serials, stages, the work done on each and the parts it took. Not a spreadsheet row - a history."],
            ["Your client sees the same page you do", "Reports, quotes, invoices and parts orders come off the same records the bench works from, so there is one version of what happened."],
            ["Parts, sourced and tracked", "What fits the machine, what it costs, who can get it soonest, and where the box is."],
          ].map(([h, p]) => (
            <div key={h}>
              <div className="t-body" style={{ fontWeight: 700, color: "var(--navy)" }}>{h}</div>
              <div className="mut t-small" style={{ lineHeight: 1.6 }}>{p}</div>
            </div>
          ))}
        </div>
      </div>

      {catalogOn && (
        <div className="card" style={{ padding: 18, marginTop: 12 }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Open to everyone</div>
          <div className="t-body" style={{ fontWeight: 700, color: "var(--navy)", marginBottom: 4 }}>
            The equipment library
          </div>
          <div className="mut t-small" style={{ lineHeight: 1.6, marginBottom: 10 }}>
            Specifications, part numbers, PM kit contents and maintenance intervals,
            recorded from service work rather than copied off a datasheet. No account needed.
          </div>
          <Link className="btn sm primary" href="/equipment" style={{ textDecoration: "none" }}>
            Browse the library
          </Link>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
        <Link className="btn sm accent" href="/login" style={{ textDecoration: "none" }}>Sign in</Link>
        <span className="mut t-small">Already working with us? Your portal is here.</span>
      </div>
    </PublicShell>
  );
}
