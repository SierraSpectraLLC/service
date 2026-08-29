import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs, notifications } from "@/db/schema";
import { and, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { users } from "@/db/schema";
import { currentUser, myTenantOrgId, viewContext } from "@/lib/authz";
import { welcomeRedirect } from "@/lib/welcome";
import { PATH_HEADER } from "@/middleware";
import { readableTextOn, tint } from "@/lib/theme";
import HeaderNav from "@/components/HeaderNav";
import MobileNav from "@/components/MobileNav";
import AccountMenu from "@/components/AccountMenu";
import ViewSwitch from "@/components/ViewSwitch";
import { mayChooseView } from "@/lib/viewMode";
import { NavIcon, SearchIcon, MessagesIcon, InboxIcon } from "@/components/NavIcons";
import ViewAsBar from "@/components/ViewAsBar";
import { viewAsPeople } from "@/app/actions";
import { buildNav } from "@/lib/nav";
import { navFacts } from "@/lib/navData";
import { isPlatformStaff, isStaffRole, tenantViewer } from "@/lib/tenants";
import { visibleOrgs } from "@/lib/tenancy";
import NotificationCenter from "@/components/NotificationCenter";
import { ConfirmHost } from "@/components/ui/ConfirmDialog";
import { ToastHost } from "@/components/ui/Toast";
import TrailReporter from "@/components/TrailReporter";
import ReportButton from "@/components/ReportButton";
import { getBrand } from "@/lib/brand";
import { getModules } from "@/lib/flags";
import { getAppearance } from "@/lib/appearanceData";
import { resolveLook } from "@/lib/appearance";
import { unreadDiscussions } from "@/lib/discussionUnread";
import { unreadMessages } from "@/lib/messageUnread";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrand();
  return {
    title: `${brand.name} - Instrument management`,
    description: "Instrument refurbishment tracking",
  };
}

