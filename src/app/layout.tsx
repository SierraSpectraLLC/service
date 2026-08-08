import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sheetDiffs } from "@/db/schema";
import { currentUser } from "@/lib/authz";
import { signOut } from "@/auth";
import NavMore from "@/components/NavMore";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sierra Spectra - Instrument management",
  description: "Instrument refurbishment tracking",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Run auth and the diff count concurrently; the count only renders for staff.
  const [user, diffRows] = await Promise.all([
    currentUser(),
    db.select({ id: sheetDiffs.id }).from(sheetDiffs).where(eq(sheetDiffs.resolved, false))
      .catch(() => []), // table may not exist before first push
  ]);
  const openDiffs = user ? diffRows.length : 0;
  const isStaff = user && (user.role === "owner" || user.role === "staff");

  return (
    <html lang="en">
      <body>
        <div className="app-header" style={{ background: "var(--navy)", color: "#fff" }}>
          <div className="spectrum" />
          <div className="container" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", paddingTop: 14, paddingBottom: 14 }}>
            <Link href="/" style={{ fontWeight: 700, fontSize: 16, letterSpacing: 0.3, color: "#fff", textDecoration: "none" }}>
              SIERRA SPECTRA
            </Link>
            <span style={{ fontSize: 12, opacity: 0.75 }}>Sierra Spectra × LabZen · instrument portal</span>
            {user && (
              <nav style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <Link className="btn sm" href="/" style={{ textDecoration: "none" }}>Dashboard</Link>
                <Link className="btn sm" href="/discussions" style={{ textDecoration: "none" }}>Discussion</Link>
                <Link className="btn sm" href="/search" style={{ textDecoration: "none" }}>Search</Link>
                <Link className="btn sm" href="/assets" style={{ textDecoration: "none" }}>Assets</Link>
                {isStaff && <Link className="btn sm" href="/eod" style={{ textDecoration: "none" }}>EOD update</Link>}
                {isStaff && (
                  <NavMore items={[
                    { href: "/checkout", label: "Checkout" },
                    { href: "/metrics", label: "Metrics" },
                    { href: "/archive", label: "Archived" },
                    { href: "/parity", label: `Sheet parity${openDiffs ? ` (${openDiffs})` : ""}` },
                    ...(user.role === "owner" ? [{ href: "/settings", label: "Settings" }] : []),
                  ]} />
                )}
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
