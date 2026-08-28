"use client";

import { useEffect, useRef, useState } from "react";
import { ArrangeBar, panelSlot, panelTail } from "@/components/PanelSlot";
import { useMeasuredHeight } from "@/components/useMeasuredHeight";
import type { Arrangement, PanelGroup } from "@/components/usePanelArrangement";

/**
 * One working context at a time, with the rest a click away down the side.
 *
 * The record page grew to sixteen panels. Banded, that is three screens of
 * scroll however well the bands are labelled, and on a phone the jump bar
 * wraps into three sticky rows that eat a third of the viewport before a word
 * of the record is visible. The rail trades "everything is on the page" for
 * "the thing you came for is the whole page", which is the trade a person
 * standing at a bench with a phone in one hand actually wants.
 *
 * What it does NOT do is skip work: the panels arrive already rendered from
 * the server, so a hidden context has already been queried. Making the rail
 * cheaper means restructuring the page's fetching per context, which is a
 * separate change and deliberately not this one.
 */
export default function RailLayout({ a, groups, pinned }: {
  a: Arrangement;
  groups: PanelGroup[];
  pinned: string[];
}) {
  // Below 960px the rail stops being a side column and stacks above the pane,
  // stuck to the top of the viewport - so at those widths it is the thing the
  // pane has to clear when a context change scrolls it back into view.
  const railRef = useMeasuredHeight<HTMLElement>("--rail-h");
  // useMeasuredHeight hands out a callback ref, so the element itself needs a
  // second home for the scroll-into-view effect below.
  const navEl = useRef<HTMLElement | null>(null);
  const setRail = (el: HTMLElement | null) => { navEl.current = el; railRef(el); };

  /**
   * A context with nothing in it renders no button. The band layout's bar got
   * this wrong for years - it mapped every group, and a group whose panels
   * were all hidden rendered no section, so its button scrolled to a null
   * element and did nothing at all.
   */
  const live = groups.filter((g) => g.keys.some((k) => a.shown.includes(k) && !pinned.includes(k)));
  const first = live[0]?.key ?? "";
  const [active, setActive] = useState(first);

  // A deep link lands on its context; Back steps between contexts rather than
  // leaving the record, because these are destinations now.
  useEffect(() => {
    const fromHash = () => {
      const key = window.location.hash.replace("#", "");
      return live.some((g) => g.key === key) ? key : first;
    };
    setActive(fromHash());
    const on = () => setActive(fromHash());
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, live.length]);

  // A context that empties out while it is open (its last panel hidden in
  // arrange mode) must not leave the pane blank with no way back.
  const current = live.find((g) => g.key === active) ?? live[0];

  // On a phone the rail is one sideways-scrolling row, and a deep link can
  // land on a tab past its right edge - active but out of sight, which reads
  // as no tab being active at all. Bring it into the row; block "nearest" so
  // the page's own scroll position is left alone.
  useEffect(() => {
    navEl.current?.querySelector('button[aria-current="true"]')
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [current?.key]);

  const go = (key: string) => {
    setActive(key);
    if (window.location.hash !== `#${key}`) history.pushState({ key }, "", `#${key}`);
    /**
     * Scrolls UP only, and never past the top of the pane. Someone reading the
     * bottom of a long Files context who switches to Work would otherwise be
     * left wherever the old scroll position happened to land in the new
     * content; someone already at the top of the record would be yanked down
     * past the hero and the standing line by an unconditional "align to top".
     * The pane's scroll-margin keeps it clear of the rail where the rail is
     * stuck above it.
     */
    const pane = document.getElementById("pane");
    if (pane && pane.getBoundingClientRect().top < 0) {
      pane.scrollIntoView({ block: "start", behavior: "auto" });
    }
  };

  const slot = (k: string) => panelSlot(a, k);
  /**
   * CSS multi-column gives a lone card one of two columns, so a context with a
   * single panel renders half-width with nothing beside it - which reads as a
   * page that failed to finish loading. One card, one column.
   */
  const flowClass = (n: number) => (n > 1 ? "panel-flow" : "panel-flow one");
  const inContext = (g: PanelGroup) => (k: string) => !pinned.includes(k) && g.keys.includes(k);
  /** A panel in no group at all still belongs somewhere - the first context. */
  const orphan = (k: string) =>
    !pinned.includes(k) && !groups.some((g) => g.keys.includes(k));

  return (
    <>
      <ArrangeBar a={a} />

      {/* The record's identity rides above every context, same as it rode
          above the section bar - what you are looking at was established on
          the way in, wherever you go next. */}
      {pinned.length > 0 && (
        a.editing ? (
          <div className="panel-cols">
            <div>{a.left.filter((k: string) => pinned.includes(k)).map(slot)}</div>
            <div>{a.rightCol.filter((k: string) => pinned.includes(k)).map(slot)}</div>
          </div>
        ) : (
          <div className={flowClass(
            [...a.left, ...a.rightCol].filter((k: string) => pinned.includes(k)).length)}>
            {[...a.left, ...a.rightCol].filter((k: string) => pinned.includes(k)).map(slot)}
          </div>
        )
      )}

      {/* Arrange mode drops the rail and shows everything at once: you cannot
          drag a panel into a context you cannot see, and hunting for the card
          you just hid is the opposite of arranging. */}
      {a.editing ? (
        <div className="panel-cols">
          <div>{a.left.filter((k: string) => !pinned.includes(k)).map(slot)}{panelTail(a, false)}</div>
          <div>{a.rightCol.filter((k: string) => !pinned.includes(k)).map(slot)}{panelTail(a, true)}</div>
        </div>
      ) : (
        <div className="rail-body">
          <nav className="rail" aria-label="Sections of this record" ref={setRail}>
            <div className="railhead">This record</div>
            <ul>
              {live.map((g) => {
                const on = current?.key === g.key;
                const tone = g.badgeTone ?? "neutral";
                return (
                  <li key={g.key}>
                    <button type="button" aria-current={on} onClick={() => go(g.key)}>
                      <span className="lbl">{g.label}</span>
                      {g.badge !== undefined && g.badge !== 0 && (
                        <span className={`cnt ${tone}`}>{g.badge}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <main className="pane" id="pane">
            {live.map((g) => {
              const mine = inContext(g);
              const l = a.left.filter((k: string) => mine(k) || (g.key === first && orphan(k)));
              const r = a.rightCol.filter((k: string) => mine(k) || (g.key === first && orphan(k)));
              return (
                <section key={g.key} hidden={current?.key !== g.key} aria-label={g.label} className="view">
                  <div className={flowClass(l.length + r.length)}>{[...l, ...r].map(slot)}</div>
                </section>
              );
            })}
          </main>
        </div>
      )}
    </>
  );
}
