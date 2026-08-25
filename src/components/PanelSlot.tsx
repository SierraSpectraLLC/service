"use client";

import type { Arrangement } from "@/components/usePanelArrangement";

/**
 * One panel in its slot, plus the grip that appears in arrange mode.
 *
 * Shared by both layouts on purpose: the drag handlers and the grip's arrows
 * are the fiddly part, and a rail whose drag behaved a little differently from
 * a band's would be a second thing to learn for no reason. The panel node
 * itself is already-rendered server JSX - moving it is DOM placement, so
 * nothing refetches and nothing inside loses its state.
 */
export function panelSlot(a: Arrangement, key: string) {
  const p = a.byKey.get(key);
  if (!p) return null;
  const gripBtn = (label: string, aria: string, onClick: () => void) => (
    <button className="btn link" style={{ fontSize: "var(--fs-lead)", padding: "0 5px" }}
      aria-label={aria} onClick={onClick}>
      {label}
    </button>
  );
  return (
    <div key={key}
      className={[
        "panel-slot",
        a.editing ? "editing" : "",
        a.drag === key ? "dragging" : "",
        a.editing && a.over === key && a.drag && a.drag !== key ? "dropbefore" : "",
      ].filter(Boolean).join(" ")}
      draggable={a.editing}
      onDragStart={() => a.setDrag(key)}
      onDragEnd={() => { a.setDrag(null); a.setOver(null); }}
      onDragOver={(e) => { if (a.editing && a.drag) { e.preventDefault(); a.setOver(key); } }}
      onDragLeave={() => a.setOver((k: string | null) => (k === key ? null : k))}
      onDrop={(e) => {
        if (!a.editing || !a.drag) return;
        e.preventDefault();
        a.dropBefore(a.drag, key);
        a.setDrag(null); a.setOver(null);
      }}
    >
      {a.editing && (
        <div className="panel-grip">
          <span aria-hidden style={{ letterSpacing: -1 }}>⠿</span>
          <span>{p.label}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 2, alignItems: "center" }}>
            {gripBtn("↑", `Move ${p.label} up`, () => a.nudge(key, -1))}
            {gripBtn("↓", `Move ${p.label} down`, () => a.nudge(key, 1))}
            {gripBtn(a.inRight(key) ? "←" : "→",
              `Move ${p.label} to the ${a.inRight(key) ? "left" : "right"} column`,
              () => a.setColumn(key, !a.inRight(key)))}
            <button className="btn link" style={{ padding: "0 5px", fontWeight: 700 }}
              aria-label={`Hide ${p.label}`} onClick={() => a.setHidden(key, true)}>Hide</button>
          </span>
        </div>
      )}
      <div className="panel-body">{p.node}</div>
    </div>
  );
}

/** The drop zone past the last card in a column, so "put it at the end" exists. */
export function panelTail(a: Arrangement, toRight: boolean) {
  if (!a.editing) return null;
  const id = toRight ? "__tail_right" : "__tail_left";
  return (
    <div className={`panel-drop-tail${a.over === id ? " over" : ""}`}
      onDragOver={(e) => { if (a.drag) { e.preventDefault(); a.setOver(id); } }}
      onDragLeave={() => a.setOver((k: string | null) => (k === id ? null : k))}
      onDrop={(e) => {
        if (!a.drag) return;
        e.preventDefault();
        a.dropAtEnd(a.drag, toRight);
        a.setDrag(null); a.setOver(null);
      }}
      aria-hidden
    />
  );
}

/**
 * The strip above both layouts: the standing "something is hidden" hint, and
 * arrange mode's own controls. Identical in either shape, so it lives once.
 */
export function ArrangeBar({ a }: { a: Arrangement }) {
  if (!a.editing && a.hiddenKeys.length === 0) return null;
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        {!a.editing && a.hiddenKeys.length > 0 && (
          <button className="btn link" onClick={() => a.setEditing(true)}>
            {a.hiddenKeys.length} section{a.hiddenKeys.length === 1 ? "" : "s"} hidden
          </button>
        )}
        {a.editing && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            <span className="mut t-meta">Drag a panel, or use its arrows. Saved to your account.</span>
            <button className="btn sm" onClick={a.reset}>Reset</button>
            <button className="btn sm" onClick={() => a.setEditing(false)}>Done</button>
          </span>
        )}
      </div>

      {a.editing && a.hiddenKeys.length > 0 && (
        <div className="card" style={{ padding: "10px 12px" }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Hidden here</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {a.hiddenKeys.map((k: string) => (
              <button key={k} className="btn sm" onClick={() => a.setHidden(k, false)}>
                {a.byKey.get(k)?.label ?? k} <span aria-hidden>＋</span>
              </button>
            ))}
          </div>
          <div className="mut t-meta" style={{ marginTop: 6 }}>
            Hidden for you only, and nothing stops being recorded - a hidden panel&apos;s
            work still happens and still shows on packets and reports.
          </div>
        </div>
      )}
    </>
  );
}
