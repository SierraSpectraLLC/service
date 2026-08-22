import Link from "next/link";

/**
 * The grid for pages a photo leads: equipment, stockrooms, gallery. Cards
 * flow 1 to 4 columns by width; every card is an EntityCard so the anatomy
 * never varies: image (warn-tinted placeholder when missing), eyebrow,
 * title, meta, at most one pill row, one kebab slot.
 */
export function CardGrid({ children }: { children: React.ReactNode }) {
  return <div className="cardgrid">{children}</div>;
}

export function EntityCard({ image, imageAlt = "", eyebrow, title, mono, href, meta, pills, kebab }: {
  /** Image URL; absent renders the warn-tinted placeholder. */
  image?: string;
  imageAlt?: string;
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  /** Identifier titles (model codes) set in the mono face. */
  mono?: boolean;
  href?: string;
  meta?: React.ReactNode;
  /** At most one row - the anatomy is the point. */
  pills?: React.ReactNode;
  kebab?: React.ReactNode;
}) {
  return (
    <div className="ecard">
      <span className={`ecard-img${image ? "" : " missing"}`} aria-hidden={image ? undefined : true}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {image && <img src={image} alt={imageAlt} loading="lazy" />}
      </span>
      {eyebrow != null && <span className="eyebrow">{eyebrow}</span>}
      <span className={`ecard-title${mono ? " mono" : ""}`}>
        {href ? <Link href={href}>{title}</Link> : title}
      </span>
      {meta != null && <span className="ecard-meta">{meta}</span>}
      {kebab != null && <span className="ecard-kebab">{kebab}</span>}
      {pills != null && <span className="ecard-pills">{pills}</span>}
    </div>
  );
}
