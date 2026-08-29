"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef } from "react";
import type { NavLeaf } from "@/lib/nav";

/** A rail group. A section with nothing to group passes one unlabelled group. */
export type RailGroup = {
  /** Omitted for a flat rail - the heading is hidden on a phone either way. */
  label?: string;
  entries: (NavLeaf & { active?: boolean })[];
};

/**
 * One secondary navigation, for every section.
 *
 * The app had three of these: the financial rail, the settings sidebar and a
 * per-page tab row, all answering "what else is in here" in three different
 * shapes. This is the one - the FinanceRail idiom, generalized - so somebody
 * who learns the money section gets Operations, Library, Settings and their
 * own account for free.
 *
 * Desktop: a list down the left. Phone: the same markup becomes one row that
 * scrolls sideways with the current room as a filled chip, which is entirely a
 * globals.css decision (see the `.rail` block and its 960px query). The one
 * thing CSS cannot do is put the current chip on screen when the row is wider
 * than the phone, which is what the effect below is for.
 */
export default function SectionRail({ label, groups }: {
  /** Names the nav for a screen reader: "Financial sections". */
  label: string;
  groups: RailGroup[];
}) {
  const ref = useRef<HTMLElement>(null);

  /**
   * Put the current room on screen.
   *
   * On a phone the strip is often wider than the viewport, and a section whose
   * current room sits eighth of ten opens showing rooms one through four - the
   * reader's own position is off the right edge, which reads as "this page
   * isn't in the list". Horizontal only, and `nearest` in the block direction,
   * so bringing a chip into view never scrolls the PAGE away from its heading.
   */
  useEffect(() => {
    const el = ref.current?.querySelector('[aria-current="page"]');
    if (!el) return;
    // Only when the strip actually scrolls - on a desktop rail this is a no-op
    // and calling it would be a scroll nobody asked for.
    const strip = ref.current!;
    if (strip.scrollWidth <= strip.clientWidth) return;
    el.scrollIntoView({ block: "nearest", inline: "center" });
  }, []);

  return (
    /* Heading, list, heading, list - a flat sequence rather than a wrapper per
       group, because that is the shape the phone layout needs: the rail itself
       becomes the sideways scroller and every list inside it lines up in one
       row. A wrapper per group would put four scrollers side by side. */
    <nav className="rail" aria-label={label} ref={ref}>
      {groups.map((g, gi) => (
        <Fragment key={g.label ?? gi}>
          {g.label && <div className="railhead">{g.label}</div>}
          <ul>
            {g.entries.map((e) => (
              <li key={e.href}>
                <Link href={e.href} aria-current={e.active ? "page" : undefined}>
                  <span className="lbl">{e.label}</span>
                  {/* A count, where the rail has room for one. The drawer gets
                      a dot instead - see the badge policy in lib/nav. */}
                  {e.badge ? <span className={`cnt${e.tone ? ` ${e.tone}` : ""}`}>{e.badge}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </Fragment>
      ))}
    </nav>
  );
}
