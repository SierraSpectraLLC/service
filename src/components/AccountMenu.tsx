"use client";

import Link from "next/link";
import { signOutAction } from "@/app/actions";
import Dropdown from "@/components/Dropdown";

/**
 * The account corner: who you're signed in as, where your own settings are, and
 * the way out. Sign out and the persona switcher used to be permanent buttons in
 * the header - two of the least-pressed controls in the app holding the most
 * valuable real estate. They live here now, which is where anyone who has used a
 * website in the last decade will look for them.
 *
 * The initials disc is the affordance. It also answers a question the old header
 * couldn't: WHICH account, which matters on a shared bench machine.
 */
export default function AccountMenu({ name, email, orgName, roleLabel, settingsHref, viewAs }: {
  name: string;
  email: string;
  /** The organization whose workspace this is, if any. */
  orgName: string;
  roleLabel: string;
  /** Where this person's own settings live - null when they have none. */
  settingsHref: string | null;
  /** The owner's persona switcher, rendered inside the menu. */
  viewAs?: React.ReactNode;
}) {
  const initials = (name || email)
    .split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

  return (
    <Dropdown label={<span className="nav-avatar" aria-hidden>{initials}</span>} ariaLabel={`Account: ${name}`}>
      <div className="menu-head">
        <div style={{ fontSize: 13, fontWeight: 700 }}>{name}</div>
        <div className="mut mono" style={{ fontSize: 11, overflowWrap: "anywhere" }}>{email}</div>
        <div className="mut" style={{ fontSize: 11, marginTop: 3 }}>
          {orgName ? `${orgName} · ${roleLabel}` : roleLabel}
        </div>
      </div>
      {settingsHref && <Link href={settingsHref}>Settings</Link>}
      <Link href="/inbox">Notifications &amp; email</Link>
      <Link href="/documents">My files</Link>
      {/* The changelog, re-readable after its one appearance as an overlay. */}
      <Link href="/whats-new">What&apos;s new</Link>
      {/* The persona switcher opens a second step inside the menu, so its clicks
          must not reach the panel's close-on-choose handler. */}
      {viewAs && <div className="menu-sub" onClick={(e) => e.stopPropagation()}>{viewAs}</div>}
      {/* A real form, so signing out survives a dead client bundle. */}
      <form action={signOutAction}>
        <button type="submit" style={{ width: "100%" }}>Sign out</button>
      </form>
    </Dropdown>
  );
}
