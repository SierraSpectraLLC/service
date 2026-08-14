import type { Metadata } from "next";
import Link from "next/link";
import { getBrand } from "@/lib/brand";

// Public marketing / sales page. Reachable signed out (see src/middleware.ts);
// every screenshot lives in public/landing and shows a demo workspace, so
// nothing client-identifying is exposed. Swap the images for real bench shots
// by replacing the files - the page never needs to change.

export const dynamic = "force-dynamic";

/** Where "Request a walkthrough" goes. Change here, not in the copy below. */
const CONTACT_EMAIL = "joe.vincent96@gmail.com";

export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrand();
  return {
    title: `${brand.name} - Instrument service management`,
    description:
      "One system of record for instrument service and refurbishment: stages, tasks, maintenance, parts, sign-off packets, and a real client portal - with an append-only audit trail under all of it.",
  };
}

type Feature = {
  kicker: string;
  title: string;
  copy: string;
  bullets: string[];
  img: string;
  alt: string;
};

const FEATURES: Feature[] = [
  {
    kicker: "The system record",
    title: "The whole instrument on one page",
    copy: "Tasks with checklists and threaded notes, the modules it's built from, maintenance schedules, parts with tracking links, photos, files, logged hours, and a discussion thread with the client - one page, arranged the way each person likes it, with drag-and-drop panels saved per user.",
    bullets: [
      "Tasks with checklists, assignees, due dates, and per-item note threads",
      "Modules are first-class units with their own serials, history and photos",
      "A whose-move-is-it queue: park a system with the client and stop the clock",
      "Labour logged in minutes against the system or the exact module",
      "Every edit lands in the record's activity feed, automatically",
    ],
    img: "/landing/instrument.png",
    alt: "Instrument record with tasks, assets, hours, photos and discussion",
  },
  {
    kicker: "Preventive maintenance",
    title: "Maintenance that schedules itself",
    copy: "Write a procedure once against a model and it stamps schedules onto every matching unit. Schedules generate ordinary tasks the day they fall due and advance themselves when the work is completed. The shop-wide calendar shows overdue work in full and folds the future into months - an up-to-date shop reads as one line and a date.",
    bullets: [
      "Cadences from 1 day to 10 years, due dates in shop time",
      "Overdue first; everything else folded by month",
      "Completing the generated task moves the schedule - no double bookkeeping",
      "PM compliance (on-time vs late) reported on the metrics page",
    ],
    img: "/landing/maintenance.png",
    alt: "Maintenance calendar with overdue work and future months folded",
  },
  {
    kicker: "Inventory & purchasing",
    title: "Stockrooms, price book, and POs that close the loop",
    copy: "Real inventory behind the parts panel: shop shelves, client cages, and van kits, each with counts, floors and bins. The reorder list groups itself into the draft purchase orders it would become - one per vendor, priced from a book that keeps the OEM and every third-party offer side by side. Receiving a PO is what puts stock on the shelf, so the count and the paperwork can't disagree.",
    bullets: [
      "Issue-to-record, receive, and transfer moves with a full ledger",
      "Reorder points with shortages summarized per room",
      "Vendor price book with OEM flagged and the best offer ranked",
      "PO lifecycle: draft, sent, partial, received - with line-level receiving",
    ],
    img: "/landing/stock.png",
    alt: "Stockroom with bins, floors, shortages and a reorder list",
  },
  {
    kicker: "Release & sign-off",
    title: "A release packet that gates itself",
    copy: "The sign-off packet assembles the system's assets, completed work, test results, parts fitted and documents on file into a print-ready page - and it will not let anyone sign while required work is open or a mandatory test lacks evidence. Signatures freeze what was true at the moment of signing; revoking one keeps the revocation on the record.",
    bullets: [
      "Release gate computed from required procedures and filed evidence",
      "Frozen evidence snapshot - later edits never rewrite what was signed",
      "Client's signature line stays theirs to give",
      "Print / save as PDF, ready for the delivery folder",
    ],
    img: "/landing/signoff.png",
    alt: "Sign-off packet with a release gate blocking an unfinished task",
  },
  {
    kicker: "Client portal",
    title: "Clients see their fleet - and the daily report writes itself",
    copy: "Clients sign in to a real portal scoped to their own systems: read-only or editing, your choice per person, every edit audited. Updates written at the bench assemble into one end-of-day report per client - reviewed, trimmed, and sent in a minute, with every line linking back into the portal so replies become discussions instead of email chains.",
    bullets: [
      "Per-organization access with viewer and editor roles, enforced server-side",
      "End-of-day client report pre-filled from today's updates",
      "Discussion threads per system; internal posts stay internal",
      "Daily staff digest email: stages, gases and open parts, problems on top",
    ],
    img: "/landing/eod.png",
    alt: "End-of-day report builder grouped per client",
  },
  {
    kicker: "Metrics",
    title: "Numbers you can run the shop on",
    copy: "PM compliance, true turnaround, hours by person and client, parts spend, and time-in-stage per system. Turnaround knows when the ball wasn't in your court: days a system sat parked in someone else's queue are reported separately, so you're never charged for a client's three-week contractor delay.",
    bullets: [
      "30 and 90-day windows",
      "Turnaround net of client-parked time",
      "Hours and spend rolled up by client, person and vendor",
      "Report math is a pure, unit-tested library - not spreadsheet folklore",
    ],
    img: "/landing/metrics.png",
    alt: "Metrics page with PM compliance, turnaround, hours and time in stage",
  },
  {
    kicker: "Migration",
    title: "Keep the spreadsheet - until it proves itself obsolete",
    copy: "The bridge that gets a skeptical team to yes: the portal reads the existing Google Sheet every hour through a private service account and shows every disagreement side by side. Nothing is ever auto-applied - each diff is resolved 'keep ours' or 'accept sheet' by a human, until the day the sheet has nothing left to say.",
    bullets: [
      "Hourly parity check against the sheet, read-only, no publish-to-web",
      "Per-diff resolution with a full trail of who chose what",
      "CSV import with header mapping, dry run, and duplicate reconciliation",
      "CSV export of systems and the asset registry at any time",
    ],
    img: "/landing/parity.png",
    alt: "Sheet parity view with side-by-side diffs",
  },
  {
    kicker: "Photos & documents",
    title: "Evidence that stays evidence",
    copy: "Photos and files attach to systems, modules and tasks, and every read goes through an authorized proxy - raw storage URLs never reach a browser. The gallery shows everything an organization holds as photographs, each linked back to its record. Framing (rotate, zoom, nudge) is stored as numbers and applied on display: the original file is never altered, because cropping evidence to tidy a thumbnail is not a trade worth making.",
    bullets: [
      "One file, one row: a document on four records counts against storage once",
      "PDF studio: reorder pages, add a cover and headers, combine into one packet",
      "Import straight from OneDrive / SharePoint; files are copied, not linked",
      "Per-organization storage meters and quotas",
    ],
    img: "/landing/gallery.png",
    alt: "Photo gallery of instruments, each linked to its record",
  },
  {
    kicker: "Asset registry",
    title: "Every unit is somebody - even the spares",
    copy: "Pumps, autosamplers, detectors and mass specs are tracked units with their own serial, status, photos and merged service history. Spares live on the shelf without pretending to be systems; a unit's dossier follows it from system to system. A strict equipment catalog is the only place types and models are defined, so 'LC-20' spelled four ways can't happen.",
    bullets: [
      "Registry grouped by what each unit is, with photo-grid view",
      "Unit dossiers: lifecycle events, tasks, parts and hours in one timeline",
      "Spreadsheet-style bulk entry - paste rows from Excel, save once",
      "Printable QR labels that scan straight to the record",
    ],
    img: "/landing/assets.png",
    alt: "Asset registry grouped by unit type",
  },
];

