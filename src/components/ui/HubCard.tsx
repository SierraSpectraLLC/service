import Link from "next/link";
import Pill from "@/components/ui/Pill";
import type { Tone } from "@/lib/tones";

/**
 * A section hub's card: a room, what it is for, and what it is saying today.
 *
 * The point of a hub is that it is a MORNING PAGE, not a menu. A list of nine
 * links tells you the app has nine rooms; a card that reads "EOD · not filed
 * yet" tells you which one to open, and answers "what needs me" before you tap
 * anything. That is the whole difference between a section with a page and a
 * section that was only ever a dropdown label.
 *
 * The signal is optional and honestly absent: a card with nothing to report
 * shows no pill rather than a green "OK", because seven green pills teach
 * people to stop reading pills.
 */
export function HubGrid({ children }: { children: React.ReactNode }) {
  return <div className="hubgrid">{children}</div>;
}

export function HubCard({ href, title, sub, signal, tone }: {
  href: string;
  title: React.ReactNode;
  /** One line on what the room is for. */
  sub?: React.ReactNode;
  /** What it is saying today - a count, a date, a state. */
  signal?: React.ReactNode;
  /** Colours the card's border and its signal. Absent = a plain card. */
  tone?: Tone;
}) {
  return (
    <Link href={href} className={`hubcard${tone ? ` tone-${tone}` : ""}`}>
      <span className="hubcard-title">{title}</span>
      {signal != null && <Pill tone={tone ?? "neutral"}>{signal}</Pill>}
      {sub != null && <span className="hubcard-sub">{sub}</span>}
    </Link>
  );
}
