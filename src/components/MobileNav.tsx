"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { signOutAction } from "@/app/actions";
import { isActive, sectionTone, type NavTree, type SectionKey, type TabKey } from "@/lib/nav";

/**
 * Navigation for a phone: a bottom tab bar with the daily destinations, and a
 * drawer (from the hamburger this component also renders into the header)
 * carrying the sections - so the header itself never has to wrap.
 * Renders nothing visible from 640px up; the desktop keeps its link row.
 *
 * THE DRAWER IS A FOLD, NOT A SITE MAP. It used to take the same links and
 * groups the desktop header folds into three dropdowns and unroll all of them
 * into one scroll: 29 rows on a staff phone, four of them duplicating the tab
 * bar underneath in different words. At rest it is now ten rows, and the
 * sections are exclusive-open accordions - opening one closes the other, so
 * the worst case on screen is ten plus the largest group rather than the whole
 * app at once.
 *
 * Icons are inline line SVGs on currentColor, same idiom as NavIcons: a few
 * small drawings are not worth a package, and currentColor keeps them legible
 * on a themed header.
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
 * tab, which appeared in neither nav branch, and three labels that disagreed
 * with the ones beside them on a desktop. Both the destinations and the words
 * now come from the one tree - see lib/nav.
 */
const TAB_ICON: Record<TabKey, React.ReactNode> = {
  home: <HomeIcon />, work: <WorkIcon />, assets: <AssetsIcon />,
  inbox: <InboxTabIcon />, library: <LibraryIcon />,
  approvals: <ApprovalsIcon />, parts: <PartsIcon />,
};

const Chevron = () => (
  <svg {...S} width="16" height="16" className="mnav-caret" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
);

export default function MobileNav({ nav, userName, orgName }: {
  /** The whole tree. The drawer renders the fold; the bar renders the tabs. */
  nav: NavTree;
  userName: string;
  orgName: string;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  /**
   * EXCLUSIVE OPEN: one key, not a set. Opening a section sets it, which
   * collapses whichever was open, so the drawer's height stays bounded by its
   * largest single group instead of growing with every tap. Closing the drawer
   * resets it - a drawer that reopens mid-scroll on yesterday's section is a
   * drawer that has to be re-read.
   */
  const [expanded, setExpanded] = useState<SectionKey | null>(null);

  // A navigation is the end of the drawer's business; and Escape closes it
  // like any overlay.
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => { if (!open) setExpanded(null); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const active = (href: string) => isActive(path, href);
  /* The sections that fold. Account is deliberately not one of them: four
     children is not worth a fold, and it is the row people find by muscle
     memory at the bottom of a drawer. */
  const folding = nav.sections.filter((s) => s.key !== "account");
  const account = nav.sections.find((s) => s.key === "account");

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
            {nav.primary.map((l) => (
              <Link key={l.href} href={l.href} className={active(l.href) ? "active" : undefined}>{l.label}</Link>
            ))}
            <div className="mnav-rule" />
            {folding.map((s) => {
              const isOpen = expanded === s.key;
              const tone = sectionTone(s);
              /* A section reads as current when the page is one of its rooms
                 OR its own hub - the hub is the section, not a child of it. */
              const inside = active(s.href) || s.items.some((i) => active(i.href));
              return (
                <div key={s.key} className="mnav-section">
                  <button type="button" aria-expanded={isOpen}
                    className={`mnav-sectionhead${isOpen ? " open" : ""}${inside ? " inside" : ""}`}
                    onClick={() => setExpanded(isOpen ? null : s.key)}>
                    <span>{s.label}</span>
                    {/* A DOT, NOT A NUMBER. The drawer has room for one bit per
                        row; counts live where there is room to say what they
                        count - the tab bar and the hub cards. */}
                    {tone && <span className={`dot ${tone}`} aria-label={`${s.label} needs attention`} />}
                    <span className="sp" />
                    <Chevron />
                  </button>
                  {isOpen && (
                    <div className="mnav-sectionbody">
                      {/* The hub leads, bolder than its siblings: it is the one
                          row that means "the whole of this section", and it
                          carries the live signals a drawer row cannot. */}
                      <Link href={s.href} className={`mnav-home${active(s.href) ? " active" : ""}`}>
                        {s.homeLabel}
                      </Link>
                      {s.items.map((i) => (
                        <Link key={i.href} href={i.href} className={active(i.href) ? "active" : undefined}>
                          {i.label}
                          {i.badge && i.tone ? <span className={`dot ${i.tone}`} aria-hidden /> : null}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {account && (
              <>
                <div className="mnav-rule" />
                <Link href={account.href} className={active(account.href) ? "active" : undefined}>
                  {account.label}
                </Link>
              </>
            )}
            {/* A real form, so signing out survives a dead client bundle. */}
            <form action={signOutAction}>
              <button type="submit" className="mnav-signout">Sign out</button>
            </form>
          </div>
        </div>
      )}

      <nav className="mnav-tabbar no-print" aria-label="Primary">
        {nav.tabs.map((t) => (
          <Link key={t.href} href={t.href}
            aria-current={active(t.href) ? "page" : undefined}
            className={active(t.href) ? "active" : undefined}>
            {TAB_ICON[t.icon]}
            {t.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