/** What a role is called to the person who has it, not to the schema. */
const ROLE_LABEL: Record<string, string> = {
  owner: "owner", staff: "staff", client_editor: "editor", client_viewer: "read-only",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [user, brand, view, modules] = await Promise.all([currentUser(), getBrand(), viewContext(), getModules()]);

  // A first sign-in goes to /welcome once, wherever they were headed - a name,
  // what to email them about, and a password if they want one. Decided here
  // rather than in middleware because it takes a database read; see lib/welcome.
  /* This person's own row, read once. The welcome redirect wants one column
     off it and the view switch wants another, and two round trips for two
     columns of the same row is a round trip nobody needed. */
  const [me] = user
    ? await db.select({
        onboardedAt: users.onboardedAt, viewMode: users.viewMode, viewTourAt: users.viewTourAt,
      }).from(users).where(eq(users.email, user.email.toLowerCase())).catch(() => [])
    : [];
  if (user) {
    const to = welcomeRedirect(true, me?.onboardedAt ?? null, (await headers()).get(PATH_HEADER) ?? "/");
    if (to) redirect(to);
  }
  const isStaff = user && (user.role === "owner" || user.role === "staff");
  /* Only the real owner is offered the switch, and only once signed in - and
     only the PLATFORM's owner. "View as" is a support tool for whoever runs
     the instance: standing in somebody's shoes is how you reproduce a screen
     you cannot otherwise see, and that is the landlord's job, not a tenant's.
     `role === "owner"` is true for every workspace's owner, so a second
     operator was offered the picker at all - and the org list below was the
     whole orgs table with no predicate, so it named every company on the
     instance before anybody clicked anything. */
  const mayViewAs = !!view.real && isPlatformStaff(tenantViewer(view.real));
  const orgOptions = mayViewAs && view.real
    ? await visibleOrgs(view.real)
        .then((rows) => rows.map((o) => ({ id: o.id, name: o.name, kind: o.kind })))
        .catch(() => [])
    : [];
  /* And the people, for standing in one named person's shoes rather than a
     role's - the only way to reach somebody's saved layout, their assigned
     work and their read state. Read only when the picker is about to be shown:
     it resolves every account's identity, which is not work a client's page
     load should be paying for. */
  const peopleOptions = mayViewAs && !view.persona
    ? await viewAsPeople().catch(() => [])
    : [];
  // Unread inbox count for the nav badge. A deploy that beats the schema sync
  // must not blank the whole shell, so a count that cannot be read is zero and
  // the badge simply doesn't show - the honest failure.
  const unreadRows = user
    ? await db.select({ id: notifications.id }).from(notifications)
        .where(and(eq(notifications.email, user.email.toLowerCase()), isNull(notifications.readAt)))
        .catch(() => [])
    : [];
  const unread = unreadRows.length;
  // Same posture for the two conversation counts.
  const unreadTalk = user ? await unreadDiscussions(user).catch(() => 0) : 0;
  const unreadDm = user ? await unreadMessages(user.email).catch(() => 0) : 0;

  /*
   * THE NAV, AS ONE TREE.
   *
   * This file used to build it: about 150 lines of role branching assembling
   * three shapes - a link row, a list of menus, and a tab bar - that four
   * surfaces then rendered with no guarantee any two agreed. They didn't. One
   * destination went by three names, and the phone drawer unrolled every group
   * the header folded, which is how a staff phone opened onto 29 flat rows.
   *
   * The facts come from lib/navData (which owns the queries) and the shape
   * from lib/nav (which is pure, and pinned per persona in tests/nav.test.ts).
   * Every surface below renders a projection of this one value.
   */
  const facts = await navFacts();
  const nav = buildNav(facts);

  /*
   * WHOSE WORKSPACE this is - one id, and everything about the chrome follows
   * it: the colour, the logo, the spectrum, and the name after the ×.
   *
   * A client's is their own organization. A tenant's STAFF get the service
   * company they work for, which they did not before: the whole shell was the
   * platform's, so an engineer at Sierra Spectra opened the app and read their
   * vendor's name in the header with no sign of their own company anywhere,
   * while every client of theirs got a co-brand. Staff have orgId null, which
   * is what silently excluded them - null is not "no workspace", it is "not a
   * client", and their workspace is the operator they are staff OF.
   *
   * Platform staff land on null and keep the platform's own look, which is
   * correct rather than a fallback: the platform IS their workspace.
   */
  const workspaceOrgId = user
    ? (user.orgId ?? (isStaff ? myTenantOrgId(user) : null))
    : null;
  const [workspace] = workspaceOrgId != null
    ? await db.select({
        name: orgs.name, themeColor: orgs.themeColor, logoUrl: orgs.logoUrl,
        spectrumStops: orgs.spectrumStops, spectrumHeight: orgs.spectrumHeight,
      }).from(orgs).where(eq(orgs.id, workspaceOrgId))
    : [];
  // Two layers, narrowest first, resolved field by field so a workspace that
  // picked only a colour still follows the platform's gradient when it moves.
  // Every value is validated in lib/appearance before it reaches a style
  // attribute - a colour that is not a colour is a way to write arbitrary CSS
  // onto every page.
  const look = resolveLook(workspace ?? null, await getAppearance());
  const headerBg = look.headerColor;
  const headerFg = readableTextOn(look.headerColor);
  const pageTint = tint(look.headerColor, 0.93);
  const logoUrl = workspace?.logoUrl || "";
  /* The name after the ×. Suppressed when the workspace IS the platform's own
     operator, because "RIDGELINE × Ridgeline" is a lockup with itself. */
  const coBrand = workspace && workspaceOrgId !== brand.operatorOrgId ? workspace.name : "";

  return (
    /* en-US, not a bare "en". The language tag is what a browser picks a
       SPELLCHECK DICTIONARY from, and bare English lets it fall back to
       whichever variant the machine prefers - which is how an American shop
       ended up with "utilizing" underlined in red on its own work orders.
       Every free-text field in this app inherits this. */
    <html lang="en-US">
      <body className={user ? "has-tabbar" : undefined} style={{
        ["--bg" as string]: pageTint,
        ["--spectrum-h" as string]: `${look.spectrumHeight}px`,
        ["--spectrum-bg" as string]: look.spectrumCss,
      } as React.CSSProperties}>
        {/* Topmost so a persona is never mistaken for a broken page. */}
        {view.persona && (
          <ViewAsBar orgs={[]} active={{
            kind: view.persona.kind, orgName: view.persona.orgName,
            role: view.persona.role, name: view.persona.name,
          }} />
        )}
        <div className="app-header" style={{ background: headerBg, color: headerFg }}>
          <div className="spectrum" />
          <div className="container wide header-row">
            {/* The burger renders here (mobile only); the drawer and tab bar
                it controls are fixed overlays, so their DOM home is moot. */}
            {user && (
              <MobileNav nav={nav}
                userName={user.name || user.email} orgName={user.orgName || brand.operatorName} />
            )}
            <Link href="/" className="brand">
              {logoUrl && (
                // Plain img: the logo lives on Blob, outside next/image's domain allowlist.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt={`${user?.orgName || "workspace"} logo`}
                  style={{ height: 26, maxWidth: 120, objectFit: "contain", display: "block" }} />
              )}
              <span className="brand-name">{brand.name.toUpperCase()}</span>
              {coBrand && <span className="brand-org">× {coBrand}</span>}
            </Link>
            {user && (
              <nav className="header-nav">
                <HeaderNav nav={nav} />

                {/* Right of the divide: the furniture. Always these four, always
                    here, small - so the row above can change without the way out
                    or the way to search moving with it. */}
                <span className="nav-utility">
                  <NavIcon href="/search" label="Search"><SearchIcon /></NavIcon>
                  {/* Its own icon rather than folded into the bell: the bell is
                      what the system told you, this is where people talk. A
                      discussion post already raises a notification, so merging
                      them would make one control both the alert and the room. */}
                  <NavIcon href="/discussions" label="Discussions" count={unreadTalk}><MessagesIcon /></NavIcon>
                  {/* Its own icon again, and for the same reason: the bubble is
                      the room attached to a system, this is mail addressed to
                      you by a person. */}
                  <NavIcon href="/messages" label="Messages" count={unreadDm}><InboxIcon /></NavIcon>
                  {/* Live: polls for new arrivals, toasts them, and (opt-in)
                      raises OS notifications when the tab is hidden. */}
                  <NotificationCenter initialUnread={unread} />
                  <AccountMenu
                    name={user.name} email={user.email}
                    orgName={user.orgName} roleLabel={ROLE_LABEL[user.role] ?? user.role}
                    orgSettingsHref={facts.settingsHref}
                    viewAs={mayViewAs && !view.persona
                      ? <ViewAsBar orgs={orgOptions} people={peopleOptions} active={null} />
                      : undefined}
                    viewSwitch={!isStaff && mayChooseView(facts.orgResells)
                      ? <ViewSwitch mode={facts.resells ? "reseller" : "lab"} orgName={user.orgName || "Your company"} />
                      : undefined}
                  />
                </span>
              </nav>
            )}
          </div>
        </div>
        {children}
        <div className="container app-footer" style={{ paddingTop: 24, paddingBottom: 18 }}>
          <div className="mut mono t-meta">
            build {process.env.NEXT_PUBLIC_BUILD_SHA} ·{" "}
            {new Date(process.env.NEXT_PUBLIC_BUILD_TIME || 0).toLocaleString("en-US", {
              timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
            })}{" "}
            PT
          </div>
        </div>
        {/* The shared feedback layer: one confirm, one toast rack, for every
            page. Both render nothing until asked. */}
        <ConfirmHost />
        <ToastHost />
        {/* Records the page and any error thrown on it - only when the module
            is on, so an instance that has not asked for it pays nothing. It
            reads the URL, so it needs the Suspense boundary useSearchParams
            wants; there is nothing to fall back to because it renders null. */}
        {modules.trail && user && (
          <Suspense fallback={null}><TrailReporter /></Suspense>
        )}
        {/* Say something is wrong, from wherever you are standing when you see
            it. Staff only - a client's route for "something is wrong with my
            instrument" is Request service, and this is about the software.
            Not behind a module flag: a way to report a bug that an instance
            can switch off is not a reliable way to report a bug. */}
        {user && isStaffRole(user.role) && <ReportButton />}
        <Analytics />
      </body>
    </html>
  );
}
