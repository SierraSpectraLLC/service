import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sheetDiffs } from "@/db/schema";
import { currentUser } from "@/lib/authz";
import { signOut } from "@/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sierra Spectra - Instrument management",
  description: "Instrument refurbishment tracking",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  let openDiffs = 0;
  if (user) {
    try {
      const rows = await db.select({ id: sheetDiffs.id }).from(sheetDiffs).where(eq(sheetDiffs.resolved, false));
      openDiffs = rows.length;
    } catch { /* table may not exist before first push */ }
  }
  const isStaff = user && (user.role === "owner" || user.role === "staff");

  return (
    <html lang="en">
      <body>
        <div style={{ background: "var(--navy)", color: "#fff" }}>
          <div className="spectrum" />
          <div className="container" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", paddingTop: 14, paddingBottom: 14 }}>
            <Link href="/" style={{ fontWeight: 700, fontSize: 16, letterSpacing: 0.3, color: "#fff", textDecoration: "none" }}>
              SIERRA SPECTRA
            </Link>
            <span style={{ fontSize: 12, opacity: 0.75 }}>Instrument management</span>
            {user && (
              <nav style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <Link className="btn sm" href="/" style={{ textDecoration: "none" }}>Dashboard</Link>
                {isStaff && (
                  <Link className="btn sm" href="/parity" style={{ textDecoration: "none" }}>
                    Sheet parity{openDiffs ? ` (${openDiffs})` : ""}
                  </Link>
                )}
                {user.role === "owner" && (
                  <Link className="btn sm" href="/settings" style={{ textDecoration: "none" }}>Settings</Link>
                )}
                <form action={async () => { "use server"; await signOut({ redirectTo: "/login" }); }}>
                  <button className="btn sm" type="submit">Sign out</button>
                </form>
              </nav>
            )}
          </div>
        </div>
        {children}
      </body>
    </html>
  );
}
