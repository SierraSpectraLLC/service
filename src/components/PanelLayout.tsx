"use client";

import { useState } from "react";
import { saveUiLayout, type PanelArrangement } from "@/app/actions";

export type Panel = { key: string; label: string; node: React.ReactNode };

/**
 * Two-column shell for the long record pages, arranged by the person reading.
 *
 * The panels arrive already rendered - they're server components passed in as
 * nodes - so moving or hiding one is pure DOM placement. Nothing re-fetches and
 * no panel loses the state inside it when the layout changes.
 *
 * The arrangement is stored per PERSON (ui_layouts, keyed on their sign-in
 * email) and read on the server, so the page arrives already arranged and
 * follows them from the bench PC to a laptop. `saved` is that row.
 *
 * Below 1200px CSS collapses the two stacks into one and the cards fall in DOM
 * order - left column, then right - so `defaultRight` has to be chosen to read
 * correctly flattened, not just side by side.
 */
export default function PanelLayout({ viewKey, panels, defaultRight, saved }: {
  viewKey: string;
  panels: Panel[];
  /** Keys that start in the right-hand column. */
  defaultRight: string[];
  /** This person's stored arrangement, or null for the defaults. */
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
    };
  });
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  // Optimistic: the arrangement is already on screen, and a failed save is not
  // worth interrupting anyone over - the next change retries the whole shape.
  const persist = (next: PanelArrangement) => {
    setLayout(next);
    void saveUiLayout(viewKey, next).catch(() => {});
  };

  const reset = () => persist(defaults);

  const inRight = (k: string) => layout.right.includes(k);
  const isHidden = (k: string) => layout.hidden.includes(k);
  const shown = layout.order.filter((k) => !isHidden(k));
  const left = shown.filter((k) => !inRight(k));
  const rightCol = shown.filter(inRight);
  const hiddenKeys = layout.order.filter(isHidden);

  const byKey = new Map(panels.map((p) => [p.key, p]));
  const withRight = (right: string[]) => [...new Set(right)];

  const setColumn = (key: string, toRight: boolean) =>
    persist({
      ...layout,
      right: toRight ? withRight([...layout.right, key]) : layout.right.filter((k) => k !== key),
    });

  const setHidden = (key: string, hide: boolean) =>
    persist({
      ...layout,
      hidden: hide ? withRight([...layout.hidden, key]) : layout.hidden.filter((k) => k !== key),
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
      order,
      hidden: layout.hidden.filter((k) => k !== key),
      right: toRight ? withRight([...layout.right, key]) : layout.right.filter((k) => k !== key),
    });
  };

  const dropAtEnd = (key: string, toRight: boolean) => {
    const order = layout.order.filter((k) => k !== key);
    order.push(key);
    persist({
      order,
      hidden: layout.hidden.filter((k) => k !== key),
      right: toRight ? withRight([...layout.right, key]) : layout.right.filter((k) => k !== key),
    });
  };

  const gripBtn = (label: string, aria: string, onClick: () => void) => (
    <button className="btn link" style={{ fontSize: 14, padding: "0 5px" }} aria-label={aria} onClick={onClick}>
      {label}
    </button>
  );

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
            <span style={{ marginLeft: "auto", display: "flex", gap: 2, alignItems: "center" }}>
              {gripBtn("↑", `Move ${p.label} up`, () => nudge(key, -1))}
              {gripBtn("↓", `Move ${p.label} down`, () => nudge(key, 1))}
              {gripBtn(inRight(key) ? "←" : "→",
                `Move ${p.label} to the ${inRight(key) ? "left" : "right"} column`,
                () => setColumn(key, !inRight(key)))}
              <button className="btn link" style={{ fontSize: 11, padding: "0 5px", fontWeight: 700 }}
                aria-label={`Hide ${p.label}`} onClick={() => setHidden(key, true)}>Hide</button>
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
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        {/* Outside edit mode, the only hint that anything is hidden - otherwise
            a panel someone hid months ago is just missing. */}
        {!editing && hiddenKeys.length > 0 && (
          <button className="btn link" style={{ fontSize: 11 }} onClick={() => setEditing(true)}>
            {hiddenKeys.length} section{hiddenKeys.length === 1 ? "" : "s"} hidden
          </button>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {editing && (
            <>
              <span className="mut" style={{ fontSize: 11 }}>Drag a panel, or use its arrows. Saved to your account.</span>
              <button className="btn sm" onClick={reset}>Reset</button>
            </>
          )}
          <button className="btn sm" onClick={() => setEditing(!editing)}>
            {editing ? "Done" : "Rearrange"}
          </button>
        </span>
      </div>

      {editing && hiddenKeys.length > 0 && (
        <div className="card" style={{ padding: "10px 12px" }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Hidden here</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {hiddenKeys.map((k) => (
              <button key={k} className="btn sm" onClick={() => setHidden(k, false)}>
                {byKey.get(k)?.label ?? k} <span aria-hidden>＋</span>
              </button>
            ))}
          </div>
          <div className="mut" style={{ fontSize: 11, marginTop: 6 }}>
            Hidden for you only, and nothing stops being recorded - a hidden panel&apos;s
            work still happens and still shows on packets and reports.
          </div>
        </div>
      )}

      <div className="panel-cols">
        <div>{left.map(slot)}{tail(false)}</div>
        <div>{rightCol.map(slot)}{tail(true)}</div>
      </div>
    </>
  );
}
