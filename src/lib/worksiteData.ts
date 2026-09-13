// The read behind the site-location picker. The shaping is lib/sites and stays pure.

import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { orgSites, orgs } from "@/db/schema";
import type { SessionUser } from "@/lib/authz";
import { forTenant, readTenant } from "@/lib/tenancy";
import { worksiteChoices, type WorksiteChoice } from "@/lib/sites";

/**
 * Every live site of every organization this workspace works with, for
 * offering as an engineer's site location. Scoped by the site's tenant stamp:
 * another operator's labs are not places our people are stationed.
 */
export async function worksiteChoicesFor(user: SessionUser): Promise<WorksiteChoice[]> {
  const rows = await db.select({
    id: orgSites.id, name: orgSites.name, address: orgSites.address, orgName: orgs.name,
  }).from(orgSites).innerJoin(orgs, eq(orgs.id, orgSites.orgId))
    .where(and(eq(orgSites.archived, false), forTenant(orgSites.tenantOrgId, readTenant(user))))
    .orderBy(asc(orgs.name), asc(orgSites.name));
  return worksiteChoices(rows);
}
