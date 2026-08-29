import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clientShares, orgs } from "@/db/schema";
import { getBrand } from "@/lib/brand";
import { blindSummary, inventoryLines, inventoryOf, parsePayload, redactPayload } from "@/lib/clientShare";
import { FREE_TIER_LINES } from "@/lib/plan";
import { daysLeft, inviteOpen, inviteState, looksLikeToken, pitchLine } from "@/lib/handoff";
import { termsLine } from "@/lib/referral";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { markHandoffOpened } from "@/app/actions";
import { EmptyState, PublicShell } from "@/components/ui";
import AcceptHandoff from "@/components/AcceptHandoff";

export const dynamic = "force-dynamic";

/**
 * What somebody with no Ridgeline account sees when a shop tries to hand them
 * a client.
 *
 * The link is the authorization, exactly as it is on the share page - and this
 * one has strangers on the other end of it, so what it shows is the REDACTED
 * payload and nothing else: the equipment, how many sites, which state, and
 * the terms. Not the client's name, not an address, not a serial. They can
 * read every word of this page and still not be able to go round the sender,
 * which is what makes it safe to send to somebody who has agreed to nothing.
 *
 * The pitch is the last step, not this page. Accepting opens a workspace with
 * the client already in it, so the first thing anybody sees in Ridgeline is
 * real work of theirs rather than an empty database.
 */
