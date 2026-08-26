import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clientAllowlist, orgs, sheetDiffs, notifications, stockrooms, stockroomShares } from "@/db/schema";
import { and, asc, isNull, or } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { users } from "@/db/schema";
import { currentUser, viewContext } from "@/lib/authz";
import { welcomeRedirect } from "@/lib/welcome";
import { PATH_HEADER } from "@/middleware";
import { isValidHex, readableTextOn, tint } from "@/lib/theme";
import HeaderNav from "@/components/HeaderNav";
import MobileNav, { type TabItem } from "@/components/MobileNav";
import AccountMenu from "@/components/AccountMenu";
import { NavIcon, SearchIcon, MessagesIcon, InboxIcon } from "@/components/NavIcons";
import ViewAsBar from "@/components/ViewAsBar";
import NotificationCenter from "@/components/NotificationCenter";
import { ConfirmHost } from "@/components/ui/ConfirmDialog";
import { ToastHost } from "@/components/ui/Toast";
import { getBrand } from "@/lib/brand";
import { getModules } from "@/lib/flags";
import { getAppearance } from "@/lib/appearanceData";
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
  if (user) {
    const [me] = await db.select({ onboardedAt: users.onboardedAt })
      .from(users).where(eq(users.email, user.email.toLowerCase())).catch(() => []);
    const to = welcomeRedirect(true, me?.onboardedAt ?? null, (await headers()).get(PATH_HEADER) ?? "/");
    if (to) redirect(to);
  }
  const isStaff = user && (user.role === "owner" || user.role === "staff");
  // Only the real owner is offered the switch, and only once signed in.
  const mayViewAs = view.real?.role === "owner";
  const orgOptions = mayViewAs
    ? await db.select({ id: orgs.id, name: orgs.name, kind: orgs.kind }).from(orgs).orderBy(asc(orgs.name)).catch(() => [])
    : [];
  // Parity is an operator concern, so don't even ask the database for it on a
  // client's request.
  const diffRows = isStaff && modules.sheetSync
    ? await db.select({ id: sheetDiffs.id }).from(sheetDiffs).where(eq(sheetDiffs.resolved, false))
        .catch(() => []) // table may not exist before first push
    : [];
  const openDiffs = diffRows.length;
  // Unread inbox count for the nav badge. Same .catch posture as the parity
  // count: a deploy that beats the schema sync must not blank the whole shell.
  const unreadRows = user
    ? await db.select({ id: notifications.id }).from(notifications)
        .where(and(eq(notifications.email, user.email.toLowerCase()), isNull(notifications.readAt)))
        .catch(() => [])
    : [];
  const unread = unreadRows.length;
  // Same posture as the parity and inbox counts: a shell that can't count must
  // still render. Zero hides the badge, which is the honest failure.
  const unreadTalk = user ? await unreadDiscussions(user).catch(() => 0) : 0;
  const unreadDm = user ? await unreadMessages(user.email).catch(() => 0) : 0;
  // Staff always get the Stock link; an org only gets it once it has a room of
  // its own or one shared with it, so a client without inventory sees no
  // dead end.
  // One read of the viewer's own organization, for the three facts a client's
  // nav turns on. Remote support only when their tier is on - an entry leading
  // to a page that redirects is worse than no entry. Whether they are a CLIENT
  // org at all, because /store and /orders both bounce a non-staff member of a
  // provider org (store/page.tsx and orders/page.tsx check org.kind), and
  // shipping them those two doors ships two dead ends. And whether they resell,
  // which changes what their landing is even about.
  const [ownOrg] = user?.orgId != null
    ? await db.select({
        kind: orgs.kind, remote: orgs.remoteAccessEnabled, resale: orgs.resaleEnabled,
      }).from(orgs).where(eq(orgs.id, user.orgId)).catch(() => [])
    : [];
  const orgRemoteOn = !isStaff && modules.remote && ownOrg?.remote === true;
  const isClientOrg = !isStaff && ownOrg?.kind === "client";
  // A reseller's units are stock heading for a sale rather than benches, so
  // their first door is a pipeline and they get a room their listings live in.
  const resells = !isStaff && ownOrg?.resale === true;
  // Payroll is in the nav only for somebody who may actually read one: the
  // company's own owner, or a person at a client whose flag was turned on. An
  // entry that leads to a page which redirects is worse than no entry, and
  // here it would also be an entry that names a thing they cannot have.
  const seesPayroll = user?.role === "owner"
    || (user?.orgId != null && (
      await db.select({ on: clientAllowlist.canSeePayroll }).from(clientAllowlist)
        .where(eq(clientAllowlist.entry, user.email.toLowerCase())).catch(() => [])
    )[0]?.on === true);
  const hasStock = isStaff || (user?.orgId != null && (
    await db.select({ id: stockrooms.id }).from(stockrooms)
      .leftJoin(stockroomShares, eq(stockroomShares.stockroomId, stockrooms.id))
      .where(and(eq(stockrooms.archived, false),
        or(eq(stockrooms.orgId, user.orgId), eq(stockroomShares.orgId, user.orgId))))
      .limit(1).catch(() => [])
  ).length > 0);

  // The viewer's organization paints its own workspace; staff and org-less
  // sessions keep the platform look. Bad hex stored by any path degrades to
  // the default rather than an unreadable header.
  const [orgTheme] = user?.orgId != null
    ? await db.select({ themeColor: orgs.themeColor, logoUrl: orgs.logoUrl }).from(orgs).where(eq(orgs.id, user.orgId))
    : [];
  const themed = orgTheme && isValidHex(orgTheme.themeColor) ? orgTheme.themeColor : null;
  // Three layers, narrowest first: an organization paints its own workspace,
  // the platform paints everyone else's, and lib/appearance holds the look the
  // app ships with. Every one of these values is validated there before it
  // reaches a style attribute.
  const look = await getAppearance();
  const headerBg = themed ?? look.headerColor;
  const headerFg = readableTextOn(themed ?? look.headerColor);
  const pageTint = tint(themed ?? look.headerColor, 0.93);
  const logoUrl = orgTheme?.logoUrl || "";

  /* The nav, as data: the same links and menus feed the desktop header row
     and the phone's drawer, so the two can never disagree about what the app
     contains. The primary links are where the work is; the long tail lives
     in two labelled menus - Operations for the shop's rhythms, Library for
     files and tools - instead of one flat "More". */
  /* Two products, not one product with things hidden.
     Staff get the shop: a board, the work, the equipment, the money. A client
     gets five doors onto their own relationship, in their own words - they do
     not file a work order, they ask for help, and the work order is what the
     shop creates in response. See lib/clientView for the rest of that
     vocabulary. Anything a particular account happens to have (its own
     stockroom, remote support, its own payroll) is a capability rather than a
     door, and lives in the group below. */
  const navLinks = isStaff ? [
    { href: "/", label: "Dashboard" },
    { href: "/work", label: "Work orders" },
    { href: "/assets", label: "Assets" },
    ...(hasStock ? [{ href: "/stock", label: "Inventory" }] : []),
    /* Money is staff work: a client sees their own bills through their own
       portal, never through a nav word that lists everybody's. "Financial"
       rather than "Billing" because the section stopped being about billing
       the moment purchasing, reimbursements, overhead and payroll joined it -
       see lib/finance. */
    { href: "/money", label: "Financial" },
  ] : [
    { href: "/", label: resells ? "Your pipeline" : "Your lab" },
    { href: "/work", label: "Requests" },
    /* Quotes and invoices, named for what the client does with them rather
       than for what the shop filed. */
    ...(isClientOrg ? [{ href: "/orders", label: "Approvals" }] : []),
    ...(resells
      ? [{ href: "/listings", label: "Listings" }]
      : isClientOrg ? [{ href: "/store", label: "Parts" }] : []),
    { href: "/documents", label: "Documents" },
  ];
  const navGroups = isStaff ? [
    {
      label: "Operations",
      items: [
        ...(modules.eod ? [{ href: "/eod", label: "EOD update" }] : []),
        /* What is happening WHEN, across everything - the field crew's
           morning question, so it leads the group. */
        { href: "/calendar", label: "Calendar" },
        { href: "/maintenance", label: "Maintenance" },
        { href: "/money/purchasing", label: "Purchasing" },
        /* Money an engineer fronted, and where the payout stands. It keeps
           its place in Operations because the person it serves is the
           engineer, and it carries the financial rail as well - the two
           doors reach the same page. "Reimbursements", not "Expenses":
           Overhead is also expenses, and two things by one name in one
           section is the confusion this merge exists to remove. */
        { href: "/money/reimbursements", label: "Reimbursements" },
        /* What the shop pays its own people, and what that makes a month
           cost. Owners only - see lib/payroll, where the rule that keeps it
           from the bench (and from every other workspace) lives. */
        ...(seesPayroll ? [{ href: "/money/payroll", label: "Payroll" }] : []),
        /* Something you DO to a system, so it sits with the other doing - it
           was under Library, which is files and tools, and a remote session
           is neither. */
        ...(modules.remote ? [{ href: "/remote", label: "Remote support" }] : []),
        { href: "/metrics", label: "Metrics" },
        ...(modules.sheetSync ? [{ href: "/parity", label: `Sheet parity${openDiffs ? ` (${openDiffs})` : ""}` }] : []),
        { href: "/archive", label: "Archived" },
      ],
    },
    {
      label: "Library",
      items: [
        /* The equipment catalog is reference material the shop reaches for
           daily; burying it three taps into Settings made it feel like
           configuration. It still lives at its Settings URL - this is the
           short way in. */
        { href: "/settings/catalog", label: "Equipment catalog" },
        { href: "/settings/parts", label: "Parts book" },
        { href: "/documents", label: "Files" },
        { href: "/gallery", label: "Gallery" },
        { href: "/pdf", label: "PDF studio" },
        { href: "/import", label: "Import spreadsheet" },
      ],
    },
  ] : [
    /* One group, and only what this particular account actually has. Gallery
       and PDF studio are gone from a client's nav: they are operator tools for
       assembling paperwork, and a client who wants a packet is handed one
       rather than sent to build it. Files is not here either - it was promoted
       to Documents, a door of its own, because it is the second most used
       thing a client comes for. */
    ...(hasStock || orgRemoteOn || seesPayroll || (resells && isClientOrg) ? [{
      label: "Your account",
      items: [
        // A reseller's primary row spends its fifth slot on Listings, so the
        // parts store moves here rather than disappearing - they buy parts to
        // refurbish with, and a door they use should not vanish.
        ...(resells && isClientOrg ? [{ href: "/store", label: "Parts" }] : []),
        // Their own shelf, when they keep one - not the shop's inventory.
        ...(hasStock ? [{ href: "/stock", label: "Your inventory" }] : []),
        ...(orgRemoteOn ? [{ href: "/remote", label: "Remote support" }] : []),
        // Their own company's payroll, kept on their own side of the wall.
        ...(seesPayroll ? [{ href: "/money/payroll", label: "Payroll" }] : []),
      ],
    }] : []),
  ];
  /* The phone's five. Staff keep the shop's daily run; a client gets the same
     five doors their header shows, so the two surfaces stop disagreeing about
     what the app contains. */
  const navTabs: TabItem[] = isStaff ? [
    { href: "/", label: "Today", icon: "home" },
    { href: "/work", label: "Work", icon: "work" },
    { href: "/assets", label: "Assets", icon: "assets" },
    { href: "/inbox", label: "Inbox", icon: "inbox" },
    { href: "/documents", label: "Library", icon: "library" },
  ] : [
    { href: "/", label: resells ? "Pipeline" : "Your lab", icon: "home" },
    { href: "/work", label: "Requests", icon: "work" },
    ...(isClientOrg ? [{ href: "/orders", label: "Approvals", icon: "approvals" as const }] : []),
    ...(resells
      ? [{ href: "/listings", label: "Listings", icon: "parts" as const }]
      : isClientOrg ? [{ href: "/store", label: "Parts", icon: "parts" as const }] : []),
    { href: "/documents", label: "Documents", icon: "library" },
  ];

  const settingsHref =
    user?.role === "owner" ? "/settings"
      : isStaff ? "/settings/catalog"
        : user?.role === "client_editor" && user.orgId !== null ? `/settings/organizations/${user.orgId}`
          : null;

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
          <ViewAsBar orgs={[]} active={{ orgName: view.persona.orgName, role: view.persona.role }} />
        )}
        <div className="app-header" style={{ background: headerBg, color: headerFg }}>
          <div className="spectrum" />
          <div className="container wide header-row">
            {/* The burger renders here (mobile only); the drawer and tab bar
                it controls are fixed overlays, so their DOM home is moot. */}
            {user && (
              <MobileNav tabs={navTabs} links={navLinks} groups={navGroups} settingsHref={settingsHref}
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
              {user?.orgName && <span className="brand-org">× {user.orgName}</span>}
            </Link>
            {user && (
              <nav className="header-nav">
                <HeaderNav links={navLinks} groups={navGroups} />

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
                    settingsHref={settingsHref}
                    viewAs={mayViewAs && !view.persona ? <ViewAsBar orgs={orgOptions} active={null} /> : undefined}
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
        <Analytics />
      </body>
    </html>
  );
}
