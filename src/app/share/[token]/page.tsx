import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { attachments, orgs, shareLinks, shareLinkFiles, shareLinkSystems } from "@/db/schema";
import { brandForTenant, getBrand } from "@/lib/brand";
import { linkState } from "@/lib/dropShare";
import { fmtBytes } from "@/lib/storage";
import { shopToday } from "@/lib/shopday";
import {
  asStatementRow, billingContext, creditFor, invoiceForOrg, invoicesForOrg,
  quoteForOrg, quoteSubtotal, quoteTotal,
} from "@/lib/invoiceData";
import {
  addressBlock, addressedTo, discountLabel, discountOf, greetingLine, quoteStanding,
} from "@/lib/quotes";
import { stripeMode } from "@/lib/stripe";
import { feeClause } from "@/lib/billingPolicy";
import { statementFor } from "@/lib/statement";
import ClientInvoice from "@/components/ClientInvoice";
import ClientQuote from "@/components/ClientQuote";
import { EmptyState, Panel, Pill, PublicShell } from "@/components/ui";
import { fleetRowsFor } from "@/lib/fleetBriefData";
import { buildFleetBrief, moduleLine } from "@/lib/fleetBrief";
import { CLIENT_STATE } from "@/lib/clientView";

export const dynamic = "force-dynamic";

/**
 * What a share link shows the person holding it, and nothing about the store
 * it came from. Dead links say why in one sentence and stop - see the drop
 * page for the reasoning; it is the same posture.
 *
 * The link is also the authorization. Everything a client sees about money is
 * fetched through the ORG ID ON THIS ROW - never through an id in the URL - so
 * a token for one client cannot be pointed at another client's invoice.
 */
export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [link] = token.length >= 12
    ? await db.select().from(shareLinks).where(eq(shareLinks.token, token)).catch(() => [])
    : [];
  const state = link ? linkState(link, shopToday()) : null;
  const brand = await getBrand();

  if (!link || state !== "active") {
    return (
      <PublicShell brandName={brand.name} tagline={brand.tagline} width={520}>
        <EmptyState
          title={state === "expired" ? "This link has expired" : "This link is no longer active"}
          body="Ask whoever sent it to you for a new one."
        />
      </PublicShell>
    );
  }

  // The open, recorded on the link itself. This IS the Viewed signal an
  // invoice timeline reads: one answer to "did they see it", living where the
  // link already lives rather than in a second tracker that can disagree.
  await db.update(shareLinks).set({
    openedAt: link.openedAt ?? new Date(),
    lastOpenedAt: new Date(),
    openCount: link.openCount + 1,
  }).where(eq(shareLinks.id, link.id)).catch(() => {});

  if (link.kind === "invoice" && link.invoiceId !== null && link.orgId !== null) {
    return <InvoiceShare link={link} />;
  }
  if (link.kind === "quote" && link.quoteId !== null && link.orgId !== null) {
    return <QuoteShare link={link} />;
  }
  if (link.kind === "fleet" && link.orgId !== null) {
    return <FleetShare link={link} />;
  }

  const fileIds = (await db.select({ attachmentId: shareLinkFiles.attachmentId })
    .from(shareLinkFiles).where(eq(shareLinkFiles.shareId, link.id))).map((r) => r.attachmentId);
  const files = fileIds.length
    ? await db.select({ id: attachments.id, fileName: attachments.fileName, size: attachments.size })
        .from(attachments).where(inArray(attachments.id, fileIds))
    : [];

  return (
    <PublicShell brandName={brand.name} tagline={brand.tagline}
      title={link.label || "Files shared with you"}
      sub={`${files.length} file${files.length === 1 ? "" : "s"} · available until ${link.expiresOn}`}>
      <div className="card">
        {files.map((f) => (
          <div key={f.id} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)" }}>
            <a href={`/api/share/${token}/file/${f.id}`} className="t-body" style={{ fontWeight: 600, textDecoration: "none", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
              {f.fileName}
            </a>
            <span className="mut t-small" style={{ flexShrink: 0 }}>{fmtBytes(f.size)}</span>
          </div>
        ))}
        {files.length === 0 && <div className="mut t-body">The shared files are gone.</div>}
        {files.length > 1 && (
          <div style={{ marginTop: 12 }}>
            <a className="btn sm primary" href={`/api/share/${token}/zip`} style={{ textDecoration: "none" }}>
              Download all (.zip)
            </a>
          </div>
        )}
      </div>
    </PublicShell>
  );
}

