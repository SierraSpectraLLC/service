import Link from "next/link";
import { readableTextOn, tint } from "@/lib/theme";
import type { LandingLibrary } from "@/lib/landingData";

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
 *
 * WHY THIS IS NOT PublicShell. Every other page a stranger meets - a share
 * link, a file drop, a sale listing - is a document handed to one person who
 * already has the URL, and PublicShell's narrow column is right for those.
 * This page is the only one that has to persuade somebody who arrived by
 * accident, and it inherited a 19px heading in a 760px column because it was
 * borrowing that frame. It draws its own bands instead, at its own scale
 * (see the `.lp` block in globals.css); nothing here can resize the app.
 */
export default function Landing({
  brandName, operatorName, tagline, catalogOn, contactEmail, headerColor, library,
}: {
  /** The platform: the product being sold to other service companies. */
  brandName: string;
  /** The service company running this instance, who actually does the work. */
  operatorName: string;
  /** The platform's own one-liner, for the footer. */
  tagline: string;
  catalogOn: boolean;
  /** Where a service enquiry goes. Blank falls back to the library and sign-in. */
  contactEmail: string;
  /** The instance's header colour, so the hero continues it instead of fighting it. */
  headerColor: string;
  /** Counts and models from the PUBLISHED catalog only. See lib/landingData. */
  library: LandingLibrary;
}) {
  const sameName = operatorName.trim().toLowerCase() === brandName.trim().toLowerCase();
  // The service side is the operator's, and it must read as theirs. With no
  // operator org set, brand.operatorName already falls back to the platform
  // name - saying "from Ridgeline" about repair work would be the false
  // statement about who did the work that lib/brand exists to prevent, so in
  // that case the sentence simply doesn't name anybody.
  const byOperator = sameName ? "" : ` from ${operatorName}`;

  // Same rule as the header: white on a dark theme, navy on a light one. An
  // operator can paint the header any hex, and a hero that assumed navy would
  // be white-on-pale for anybody who picked one.
  const heroFg = readableTextOn(headerColor);
  const heroBg = `linear-gradient(168deg, ${headerColor} 0%, ${tint(headerColor, heroFg === "#FFFFFF" ? 0.1 : 0.34)} 100%)`;

  // Only the library is open without an account, so it is the only honest
  // "start here" when no enquiry address is configured. contactEmail blank is
  // a supported state (lib/brand: "blank means do not offer the door at all"),
  // and the old page answered it by rendering a hero with no call to action.
  const mail = (subject: string) =>
    `mailto:${contactEmail}?subject=${encodeURIComponent(subject)}`;
  const showLibrary = catalogOn && library.models > 0;

  return (
    <div className="lp">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="lp-hero" style={{ background: heroBg, color: heroFg }}>
        <div className="container lp-hero-grid">
          <div>
          <p className="lp-eyebrow">{brandName}</p>
          <h1>Every instrument, accounted for</h1>
          <p className="lp-lead">
            One record per machine - its modules, its serials, the work done on it
            and the parts that went in - shared with the people who own it.
            Built on the bench, not in a boardroom.
          </p>

          <div className="lp-hero-acts">
            {showLibrary && (
              <Link className="lp-btn accent" href="/equipment">Browse the equipment library</Link>
            )}
            <Link className={`lp-btn ${showLibrary ? "ghost" : "accent"}`} href="/login">
              Sign in to your portal
            </Link>
          </div>
          {showLibrary && (
            <p className="lp-hero-note">Open to everyone - no account, no sales call.</p>
          )}

          {/* Figures, not adjectives - and only figures that are already public
              anyway, one crawlable page per model counted. See lib/landingData
              for why nothing else on the instance may be totted up here. */}
          {showLibrary && (
            <div className="lp-figures">
              <div>
                <div className="lp-fig-n">{library.models}</div>
                <div className="lp-fig-l">Models documented</div>
              </div>
              {library.makers.length > 0 && (
                <div>
                  <div className="lp-fig-n">{library.makers.length}</div>
                  <div className="lp-fig-l">Manufacturers</div>
                </div>
              )}
              {/* Two figures, not three. A "$0" tile sat here reading "no
                  account needed", which is a claim wearing a number's
                  clothes - and the third tile was the one that wrapped the
                  strip onto a second line at every width under 1100. The
                  claim itself is true and stays, one line down, in words. */}
            </div>
          )}
          </div>

          <RecordExhibit operatorName={operatorName} />
        </div>
      </section>

      {/* ── The two doors ────────────────────────────────────────────────────
          Above everything else because choosing between them is the page's
          whole job. Points rather than paragraphs: the old cards said the same
          things in prose, and prose on a landing page is read by nobody. */}
      <section className="lp-band-tint">
        <div className="container">
          <div className="lp-doors">
            <div className="lp-door lab">
              <p className="lp-eyebrow">For laboratories</p>
              <h2>Get an instrument fixed</h2>
              <p>
                LC, GC, MS, TOC and the modules around them{byOperator} - repair,
                refurbishment, preventive maintenance and parts.
              </p>
              <ul className="lp-points">
                <li>A portal with your systems in it, and what is happening to each one</li>
                <li>Every service report, quote and invoice in one place, not in a thread</li>
                <li>PM schedules that come due on their own instead of when someone remembers</li>
              </ul>
              {contactEmail
                ? <a className="lp-btn accent" href={mail("Instrument service inquiry")}>
                    Talk to us about a system
                  </a>
                : <Link className="lp-btn accent" href="/login">Sign in to your portal</Link>}
            </div>

            <div className="lp-door shop">
              <p className="lp-eyebrow">For service companies</p>
              <h2>Run your shop on {brandName}</h2>
              <p>
                The system this shop runs on, for yours - under your name and your
                logo, not ours.
              </p>
              <ul className="lp-points">
                <li>Work orders, PM schedules, parts sourcing and purchase orders</li>
                <li>Quotes, invoices, expenses and payroll against the job they came from</li>
                <li>A client portal showing your customers the record your bench works from</li>
              </ul>
              {contactEmail
                ? <a className="lp-btn primary" href={mail(`${brandName} for our service business`)}>
                    See it on your own work
                  </a>
                : <Link className="lp-btn primary" href="/login">Sign in</Link>}
            </div>
          </div>
        </div>
      </section>

      {/* ── The exhibit ──────────────────────────────────────────────────────
          It proves the claim above for a lab (we know this equipment) and for
          an operator (this is what the catalog gives you), and it is the one
          surface a crawler can read. The chips are real published models, so
          they are also the internal links that give each model page a way in
          from the highest-authority page on the site. */}
      {showLibrary && (
        <section className="lp-band-white">
          {/* Three children, and the third is only the button. On a desk it
              sits under the copy in the left column, where the eye lands after
              reading it. Stacked on a phone that same DOM order put "browse
              all 3 models" ABOVE the three models - offering the index before
              showing anybody what was in it. Ordered, a phone reads copy, then
              examples, then the way in. See `.lp-split`. */}
          <div className="container lp-split">
            <div className="lp-split-head">
              <div className="lp-head">
                <p className="lp-eyebrow mut">Open to everyone, no account</p>
                <h2>The equipment library</h2>
                <p>
                  Specifications, part numbers, PM kit contents and maintenance
                  intervals, recorded from service work rather than copied off a
                  datasheet. Look up the module in front of you and see what it
                  takes to keep it running.
                </p>
              </div>
            </div>

            <div className="lp-split-list">
              {library.featured.length > 0 && (
                <div className="lp-chips">
                  {library.featured.map((m) => (
                    <Link key={m.slug} className="lp-chip" href={`/equipment/${m.slug}`}>
                      {m.manufacturer && <span className="mk">{m.manufacturer}</span>}
                      <span>{m.name}</span>
                      {/* What kind of module it is, pushed right by `.kind`.
                          Without it the column is three names with no way to
                          tell a pump from a mass spec at a glance. */}
                      {m.assetType && <span className="kind">{m.assetType}</span>}
                    </Link>
                  ))}
                </div>
              )}

              {/* Every published model carries a manufacturer or it carries
                  nothing; naming them is what tells a technician in ten seconds
                  whether their bench is covered. Only worth printing when it
                  says something the chips above have not already said. */}
              {library.makers.length > library.featured.length && (
                <p className="lp-makers">{library.makers.join(" · ")}</p>
              )}
            </div>

            <div className="lp-split-act">
              <Link className="lp-btn plain" href="/equipment">
                Browse all {library.models} models
              </Link>
            </div>
          </div>
        </section>
      )}

      {/* ── What the system holds ────────────────────────────────────────────
          Named modules, every one of which is a route in this app. The old
          page asserted "work orders, PM schedules, parts sourcing" in a single
          run-on sentence inside a card; a reader deciding whether to spend
          twenty minutes on a demo needs to see the shape of it. */}
      <section className={showLibrary ? "lp-band-tint" : "lp-band-white"}>
        <div className="container">
          <div className="lp-head">
            <p className="lp-eyebrow mut">One record, end to end</p>
            <h2>Everything a machine accumulates</h2>
            <p>
              A system arrives, gets worked on, gets billed and goes home. Every
              step of that leaves something behind - and all of it hangs off the
              same record rather than four systems that disagree.
            </p>
          </div>
          <div className="lp-grid">
            <div className="lp-cell">
              <h3>Work orders and PM</h3>
              <p>
                Multi-stage tags, checklists, threaded notes and assignment. Preventive
                maintenance comes due on a schedule per model, not per memory.
              </p>
            </div>
            <div className="lp-cell">
              <h3>Parts and purchasing</h3>
              <p>
                A part catalog with the numbers that actually fit, purchase orders with
                carrier tracking, and stockroom shelves that know when to reorder.
              </p>
            </div>
            <div className="lp-cell">
              <h3>Quotes, invoices and cost</h3>
              <p>
                Quote a job, bill it, and see what it cost to do - labor, parts, travel
                and expenses landing against the work order they came from.
              </p>
            </div>
            <div className="lp-cell">
              <h3>Documents that sign</h3>
              <p>
                Service reports, sign-off packets and QR labels, carrying the operator&apos;s
                name and logo - never the platform&apos;s.
              </p>
            </div>
            <div className="lp-cell">
              <h3>The client&apos;s own view</h3>
              <p>
                Customers read the same record the bench works from, scoped to their
                systems, with an append-only audit log behind every line of it.
              </p>
            </div>
            <div className="lp-cell">
              <h3>Regulated work</h3>
              <p>
                Systems marked GxP carry a validation package, dated paper that nags
                before it expires, and coverage that knows what an agreement owes.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────────
          The root layout's footer prints a build sha, which is for us. This one
          is for the reader. */}
      <footer className="lp-foot">
        <div className="container">
          <div className="lp-foot-row">
            <div>
              <div className="lp-foot-name">{brandName.toUpperCase()}</div>
              <p className="lp-foot-note">
                {tagline}
                {sameName ? "" : ` · Operated by ${operatorName}.`}
              </p>
            </div>
            <div className="lp-foot-links">
              {showLibrary && <Link href="/equipment">Equipment library</Link>}
              <Link href="/login">Sign in</Link>
              {contactEmail && <a href={mail("Hello")}>Contact</a>}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * One record, drawn.
 *
 * The page claims four times over that everything about a machine hangs off a
 * single record. This is the only part of that claim a reader takes in without
 * reading, and it is what stops the hero being copy on the left and nothing on
 * the right at desk width.
 *
 * Drawn rather than screenshotted, and the reasons are in the `.lp-exhibit`
 * block in globals.css. The one that matters here: NOTHING in it may name a
 * client. Which customer owns what is the single fact a service company can
 * never publish (lib/publicCatalog), and an invented name on the front page is
 * worse than a real one, because no reader can tell which it was. The queue
 * badge names the OPERATOR, who is already named twice above it.
 *
 * The stage names are the real ones from lib/stages, and the pills and dots
 * are the app's own - if the vocabulary ever changes, this should read wrong
 * to whoever changes it.
 */
function RecordExhibit({ operatorName }: { operatorName: string }) {
  return (
    <div className="lp-exhibit" role="img"
      aria-label="Illustration of one instrument record: an LC-MS system in checkout, with its stage, an open work order, a preventive-maintenance date and a part on order.">
      <div className="lp-ex-head">
        <div className="lp-ex-top">
          <span className="lp-ex-kind">LC-MS system</span>
          <span className="pill info">Checkout</span>
        </div>
        <div className="lp-ex-name">Triple quad + binary pump</div>
        <div className="lp-ex-sn">SN 000-0000 · 4 modules</div>
      </div>

      <div className="lp-ex-rows">
        <div className="lp-ex-row">
          <span className="dot good" />
          <span>Source cleaned, tune passed</span>
          <span className="who">{operatorName}</span>
        </div>
        <div className="lp-ex-row">
          <span className="dot warn" />
          <span>PM due in 12 days</span>
          <span className="who">Quarterly</span>
        </div>
        <div className="lp-ex-row">
          <span className="dot info" />
          <span>Detector board on order</span>
          <span className="who">Tracking</span>
        </div>
      </div>

      <div className="lp-ex-foot">
        <span>3 visits this year</span>
        <span aria-hidden="true">·</span>
        <span>Sign-off packet ready</span>
      </div>
    </div>
  );
}
