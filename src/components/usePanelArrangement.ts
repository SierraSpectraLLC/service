"use client";

import { useEffect, useState } from "react";
import { saveUiLayout, type PanelArrangement } from "@/app/actions";
import { ARRANGE_EVENT } from "@/components/ui/HeroKebab";
import { modeFor, type PanelMode } from "@/lib/panelMode";

export type Panel = { key: string; label: string; node: React.ReactNode };

/**
 * One tab of a record page. `badge` is the tab's reason to be visited now -
 * open work, unread posts - so flipping between tabs is navigation, not
 * hunting. Tone colors the badge: "bad" for overdue-grade attention.
 */
export type PanelGroup = {
  key: string; label: string; keys: string[];
  badge?: number | string; badgeTone?: "info" | "warn" | "bad";
};

/**
 * Everything two layouts of the same panels have to agree about: what is
 * hidden, what sits where, what is being dragged, and which shape the page is
 * in.
 *
 * Extracted rather than duplicated because the parts that are easy to get
 * subtly different are the parts nobody looks at twice - the unknown-key
 * merge that keeps a newly shipped panel visible to somebody who saved a
 * layout before it existed, and the optimistic save. Two copies of those drift,
 * and the drift shows up as a panel that vanishes for one person on one page.
 */
export function usePanelArrangement({ viewKey, panels, defaultRight, saved }: {
  viewKey: string;
  panels: Panel[];
  defaultRight: string[];
  saved: PanelArrangement | null;
}) {
  const known = panels.map((p) => p.key);
  const defaults: PanelArrangement = {
    order: known,
    right: defaultRight.filter((k) => known.includes(k)),
    hidden: [],
  };

  const [layout, setLayout] = useState<PanelArrangement>(() => {
    if (!saved) return defaults;
    const order = (saved.order ?? []).filter((k) => known.includes(k));
    return {
      // A release that adds a panel must not hide it from anyone who saved a
      // layout before it existed, so unknown-to-the-save keys land at the end.
      order: [...order, ...known.filter((k) => !order.includes(k))],
      right: (saved.right ?? []).filter((k) => known.includes(k)),
      hidden: (saved.hidden ?? []).filter((k) => known.includes(k)),
      mode: saved.mode,
    };
  });

  const [editing, setEditing] = useState(false);
  // The toggle lives in the record hero's kebab now; the event is how it
  // reaches this component without lifting the whole layout state up.
  useEffect(() => {
    const on = () => setEditing((v) => !v);
    window.addEventListener(ARRANGE_EVENT, on);
    return () => window.removeEventListener(ARRANGE_EVENT, on);
  }, []);

  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  // Optimistic: the arrangement is already on screen, and a failed save is not
  // worth interrupting anyone over - the next change retries the whole shape.
  const persist = (next: PanelArrangement) => {
    setLayout(next);
    void saveUiLayout(viewKey, next).catch(() => {});
  };

  const mode: PanelMode = modeFor(viewKey, layout);
  /** Flip the page's shape, and remember it. Arrange mode ends with it. */
  const setMode = (next: PanelMode) => {
    setEditing(false);
    persist({ ...layout, mode: next });
  };

  const reset = () => persist({ ...defaults, mode: layout.mode });

  const inRight = (k: string) => layout.right.includes(k);
  const isHidden = (k: string) => layout.hidden.includes(k);
  const shown = layout.order.filter((k) => !isHidden(k));
  const left = shown.filter((k) => !inRight(k));
  const rightCol = shown.filter(inRight);
  const hiddenKeys = layout.order.filter(isHidden);

  const byKey = new Map(panels.map((p) => [p.key, p]));
  const dedupe = (list: string[]) => [...new Set(list)];

  const setColumn = (key: string, toRight: boolean) =>
    persist({
      ...layout,
      right: toRight ? dedupe([...layout.right, key]) : layout.right.filter((k) => k !== key),
    });

  const setHidden = (key: string, hide: boolean) =>
    persist({
      ...layout,
      hidden: hide ? dedupe([...layout.hidden, key]) : layout.hidden.filter((k) => k !== key),
    });

  /** Move within the column it's already in, skipping over the other one. */
  const nudge = (key: string, dir: -1 | 1) => {
    const col = inRight(key) ? rightCol : left;
    const swapWith = col[col.indexOf(key) + dir];
    if (swapWith === undefined) return;
    const order = [...layout.order];
    const a = order.indexOf(key), b = order.indexOf(swapWith);
    order[a] = swapWith; order[b] = key;
    persist({ ...layout, order });
  };

  /** Drop `key` immediately before `target`, adopting the target's column. */
  const dropBefore = (key: string, target: string) => {
    if (key === target) return;
    const order = layout.order.filter((k) => k !== key);
    order.splice(order.indexOf(target), 0, key);
    const toRight = inRight(target);
    persist({
      ...layout,
      order,
      hidden: layout.hidden.filter((k) => k !== key),
      right: toRight ? dedupe([...layout.right, key]) : layout.right.filter((k) => k !== key),
    });
  };

  const dropAtEnd = (key: string, toRight: boolean) => {
    const order = layout.order.filter((k) => k !== key);
    order.push(key);
    persist({
      ...layout,
      order,
      hidden: layout.hidden.filter((k) => k !== key),
      right: toRight ? dedupe([...layout.right, key]) : layout.right.filter((k) => k !== key),
    });
  };

  return {
    layout, mode, setMode,
    editing, setEditing,
    drag, setDrag, over, setOver,
    shown, left, rightCol, hiddenKeys, byKey,
    inRight, isHidden,
    reset, setColumn, setHidden, nudge, dropBefore, dropAtEnd,
  };
}

export type Arrangement = ReturnType<typeof usePanelArrangement>;