/**
 * The bill, and the client's own account beside it.
 *
 * The document carries the OPERATOR's name, never the platform's - a client
 * is buying service from a service company, and the software they never chose
 * has no business signing their invoice.
 */
async function InvoiceShare({ link }: { link: typeof shareLinks.$inferSelect }) {
  const orgId = link.orgId as number;
  const [full, all, org, brand] = await Promise.all([
    invoiceForOrg(link.invoiceId as number, orgId),
    invoicesForOrg(orgId),
    db.select().from(orgs).where(eq(orgs.id, orgId)).then((r) => r[0] ?? null),
    brandForTenant(link.tenantOrgId),
  ]);
  const name = brand.operatorName || brand.name;

  if (!full) {
    return (
      <PublicShell brandName={name} width={620}>
        <EmptyState title="This invoice is no longer available" body="Ask us for a fresh link." />
      </PublicShell>
    );
  }

  const today = shopToday();
  const statement = statementFor({ orgId, invoices: all.map(asStatementRow), today });

  // Whether this client can pay online at all. Three things have to be true -
  // keys on the instance, a connected account, and Stripe having finished its
  // checks - and any of them being false is a supported state, not an error.
  const [operator, ctx] = await Promise.all([
    full.row.tenantOrgId === null ? Promise.resolve(null)
      : db.select().from(orgs).where(eq(orgs.id, full.row.tenantOrgId)).then((r) => r[0] ?? null),
    billingContext(orgId),
  ]);
  const mode = stripeMode();
  const canPay = mode !== "absent" && Boolean(operator?.stripeAccountId) && Boolean(operator?.stripeReady);

  return (
    <PublicShell brandName={name} tagline={brand.tagline} width={640}>
      <ClientInvoice
        brandName={name}
        orgName={org?.name ?? ""}
        apEmail={org?.apEmail ?? ""}
        invoice={{
          id: full.row.id, number: full.row.number, issuedOn: full.row.issuedOn,
          dueOn: full.row.dueOn, poNumber: full.row.poNumber, note: full.row.note,
          lines: full.lines.map((l) => ({
            id: l.id, kind: l.kind, description: l.description, detail: l.detail,
            qty: l.qty / 1000, unitCents: l.unitCents, covered: l.covered, coveredBy: l.coveredBy,
          })),
          paidCents: full.payments.reduce((n, p) => n + p.amountCents, 0),
        }}
        pay={{
          token: link.token,
          enabled: canPay,
          cardsEnabled: ctx.policy.cardsEnabled,
          cardSurchargeBps: ctx.policy.cardSurchargeBps,
          cardSurchargeFlatCents: ctx.policy.cardSurchargeFlatCents,
          testMode: canPay && mode === "test",
          checkTo: name,
        }}
        statement={{
          openCents: statement.openCents,
          payableCents: statement.payableCents,
          count: statement.open.length,
          open: statement.open.map((v) => ({
            number: v.number, balanceCents: v.balanceCents, daysLate: v.daysLate,
          })),
        }}
      />
    </PublicShell>
  );
}

/**
 * The price, and the three things a client can do about it.
 *
 * Same door as the invoice: the quote is fetched through the ORG ID ON THIS
 * ROW, so a token for one client cannot be pointed at another client's price.
 * The credit standing is read here rather than at approval time so the portal
 * can say, before they press anything, that the job will open on hold.
 */
