"use client";

import { useEffect, useState } from "react";
import { saveUiLayout, type PanelArrangement } from "@/app/actions";

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
export default function PanelLayout({ viewKey, panels, defaultRight, saved, groups, pinned = [] }: {
  viewKey: string;
  panels: Panel[];
  /** Keys that start in the right-hand column. */
  defaultRight: string[];
  /** This person's stored arrangement, or null for the defaults. */
  saved: PanelArrangement | null;
  /**
   * Tabs. A record page grew to fifteen panels, which is three screens of
   * scroll and none of it findable; grouped, each tab is one working context -
   * the work, the equipment, the paper, the log. Panels stay mounted when
   * their tab is inactive (hidden, not unmounted), so a half-typed note
   * survives flipping away and back. Omit for the old single-page layout.
   */
  groups?: PanelGroup[];
  /** Keys that render above the tabs on every tab - the record's identity. */
  pinned?: string[];
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

  // The active tab lives in the URL hash, so "the maintenance tab of T-003"
  // is a link somebody can send. Initialized after mount rather than in state
  // (the server render has no hash to read), which costs one paint on a
  // deep-link and nothing otherwise.
  const [active, setActive] = useState(groups?.[0]?.key ?? "");
  useEffect(() => {
    if (!groups?.length) return;
    const apply = () => {
      const fromHash = window.location.hash.replace("#", "");
      if (groups.some((g) => g.key === fromHash)) setActive(fromHash);
    };
    apply();
    // Hash-only navigation (back/forward, a #documents link clicked on the
    // page itself) never remounts the component, so the listener is the only
    // thing that hears it.
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pickTab = (key: string) => {
    setActive(key);
    history.replaceState(null, "", `#${key}`);
  };
  /** Which tab a panel belongs to; strays land on the first tab, never vanish. */
  const groupOf = (key: string): string => {
    if (!groups?.length || pinned.includes(key)) return "";
    return groups.find((g) => g.keys.includes(key))?.key ?? groups[0].key;
  };
  // While arranging, every panel shows - moving a panel you cannot see is a
  // guessing game - and the tabs read as labels for where things will land.
  const tabbed = !!groups?.length;
  const visibleNow = (key: string) => !tabbed || editing || groupOf(key) === "" || groupOf(key) === active;

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
        style={visibleNow(key) ? undefined : { display: "none" }}
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

      {/* The record's identity rides above the tabs - whatever tab is open,
          you can still see what you're looking at. Same grid, same widths. */}
      {tabbed && !editing && pinned.length > 0 && (
        <div className="panel-cols">
          <div>{left.filter((k) => pinned.includes(k)).map(slot)}</div>
          <div>{rightCol.filter((k) => pinned.includes(k)).map(slot)}</div>
        </div>
      )}

      {tabbed && !editing && (
        <div className="subtabs" style={{ marginBottom: 10, flexWrap: "wrap" }}>
          {groups!.map((g) => {
            const tone = g.badgeTone ?? "info";
            const badgeStyle = tone === "bad" ? { background: "#FBE9E9", color: "#A32D2D" }
              : tone === "warn" ? { background: "#FAF0DC", color: "#8A5410" }
              : { background: "#E7F2FA", color: "#1D6396" };
            return (
              <button key={g.key} className={`subtab${active === g.key ? " active" : ""}`}
                aria-pressed={active === g.key} onClick={() => pickTab(g.key)}>
                {g.label}
                {g.badge !== undefined && g.badge !== 0 && (
                  <span className="pill" style={{ ...badgeStyle, marginLeft: 6 }}>{g.badge}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="panel-cols">
        <div>{(tabbed && !editing ? left.filter((k) => !pinned.includes(k)) : left).map(slot)}{tail(false)}</div>
        <div>{(tabbed && !editing ? rightCol.filter((k) => !pinned.includes(k)) : rightCol).map(slot)}{tail(true)}</div>
      </div>
    </>
  );
}
