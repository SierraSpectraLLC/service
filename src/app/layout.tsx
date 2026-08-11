import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs, sheetDiffs, notifications, stockrooms, stockroomShares } from "@/db/schema";
import { and, asc, isNull, or } from "drizzle-orm";
import { currentUser, viewContext } from "@/lib/authz";
import { isValidHex, readableTextOn, tint } from "@/lib/theme";
import NavMore from "@/components/NavMore";
import AccountMenu from "@/components/AccountMenu";
import { NavIcon, SearchIcon, MessagesIcon } from "@/components/NavIcons";
import ViewAsBar from "@/components/ViewAsBar";
import NotificationCenter from "@/components/NotificationCenter";
import { getBrand } from "@/lib/brand";
import { getModules } from "@/lib/flags";
import { unreadDiscussions } from "@/lib/discussionUnread";
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
  // Staff always get the Stock link; an org only gets it once it has a room of
  // its own or one shared with it, so a client without inventory sees no
  // dead end.
  // Remote support in the client's nav only when their own tier is on - an entry
  // leading to a page that redirects is worse than no entry. Same forgiving read
  // as every other count in the shell.
  const orgRemoteOn = !isStaff && modules.remote && user?.orgId != null && (
    await db.select({ on: orgs.remoteAccessEnabled }).from(orgs).where(eq(orgs.id, user.orgId))
      .catch(() => [])
  )[0]?.on === true;
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
  const headerBg = themed ?? "var(--navy)";
  const headerFg = themed ? readableTextOn(themed) : "#fff";
  const logoUrl = orgTheme?.logoUrl || "";

  return (
    <html lang="en">
      <body style={themed ? ({ ["--bg" as string]: tint(themed, 0.93) } as React.CSSProperties) : undefined}>
        {/* Topmost so a persona is never mistaken for a broken page. */}
        {view.persona && (
          <ViewAsBar orgs={[]} active={{ orgName: view.persona.orgName, role: view.persona.role }} />
        )}
        <div className="app-header" style={{ background: headerBg, color: headerFg }}>
          <div className="spectrum" />
          <div className="container" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", paddingTop: 14, paddingBottom: 14 }}>
            {logoUrl && (
              // Plain img: the logo lives on Blob, outside next/image's domain allowlist.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt={`${user?.orgName || "workspace"} logo`}
                style={{ height: 26, maxWidth: 120, objectFit: "contain", display: "block" }} />
            )}
            <Link href="/" style={{ fontWeight: 700, fontSize: 16, letterSpacing: 0.3, color: headerFg, textDecoration: "none" }}>
              {brand.name.toUpperCase()}
            </Link>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              {user?.orgName ? `${brand.name} × ${user.orgName} · ${brand.tagline}` : `${brand.name} · ${brand.tagline}`}
            </span>
            {user && (
              <nav style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {/* Left of the divide: where the work is. These change with the
                    instance's modules and the viewer's role. */}
                <Link className="btn sm" href="/" style={{ textDecoration: "none" }}>Dashboard</Link>
                <Link className="btn sm" href="/assets" style={{ textDecoration: "none" }}>Assets</Link>
                {hasStock && <Link className="btn sm" href="/stock" style={{ textDecoration: "none" }}>Stock</Link>}
                {isStaff && modules.eod && <Link className="btn sm" href="/eod" style={{ textDecoration: "none" }}>EOD update</Link>}
                {isStaff ? (
                  <NavMore items={[
                    { href: "/maintenance", label: "Maintenance" },
                    { href: "/purchasing", label: "Purchasing" },
                    { href: "/pdf", label: "PDF studio" },
                    { href: "/documents", label: "Files" },
                    ...(modules.remote ? [{ href: "/remote", label: "Remote support" }] : []),
                    { href: "/metrics", label: "Metrics" },
                    { href: "/archive", label: "Archived" },
                    ...(modules.sheetSync ? [{ href: "/parity", label: `Sheet parity${openDiffs ? ` (${openDiffs})` : ""}` }] : []),
                    // Settings is in the account menu now, where a person looks
                    // for their own settings. Staff keep the catalog link here
                    // because curating it is work, not configuration.
                    ...(user.role === "owner" ? [] : [{ href: "/settings/catalog", label: "Catalog & procedures" }]),
                  ]} />
                ) : (
                  // An organization's own tools: its file shelf and the studio.
                  // Both used to be staff-only, which left a client with nowhere
                  // to keep a document and no way to assemble a packet.
                  <NavMore items={[
                    { href: "/documents", label: "Files" },
                    { href: "/pdf", label: "PDF studio" },
                    ...(orgRemoteOn ? [{ href: "/remote", label: "Remote support" }] : []),
                  ]} />
                )}

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
                  {/* Live: polls for new arrivals, toasts them, and (opt-in)
                      raises OS notifications when the tab is hidden. */}
                  <NotificationCenter initialUnread={unread} />
                  <AccountMenu
                    name={user.name} email={user.email}
                    orgName={user.orgName} roleLabel={ROLE_LABEL[user.role] ?? user.role}
                    settingsHref={
                      user.role === "owner" ? "/settings"
                        : isStaff ? "/settings/catalog"
                          : user.role === "client_editor" && user.orgId !== null ? `/settings/organizations/${user.orgId}`
                            : null
                    }
                    viewAs={mayViewAs && !view.persona ? <ViewAsBar orgs={orgOptions} active={null} /> : undefined}
                  />
                </span>
              </nav>
            )}
          </div>
        </div>
        {children}
        <div className="container app-footer" style={{ paddingTop: 24, paddingBottom: 18 }}>
          <div className="mut mono" style={{ fontSize: 11 }}>
            build {process.env.NEXT_PUBLIC_BUILD_SHA} ·{" "}
            {new Date(process.env.NEXT_PUBLIC_BUILD_TIME || 0).toLocaleString("en-US", {
              timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
            })}{" "}
            PT
          </div>
        </div>
      </body>
    </html>
  );
}
