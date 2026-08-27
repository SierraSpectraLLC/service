"use client";

import Link from "next/link";
import { CHART_INK, oneSeries } from "@/lib/chartPalette";
import { formatCents } from "@/lib/money";

export type RankRow = {
  key: string;
  label: string;
  cents: number;
  detail?: string;
  href?: string;
  /** Context rather than a subject - the summed tail, drawn in the faint step. */
  faint?: boolean;
};

/**
 * Who owes the most, largest first.
 *
 * ONE SERIES, ONE COLOUR. The temptation on a chart like this is to shade each
 * bar darker where it is bigger; it double-encodes length as hue, spends the
 * only free channel on something the bar already says, and fails the
 * categorical checks by construction. Clients have no natural order, so their
 * colour carries no information and should not pretend to.
 *
 * Horizontal, because the labels are company names and a vertical axis would
 * turn them on their side.
 */
export default function RankBars({ rows, max }: {
  rows: RankRow[];
  /** The scale's top. Passed in so two charts side by side can share one. */
  max?: number;
}) {
  const top = max ?? Math.max(0, ...rows.map((r) => r.cents));
  if (!rows.length || top <= 0) return null;
  const fill = oneSeries();

  return (
    <div className="rank-bars">
      {rows.map((r) => {
        const pct = Math.max((r.cents / top) * 100, 0.8);
        const body = (
          <>
            {/* Name over detail, not name · detail on one line. Half-width in a
                chart-pair, "Coastal Analytical · 2 invoices" ellipsised into
                "Coastal Analytical · …" - a truncation that eats the useful half
                and leaves a dangling separator. */}
            <span className="rank-name">
              <span className="rank-label">{r.label}</span>
              {r.detail && <span className="rank-detail">{r.detail}</span>}
            </span>
            <span className="rank-track">
              <span className="rank-fill" style={{
                width: `${pct}%`,
                background: r.faint ? CHART_INK.faint : fill,
              }} />
            </span>
            <span className="rank-val">{formatCents(r.cents)}</span>
          </>
        );
        return r.href
          ? <Link key={r.key} href={r.href} className="rank-row rank-link">{body}</Link>
          : <div key={r.key} className="rank-row">{body}</div>;
      })}
    </div>
  );
}
