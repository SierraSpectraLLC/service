import { RAMP, STATUS } from "@/lib/chartPalette";

/**
 * One ratio against a limit.
 *
 * A pie of two slices is the wrong answer to this question and a stacked bar of
 * two segments is only a little better; a meter says "how far along" in the one
 * dimension the question has.
 *
 * The track is a LIGHTER STEP OF THE SAME RAMP rather than plain grey, so the
 * whole bar reads as one scale and the empty part reads as "not yet" rather
 * than as a different thing. Severity moves the fill through the status tones -
 * and every one of those ships beside a written figure, because a reader who
 * cannot separate amber from red still has the sentence.
 */
export default function Meter({ done, total, label, sub, invert = false }: {
  done: number;
  total: number;
  label: string;
  sub?: string;
  /**
   * Whether a FULL bar is bad. "Systems behind" fills toward trouble; "PMs
   * delivered" fills toward done, and the same colours would say the opposite
   * of what is happening.
   */
  invert?: boolean;
}) {
  const share = total > 0 ? Math.min(1, done / total) : 0;
  const pct = Math.round(share * 100);
  const heat = invert ? share : 1 - share;
  const fill = total === 0 ? RAMP[1]
    : heat >= 0.5 ? STATUS.bad
      : heat >= 0.2 ? STATUS.warn
        : STATUS.good;

  return (
    <div className="meter">
      <div className="meter-head">
        <span className="stat-label">{label}</span>
        <span className="meter-figure">{done} <span className="mut">of {total}</span></span>
      </div>
      <div className="meter-track" role="img" aria-label={`${done} of ${total}, ${pct}%`}>
        <div className="meter-fill" style={{ width: `${Math.max(pct, total > 0 ? 2 : 0)}%`, background: fill }} />
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