const MORE: { t: string; d: string }[] = [
  { t: "Remote support, done right", d: "Browser-based remote access to lab PCs - per-person, consent-gated, revocable, and audited. No more passwords taped to monitors." },
  { t: "Serial-number lookup", d: "Exact-serial search across the platform: find a unit's identity anywhere, request access, or claim ownership - never browse someone else's inventory." },
  { t: "Multi-company tenancy", d: "Several service companies on one instance, each with its own branding, staff, clients and catalog - collaborating on shared instruments without seeing each other's business." },
  { t: "Cost redaction built in", d: "Part costs and PO numbers are visible to the operator and the paying client only. Other parties on a shared system see them blank." },
  { t: "Sign-in built for the bench", d: "Magic link, six-digit code you can read off a phone and type at an instrument, optional SMS, and a password fallback for the day email is down." },
  { t: "Notifications that respect you", d: "An inbox with per-kind email preferences, unread badges, and opt-in desktop notifications when the tab is hidden." },
  { t: "Resale listings", d: "Public, unguessable, redacted listing pages for systems you're selling - work history and opted-in reports, never clients, costs or people." },
  { t: "Frozen engagement records", d: "When a share ends or a system changes hands, the outgoing party keeps a read-only dossier of their tenure - immune to later edits." },
  { t: "Chain of custody", d: "Ownership history and handoffs on every system, with everyone else's access surviving the handoff by design." },
  { t: "White-label throughout", d: "Wordmark, tagline, sign-in copy, email headers, per-org theme colors and logos - all configurable without a deploy." },
  { t: "Search that spans the record", d: "Systems, units, tasks, parts, files, discussions and audit history from one box - scoped to exactly what you may see." },
  { t: "Excel service reports", d: "Generate service reports from your own Excel template - tokens are found by content, so anyone can restyle the workbook." },
];

