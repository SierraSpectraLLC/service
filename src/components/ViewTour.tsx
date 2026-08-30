"use client";

import { useTransition } from "react";
import { dismissViewTour } from "@/app/actions";
import { VIEW_BLURB, VIEW_LABEL, type ViewMode } from "@/lib/viewMode";

/**
 * "This is the view you're in, and here is how to change it." Once.
 *
 * The switch lives in the account menu, behind an avatar, which is the right
 * home for a personal setting and the wrong place to DISCOVER one. Somebody
 * started in a view by their operator has no reason to suspect there is
 * another, and the failure mode is silent: they use the wrong half of the app
 * and conclude it is the app.
 *
 * So it is said out loud, on the page they land on, once - and it names the
 * view rather than gesturing at "settings", because the useful sentence is
 * which shape they are in and what the other one is FOR. A tour that only
 * pointed at a menu would teach somebody where to click without telling them
 * why they would want to.
 *
 * Dismissed by reading it. There is no second step and no "next": three
 * sentences about a menu do not earn a carousel.
 */
export default function ViewTour({ mode, others, assigned }: {
  /** The view they are in right now. */
  mode: ViewMode;
  /** The ones they could switch to. */
  others: ViewMode[];
  /** True when their operator chose this starting point, not their company. */
  assigned: boolean;
}) {
  const [going, start] = useTransition();

  return (
    <div className="container" style={{ paddingBottom: 0 }}>
      <div className="card" style={{ borderLeft: "3px solid var(--t-accent-fg)" }}>
        <div className="row-2" style={{ alignItems: "baseline", marginBottom: 4 }}>
          <span className="card-title">You&apos;re in the {VIEW_LABEL[mode].toLowerCase()} view</span>
          <span className="sp" />
          <button className="btn link t-meta" disabled={going}
            onClick={() => start(async () => { await dismissViewTour(); })}>
            {going ? "…" : "Got it"}
          </button>
        </div>
        <div className="t-body">
          {VIEW_BLURB[mode]}.{" "}
          {assigned
            ? "Somebody set this as your starting point"
            : "This is what your company works on"}
          , and you can change it whenever you like.
        </div>
        <div className="t-body" style={{ marginTop: 6 }}>
          {others.length === 1 ? "The other one is" : "The others are"}{" "}
          {others.map((o, i) => (
            <span key={o}>
              {i > 0 && (i === others.length - 1 ? " and " : ", ")}
              <b>{VIEW_LABEL[o]}</b> - {VIEW_BLURB[o].toLowerCase()}
            </span>
          ))}.
          {" "}Switch between them under your initials, top right, in{" "}
          <b>Your view</b>. It changes what these pages lead with, never what
          you can see.
        </div>
      </div>
    </div>
  );
}
