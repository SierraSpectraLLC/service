import Link from "next/link";
import { PublicShell } from "@/components/ui";

/**
 * What the apex says to somebody with no account.
 *
 * The root path is two pages wearing one address: signed in it is the board,
 * signed out it is this. That split is why it lives in a component rather
 * than a route of its own - moving the dashboard off "/" would have meant
 * rewriting 42 redirect("/") calls, every one of which means "you do not
 * belong on that page, go home", and home is still the board for a session.
 *
 * TWO AUDIENCES, and the page says so rather than blurring them. A lab with
 * a dead LC wants somebody to fix it; a service company wants the system the
 * fixing runs on. Writing one page that gestures at both would have served
 * neither, so the fold splits and each side gets its own door.
 *
 * The platform/operator distinction the README insists on is load-bearing
 * here: `brandName` is the PRODUCT and `operatorName` is the company that
 * does the service work. Naming the operator on the service side is what
 * keeps the page honest - the software does not repair anything.
 *
 * The library leads the lead-gen because it is the only part of this that a
 * stranger can use before talking to anyone, and it is the only part search
 * engines can see. Someone looking up a part number for the pump in front of
 * them is a better first contact than someone reading a pitch.
 */
export default function Landing({ brandName, operatorName, catalogOn, contactEmail }: {
  /** The platform: the product being sold to other service companies. */
  brandName: string;
  /** The service company running this instance, who actually does the work. */
  operatorName: string;
  catalogOn: boolean;
  /** Where a service enquiry goes. Blank hides the button rather than mailing nowhere. */
  contactEmail: string;
}) {
  const sameName = operatorName.trim().toLowerCase() === brandName.trim().toLowerCase();
  return (
    <PublicShell brandName={brandName} width={760}
      title="Every instrument, accounted for"
      sub="One record per machine - its modules, its serials, the work done on it and the parts that went in - shared with the people who own it. Built on the bench, not in a boardroom.">

      {/* The two doors. Side by side at desk width, stacked on a phone: the
          choice is the page's whole job, so it sits above everything else. */}
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column" }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>For laboratories</div>
          <div className="t-lead" style={{ fontWeight: 700, color: "var(--navy)", marginBottom: 6 }}>
            Get an instrument fixed
          </div>
          <div className="mut t-small" style={{ lineHeight: 1.65, flex: 1 }}>
            LC, GC, MS, TOC and the modules around them - repair, refurbishment,
            preventive maintenance and parts{sameName ? "" : `, from ${operatorName}`}.
            You get a portal with your systems in it: what is happening to each one,
            what it costs, and every report and invoice in one place.
          </div>
          {contactEmail && (
            <div style={{ marginTop: 12 }}>
              <a className="btn sm accent" style={{ textDecoration: "none" }}
                href={`mailto:${contactEmail}?subject=${encodeURIComponent("Instrument service inquiry")}`}>
                Talk to us about a system
              </a>
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column" }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>For service companies</div>
          <div className="t-lead" style={{ fontWeight: 700, color: "var(--navy)", marginBottom: 6 }}>
            Run your shop on {brandName}
          </div>
          <div className="mut t-small" style={{ lineHeight: 1.65, flex: 1 }}>
            The system this shop runs on, for yours. Work orders, PM schedules,
            parts sourcing and purchase orders, quotes and invoices, and a client
            portal that shows your customers the same record your bench works
            from - under your name and your logo, not ours.
          </div>
          {contactEmail && (
            <div style={{ marginTop: 12 }}>
              <a className="btn sm primary" style={{ textDecoration: "none" }}
                href={`mailto:${contactEmail}?subject=${encodeURIComponent(`${brandName} for our service business`)}`}>
                See it on your own work
              </a>
            </div>
          )}
        </div>
      </div>

      {/* The shared exhibit. It proves the claim above for a lab (we know this
          equipment) and for an operator (this is what the catalog gives you),
          and it is the one surface a crawler can read. */}
      {catalogOn && (
        <div className="card" style={{ padding: 18, marginTop: 12 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Open to everyone, no account</div>
          <div className="t-lead" style={{ fontWeight: 700, color: "var(--navy)", marginBottom: 6 }}>
            The equipment library
          </div>
          <div className="mut t-small" style={{ lineHeight: 1.65, marginBottom: 12 }}>
            Specifications, part numbers, PM kit contents and maintenance intervals,
            recorded from service work rather than copied off a datasheet. Look up the
            module in front of you and see what it takes to keep it running.
          </div>
          <Link className="btn sm" href="/equipment" style={{ textDecoration: "none" }}>
            Browse the library
          </Link>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
        <Link className="btn sm" href="/login" style={{ textDecoration: "none" }}>Sign in</Link>
        <span className="mut t-small">Already working with us? Your portal is here.</span>
      </div>
    </PublicShell>
  );
}
