import type { Tone } from "@/lib/tones";

/**
 * Status as an 8px disc, for rows where a pill on every line is noise.
 * Color alone carries no text, so a page using dots renders a Legend, and
 * the dot itself is hidden from screen readers unless given a label.
 */
export default function Dot({ tone, label }: { tone: Tone; label?: string }) {
  return label
    ? <span className={`dot ${tone}`} role="img" aria-label={label} />
    : <span className={`dot ${tone}`} aria-hidden="true" />;
}
