import QRCode from "qrcode";
import PrintButton from "@/components/PrintButton";
import { PrintHeader } from "@/components/ui";

/**
 * A printable equipment label: QR straight to the record, with enough text
 * that the label still identifies the unit when nobody scans it. Server
 * component - the QR is inlined as SVG, no client JS involved. The shared
 * print letterhead sits above the label itself, so the sheet says who
 * printed it without eating into the sticker.
 */
export default async function LabelCard({ url, headline, lines, brandName, logoUrl }: {
  /** Absolute link the QR encodes; empty = dev without APP_URL. */
  url: string;
  /** The big identifier: system external id, or the asset's serial. */
  headline: string;
  /** Small print under it: model, client, kind. Blank entries dropped. */
  lines: string[];
  brandName: string;
  logoUrl?: string | null;
}) {
  const svg = url ? await QRCode.toString(url, { type: "svg", margin: 0, errorCorrectionLevel: "M" }) : "";
  return (
    <div className="container" style={{ maxWidth: 460 }}>
      <PrintHeader logoUrl={logoUrl} operator={brandName} title="Equipment label" docId={headline} />
      <div className="card label-card" style={{ display: "flex", gap: 16, alignItems: "center" }}>
        {svg ? (
          <div style={{ width: 120, height: 120, flexShrink: 0 }} dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <div className="mut" style={{ width: 120, height: 120, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", border: "1px dashed var(--line)", borderRadius: 8, fontSize: 11, textAlign: "center", padding: 8 }}>
            Set APP_URL to give scans somewhere to go
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 24, fontWeight: 700, color: "var(--navy)", lineHeight: 1.1, overflowWrap: "anywhere" }}>
            {headline}
          </div>
          {lines.filter(Boolean).map((l, i) => (
            <div key={i} style={{ fontSize: 13, marginTop: 2, overflowWrap: "anywhere" }}>{l}</div>
          ))}
          <div className="mut" style={{ fontSize: 11, marginTop: 6 }}>{brandName}</div>
        </div>
      </div>
      <div className="no-print" style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <PrintButton />
        <span className="mut" style={{ fontSize: 12, alignSelf: "center" }}>
          Scanning the code opens this record in the portal (sign-in still applies).
        </span>
      </div>
    </div>
  );
}
