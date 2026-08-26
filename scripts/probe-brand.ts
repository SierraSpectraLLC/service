import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, orgs } from "@/db/schema";
import { getBrand, brandForTenant } from "@/lib/brand";
import { visibleOrgs } from "@/lib/tenancy";
async function main() {
  const [s] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  console.log("app_settings.platform_name    :", JSON.stringify(s?.platformName));
  console.log("app_settings.platform_tagline :", JSON.stringify(s?.platformTagline));
  console.log("app_settings.operator_org_id  :", s?.operatorOrgId);
  console.log("public_contact_email          :", JSON.stringify(s?.publicContactEmail));
  const b = await getBrand();
  console.log("\ngetBrand():", JSON.stringify(b, null, 2));
  const ops = await db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(eq(orgs.isOperator, true));
  const demo = ops.find((o) => o.name === "Cascade Instrument Service")!;
  console.log("\nbrandForTenant(demo):", JSON.stringify(await brandForTenant(demo.id)));
  const demoOwner = { email: "demo@ridgelinefield.com", role: "owner", orgId: null,
    operatorOrgId: demo.id, rootOperatorOrgId: s?.operatorOrgId ?? null } as never;
  const seen = await visibleOrgs(demoOwner);
  console.log("\nvisibleOrgs() for the demo owner —", seen.length, "orgs:");
  for (const o of seen) console.log(`   ${String(o.id).padStart(3)}  ${o.isOperator ? "[operator]" : "[client]  "}  ${o.name}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e.message); process.exit(1); });
