"use client";

import { useOptimistic, useTransition } from "react";
import { setMyViewMode } from "@/app/actions";
import { VIEW_BLURB, VIEW_LABEL, type ViewMode } from "@/lib/viewMode";

/**
 * Which half of the app I work in, on a company that does both.
 *
 * In the account menu rather than in Settings, and beside the persona switcher
 * rather than under it, because it is the same kind of thing from the other
 * side: that one is "let me look as somebody else", this is "this is who I
 * am". Both are about what the screen shows you and neither is a permission.
 *
 * The current one is stated rather than implied by a highlight - somebody
 * opening this menu is usually here because the app is showing them the wrong
 * thing, and the first useful sentence is which thing it thinks they want.
 */
export default function ViewSwitch({ mode, modes, orgName }: {
  /** The mode in force right now, already resolved from the org's default. */
  mode: ViewMode;
  /** The views this person's company has at all. See lib/viewMode.availableViews. */
  modes: ViewMode[];
  orgName: string;
}) {
  const [pending, start] = useTransition();
  const [shown, choose] = useOptimistic(mode, (_cur: ViewMode, next: ViewMode) => next);

  return (
    <div className="menu-sub" onClick={(e) => e.stopPropagation()}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>Your view</div>
      <div className="mut t-meta" style={{ marginBottom: 6 }}>
        Pick the one you work from - it changes what these pages lead with,
        not what you can see.
      </div>
      {modes.map((m) => (
        <button
          key={m}
          type="button"
          disabled={pending}
          aria-pressed={shown === m}
          onClick={() => {
            if (shown === m) return;
            start(async () => {
              choose(m);
              await setMyViewMode(m);
            });
          }}
          style={{
            width: "100%", textAlign: "left", padding: "6px 8px", borderRadius: 8,
            border: "1px solid var(--line)", marginBottom: 4, cursor: "pointer",
            background: shown === m ? "var(--t-accent-bg)" : "transparent",
            color: shown === m ? "var(--t-accent-fg)" : "inherit",
            fontWeight: shown === m ? 700 : 400,
          }}
        >
          <div className="t-body">{VIEW_LABEL[m]}</div>
          <div className="t-meta" style={{ opacity: 0.75 }}>{VIEW_BLURB[m]}</div>
        </button>
      ))}
      {/* The way back to "whatever my company is", so a choice made once is not
          a choice somebody is stuck with when the company changes shape. */}
      <button type="button" className="btn link t-meta" disabled={pending}
        onClick={() => start(async () => { await setMyViewMode(""); })}>
        Follow {orgName}&apos;s default
      </button>
    </div>
  );
}
