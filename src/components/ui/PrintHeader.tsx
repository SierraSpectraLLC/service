/**
 * The letterhead every printable document shares: operator logo and name,
 * what the document is, when it was prepared, and the record's identifier
 * on the right. One shape, so a label, a sign-off packet and a validation
 * binder all open the same way on paper.
 */
export default function PrintHeader({ logoUrl, operator, title, date, docId }: {
  logoUrl?: string | null;
  operator: string;
  /** What this document is: "Instrument delivery & sign-off", "Validation binder". */
  title: string;
  /** Prepared/printed date; omit to leave it off. */
  date?: string;
  /** The record's identifier, set right in the mono face. */
  docId?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 12, borderBottom: "3px solid var(--navy)", paddingBottom: 10, marginBottom: 12 }}>
      <div style={{ minWidth: 0 }}>
        {logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" style={{ height: 34, maxWidth: 160, objectFit: "contain", marginBottom: 4 }} />
        )}
        <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: 0.4, color: "var(--navy)" }}>{operator.toUpperCase()}</div>
        <div className="mut" style={{ fontSize: 13 }}>{title}{date ? ` · ${date}` : ""}</div>
      </div>
      {docId && (
        <div className="mono" style={{ marginLeft: "auto", fontWeight: 700, fontSize: 14, color: "var(--navy)", flexShrink: 0 }}>{docId}</div>
      )}
    </div>
  );
}
