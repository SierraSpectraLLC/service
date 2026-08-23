import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, invoiceFees, invoices, orgs, payments } from "@/db/schema";
import { requireOwner } from "@/lib/authz";
import { myTenantOrgId } from "@/lib/authz";
import { resolvePolicy } from "@/lib/billingPolicy";
import { monthsWithActivity } from "@/lib/accountingExport";
import { stripeMode } from "@/lib/stripe";
import BillingDefaultsForm from "@/components/BillingDefaultsForm";
import { PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * How money works here before anybody overrides it per client.
 *
 * Owner only, and the page says out loud what mode Stripe is actually in -
 * read from the key, not from a flag - because the failure everybody has seen
 * is a test key quietly left in production, or worse, the reverse.
 */
export default async function BillingSettingsPage() {
  let user;
  try { user = await requireOwner(); } catch { redirect("/"); }

  const orgId = myTenantOrgId(user);
  const [[settings], operator, invoiceRows, payRows, feeRows] = await Promise.all([
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
    orgId === null ? Promise.resolve(null)
      : db.select().from(orgs).where(eq(orgs.id, orgId)).then((r) => r[0] ?? null),
    db.select({ issuedOn: invoices.issuedOn }).from(invoices),
    db.select({ receivedOn: payments.receivedOn }).from(payments),
    db.select({ postedOn: invoiceFees.postedOn }).from(invoiceFees),
  ]);

  const policy = resolvePolicy(settings?.billingPolicy ?? null, null);
  const months = monthsWithActivity([
    ...invoiceRows.map((r) => r.issuedOn),
    ...payRows.map((r) => r.receivedOn),
    ...feeRows.map((r) => r.postedOn),
  ]);

  return (
    <>
      <PageHead
        title="Billing & payments"
        sub="Defaults. Override per client on the organization page."
      />
      <BillingDefaultsForm
        policy={policy}
        invoicePrefix={settings?.invoicePrefix ?? "INV-"}
        loadedLaborCents={settings?.loadedLaborCents ?? 0}
        platformFeeBps={settings?.platformFeeBps ?? 0}
        stripe={{
          mode: stripeMode(),
          accountId: operator?.stripeAccountId ?? "",
          ready: operator?.stripeReady ?? false,
        }}
        months={months}
      />
    </>
  );
}