const TRUST: { t: string; d: string }[] = [
  { t: "Append-only audit log", d: "Every mutation writes actor, field, old and new value. There is deliberately no code path that updates or deletes an audit row - if someone erases a note, the history has the old value. Destructive actions prompt for a typed reason." },
  { t: "Authorization on the server", d: "Every rule is enforced in server actions, not hidden in the UI. Tenant isolation - who can see what across organizations - lives in one module with dedicated tests." },
  { t: "Credentials sealed, not stored", d: "Cloud-storage tokens are AES-256-GCM sealed with a key that lives only in the environment. A copy of the database on its own opens nothing." },
  { t: "Honest compliance posture", d: "Sign-off signatures are audited approvals with frozen evidence - and the docs say plainly what they are and what a full 21 CFR Part 11 e-signature would add. No compliance theater." },
];

export default async function WelcomePage() {
  const brand = await getBrand();
  const B = brand.name;
  return (
    <div className="lp">
      <style
        // Scoped, self-contained styling for the marketing page only.
        dangerouslySetInnerHTML={{
          __html: `
.lp { --lpw: 1120px; line-height: 1.55; }
.lp section { padding: 56px 20px; }
.lp .in { max-width: var(--lpw); margin: 0 auto; }
.lp h1 { font-size: clamp(30px, 5vw, 46px); line-height: 1.12; letter-spacing: -0.8px; color: var(--navy); margin: 0 0 16px; }
.lp h2 { font-size: clamp(22px, 3vw, 30px); line-height: 1.2; letter-spacing: -0.4px; color: var(--navy); margin: 6px 0 12px; }
.lp .kicker { font-size: 12px; font-weight: 800; letter-spacing: 1.4px; text-transform: uppercase; color: var(--coral); }
.lp p.lead { font-size: clamp(15px, 2vw, 18px); color: var(--slate); max-width: 640px; margin: 0 auto 26px; }
.lp .hero { text-align: center; padding-top: 64px; padding-bottom: 28px; }
.lp .cta-row { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-bottom: 42px; }
.lp .cta, .lp .cta2 { display: inline-block; padding: 12px 22px; border-radius: 10px; font-weight: 700; font-size: 15px; text-decoration: none; }
.lp .cta { background: var(--navy); color: #fff; border: 1px solid var(--navy); }
.lp .cta2 { background: #fff; color: var(--navy); border: 1px solid var(--line); }
.lp .cta:hover { background: #21375c; }
.lp .frame { background: #fff; border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 24px 60px -24px rgba(23,42,74,.35); overflow: hidden; }
.lp .frame .bar { display: flex; gap: 6px; padding: 10px 14px; border-bottom: 1px solid var(--line); background: #F8FAFC; }
.lp .frame .bar i { width: 10px; height: 10px; border-radius: 50%; background: #E2E8F0; }
.lp .frame img { display: block; width: 100%; height: auto; }
.lp .strip { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: #fff; padding: 18px 20px; }
.lp .strip .in { display: flex; gap: 10px 28px; justify-content: center; flex-wrap: wrap; font-size: 13px; font-weight: 700; color: var(--slate); }
.lp .strip b { color: var(--navy); }
.lp .feat { display: grid; grid-template-columns: 5fr 7fr; gap: 44px; align-items: center; }
.lp .feat.flip .txt { order: 2; } .lp .feat.flip .shot { order: 1; }
.lp .feat ul { margin: 14px 0 0; padding: 0; list-style: none; }
.lp .feat li { padding: 5px 0 5px 26px; position: relative; font-size: 14px; color: var(--ink); }
.lp .feat li::before { content: ""; position: absolute; left: 2px; top: 11px; width: 14px; height: 8px; border-left: 2.5px solid var(--teal, #1D9E75); border-bottom: 2.5px solid #1D9E75; transform: rotate(-48deg); }
.lp .feat p { color: var(--slate); font-size: 15px; margin: 0; }
.lp section:nth-of-type(even) { background: #fff; }
.lp section.trust, .lp .lp-navy { background: var(--navy); }
.lp .mini { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.lp .mini figure { margin: 0; }
.lp .mini figcaption { font-size: 13px; color: var(--slate); padding-top: 10px; }
.lp .mini figcaption b { color: var(--navy); }
.lp .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.lp .cell { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px; }
.lp .cell h3 { margin: 0 0 6px; font-size: 15px; color: var(--navy); letter-spacing: -0.2px; }
.lp .cell p { margin: 0; font-size: 13.5px; color: var(--slate); }
.lp .trust { background: var(--navy); color: #E6EDF7; }
.lp .trust h2, .lp .trust .kicker { color: #fff; }
.lp .trust .kicker { color: #F0A48E; }
.lp .trust .cell { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.14); }
.lp .trust .cell h3 { color: #fff; }
.lp .trust .cell p { color: #B9C6DA; }
.lp .final { text-align: center; }
.lp .foot-note { font-size: 12px; color: var(--mut); text-align: center; padding: 0 20px 30px; }
@media (max-width: 900px) {
  .lp .feat { grid-template-columns: 1fr; gap: 22px; }
  .lp .feat.flip .txt { order: 1; } .lp .feat.flip .shot { order: 2; }
  .lp .mini, .lp .grid { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 600px) { .lp .mini, .lp .grid { grid-template-columns: 1fr; } .lp section { padding: 36px 16px; } }
`,
        }}
      />

      {/* ---------- hero ---------- */}
      <section className="hero">
        <div className="in">
          <div className="kicker">Instrument service management</div>
          <h1>
            Run your instrument service business
            <br />
            on one system of record
          </h1>
          <p className="lead">
            {B} tracks every system and every module through stages, tasks, maintenance,
            parts and sign-off - with a real client portal on top and an append-only audit
            trail underneath. The spreadsheet, the shared folder and the reply-all chain,
            retired in one move.
          </p>
          <div className="cta-row">
            <a className="cta" href={`mailto:${CONTACT_EMAIL}?subject=Walkthrough request`}>
              Request a walkthrough
            </a>
            <Link className="cta2" href="/login">
              Sign in
            </Link>
          </div>
          <div className="frame">
            <div className="bar"><i /><i /><i /></div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/landing/dashboard.png" alt="The shop board: every system, its stages, and whose move it is" />
          </div>
        </div>
      </section>

      <div className="strip">
        <div className="in">
          <span><b>Built for</b> LC/GC/MS service &amp; refurb shops</span>
          <span><b>Append-only</b> audit on every change</span>
          <span><b>Multi-company</b> tenancy &amp; client portal</span>
          <span><b>White-label</b> - your name on everything</span>
        </div>
      </div>

      {/* ---------- features ---------- */}
      {FEATURES.map((f, i) => (
        <section key={f.title}>
          <div className="in">
            <div className={`feat${i % 2 ? " flip" : ""}`}>
              <div className="txt">
                <div className="kicker">{f.kicker}</div>
                <h2>{f.title}</h2>
                <p>{f.copy}</p>
                <ul>
                  {f.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
              <div className="shot">
                <div className="frame">
                  <div className="bar"><i /><i /><i /></div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={f.img} alt={f.alt} loading="lazy" />
                </div>
              </div>
            </div>
          </div>
        </section>
      ))}

      {/* ---------- three-up ---------- */}
      <section>
        <div className="in">
          <div className="kicker">Around the shop</div>
          <h2>The small pages that save the day</h2>
          <div className="mini" style={{ marginTop: 20 }}>
            <figure>
              <div className="frame">
                <div className="bar"><i /><i /><i /></div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/purchasing.png" alt="Purchase order list" loading="lazy" />
              </div>
              <figcaption><b>Purchasing.</b> Draft to received, with receiving updating shelf counts.</figcaption>
            </figure>
            <figure>
              <div className="frame">
                <div className="bar"><i /><i /><i /></div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/discussions.png" alt="Discussion threads" loading="lazy" />
              </div>
              <figcaption><b>Discussions.</b> Conversation on the record, not in an inbox. Internal stays internal.</figcaption>
            </figure>
            <figure>
              <div className="frame">
                <div className="bar"><i /><i /><i /></div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/label.png" alt="Printable QR label" loading="lazy" />
              </div>
              <figcaption><b>QR labels.</b> Print, stick, scan - the bench and the record stay one thing.</figcaption>
            </figure>
            <figure>
              <div className="frame">
                <div className="bar"><i /><i /><i /></div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/search.png" alt="Cross-record search" loading="lazy" />
              </div>
              <figcaption><b>Search.</b> Systems, tasks, parts, files, discussions and audit history from one box.</figcaption>
            </figure>
            <figure>
              <div className="frame">
                <div className="bar"><i /><i /><i /></div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/inbox.png" alt="Notification inbox" loading="lazy" />
              </div>
              <figcaption><b>Inbox.</b> Mentions, assignments and client requests, with per-kind email preferences.</figcaption>
            </figure>
            <figure>
              <div className="frame">
                <div className="bar"><i /><i /><i /></div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/settings.png" alt="Settings and white-label configuration" loading="lazy" />
              </div>
              <figcaption><b>Settings.</b> Branding, modules, client access and stage vocabulary - no deploy needed.</figcaption>
            </figure>
          </div>
        </div>
      </section>

      {/* ---------- more grid ---------- */}
      <section>
        <div className="in">
          <div className="kicker">And more</div>
          <h2>Also in the box</h2>
          <div className="grid" style={{ marginTop: 20 }}>
            {MORE.map((m) => (
              <div className="cell" key={m.t}>
                <h3>{m.t}</h3>
                <p>{m.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- trust ---------- */}
      <section className="trust">
        <div className="in">
          <div className="kicker">Why teams trust it</div>
          <h2>Built like a lab notebook, not a whiteboard</h2>
          <div className="grid" style={{ marginTop: 20 }}>
            {TRUST.map((m) => (
              <div className="cell" key={m.t}>
                <h3>{m.t}</h3>
                <p>{m.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- final CTA ---------- */}
      <section className="final">
        <div className="in">
          <h2>See it with your own instruments on the board</h2>
          <p className="lead">
            A walkthrough takes half an hour, with your fleet - not a canned demo. Bring the
            spreadsheet; the parity view will do the arguing.
          </p>
          <div className="cta-row" style={{ marginBottom: 8 }}>
            <a className="cta" href={`mailto:${CONTACT_EMAIL}?subject=Walkthrough request`}>
              Request a walkthrough
            </a>
            <Link className="cta2" href="/login">
              Sign in
            </Link>
          </div>
        </div>
      </section>
      <div className="foot-note">
        Screenshots show a demo workspace with sample data.
      </div>
    </div>
  );
}
