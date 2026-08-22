/**
 * The frame for pages that face someone with no account - share links, file
 * drops, sale listings, the public library, sign-in. The root layout still
 * draws the platform header; this shapes what sits under it: the brand as a
 * quiet eyebrow, an optional title and sub, the content, and a one-line
 * footer naming the platform. No nav - a token is not a session.
 */
export default function PublicShell({ brandName, tagline, title, sub, width = 560, children }: {
  brandName: string;
  /** The platform tagline, folded into the footer when given. */
  tagline?: string;
  title?: React.ReactNode;
  sub?: React.ReactNode;
  /** Container max width: 560 for tokened cards, wider for the library. */
  width?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="container" style={{ maxWidth: width, paddingTop: 40, paddingBottom: 24 }}>
      {(title != null || sub != null) && (
        <div style={{ marginBottom: 12 }}>
          <div className="eyebrow">{brandName}</div>
          {title != null && <h1 style={{ fontSize: 20, margin: "2px 0 0" }}>{title}</h1>}
          {sub != null && <p className="mut" style={{ fontSize: 13, margin: "4px 0 0", lineHeight: 1.6 }}>{sub}</p>}
        </div>
      )}
      {children}
      <div className="mut" style={{ fontSize: 11, textAlign: "center", marginTop: 20 }}>
        {brandName}{tagline ? ` · ${tagline}` : ""}
      </div>
    </div>
  );
}