export default async function HandoffPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const brand = await getBrand();
  const [row] = looksLikeToken(token)
    ? await db.select().from(clientShares).where(eq(clientShares.inviteToken, token)).catch(() => [])
    : [];

  const today = shopToday();
  const state = row ? inviteState(row, today) : null;
  const payload = row ? parsePayload(row.payload) : null;

  if (!row || !row.toEmail || row.toOrgId !== null || !payload || state === null) {
    return (
      <PublicShell brandName={brand.name} tagline={brand.tagline} width={520}>
        <EmptyState title="This link is not live"
          body="It may have been withdrawn, or it may never have been a link at all. Whoever sent it can send another." />
      </PublicShell>
    );
  }

  const [from] = row.tenantOrgId === null ? []
    : await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, row.tenantOrgId));
  const fromName = from?.name ?? "A service company";

  /*
   * ACCEPTED IS A SUCCESS PAGE, not a dead end.
   *
   * It reads as one for a mechanical reason worth writing down: accepting
   * revalidates, this server component re-runs, and the invitation is
   * accepted by the time it does - so the screen that replaces the form is
   * this one. Told "somebody has taken this one on", the person who just took
   * it reads a failure at the exact moment they converted. And there is no
   * second audience to protect: the only reader of an unguessable token is the
   * shop it was sent to.
   */
  if (state === "accepted") {
    const [dest] = row.destOrgId === null ? []
      : await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, row.destOrgId));
    return (
      <PublicShell brandName={brand.name} tagline={brand.tagline} width={560}>
        <div className="card" style={{ padding: "22px 24px" }}>
          <div className="eyebrow">Accepted</div>
          <h1 className="t-page" style={{ margin: "4px 0 10px" }}>
            You have the client{dest?.name ? `, and ${dest.name} is on file` : ""}.
          </h1>
          <div className="t-body">
            The sites, the systems, the serials, the maintenance schedules and the parts
            history {fromName} had on file are in your workspace now - nothing to type in.
          </div>
          <div className="mut t-small" style={{ marginTop: 10 }}>
            Sign in as <span className="mono">{row.toEmail}</span>. We email a code;
            there is no password to choose.
          </div>
          {/* Said again on the way in, because this is the screen somebody
              actually reads - the one before it they skimmed. */}
          <div className="mut t-small" style={{ marginTop: 6 }}>
            The workspace is free for {dest?.name ? <b>{dest.name}</b> : "this client"} and has no
            clock on it. Taking on a client of your own is where a subscription starts.
          </div>
          {/* inline-block, or the margin on an inline anchor is ignored and the
              button sits on top of the line above it. */}
          <a className="btn accent"
            style={{ display: "inline-block", marginTop: 14, textDecoration: "none" }}
            href="/login">
            Sign in
          </a>
        </div>
      </PublicShell>
    );
  }

  if (!inviteOpen(state)) {
    return (
      <PublicShell brandName={brand.name} tagline={brand.tagline} width={520}>
        <EmptyState title="This offer has closed"
          body={`${fromName} is no longer offering this. They can send a fresh one.`} />
      </PublicShell>
    );
  }

  // Recorded once, so the sender can tell read from ignored before they pick
  // up the telephone. Best-effort - a page never fails on its bookkeeping.
  await markHandoffOpened(token);

  const shown = redactPayload(payload);
  const terms = {
    kind: row.feeKind, feeCents: row.feeCents, feeBps: row.feeBps,
    windowMonths: row.feeWindowMonths, minCents: row.feeMinCents,
    maxCents: row.feeMaxCents, note: row.feeNote,
  };
  const left = daysLeft(row.expiresOn, today);
  /*
   * Counted off the REDACTED payload, which is the same count either way -
   * redaction rewrites rows, it never drops one. Doing it here rather than off
   * the original is the guarantee that this page can never advertise a number
   * bigger than the thing it is showing, and materialize writes every one of
   * these, so it can never advertise a number bigger than what acceptance
   * delivers either.
   */
  const inv = inventoryOf(shown);
  const lines = inventoryLines(inv);

  return (
    <PublicShell brandName={brand.name} tagline={brand.tagline} width={640}>
      <div className="card" style={{ padding: "22px 24px" }}>
        <div className="eyebrow">A hand-off from {fromName}</div>
        <h1 className="t-page" style={{ margin: "4px 0 10px" }}>
          {pitchLine(blindSummary(payload), fromName)}
        </h1>
        {row.note && (
          <div className="t-body" style={{ marginBottom: 12 }}>&ldquo;{row.note}&rdquo;</div>
        )}

        <div className="dialog-section">What the work is</div>
        {shown.systems.length === 0 && <div className="mut t-small">No systems listed.</div>}
        {shown.systems.map((x, i) => (
          <div key={i} className="row-2" style={{ alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
            <span className="t-body" style={{ flex: 1, minWidth: 0 }}>
              {x.model || "Unnamed system"}
              {x.category ? <span className="mut t-meta"> · {x.category}</span> : null}
            </span>
            <span className="mut t-meta">{x.modules.length
              ? `${x.modules.length} module${x.modules.length === 1 ? "" : "s"}` : ""}</span>
          </div>
        ))}
        <div className="mut t-meta" style={{ marginTop: 6 }}>
          {/* Said only when there is something to say. A payload whose sites
              never made it reads "Across 0 sites", which is worse than
              silence - it looks like an offer of nothing. */}
          {shown.sites.length > 0 && (
            <>
              Across {shown.sites.length} site{shown.sites.length === 1 ? "" : "s"}
              {shown.sites[0]?.name.includes(",")
                ? ` in ${shown.sites[0].name.split(",").pop()?.trim()}` : ""}
              .{" "}
            </>
          )}
          Who the client is, where exactly, and every serial arrive when you accept.
        </div>

        {/*
          * THE PAYOFF, and the only part of this page that is a pitch.
          *
          * Counts rather than contents, which is what lets it be both honest
          * and safe: it is the full inventory of what materialize actually
          * writes, and every figure in it survives blinding, so a stranger
          * learns how much there is to take on without learning enough to go
          * round the sender. What converts is that the list is real - accepting
          * does not open a sign-up form, it opens a workspace with all of this
          * already in it.
          */}
        {lines.length > 0 && (
          <>
            <div className="dialog-section" style={{ marginTop: 16 }}>What lands in your workspace</div>
            <div className="t-body">
              {lines.map((l, i) => (
                <div key={i} style={{ padding: "3px 0" }}>{l}</div>
              ))}
            </div>
            {inv.pricingYears > 0 && (
              <div className="t-small" style={{ marginTop: 6 }}>
                {fromName} is selling the account rather than making an introduction, so what
                this client has been charged comes with it - you can quote the work the way
                they are used to being quoted instead of guessing at it.
              </div>
            )}
            {/* The closer, and it earns a rule of its own: everything above it
                is a list, and this is the sentence somebody is meant to leave
                the page with. */}
            <div className="t-lead" style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
              <b>View all this and more in Ridgeline.</b>
            </div>

            {/*
              * WHAT IT COSTS, said here rather than discovered in a month.
              *
              * The workspace this opens is free and it is not a trial - there
              * is no clock on it and nothing switches off. What it covers is
              * THIS client. Somebody who finds that out later, having moved
              * their records in, has been tricked, and a platform that
              * converts service companies by tricking them converts each of
              * them exactly once. See lib/plan.
              */}
            <div className="mut t-small" style={{ marginTop: 10 }}>
              <b>Free, and not a trial.</b> No clock, no card, nothing that switches off:
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {FREE_TIER_LINES.map((l, i) => <li key={i} style={{ padding: "1px 0" }}>{l}</li>)}
              </ul>
            </div>
          </>
        )}

        {terms.kind !== "none" && (
          <>
            <div className="dialog-section" style={{ marginTop: 14 }}>What they are asking</div>
            {/* termsLine already carries the note as its tail - see
                lib/referral - so printing it again underneath said the same
                sentence twice. */}
            <div className="t-body"><b>{termsLine(terms, formatCents)}</b></div>
          </>
        )}

        <div className="dialog-section" style={{ marginTop: 16 }}>Take it on</div>
        <AcceptHandoff token={token} email={row.toEmail} fromName={fromName} />

        <div className="mut t-meta" style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
          {left !== null && left <= 10
            ? `This offer is open for another ${left} day${left === 1 ? "" : "s"}. `
            : ""}
          Ridgeline is where {fromName} keeps their service records - work orders,
          maintenance, parts and the paper behind them. Accepting opens a workspace
          for your company with this client already in it.
        </div>
      </div>
    </PublicShell>
  );
}
