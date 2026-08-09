import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs, sheetDiffs } from "@/db/schema";
import { asc } from "drizzle-orm";
import { currentUser, viewContext } from "@/lib/authz";
import { isValidHex, readableTextOn, tint } from "@/lib/theme";
import { signOut } from "@/auth";
import NavMore from "@/components/NavMore";
import ViewAsBar from "@/components/ViewAsBar";
import { getBrand } from "@/lib/brand";
import { getModules } from "@/lib/flags";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrand();
  return {
    title: `${brand.name} - Instrument management`,
    description: "Instrument refurbishment tracking",
  };
}

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
                <Link className="btn sm" href="/" style={{ textDecoration: "none" }}>Dashboard</Link>
                <Link className="btn sm" href="/discussions" style={{ textDecoration: "none" }}>Discussion</Link>
                <Link className="btn sm" href="/search" style={{ textDecoration: "none" }}>Search</Link>
                <Link className="btn sm" href="/assets" style={{ textDecoration: "none" }}>Assets</Link>
                {isStaff && modules.eod && <Link className="btn sm" href="/eod" style={{ textDecoration: "none" }}>EOD update</Link>}
                {/* An organization's editors configure their own workspace and
                    people on the same page the owner uses. */}
                {!isStaff && user.role === "client_editor" && user.orgId !== null && (
                  <Link className="btn sm" href={`/settings/organizations/${user.orgId}`} style={{ textDecoration: "none" }}>
                    Settings
                  </Link>
                )}
                {isStaff && (
                  <NavMore items={[
                    { href: "/maintenance", label: "Maintenance" },
                    { href: "/checkout", label: "Checkout" },
                    { href: "/metrics", label: "Metrics" },
                    { href: "/archive", label: "Archived" },
                    ...(modules.sheetSync ? [{ href: "/parity", label: `Sheet parity${openDiffs ? ` (${openDiffs})` : ""}` }] : []),
                    ...(user.role === "owner"
                      ? [{ href: "/admin/access", label: "Access & ownership" }, { href: "/settings", label: "Settings" }]
                      : []),
                  ]} />
                )}
                {mayViewAs && !view.persona && <ViewAsBar orgs={orgOptions} active={null} />}
                <form action={async () => { "use server"; await signOut({ redirectTo: "/login" }); }}>
                  <button className="btn sm" type="submit">Sign out</button>
                </form>
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
