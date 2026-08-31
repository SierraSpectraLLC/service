import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/authz";
import { readTenant } from "@/lib/tenancy";
import { shopToday } from "@/lib/shopday";
import { navFacts, navSection } from "@/lib/navData";
import { opsSignals, type Signal } from "@/lib/opsSignals";
import SectionShell from "@/components/SectionShell";
import { HubCard, HubGrid } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The operations hub.
 *
 * "Operations" was a label over nine links with no page of its own, so there
 * was nothing to tap that meant "take me to the shop's rhythms" - and on a
 * phone the nine unrolled into the drawer whether you wanted them or not. This
 * is the place the word now leads to, and it is a MORNING PAGE rather than a
 * menu: each card carries what its room is saying today, so "what needs me" is
 * answered before anything is tapped.
 *
 * The rooms themselves come from the nav tree, so a room added to lib/nav
 * appears here the same day it appears in the menu and the drawer - there is
 * no second list to remember.
 */
const BLURB: Record<string, string> = {
  "/eod": "The day's work, filed per client",
  "/calendar": "Every dated fact the app keeps",
  "/maintenance": "What is owed, and when",
  "/clients": "Who the shop works for, and what of theirs it looks after",
  "/network": "The other service companies, and work moving between us",
  "/people": "The roster: pay, hours, what people are owed",
  "/money/purchasing": "Purchase orders you raised",
  "/money/reimbursements": "Money you spent and want back",
  "/remote": "Sessions on a client's instrument",
  "/metrics": "How the shop is running",
  "/parity": "Where the sheet and the app disagree",
  "/archive": "Closed and put away",
};

export default async function OpsPage() {
  let user;
  try { user = await requireStaff(); } catch { redirect("/"); }

  const [section, facts] = await Promise.all([navSection("ops"), navFacts()]);
  // The section is the page's whole content; a reader with no Operations
  // section has no /ops either, and a hub with an empty grid would be a room
  // that says nothing.
  if (!section) redirect("/");

  const signals = await opsSignals(
    readTenant(user), shopToday(), facts.openDiffs,
    { eod: facts.modules.eod, sheetSync: facts.modules.sheetSync },
  );
  const signalFor = (href: string): Signal | undefined =>
    href === "/eod" ? signals.eod
      : href === "/calendar" ? signals.calendar
        : href === "/maintenance" ? signals.maintenance
          : href === "/parity" ? signals.parity : undefined;

  return (
    <SectionShell section={section} active={section.href}
      title="Operations" sub="The shop's rhythms - what has been filed, what is due, and what disagrees.">
      <HubGrid>
        {section.items.map((i) => {
          const sig = signalFor(i.href);
          return (
            <HubCard key={i.href} href={i.href} title={i.label} sub={BLURB[i.href]}
              signal={sig?.text || undefined} tone={sig?.text ? sig.tone : undefined} />
          );
        })}
      </HubGrid>
    </SectionShell>
  );
}
