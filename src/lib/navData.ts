// The facts the navigation branches on, read once per request.
//
// These lines used to live in app/layout.tsx, interleaved with the arrays they
// fed - about 150 lines of nav construction inside a file whose job is the
// document shell. Splitting them is what lets lib/nav be pure: the branching
// is testable without a database, and this file is the only thing that has to
// know which table each fact comes from.
//
// Same posture as everything else the shell reads: every query that can fail
// on a deploy which beat the schema sync is caught, and the honest failure is
// the quieter nav rather than a blank page.
import { cache } from "react";
import { and, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { clientAllowlist, orgs, sheetDiffs, stockrooms, stockroomShares, users } from "@/db/schema";
import { currentUser, type SessionUser } from "@/lib/authz";
import { seesBooksFor } from "@/lib/financeData";
import { getModules, type Modules } from "@/lib/flags";
import { mayAdminPeople, seesPayrollFor } from "@/lib/hr";
import { buildNav, type NavContext, type NavSection, type NavTree, type SectionKey } from "@/lib/nav";
import { viewModeFor, type ViewMode } from "@/lib/viewMode";

/**
 * What the shell needs beyond the nav itself: the two facts about a client's
 * own company that the view switch and the landing also read, so neither has
 * to ask again and neither can get a different answer.
 */
export type NavFacts = NavContext & {
  /** Their organization resells, whatever this person has chosen for themselves. */
  orgResells: boolean;
  /**
   * The view this person actually reads - their own choice, the starting view
   * their operator set, or their company's default, resolved once here so the
   * landing, the nav and the switch in the account menu all say the same
   * thing. "lab" for staff, whose board is not a preference. See lib/viewMode.
   */
  view: ViewMode;
};

/** An empty context, for a signed-out request. buildNav returns nothing from it. */
export const NO_NAV: NavFacts = {
  signedIn: false, isStaff: false, resells: false, isClientOrg: false, hasOrg: false,
  modules: { eod: false, remote: false, sheetSync: false },
  hasStock: false, orgRemoteOn: false, seesBooks: false, seesPayroll: false,
  seesOwnMoney: false, adminsPeople: false, openDiffs: 0, settingsHref: null,
  orgResells: false, view: "lab",
};

/**
 * The facts, once per request.
 *
 * Cached because four things now want them - the shell, the section hubs, the
 * section shells and /search - and every one of them wants the SAME answer.
 * Two reads of "may this person see the books" that disagree is the class of
 * bug this whole module exists to remove, and a second round of six queries
 * per page is the lesser reason.
 */
export const navFacts = cache(async (): Promise<NavFacts> => {
  const [user, modules] = await Promise.all([currentUser(), getModules()]);
  if (!user) return NO_NAV;
  /* Their own screen preference, off their user row rather than the session -
     widening the session for a screen preference would put it in every token
     in the app. See lib/viewMode. */
  const [row] = await db.select({ viewMode: users.viewMode }).from(users)
    .where(eq(users.email, user.email.toLowerCase())).catch(() => []);
  return navFactsFor(user, row?.viewMode ?? "", modules);
});

/** The tree this reader gets. Every surface renders a projection of it. */
export const navTree = cache(async (): Promise<NavTree> => buildNav(await navFacts()));

/**
 * One section of it, by key - what a hub or a SectionShell asks for. Null when
 * this reader has no such section, which is the answer a page turns into a
 * redirect rather than into an empty rail.
 */
export async function navSection(key: SectionKey): Promise<NavSection | null> {
  return (await navTree()).sections.find((s) => s.key === key) ?? null;
}

/** The same, given facts already in hand - pure of the request cache. */
export async function navFactsFor(
  user: SessionUser | null,
  /** This person's own screen preference, off their user row. See lib/viewMode. */
  viewMode: string,
  modules: Modules,
): Promise<NavFacts> {
  if (!user) return NO_NAV;
  const isStaff = user.role === "owner" || user.role === "staff";
  const email = user.email.toLowerCase();

  /* One read of the viewer's own organization, for the three facts a client's
     nav turns on. Remote support only when their tier is on - an entry leading
     to a page that redirects is worse than no entry. Whether they are a CLIENT
     org at all, because /store and /orders both bounce a non-staff member of a
     provider org (store/page.tsx and orders/page.tsx check org.kind), and
     shipping them those two doors ships two dead ends. And whether they
     resell, which changes what their landing is even about. */
  const [ownOrg] = user.orgId != null
    ? await db.select({
        kind: orgs.kind, remote: orgs.remoteAccessEnabled, resale: orgs.resaleEnabled,
      }).from(orgs).where(eq(orgs.id, user.orgId)).catch(() => [])
    : [];

  /* Payroll is in the nav only for somebody who may actually read one, and the
     books only for somebody who may read those. Through lib/hr and
     lib/financeData rather than `role === "owner" || allowRow`: this used to
     be the fifth place in the app assembling that answer from its own set of
     facts, and a word in the menu that disagrees with the page behind it is a
     door that leads to a redirect. */
  const [allowRow] = user.orgId != null
    ? await db.select({ money: clientAllowlist.canSeeMoney, startView: clientAllowlist.startView })
        .from(clientAllowlist).where(eq(clientAllowlist.entry, email)).catch(() => [])
    : [];

  const [seesPayroll, seesBooks, adminsPeople] = await Promise.all([
    seesPayrollFor(user),
    seesBooksFor(user),
    /* The HR room. The owner, and whoever they have made HR - see lib/hr. It
       is not a Settings link: Settings is who has a login, this is what the
       people on the roster are owed. */
    mayAdminPeople(user),
  ]);

  // Parity is an operator concern, so don't even ask the database for it on a
  // client's request. The table may not exist before the first push, which is
  // what the catch is for; zero hides the badge, which is the honest failure.
  const diffRows = isStaff && modules.sheetSync
    ? await db.select({ id: sheetDiffs.id }).from(sheetDiffs)
        .where(eq(sheetDiffs.resolved, false)).catch(() => [])
    : [];

  // Staff always get Inventory; an org only gets it once it has a room of its
  // own or one shared with it, so a client without inventory sees no dead end.
  const hasStock = isStaff || (user.orgId != null && (
    await db.select({ id: stockrooms.id }).from(stockrooms)
      .leftJoin(stockroomShares, eq(stockroomShares.stockroomId, stockrooms.id))
      .where(and(eq(stockrooms.archived, false),
        or(eq(stockrooms.orgId, user.orgId), eq(stockroomShares.orgId, user.orgId))))
      .limit(1).catch(() => [])
  ).length > 0);

  const orgResells = ownOrg?.resale === true;

  /* WHICH VIEW THIS PERSON WORKS IN is theirs to say: the org's flag is the
     default and a COO in charge of the equipment can sit on the other side
     of it. Three answers, closest first: what this person chose (off their
     own user row rather than the session - widening the session for a screen
     preference would put it in every token in the app), where the operator
     started them, and what their company is. */
  const view: ViewMode = isStaff ? "lab"
    : viewModeFor(viewMode, allowRow?.startView ?? "", orgResells);

  return {
    signedIn: true,
    isStaff,
    resells: view === "reseller",
    isClientOrg: !isStaff && ownOrg?.kind === "client",
    hasOrg: user.orgId != null,
    modules: { eod: modules.eod, remote: modules.remote, sheetSync: modules.sheetSync },
    hasStock,
    orgRemoteOn: !isStaff && modules.remote && ownOrg?.remote === true,
    seesBooks,
    seesPayroll,
    /* The client half of the books rule: the quotes their organization has
       been sent and the invoices it owes. Their org has no owner role to fall
       back on, so this is a per-person flag that defaults ON - the switch
       exists to take the privilege away from a named person, not to remove it
       from everybody by shipping. */
    seesOwnMoney: allowRow ? allowRow.money !== false : true,
    adminsPeople,
    openDiffs: diffRows.length,
    settingsHref: settingsHrefFor(user),
    orgResells,
    view,
  };
}

/**
 * Where "Organization settings" leads for this reader, or null if nowhere.
 *
 * Their own company's configuration, and only for somebody who actually
 * administers it: the workspace owner, or a client editor over their own
 * organization.
 *
 * A plain staff member gets NULL, which they did not before - they were sent
 * to /settings/catalog, on the reasoning that it is the settings page they
 * work in. Two things were wrong with that. It named the equipment catalog
 * "Settings", which is a claim about the room that is not true; and the
 * catalog is already a room of the Library, so the same page carried two
 * different names in one person's nav. One destination, one word - see
 * lib/nav.
 */
export function settingsHrefFor(
  user: Pick<SessionUser, "role" | "orgId">,
): string | null {
  if (user.role === "owner") return "/settings";
  if (user.role === "client_editor" && user.orgId !== null) {
    return `/settings/organizations/${user.orgId}`;
  }
  return null;
}
