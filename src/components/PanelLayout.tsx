"use client";

import { useEffect } from "react";
import type { PanelArrangement } from "@/app/actions";
import { LAYOUT_EVENT } from "@/components/ui/HeroKebab";
import BandLayout from "@/components/BandLayout";
import RailLayout from "@/components/RailLayout";
import { usePanelArrangement, type Panel, type PanelGroup } from "@/components/usePanelArrangement";

export type { Panel, PanelGroup };

/**
 * The shell for the long record pages, arranged by the person reading.
 *
 * Two shapes, one set of panels, and this picks between them. BANDS lay every
 * panel down a single scroll under labelled headings; the RAIL shows one
 * working context at a time. Which one a person gets is their own saved
 * preference (ui_layouts, keyed on their sign-in email), defaulting per view -
 * see lib/panelMode, which both this and the server page read so the page
 * cannot arrive in one shape and flip to the other a frame later.
 *
 * The panels arrive already rendered - they're server components passed in as
 * nodes - so moving, hiding or switching shape is pure DOM placement. Nothing
 * re-fetches and no panel loses the state inside it.
 */
export default function PanelLayout({ viewKey, panels, defaultRight, saved, groups, pinned = [] }: {
  viewKey: string;
  panels: Panel[];
  /** Keys that start in the right-hand column. */
  defaultRight: string[];
  /** This person's stored arrangement, or null for the defaults. */
  saved: PanelArrangement | null;
  /**
   * The working contexts: the work, the equipment, the paper, the log. The
   * bands render them as headings down one page; the rail renders them as
   * destinations. Omit for the plain two-column layout, which has neither.
   */
  groups?: PanelGroup[];
  /** Keys that render above the contexts - the record's identity. */
  pinned?: string[];
}) {
  const a = usePanelArrangement({ viewKey, panels, defaultRight, saved });

  // Same pattern as arrange mode: the toggle lives in the record hero's kebab
  // and reaches this component through a window event, so the page does not
  // have to lift the whole layout state up to hold one boolean.
  // Deliberately no dependency array: the handler has to close over the
  // CURRENT mode and arrangement, and re-subscribing once per render is
  // cheaper than the stale-closure bug where the second flip does nothing.
  useEffect(() => {
    const on = () => a.setMode(a.mode === "rail" ? "bands" : "rail");
    window.addEventListener(LAYOUT_EVENT, on);
    return () => window.removeEventListener(LAYOUT_EVENT, on);
  });

  const gs = groups ?? [];
  // The rail needs contexts to be a rail. Without groups there is nothing to
  // put in it, so that page gets the two-column shape it always had.
  if (a.mode === "rail" && gs.length > 0) {
    return <RailLayout a={a} groups={gs} pinned={pinned} />;
  }
  return <BandLayout a={a} groups={gs} pinned={pinned} />;
}
