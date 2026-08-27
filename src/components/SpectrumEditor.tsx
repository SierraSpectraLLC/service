"use client";

import {
  DEFAULT_HEADER, DEFAULT_SPECTRUM_HEIGHT, DEFAULT_STOPS,
  MAX_SPECTRUM_HEIGHT, MAX_STOPS, gradientCss, type Stop,
} from "@/lib/appearance";
import { isValidHex } from "@/lib/theme";

/**
 * The gradient bar, edited.
 *
 * ONE editor, used by the platform's Configuration page and by an
 * organization's own appearance panel. It was inline in the platform form
 * first; copying it for organizations would have been two sets of controls
 * over one validated shape, and the copy is always the one that stops
 * clamping.
 *
 * `inheriting` is the third state that a colour picker cannot express. Blank
 * stops and a null height mean "follow the platform", which is different from
 * having chosen the platform's current values - the first keeps following when
 * the platform changes and the second does not. So the checkbox is the control
 * and the stops below it are disabled while it is on, rather than the stops
 * being cleared to something that looks the same and behaves differently.
 */
export default function SpectrumEditor({
  stops, height, onStops, onHeight, disabled = false,
  inheriting, onInheriting, inheritLabel,
}: {
  stops: Stop[];
  height: number;
  onStops: (next: Stop[]) => void;
  onHeight: (next: number) => void;
  disabled?: boolean;
  /**
   * Present only where inheriting is possible - an organization. The platform
   * has nothing above it to follow, so its editor omits these three and the
   * controls are always live.
   */
  inheriting?: boolean;
  onInheriting?: (next: boolean) => void;
  inheritLabel?: string;
}) {
  const off = disabled || inheriting === true;
  const setStop = (i: number, patch: Partial<Stop>) =>
    onStops(stops.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  const addStop = () => {
    if (stops.length >= MAX_STOPS) return;
    // The new band goes in the WIDEST GAP, which is where a person is reaching
    // when they press add - not always on the end. Appending to the end makes
    // the button feel broken on a gradient whose last two stops are adjacent.
    const sorted = [...stops].sort((a, b) => a.at - b.at);
    let at = 50, gap = -1;
    for (let i = 0; i < sorted.length - 1; i++) {
      const g = sorted[i + 1].at - sorted[i].at;
      if (g > gap) { gap = g; at = Math.round(sorted[i].at + g / 2); }
    }
    onStops([...stops, { c: sorted[Math.floor(sorted.length / 2)]?.c ?? DEFAULT_HEADER, at }]
      .sort((a, b) => a.at - b.at));
  };

  return (
    <div>
      {onInheriting && (
        <label className="t-small" style={{ display: "flex", alignItems: "center", gap: 6, margin: "0 0 8px", fontWeight: 400, color: "var(--ink)" }}>
          <input type="checkbox" checked={inheriting === true} disabled={disabled}
            style={{ width: "auto" }}
            onChange={(e) => onInheriting(e.target.checked)} />
          {inheritLabel ?? "Follow the platform's spectrum"}
        </label>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <span className="mut t-small">Thickness</span>
        <input type="range" min={0} max={MAX_SPECTRUM_HEIGHT} value={height} disabled={off}
          onChange={(e) => onHeight(parseInt(e.target.value))} style={{ width: 160 }} />
        <span className="mono t-small" style={{ minWidth: 34 }}>{height}px</span>
        {height === 0 && <span className="mut t-small">hidden</span>}
      </div>

      {stops.map((st, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderTop: "1px solid var(--line)" }}>
          <input type="color" value={isValidHex(st.c) ? st.c : DEFAULT_HEADER} disabled={off}
            onChange={(e) => setStop(i, { c: e.target.value.toUpperCase() })}
            style={{ width: 40, height: 26, padding: 2 }} />
          <input className="mono t-small" value={st.c} disabled={off}
            onChange={(e) => setStop(i, { c: e.target.value.toUpperCase() })}
            style={{ width: 100 }} />
          <input type="range" min={0} max={100} value={st.at} disabled={off}
            onChange={(e) => setStop(i, { at: parseInt(e.target.value) })}
            style={{ flex: "1 1 90px", minWidth: 80 }} />
          <span className="mono t-small" style={{ minWidth: 34 }}>{st.at}%</span>
          <button className="btn link" disabled={off || stops.length <= 1}
            onClick={() => onStops(stops.filter((_, n) => n !== i))}
            style={{ fontSize: 12 }}>remove</button>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
        <button className="btn sm" onClick={addStop} disabled={off || stops.length >= MAX_STOPS}>
          Add color
        </button>
        <button className="btn link" disabled={off} style={{ fontSize: 12 }}
          onClick={() => { onHeight(DEFAULT_SPECTRUM_HEIGHT); onStops(DEFAULT_STOPS); }}>
          reset to the stock gradient
        </button>
      </div>

      {/* The preview belongs beside the controls: nobody picks a five-stop
          gradient from a column of hex codes. */}
      <div style={{ marginTop: 10, borderRadius: 6, overflow: "hidden", border: "1px solid var(--line)" }}>
        <div style={{ height: Math.max(height, 1), background: gradientCss(stops) }} />
      </div>
    </div>
  );
}
