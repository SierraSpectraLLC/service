import Id from "@/components/ui/Id";
import type { Tone } from "@/lib/tones";

export type HeroStat = {
  label: string;
  value: React.ReactNode;
  /** warn/bad when the number needs an eye; omit for a plain fact. */
  tone?: Tone;
};

/**
 * The top of every record page: what this record IS, how it is doing, and
 * what you can do to it - before any panel. Image (or none), eyebrow, the
 * identifier plus title, a one-line meta, a stats line whose warn-toned
 * numbers are the record's open questions, and the actions.
 *
 * Actions discipline: up to three buttons ride in `actions`; everything else
 * belongs in `kebab` (see HeroKebab). On a phone only the first action and
 * the kebab survive - globals.css hides the rest - so pass the primary one
 * first.
 */
export default function RecordHero({ image, imageAlt = "", eyebrow, id, title, meta, stats, actions, kebab }: {
  image?: string;
  imageAlt?: string;
  eyebrow?: React.ReactNode;
  /** The record's identifier, set in the mono face beside the title. */
  id?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  stats?: HeroStat[];
  actions?: React.ReactNode;
  kebab?: React.ReactNode;
}) {
  return (
    <div className="card rhero">
      {image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="rhero-img" src={image} alt={imageAlt} />
      )}
      <div className="rhero-main">
        {eyebrow != null && <div className="eyebrow">{eyebrow}</div>}
        <div className="rhero-title">
          {id != null && <Id>{id}</Id>}
          <h1>{title}</h1>
        </div>
        {meta != null && <div className="rhero-meta mut">{meta}</div>}
        {stats && stats.length > 0 && (
          <div className="rhero-stats">
            {stats.map((s, i) => (
              <span key={i} className={`rhero-stat${s.tone ? ` ${s.tone}` : ""}`}>
                <b>{s.value}</b> {s.label}
              </span>
            ))}
          </div>
        )}
      </div>
      {(actions != null || kebab != null) && (
        <div className="rhero-acts">
          {actions}
          {kebab}
        </div>
      )}
    </div>
  );
}
