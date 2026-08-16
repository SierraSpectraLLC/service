"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Dropdown from "@/components/Dropdown";

type Item = { href: string; label: string };
export type NavGroup = { label: string; items: Item[] };

/**
 * The header's navigation: a few primary links, then the long tail grouped
 * into labelled menus (Operations, Library) instead of one flat "More".
 *
 * Client component for one reason: the active route. The old header drew ten
 * identical white pills and never said which page you were on; here the
 * current route's link carries the filled state, and a menu whose child is
 * the current page shows the same state on its trigger.
 */
export default function HeaderNav({ links, groups }: { links: Item[]; groups: NavGroup[] }) {
  const path = usePathname();
  const isActive = (href: string) =>
    href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);

  return (
    <>
      {links.map((l) => (
        <Link key={l.href} className="nav-link" href={l.href}
          aria-current={isActive(l.href) ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
      {groups.filter((g) => g.items.length > 0).map((g) => {
        const activeChild = g.items.some((i) => isActive(i.href));
        return (
          <Dropdown key={g.label} label={g.label}
            summaryClass={activeChild ? "nav-link active" : "nav-link"}>
            {g.items.map((i) => (
              <Link key={i.href} href={i.href}
                aria-current={isActive(i.href) ? "page" : undefined}>
                {i.label}
              </Link>
            ))}
          </Dropdown>
        );
      })}
    </>
  );
}
