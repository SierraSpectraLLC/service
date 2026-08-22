import type { Tone } from "@/lib/tones";

/**
 * A status pill that states its tone by name. Replaces the inline
 * `className="pill" style={{ background, color }}` form - the tone classes
 * live in globals.css, so every pill saying "warn" is the same warn.
 * `mono` for pills whose text is an identifier or a count.
 */
export default function Pill({ tone = "neutral", mono, title, children }: {
  tone?: Tone;
  mono?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`pill ${tone}${mono ? " mono" : ""}`} title={title}>
      {children}
    </span>
  );
}
