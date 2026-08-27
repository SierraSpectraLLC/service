"use client";

import { useEffect, useRef, useState } from "react";
import { CHART_INK, SERIES } from "@/lib/chartPalette";
import { niceTicks } from "@/lib/ownerCharts";
import { formatCents } from "@/lib/money";

export type TrendPoint = { label: string; values: number[] };

/**
 * Two money series over the same months, on ONE axis.
 *
 * One axis is not a style choice. Two y-scales on one plot let the author slide
 * the two against each other until they appear to agree, and the correlation a
 * reader takes away is the author's, not the data's. Both series here are cents,
 * so they share a scale honestly and the gap between the lines means something:
 * it is the collection lag.
 *
 * MEASURED WIDTH, not a scaled viewBox. An SVG stretched to fit its container
 * scales its text with it, so an 11px axis label renders at 17px on a wide
 * screen and 8px on a phone. The observer costs a few lines and keeps every
 * label at the size the type scale says.
 */
export default function TrendChart({ points, names, height = 200 }: {
  points: TrendPoint[];
  /** One per series. Two or more series always get a legend - never colour alone. */
  names: string[];
  height?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  // Nothing to plot is not an empty chart with an axis - it is no chart. The
  // panel around this one carries the empty state. Placed after the hooks, so
  // the hook order does not change with the data.
  if (points.length === 0) return null;

  const PAD = { top: 14, right: 16, bottom: 26, left: 62 };
  const plotW = Math.max(0, w - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const max = Math.max(0, ...points.flatMap((p) => p.values));
  const { top, ticks } = niceTicks(max);

  const x = (i: number) =>
    PAD.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (top > 0 ? (v / top) * plotH : 0);

  const path = (s: number) =>
    points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.values[s] ?? 0).toFixed(1)}`).join(" ");
  const areaPath = (s: number) =>
    `${path(s)} L${x(points.length - 1).toFixed(1)} ${(PAD.top + plotH).toFixed(1)}`
    + ` L${x(0).toFixed(1)} ${(PAD.top + plotH).toFixed(1)} Z`;

  const nearest = (clientX: number) => {
    const box = wrap.current?.getBoundingClientRect();
    if (!box || points.length === 0) return null;
    const px = clientX - box.left;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(x(i) - px);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  const at = hover !== null ? points[hover] : null;
  // The tooltip is nudged to whichever side has room, so the last month's
  // figures do not hang off the edge of the card.
  const tipLeft = hover !== null && x(hover) > w / 2;

  return (
    <div>
      {/* A legend is always present for two or more series: colour alone is
          never the only channel that says which line is which. */}
      <div className="chart-legend">
        {names.map((n, i) => (
          <span key={n} className="chart-key">
            <span className="chart-swatch" style={{ background: SERIES[i] }} />
            {n}
          </span>
        ))}
      </div>

      <div ref={wrap} className="chart-wrap" style={{ height }}
        onMouseMove={(e) => setHover(nearest(e.clientX))}
        onMouseLeave={() => setHover(null)}>
        {w > 0 && (
          <svg width={w} height={height} role="img"
            aria-label={`${names.join(" and ")} by month`}>
            {/* Hairline, solid, recessive. Never dashed. */}
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={w - PAD.right} y1={y(t)} y2={y(t)}
                  stroke={CHART_INK.grid} strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t) + 3.5} textAnchor="end"
                  fill={CHART_INK.axis} fontSize={10} style={{ fontVariantNumeric: "tabular-nums" }}>
                  {t === 0 ? "0" : formatCents(t).replace(/\.00$/, "")}
                </text>
              </g>
            ))}

            {names.map((_, s) => (
              <g key={s}>
                {/* A wash, never a saturated block. */}
                <path d={areaPath(s)} fill={SERIES[s]} opacity={0.1} />
                <path d={path(s)} fill="none" stroke={SERIES[s]} strokeWidth={2}
                  strokeLinejoin="round" strokeLinecap="round" />
                {/* The end dot, with a surface ring so it stays legible where
                    the two series cross. */}
                {points.length > 0 && (
                  <circle cx={x(points.length - 1)} cy={y(points[points.length - 1].values[s] ?? 0)}
                    r={4} fill={SERIES[s]} stroke={CHART_INK.surface} strokeWidth={2} />
                )}
              </g>
            ))}

            {points.map((p, i) => (
              <text key={p.label} x={x(i)} y={height - 8} textAnchor="middle"
                fill={CHART_INK.axis} fontSize={10}
                // Every other label below eight points of room, so a twelve-month
                // axis on a phone thins out instead of overlapping itself.
                opacity={plotW / points.length < 34 && i % 2 === 1 ? 0 : 1}>
                {p.label}
              </text>
            ))}

            {hover !== null && (
              <>
                <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH}
                  stroke={CHART_INK.axis} strokeWidth={1} opacity={0.4} />
                {names.map((_, s) => (
                  <circle key={s} cx={x(hover)} cy={y(points[hover].values[s] ?? 0)} r={4.5}
                    fill={SERIES[s]} stroke={CHART_INK.surface} strokeWidth={2} />
                ))}
              </>
            )}
          </svg>
        )}

        {at && (
          <div className="chart-tip" style={{
            left: tipLeft ? undefined : x(hover!) + 12,
            right: tipLeft ? w - x(hover!) + 12 : undefined,
          }}>
            <div className="chart-tip-head">{at.label}</div>
            {names.map((n, s) => (
              <div key={n} className="chart-tip-row">
                <span className="chart-swatch" style={{ background: SERIES[s] }} />
                <span className="chart-tip-name">{n}</span>
                <span className="chart-tip-val">{formatCents(at.values[s] ?? 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
