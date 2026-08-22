import type { Tone } from "@/lib/tones";
import Dot from "@/components/ui/Dot";

/**
 * What the dots on this page mean. One per list page that uses dots,
 * usually directly above the table.
 */
export default function Legend({ items }: { items: { tone: Tone; label: string }[] }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.label}>
          <Dot tone={it.tone} />
          {it.label}
        </span>
      ))}
    </div>
  );
}