async function QuoteShare({ link }: { link: typeof shareLinks.$inferSelect }) {
  const orgId = link.orgId as number;
  const [full, org, brand] = await Promise.all([
    quoteForOrg(link.quoteId as number, orgId),
    db.select().from(orgs).where(eq(orgs.id, orgId)).then((r) => r[0] ?? null),
    brandForTenant(link.tenantOrgId),
  ]);
  const name = brand.operatorName || brand.name;

  if (!full) {
    return (
      <PublicShell brandName={name} width={620}>
        <EmptyState title="This quote is no longer available" body="Ask us for a fresh link." />
      </PublicShell>
    );
  }

  const today = shopToday();
  const [credit, ctx] = await Promise.all([
    creditFor(orgId, today).catch(() => null),
    billingContext(orgId),
  ]);
  const quoteOff = discountOf(quoteSubtotal(full), full.row);

  return (
    <PublicShell brandName={name} tagline={brand.tagline} width={640}>
      <ClientQuote
        token={link.token}
        quoteId={full.row.id}
        number={full.row.number}
        title={full.row.title}
        brandName={name}
        orgName={org?.name ?? ""}
        expiresOn={full.row.expiresOn}
        depositPct={full.row.depositPct}
        totalCents={quoteTotal(full)}
        onHold={credit?.onHold ?? false}
        standing={quoteStanding(full.row, today)}
        answeredBy={full.row.answeredBy}
        answeredOn={full.row.answeredOn ?? ""}
        feeClause={feeClause(ctx.policy)}
        /* The letter around the table: the sentence naming them, where it was
           sent, what came off the price and why, and the shop's own notes. All
           of it composed by lib/quotes, so this page, the shop's page and the
           spreadsheet say the same thing. */
        greeting={greetingLine(full.row)}
        attn={full.row.attn}
        address={addressBlock(addressedTo(full.row, org ?? null).address)}
        comments={full.row.note}
        {...(quoteOff > 0
          ? { discount: { label: discountLabel(full.row), cents: quoteOff } }
          : {})}
        lines={full.lines.map((l) => ({
          id: l.id, description: l.description, detail: l.detail, partNumber: l.partNumber,
          qty: l.qty / 1000, unitCents: l.unitCents, covered: l.covered, coveredBy: l.coveredBy,
        }))}
      />
    </PublicShell>
  );
}


/**
 * A client's fleet, shown to a peer service company with no login here.
 *
 * Every id is RE-RESOLVED against the link's own org and tenant before a row
 * renders, and anything that no longer matches both is silently dropped. The
 * frozen membership says which systems were chosen; it does not grant them, so
 * a machine handed to another operator since the link was minted stops
 * appearing without anybody having to remember to revoke.
 *
 * Same discipline as the money shares above: nothing is fetched through the
 * URL. And nothing here reads a session - like /listing and /equipment, what
 * this page renders cannot depend on who is asking.
 */
async function FleetShare({ link }: { link: typeof shareLinks.$inferSelect }) {
  const brand = await brandForTenant(link.tenantOrgId);
  const [org] = await db.select().from(orgs).where(eq(orgs.id, link.orgId!));
  const only = (await db.select({ instrumentId: shareLinkSystems.instrumentId })
    .from(shareLinkSystems).where(eq(shareLinkSystems.shareId, link.id)))
    .map((r) => r.instrumentId);
  const today = shopToday();
  const rows = await fleetRowsFor({
    orgId: link.orgId!, tenantOrgId: link.tenantOrgId, today,
    operatorName: brand.operatorName, only,
  }).catch(() => []);
  const brief = buildFleetBrief({
    client: org?.name ?? "This client", from: "", today, rows,
  });

  return (
    <PublicShell brandName={brand.operatorName || brand.name} tagline={brand.tagline} width={720}>
      <div className="card">
        <h2 className="t-h2" style={{ margin: 0 }}>{brief.client}</h2>
        <div className="mut t-body" style={{ marginTop: 2 }}>{brief.headline}</div>
        {/* Said plainly, because the recipient is usually a competitor and the
            first thing they will wonder is what else is on this page. */}
        <div className="mut t-meta" style={{ marginTop: 8 }}>
          Equipment only. Nothing here is a price, a quote, or anybody&apos;s notes.
          This link stops working on {link.expiresOn}.
        </div>
      </div>

      {brief.groups.map((g) => (
        <Panel key={g.site || "all"} title={g.site || "Systems"} count={g.rows.length}>
          {g.rows.map((r) => (
            <div key={r.externalId} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
              <div className="row-2" style={{ alignItems: "baseline" }}>
                <span className="t-body" style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>
                  <span className="mono t-small">{r.externalId}</span> {r.label}
                </span>
                <Pill tone={CLIENT_STATE[r.state].tone}>{CLIENT_STATE[r.state].label}</Pill>
                <span className="mut t-meta">{r.coverageBadge}</span>
              </div>
              {r.modules.length > 0 && (
                <div className="mut t-small" style={{ marginTop: 2 }}>
                  {r.modules.map((m) => <div key={moduleLine(m)}>{moduleLine(m)}</div>)}
                </div>
              )}
            </div>
          ))}
        </Panel>
      ))}

      {rows.length === 0 && (
        <EmptyState title="Nothing to show" body="The systems on this link are no longer available." />
      )}
    </PublicShell>
  );
}
