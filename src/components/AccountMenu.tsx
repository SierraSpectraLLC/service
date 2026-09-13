"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/app/actions";
import Dropdown from "@/components/Dropdown";
import { isActive, type NavSection } from "@/lib/nav";

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
export default function AccountMenu({ name, email, orgName, roleLabel, orgSettingsHref, org, viewAs, viewSwitch }: {
  name: string;
  email: string;
  /** The organization whose workspace this is, if any. */
  orgName: string;
  roleLabel: string;
  /**
   * The COMPANY's settings - null when this person administers none.
   *
   * It is no longer what "Settings" in this menu means. That word pointed
   * here, at pages about the catalog and the tenants and the billing, so a
   * person looking for their own name or their own password landed in the
   * organization's configuration and found neither. Their own settings are
   * /account; this is a room inside it, and stays in the menu as its own
   * named link for whoever lives there.
   */
  orgSettingsHref: string | null;
  /**
   * The organization section of the nav tree, for whoever has one - the
   * owner and HR. Rendered here under the COMPANY'S NAME rather than as a
   * sixth word in the header row: "my company" is something people look for
   * behind their own name, and the header's width is spent on the work. The
   * phone reaches the same section from the Account hub. See lib/nav.
   */
  org?: NavSection | null;
  /** The owner's persona switcher, rendered inside the menu. */
  viewAs?: React.ReactNode;
  /** Which half of the app I work in, where my company does both. */
  viewSwitch?: React.ReactNode;
}) {
  const path = usePathname();
  const current = (href: string) => (isActive(path, href) ? "page" : undefined);
  const initials = (name || email)
    .split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

  return (
    <Dropdown label={<span className="nav-avatar" aria-hidden>{initials}</span>} ariaLabel={`Account: ${name}`}>
      <div className="menu-head">
        <div className="t-body" style={{ fontWeight: 700 }}>{name}</div>
        <div className="mut mono t-meta" style={{ overflowWrap: "anywhere" }}>{email}</div>
        <div className="mut t-meta" style={{ marginTop: 3 }}>
          {orgName ? `${orgName} · ${roleLabel}` : roleLabel}
        </div>
      </div>
      <Link href="/account">Account</Link>
      {/* Preferences, not mail. "Notifications & email" used to point at the
          inbox, which is where messages LAND - the switches that decide which
          ones are sent had nowhere to live at all. */}
      <Link href="/account/notifications">Notifications</Link>
      <Link href="/inbox">Inbox</Link>
      <Link href="/documents">Documents</Link>
      {orgSettingsHref && <Link href={orgSettingsHref}>Organization settings</Link>}
      {/* The company, by name, then its rooms: sites, employees, and for the
          owner the two configuration rooms. The hub leads, as it does in every
          other menu. */}
      {org && (
        <>
          <div className="menu-label">{orgName || org.label}</div>
          <Link href={org.href} className="menu-home" aria-current={current(org.href)}>{org.label}</Link>
          {org.items.map((i) => (
            <Link key={i.href} href={i.href} aria-current={current(i.href)}>{i.label}</Link>
          ))}
        </>
      )}
      {/* The persona switcher opens a second step inside the menu, so its clicks
          must not reach the panel's close-on-choose handler. */}
      {viewAs && <div className="menu-sub" onClick={(e) => e.stopPropagation()}>{viewAs}</div>}
      {/* Brings its own menu-sub and its own click guard - it opens a second
          step inside the menu exactly as the persona switcher does. */}
      {viewSwitch}
      {/* A real form, so signing out survives a dead client bundle. */}
      <form action={signOutAction}>
        <button type="submit" style={{ width: "100%" }}>Sign out</button>
      </form>
    </Dropdown>
  );
}
