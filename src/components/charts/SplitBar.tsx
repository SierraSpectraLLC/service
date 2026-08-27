"use client";

import { useState } from "react";
import { inkOn } from "@/lib/chartPalette";
import { labelFits } from "@/lib/ownerCharts";
import { formatCents } from "@/lib/money";

export type Slice = { key: string; label: string; cents: number; share: number; color: string };

/**
 * One bar, split into ordered bands - an ageing ladder, a pipeline.
 *
 * HTML rather than SVG, because every mark here is a rectangle and every label
 * is text: an SVG would buy nothing and cost crisp type at every width. The
 * separation between bands is a 2px gap in the SURFACE colour, not a stroke - a
 * border around a mark adds ink that is not data, and at this size it reads as
 * a grid.
 *
 * A label goes inside a band only when it MEASURES as fitting. It is never
 * clipped and never shrunk: a band too narrow for its words carries no words,
 * and the legend under the bar and the tooltip on it both still say what it is.
 */
export default function SplitBar({ slices, totalCents, unit = "of what you are owed" }: {
  slices: Slice[];
  totalCents: number;
  /** What the whole bar is, said once, under it. */
  unit?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  if (!slices.length) return null;

  return (
    <div>
      <div className="split-bar" role="img"
        aria-label={slices.map((s) => `${s.label} ${formatCents(s.cents)}`).join(", ")}>
        {slices.map((s) => {
          // The rendered width in pixels is not knowable here, so the fit is
          // measured against the share of a conservative 600px bar. Erring
          // narrow means a label lands outside when it would just have fitted;
          // erring wide means it gets clipped, which is worse.
          const inside = labelFits(s.label, s.share * 600);
          return (
            <div
              key={s.key}
              className="split-seg"
              style={{ width: `${Math.max(s.share * 100, 1.5)}%`, background: s.color }}
              onMouseEnter={() => setHover(s.key)}
              onMouseLeave={() => setHover(null)}
              title={`${s.label} — ${formatCents(s.cents)}`}
            >
              {inside && (
                <span className="split-seg-label" style={{ color: inkOn(s.color) }}>
                  {s.label}
                </span>
              )}
              {hover === s.key && (
                <div className="chart-tip split-tip">
                  <div className="chart-tip-head">{s.label}</div>
                  <div className="chart-tip-row">
                    <span className="chart-tip-val">{formatCents(s.cents)}</span>
                    <span className="chart-tip-name">{Math.round(s.share * 100)}%</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* The legend carries identity for every band, including the ones too
          narrow to hold their own label. */}
      <div className="chart-legend" style={{ marginTop: 10 }}>
        {slices.map((s) => (
          <span key={s.key} className="chart-key">
            <span className="chart-swatch" style={{ background: s.color }} />
            {s.label}
            <b style={{ marginLeft: 4 }}>{formatCents(s.cents)}</b>
          </span>
        ))}
      </div>
      <div className="mut t-small" style={{ marginTop: 6 }}>
        {formatCents(totalCents)} {unit}.
      </div>
    </div>
  );
}
