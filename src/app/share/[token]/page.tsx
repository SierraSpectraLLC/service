import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { attachments, orgs, shareLinks, shareLinkFiles } from "@/db/schema";
import { brandForTenant, getBrand } from "@/lib/brand";
import { linkState } from "@/lib/dropShare";
import { fmtBytes } from "@/lib/storage";
import { shopToday } from "@/lib/shopday";
import { asStatementRow, invoiceForOrg, invoicesForOrg } from "@/lib/invoiceData";
import { statementFor } from "@/lib/statement";
import ClientInvoice from "@/components/ClientInvoice";
import { EmptyState, PublicShell } from "@/components/ui";

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
