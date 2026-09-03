import { notFound, redirect } from "next/navigation";
import QRCode from "qrcode";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { assertSystemVisible } from "@/lib/tenancy";
import { appUrl } from "@/lib/appUrl";
import { brandForTenant } from "@/lib/brand";
import { shopToday } from "@/lib/shopday";
import { flagOn } from "@/lib/custody/flags";
import { planStatusFor } from "@/lib/custody/plan";
import { sheetByToken } from "@/lib/custody/sheets";
import { pageOfRow, type Box } from "@/lib/custody/sheetLayout";
import { parseChecklist } from "@/lib/checklist";
import PrintButton from "@/components/PrintButton";
import { PrintHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The printable PM sheet: the same procedure set the run screen shows, laid
 * out so a pen can answer it and a phone can read the answers back.
 *
 * THE BOXES ARE WHERE lib/custody/sheetLayout SAYS THEY ARE, as percentages
 * of a fixed-ratio page, because the mark reader will look in exactly those
 * places on the photo. Nothing about the layout is decided in this file; it
 * draws the frozen geometry on the sheet row. The QR is a URL with the
 * sheet's token - a phone camera opens it, and the upload page knows which
 * steps and which boxes were printed.
 */
const pct = (b: Box) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });

export default async function PmSheetPage({ params }: { params: Promise<{ token: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!(await flagOn("custody.sheets"))) notFound();
  const { token } = await params;
  const sheet = await sheetByToken(token);
  if (!sheet) notFound();
  try { await assertSystemVisible(user, sheet.instrumentId); } catch { notFound(); }
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, sheet.instrumentId));
  if (!inst) notFound();
  const brand = await brandForTenant(inst.tenantOrgId);
  const today = shopToday();
  const plan = new Map((await planStatusFor(inst.id, today)).map((p) => [p.key, p]));
  const base = appUrl();
  const scanUrl = base ? `${base}/sheets/${sheet.token}` : "";
  const qr = scanUrl ? await QRCode.toString(scanUrl, { type: "svg", margin: 0, errorCorrectionLevel: "M" }) : "";
  const L = sheet.layout;
  const pages = Math.max(1, Math.ceil(sheet.rows.length / L.rowsPerPage));

  return (
    <div className="container" style={{ maxWidth: 820 }}>
      <div className="no-print" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <PrintButton />
        <span className="mut t-small">
          Print at 100%, no scaling. Tick with a pen; the phone reads the boxes, you type the readings. Sheet {sheet.token.slice(0, 6)}.
        </span>
      </div>

      {/* Page 1..n: the checklist, boxes at the frozen coordinates. */}
      {Array.from({ length: pages }, (_, p) => (
        <div key={p} className="card pm-sheet-page" style={{ position: "relative", width: "100%", aspectRatio: "8.5 / 11", padding: 0, breakAfter: "page", overflow: "hidden" }}>
          <div style={{ position: "absolute", ...pct(L.header.qr) }} dangerouslySetInnerHTML={{ __html: qr }} />
          <div style={{ position: "absolute", ...pct(L.header.title) }}>
            <div className="eyebrow">{brand.operatorName} · PM sheet · page {p + 1} of {pages + 2}</div>
            <div className="mono" style={{ fontWeight: 700 }}>{inst.externalId}</div>
            <div className="t-small">{inst.model}{inst.client ? ` · ${inst.client}` : ""} · set v{sheet.setVersion} · printed {today}</div>
            <div className="mut t-meta">Scan the code to file this sheet. Done / Skip / N/A - fill the box fully. A skip needs a reason on the back.</div>
          </div>
          {/* Column headings over the boxes. */}
          {p === 0 && L.rows[0] && (
            <>
              <div className="t-meta mut" style={{ position: "absolute", left: `${L.rows[0].done.x * 100}%`, top: `${(L.rows[0].done.y - 0.02) * 100}%` }}>Done</div>
              <div className="t-meta mut" style={{ position: "absolute", left: `${L.rows[0].skip.x * 100}%`, top: `${(L.rows[0].skip.y - 0.02) * 100}%` }}>Skip</div>
              <div className="t-meta mut" style={{ position: "absolute", left: `${L.rows[0].na.x * 100}%`, top: `${(L.rows[0].na.y - 0.02) * 100}%` }}>N/A</div>
            </>
          )}
          {sheet.rows.map((r, i) => {
            if (pageOfRow(L, i) !== p) return null;
            const rl = L.rows[i];
            const st = plan.get(r.key);
            const status = st?.stillDue ? `still due - skipped: ${st.skipReason || "no reason given"}`
              : st?.lastDone ? `last ${st.lastDone}${st.lastGrade === "attested" ? " (attested)" : ""}${st.nextDue ? ` · due ${st.nextDue}` : ""}`
              : "never recorded";
            return (
              <div key={r.key}>
                <div style={{ position: "absolute", left: "6%", top: `${rl.done.y * 100}%`, width: "52%", height: `${rl.done.h * 100}%`, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                  <div className="t-small" style={{ fontWeight: 700, lineHeight: 1.1 }}>{r.title}</div>
                  <div className="mut t-meta" style={{ lineHeight: 1.1 }}>{r.key}{r.partNumber ? ` · part ${r.partNumber}` : ""} · {status}</div>
                </div>
                {(["done", "skip", "na"] as const).map((k) => (
                  <div key={k} style={{ position: "absolute", ...pct(rl[k]), border: "1.5px solid #000", borderRadius: 2, background: "#fff" }} />
                ))}
                {rl.comb.map((c, ci) => (
                  <div key={ci} style={{ position: "absolute", ...pct(c), border: "1px solid #000", borderLeft: ci === 0 ? "1px solid #000" : "none", background: "#fff" }} />
                ))}
                {rl.comb.length > 0 && (
                  <div className="t-meta mut" style={{ position: "absolute", left: `${(rl.comb[rl.comb.length - 1].x + rl.comb[rl.comb.length - 1].w) * 100 + 0.5}%`, top: `${rl.done.y * 100}%` }}>{r.unit ?? ""}</div>
                )}
              </div>
            );
          })}
          {p === pages - 1 && (
            <>
              <div style={{ position: "absolute", ...pct(L.findings), border: "1px solid #000" }}>
                <div className="t-meta" style={{ padding: "2px 4px", fontWeight: 700 }}>Findings - travels with the machine. No site, no contact, no prices.</div>
              </div>
              <div style={{ position: "absolute", ...pct(L.privateNotes), border: "1px dashed #000" }}>
                <div className="t-meta" style={{ padding: "2px 4px", fontWeight: 700 }}>Private notes - stays with the shop.</div>
              </div>
              <div style={{ position: "absolute", ...pct(L.technicianSign), borderBottom: "1px solid #000" }}>
                <div className="t-meta">Technician (print and sign)</div>
              </div>
              <div style={{ position: "absolute", ...pct(L.custodianSign), borderBottom: "1px solid #000" }}>
                <div className="t-meta">Lab acknowledgement (name) - a signature on paper does not verify anybody; sign in the portal to make it count</div>
              </div>
            </>
          )}
        </div>
      ))}

      {/* Page n+1: the parts pick list. */}
      <div className="card" style={{ breakAfter: "page" }}>
        <PrintHeader logoUrl={brand.operatorLogoUrl} operator={brand.operatorName} title="Parts pick list" docId={inst.externalId} />
        {sheet.rows.filter((r) => r.partNumber).length === 0
          ? <div className="mut t-small">No step on this plan names a part.</div>
          : sheet.rows.filter((r) => r.partNumber).map((r) => (
            <div key={r.key} style={{ display: "flex", gap: 8, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span className="mono t-small" style={{ fontWeight: 700, width: 160 }}>{r.partNumber}</span>
              <span className="t-small">{r.title}</span>
              <span className="mut t-small" style={{ marginLeft: "auto" }}>lot: ____________</span>
            </div>
          ))}
      </div>

      {/* Page n+2: reference steps, from the shop's own writeup. */}
      <div className="card">
        <PrintHeader logoUrl={brand.operatorLogoUrl} operator={brand.operatorName} title="Reference steps" docId={inst.externalId} />
        {sheet.rows.map((r) => {
          const steps = parseChecklist(r.checklist);
          if (!steps.length) return null;
          return (
            <div key={r.key} style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <div className="t-small" style={{ fontWeight: 700 }}>{r.title} <span className="mono mut">{r.key}</span></div>
              <ol className="t-meta" style={{ margin: "2px 0 0", paddingLeft: 16 }}>
                {steps.map((st, i) => <li key={i}>{st.text}</li>)}
              </ol>
              <div className="mut t-meta">Source: {brand.operatorName}&apos;s procedure catalog.</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
