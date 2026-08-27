import Link from "next/link";
import { CHART_INK, STATUS } from "@/lib/chartPalette";

/**
 * A number that is the whole chart.
 *
 * The most underused form on any dashboard. A single current value drawn as a
 * one-bar bar chart is a bar chart that says nothing a number would not have
 * said louder and smaller - so this is what the owner view leads with, and the
 * charts start where there is actually a shape to see.
 *
 * `spark` is a twelve-point context line, drawn in the de-emphasis grey with
 * only the last point in colour. It is context for the figure, not a chart in
 * its own right: no axis, no labels, no tooltip. If it needs any of those, it
 * wanted to be a real chart.
 */
export default function StatTile({ label, value, sub, tone, spark, href, hero = false }: {
  label: string;
  value: string;
  sub?: string;
  /** Reserved words only - this colours a STATE, never a series. */
  tone?: "good" | "warn" | "bad";
  spark?: number[];
  href?: string;
  /** The one number the page leads with. Exactly one per view. */
  hero?: boolean;
}) {
  const ink = tone ? STATUS[tone] : undefined;
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className={hero ? "stat-hero" : "stat-value"} style={ink ? { color: ink } : undefined}>
        {value}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
      {spark && spark.length > 1 && <Spark points={spark} accent={ink} />}
    </>
  );
  return href
    ? <Link href={href} className="stat-tile stat-link">{body}</Link>
    : <div className="stat-tile">{body}</div>;
}

function Spark({ points, accent }: { points: number[]; accent?: string }) {
  const W = 120, H = 26, PAD = 3;
  const max = Math.max(...points, 1);
  const x = (i: number) => (i / (points.length - 1)) * (W - PAD * 2) + PAD;
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const d = points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const last = points.length - 1;
  return (
    <svg className="stat-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke={CHART_INK.faint} strokeWidth={2}
        strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(last)} cy={y(points[last])} r={2.6}
        fill={accent ?? CHART_INK.axis} stroke={CHART_INK.surface} strokeWidth={1.5} />
    </svg>
  );
}
