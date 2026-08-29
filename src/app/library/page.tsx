import { redirect } from "next/navigation";
import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant, readTenant } from "@/lib/tenancy";
import { navSection } from "@/lib/navData";
import SectionShell from "@/components/SectionShell";
import { HubCard, HubGrid } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The library hub: the reference material and the tools that make paper.
 *
 * Static cards, mostly, and that is the honest answer - a parts catalog has no
 * state that changes overnight the way an EOD report does. The one live figure
 * is how many files the workspace holds, because "Documents" and "Documents ·
 * 1,204 files" are different invitations.
 *
 * It is also the fifth tab on a phone. That tab used to say "Library" and open
 * /documents, so the word on the tab and the page behind it were two different
 * things; now it opens the section the word names.
 */
const BLURB: Record<string, string> = {
  "/settings/catalog": "Models, procedures and what each one needs",
  "/settings/parts": "Part numbers, and the paper behind them",
  "/documents": "Everything filed, by system and by client",
  "/gallery": "Photos, across every job",
  "/pdf": "Assemble a packet from what is already filed",
  "/import": "Bring a spreadsheet in",
};

export default async function LibraryPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/documents");

  const section = await navSection("library");
  if (!section) redirect("/documents");

  // Same posture as every count in the shell: a figure that cannot be read is
  // simply not shown, and the card still works.
  const [files] = await db.select({ n: count() }).from(attachments)
    .where(forTenant(attachments.tenantOrgId, readTenant(user))).catch(() => []);

  return (
    <SectionShell section={section} active={section.href}
      title="Library" sub="Reference material, and the tools that turn it into paper.">
      <HubGrid>
        {section.items.map((i) => (
          <HubCard key={i.href} href={i.href} title={i.label} sub={BLURB[i.href]}
            signal={i.href === "/documents" && files?.n ? `${files.n.toLocaleString("en-US")} files` : undefined}
            tone={i.href === "/documents" && files?.n ? "info" : undefined} />
        ))}
      </HubGrid>
    </SectionShell>
  );
}
