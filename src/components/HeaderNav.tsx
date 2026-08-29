"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Dropdown from "@/components/Dropdown";
import { isActive, type NavTree } from "@/lib/nav";

/**
 * The header's navigation: the primary links, then the sections as labelled
 * menus.
 *
 * Client component for one reason: the active route. The old header drew ten
 * identical white pills and never said which page you were on; here the
 * current route's link carries the filled state, and a menu whose child is the
 * current page shows the same state on its trigger.
 *
 * EACH MENU LEADS WITH ITS HUB - "Financial home", "Operations home" - because
 * a section is now a place with a page of its own, and the phone's drawer
 * leads with the same row. Two surfaces, one order, one set of words: that is
 * the whole reason both read the tree from lib/nav rather than building their
 * own.
 *
 * The account section is NOT in this row. On a desktop it lives in the account
 * menu at the right, where every website has put it for a decade; on a phone
 * it is the row at the bottom of the drawer. Adding a sixth word here would
 * spend header width on the one destination nobody has to look for.
 */
export default function HeaderNav({ nav }: { nav: NavTree }) {
  const path = usePathname();
  const active = (href: string) => isActive(path, href);

  return (
    <>
      {nav.primary.map((l) => (
        <Link key={l.href} className="nav-link" href={l.href}
          aria-current={active(l.href) ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
      {nav.sections.filter((s) => s.key !== "account").map((s) => {
        const inside = active(s.href) || s.items.some((i) => active(i.href));
        return (
          <Dropdown key={s.key} label={s.label}
            summaryClass={inside ? "nav-link active" : "nav-link"}>
            <Link href={s.href} className="menu-home"
              aria-current={active(s.href) ? "page" : undefined}>
              {s.homeLabel}
            </Link>
            {s.items.map((i) => (
              <Link key={i.href} href={i.href}
                aria-current={active(i.href) ? "page" : undefined}>
                {i.label}
                {/* The count belongs to the room, not to the label - see the
                    badge policy in lib/nav. It used to be baked into the
                    string ("Sheet parity (3)"), which every surface then had
                    to print whether it had room for it or not. */}
                {i.badge ? <span className={`menu-count${i.tone ? ` ${i.tone}` : ""}`}>{i.badge}</span> : null}
              </Link>
            ))}
          </Dropdown>
        );
      })}
    </>
  );
}
