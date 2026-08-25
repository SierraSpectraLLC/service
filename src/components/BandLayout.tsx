"use client";

import { useEffect, useState } from "react";
import { ArrangeBar, panelSlot, panelTail } from "@/components/PanelSlot";
import { useMeasuredHeight } from "@/components/useMeasuredHeight";
import type { Arrangement, PanelGroup } from "@/components/usePanelArrangement";

/**
 * Every panel down one page, in labelled bands, with a sticky bar that jumps
 * between them.
 *
 * Nothing is hidden, and that is the argument for it: flipping to check a part
 * number must not lose sight of the task it was for, and a scroll position is
 * a place the browser already knows how to restore. This is the shape the
 * record pages shipped with; it is now one of two, and it is unchanged apart
 * from the two fixes noted below.
 */
export default function BandLayout({ a, groups, pinned }: {
  a: Arrangement;
  groups: PanelGroup[];
  pinned: string[];
}) {
  const banded = groups.length > 0;
  const [active, setActive] = useState(groups[0]?.key ?? "");
  // The bar is the only thing stuck to the top of a banded record, so it is
  // the bar the band anchors have to clear when they are jumped to.
  const headRef = useMeasuredHeight<HTMLElement>("--head-h");

  useEffect(() => {
    if (!banded) return;
    // Deep link: #documents scrolls to the band on arrival.
    const fromHash = window.location.hash.replace("#", "");
    if (groups.some((g) => g.key === fromHash)) {
      document.getElementById(`band-${fromHash}`)?.scrollIntoView();
    }
    // Scroll-spy: the bar highlights the band under the reader as they
    // scroll, so it doubles as a "you are here".
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting)
          .sort((x, y) => x.boundingClientRect.top - y.boundingClientRect.top)[0];
        if (hit) setActive(hit.target.id.replace("band-", ""));
      },
      { rootMargin: "-64px 0px -60% 0px" },
    );
    for (const g of groups) {
      const el = document.getElementById(`band-${g.key}`);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [banded]);

  const jumpTo = (key: string) => {
    setActive(key);
    history.replaceState(null, "", `#${key}`);
    document.getElementById(`band-${key}`)?.scrollIntoView({ behavior: "smooth" });
  };

  /** Which band a panel belongs to; strays land on the first band, never vanish. */
  const groupOf = (key: string): string => {
    if (!banded || pinned.includes(key)) return "";
    return groups.find((g) => g.keys.includes(key))?.key ?? groups[0].key;
  };

  /**
   * A band with every panel hidden renders nothing, so its button had nothing
   * to scroll to and silently did nothing when pressed. Maintenance is a
   * one-panel band, which put that one click away from any reader who hid it.
   */
  const hasContent = (g: PanelGroup) => g.keys.some((k) => a.shown.includes(k));

  const slot = (k: string) => panelSlot(a, k);

  return (
    <>
      <ArrangeBar a={a} />

      {/* The record's identity rides above the section bar - wherever you
          scroll, what you're looking at was established on the way in. */}
      {banded && pinned.length > 0 && (
        a.editing ? (
          <div className="panel-cols">
            <div>{a.left.filter((k: string) => pinned.includes(k)).map(slot)}</div>
            <div>{a.rightCol.filter((k: string) => pinned.includes(k)).map(slot)}</div>
          </div>
        ) : (
          <div className="panel-flow">
            {[...a.left, ...a.rightCol].filter((k: string) => pinned.includes(k)).map(slot)}
          </div>
        )
      )}

      {banded && !a.editing && (
        <nav className="section-bar" aria-label="Page sections" ref={headRef}>
          {groups.filter(hasContent).map((g) => {
            const tone = g.badgeTone ?? "info";
            return (
              <button key={g.key} className={`subtab${active === g.key ? " active" : ""}`}
                aria-current={active === g.key} onClick={() => jumpTo(g.key)}>
                {g.label}
                {g.badge !== undefined && g.badge !== 0 && (
                  <span className={`pill ${tone}`} style={{ marginLeft: 6 }}>{g.badge}</span>
                )}
              </button>
            );
          })}
        </nav>
      )}

      {banded ? (
        <>
          {groups.map((g) => {
            const bandKeys = (k: string) => groupOf(k) === g.key;
            const l = a.left.filter(bandKeys);
            const r = a.rightCol.filter(bandKeys);
            if (!l.length && !r.length && !a.editing) return null;
            return (
              /* .band-anchor takes its scroll offset from the bar's MEASURED
                 height, not a hard-coded 52 - which was wrong the moment the
                 bar wrapped to a second row, as it does on any phone. */
              <section key={g.key} id={`band-${g.key}`} aria-label={g.label} className="band-anchor">
                <div className="band-label">{g.label}</div>
                {a.editing ? (
                  <div className="panel-cols">
                    <div>{l.map(slot)}</div>
                    <div>{r.map(slot)}</div>
                  </div>
                ) : (
                  /* Order is still the saved arrangement (left stack, then
                     right); only the geometry balances itself. */
                  <div className="panel-flow">{[...l, ...r].map(slot)}</div>
                )}
              </section>
            );
          })}
          {a.editing && (
            <div className="panel-cols">
              <div>{panelTail(a, false)}</div>
              <div>{panelTail(a, true)}</div>
            </div>
          )}
        </>
      ) : (
        <div className="panel-cols">
          <div>{a.left.map(slot)}{panelTail(a, false)}</div>
          <div>{a.rightCol.map(slot)}{panelTail(a, true)}</div>
        </div>
      )}
    </>
  );
}
