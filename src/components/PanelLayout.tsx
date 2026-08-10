"use client";

import { useEffect, useState } from "react";

export type Panel = { key: string; label: string; node: React.ReactNode };

type Layout = { order: string[]; right: string[] };

/**
 * Two-column shell for the long record pages, with the arrangement in the
 * reader's hands.
 *
 * The panels arrive already rendered - they're server components passed as
 * nodes - so moving one is pure DOM placement. Nothing re-fetches and no panel
 * loses its internal state when the layout changes.
 *
 * The arrangement lives in localStorage rather than the database on purpose: a
 * column split is a property of the SCREEN, not the account. The layout that
 * suits a 32" monitor is the wrong one on a 13" laptop, and the same person
 * uses both.
 *
 * Below 1200px CSS collapses the two stacks into one and the cards fall in DOM
 * order - left column, then right - so `defaultRight` has to be chosen to read
 * correctly when flattened, not just when side by side.
 */
export default function PanelLayout({ storageKey, panels, defaultRight }: {
  storageKey: string;
  panels: Panel[];
  /** Keys that start in the right-hand column. */
  defaultRight: string[];
}) {
  const known = panels.map((p) => p.key);
  const defaults: Layout = { order: known, right: defaultRight.filter((k) => known.includes(k)) };

  const [layout, setLayout] = useState<Layout>(defaults);
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  // Read after mount, never during render: touching localStorage in a state
  // initializer would make the server and client markup disagree.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<Layout>;
      const savedOrder = (saved.order ?? []).filter((k) => known.includes(k));
      setLayout({
        // A release that adds a panel must not hide it from anyone who has
        // saved a layout, so unknown-to-the-save keys land at the end.
        order: [...savedOrder, ...known.filter((k) => !savedOrder.includes(k))],
        right: (saved.right ?? []).filter((k) => known.includes(k)),
      });
    } catch {
      /* corrupt or unavailable storage just means the default arrangement */
    }
    // Panels are stable for a given page, so this runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const persist = (next: Layout) => {
    setLayout(next);
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* private mode */ }
  };

  const reset = () => {
    setLayout(defaults);
    try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
  };

  const inRight = (k: string) => layout.right.includes(k);
  const left = layout.order.filter((k) => !inRight(k));
  const rightCol = layout.order.filter(inRight);

  const byKey = new Map(panels.map((p) => [p.key, p]));

  const setColumn = (key: string, toRight: boolean) =>
    persist({
      order: layout.order,
      right: toRight ? [...new Set([...layout.right, key])] : layout.right.filter((k) => k !== key),
    });

  /** Move within the column the panel is already in, skipping the other one. */
  const nudge = (key: string, dir: -1 | 1) => {
    const col = inRight(key) ? rightCol : left;
    const at = col.indexOf(key);
    const swapWith = col[at + dir];
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
      order,
      right: toRight ? [...new Set([...layout.right, key])] : layout.right.filter((k) => k !== key),
    });
  };

  /** Drop at the end of a column. */
  const dropAtEnd = (key: string, toRight: boolean) => {
    const order = layout.order.filter((k) => k !== key);
    order.push(key);
    persist({
      order,
      right: toRight ? [...new Set([...layout.right, key])] : layout.right.filter((k) => k !== key),
    });
  };

  const slot = (key: string) => {
    const p = byKey.get(key);
    if (!p) return null;
    return (
      <div key={key}
        className={[
          "panel-slot",
          editing ? "editing" : "",
          drag === key ? "dragging" : "",
          editing && over === key && drag && drag !== key ? "dropbefore" : "",
        ].filter(Boolean).join(" ")}
        draggable={editing}
        onDragStart={() => setDrag(key)}
        onDragEnd={() => { setDrag(null); setOver(null); }}
        onDragOver={(e) => { if (editing && drag) { e.preventDefault(); setOver(key); } }}
        onDragLeave={() => setOver((k) => (k === key ? null : k))}
        onDrop={(e) => {
          if (!editing || !drag) return;
          e.preventDefault();
          dropBefore(drag, key);
          setDrag(null); setOver(null);
        }}
      >
        {editing && (
          <div className="panel-grip">
            <span aria-hidden style={{ letterSpacing: -1 }}>⠿</span>
            <span>{p.label}</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
              <button className="btn link" style={{ fontSize: 14, padding: "0 5px" }}
                aria-label={`Move ${p.label} up`} onClick={() => nudge(key, -1)}>↑</button>
              <button className="btn link" style={{ fontSize: 14, padding: "0 5px" }}
                aria-label={`Move ${p.label} down`} onClick={() => nudge(key, 1)}>↓</button>
              <button className="btn link" style={{ fontSize: 14, padding: "0 5px" }}
                aria-label={`Move ${p.label} to the ${inRight(key) ? "left" : "right"} column`}
                onClick={() => setColumn(key, !inRight(key))}>{inRight(key) ? "←" : "→"}</button>
            </span>
          </div>
        )}
        <div className="panel-body">{p.node}</div>
      </div>
    );
  };

  const tail = (toRight: boolean) => {
    if (!editing) return null;
    const id = toRight ? "__tail_right" : "__tail_left";
    return (
      <div className={`panel-drop-tail${over === id ? " over" : ""}`}
        onDragOver={(e) => { if (drag) { e.preventDefault(); setOver(id); } }}
        onDragLeave={() => setOver((k) => (k === id ? null : k))}
        onDrop={(e) => {
          if (!drag) return;
          e.preventDefault();
          dropAtEnd(drag, toRight);
          setDrag(null); setOver(null);
        }}
        aria-hidden
      />
    );
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {editing && (
            <>
              <span className="mut" style={{ fontSize: 11 }}>
                Drag a panel, or use its arrows. Saved for this browser.
              </span>
              <button className="btn sm" onClick={reset}>Reset</button>
            </>
          )}
          <button className="btn sm" onClick={() => setEditing(!editing)}>
            {editing ? "Done" : "Rearrange"}
          </button>
        </span>
      </div>

      <div className="panel-cols">
        <div>{left.map(slot)}{tail(false)}</div>
        <div>{rightCol.map(slot)}{tail(true)}</div>
      </div>
    </>
  );
}
