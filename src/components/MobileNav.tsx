"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { NavGroup } from "@/components/HeaderNav";

/**
 * Navigation for a phone: a bottom tab bar with the five daily destinations,
 * and a drawer (from the hamburger this component also renders into the
 * header) carrying every nav group - so the header itself never has to wrap.
 * Renders nothing visible from 640px up; the desktop keeps its link row.
 *
 * Icons are inline line SVGs on currentColor, same idiom as NavIcons: five
 * small drawings are not worth a package, and currentColor keeps them
 * legible on a themed header.
 */
const S = {
  width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
};

const HomeIcon = () => (
  <svg {...S} aria-hidden><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>
);
const WorkIcon = () => (
  <svg {...S} aria-hidden><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M9 3v4M15 3v4M8 12h8M8 16h5" /></svg>
);
const AssetsIcon = () => (
  <svg {...S} aria-hidden><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>
);
const InboxTabIcon = () => (
  <svg {...S} aria-hidden><path d="M3 13h5l2 3h4l2-3h5" /><path d="M5 5h14l2 8v6H3v-6z" /></svg>
);
const LibraryIcon = () => (
  <svg {...S} aria-hidden><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
);

const ApprovalsIcon = () => (
  <svg {...S} aria-hidden><path d="M8 4h8a2 2 0 0 1 2 2v14l-6-3-6 3V6a2 2 0 0 1 2-2z" /><path d="M9.5 10.5l1.8 1.8 3.2-3.4" /></svg>
);
const PartsIcon = () => (
  <svg {...S} aria-hidden><path d="M12 3.5 20 8v8l-8 4.5L4 16V8z" /><path d="M4 8l8 4.5L20 8M12 12.5V21" /></svg>
);

/**
 * The tab bar's five, by key.
 *
 * The bar used to be a module constant with no role input at all: every signed-
 * in person got Today / Work / Assets / Inbox / Library, including the /inbox
 * tab, which appears in neither nav branch, and three labels that disagreed
 * with the ones beside them on a desktop. The phone was the one surface where
 * a client could not be given their own product, because nothing here knew who
 * was holding it.
 */
const TAB_ICON = {
  home: <HomeIcon />, work: <WorkIcon />, assets: <AssetsIcon />,
  inbox: <InboxTabIcon />, library: <LibraryIcon />,
  approvals: <ApprovalsIcon />, parts: <PartsIcon />,
} as const;

export type TabKey = keyof typeof TAB_ICON;
export type TabItem = { href: string; label: string; icon: TabKey };

export default function MobileNav({ tabs, links, groups, settingsHref, userName, orgName }: {
  /** The five daily destinations, chosen by whoever is holding the phone. */
  tabs: TabItem[];
  links: { href: string; label: string }[];
  groups: NavGroup[];
  settingsHref: string | null;
  userName: string;
  orgName: string;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) =>
    href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);

  // A navigation is the end of the drawer's business; and Escape closes it
  // like any overlay.
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button type="button" className="mnav-burger" aria-label="Menu" aria-expanded={open}
        onClick={() => setOpen(true)}>
        <svg {...S} aria-hidden><path d="M4 6h16M4 12h16M4 18h16" /></svg>
      </button>

      {open && (
        <div className="mnav-drawer no-print">
          <div className="scrim" onClick={() => setOpen(false)} />
          <div className="mnav-pane" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="mnav-id">
              <b>{userName}</b>
              <div className="mut t-meta">{orgName}</div>
            </div>
            <div className="mnav-group">Work</div>
            {links.map((l) => (
              <Link key={l.href} href={l.href} className={isActive(l.href) ? "active" : undefined}>{l.label}</Link>
            ))}
            {groups.filter((g) => g.items.length > 0).map((g) => (
              <span key={g.label}>
                <div className="mnav-group">{g.label}</div>
                {g.items.map((i) => (
                  <Link key={i.href} href={i.href} className={isActive(i.href) ? "active" : undefined}>{i.label}</Link>
                ))}
              </span>
            ))}
            {settingsHref && (
              <>
                <div className="mnav-group">Account</div>
                <Link href={settingsHref}>Settings</Link>
              </>
            )}
          </div>
        </div>
      )}

      <nav className="mnav-tabbar no-print" aria-label="Primary">
        {tabs.map((t) => (
          <Link key={t.href} href={t.href}
            aria-current={isActive(t.href) ? "page" : undefined}
            className={isActive(t.href) ? "active" : undefined}>
            {TAB_ICON[t.icon]}
            {t.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
