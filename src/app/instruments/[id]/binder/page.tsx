import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  instruments, tasks, attachments, assets, procedures, taskResults, vocabTerms,
  validationDocs, validationSignatures,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { assertSystemVisible, forTenant } from "@/lib/tenancy";
import { systemLabel } from "@/lib/systemLabel";
import { shopMonthDay, shopToday } from "@/lib/shopday";
import { brandForTenant } from "@/lib/brand";
import PrintButton from "@/components/PrintButton";
import { PrintHeader } from "@/components/ui";
import {
  DOC_STATE_TONE, QUALIFICATIONS, QUAL_LABEL, STANDING_TONE,
  expiryAttention, expiryLabel, packageComplete, packageForSystem, packageRows,
  qualsOf, qualStanding,
} from "@/lib/gxp";

export const dynamic = "force-dynamic";

const Row = ({ label, value }: { label: string; value: string }) => (
  <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "3px 0" }}>
    <span className="mut" style={{ width: 90, flexShrink: 0 }}>{label}</span>
    <b>{value || "-"}</b>
  </div>
);

/**
 * The audit binder: one printable page holding a regulated system's whole
 * validation story - the package with every current document and its
 * signatures, the qualification work with the readings behind it, deviations,
 * and the dated paper with its validity.
 *
 * This page exists for one moment: an inspector asks "show me the OQ for this
 * instrument" and the answer takes thirty seconds. Clients can read it - their
 * QA is exactly who needs it - the same visibility rule as the system itself.
 */
export default async function BinderPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const instId = parseInt(id);
  if (isNaN(instId)) notFound();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instId));
  if (!inst) notFound();
  try { await assertSystemVisible(user, instId); } catch { notFound(); }
  // The binder is a GxP artifact; an unregulated system has no such page.
  if (!inst.gxp) notFound();

  const [moduleRows, taskRows, attachRows, vDocs, vocabRows, brand] = await Promise.all([
    db.select().from(assets).where(eq(assets.instrumentId, instId)).orderBy(asc(assets.sortOrder), asc(assets.id)),
    db.select().from(tasks).where(eq(tasks.instrumentId, instId)).orderBy(asc(tasks.sortOrder), asc(tasks.id)),
    db.select().from(attachments).where(eq(attachments.instrumentId, instId)).orderBy(asc(attachments.createdAt)),
    db.select().from(validationDocs).where(eq(validationDocs.instrumentId, instId)).orderBy(asc(validationDocs.id)),
    db.select().from(vocabTerms).where(forTenant(vocabTerms.tenantOrgId, inst.tenantOrgId)),
    brandForTenant(inst.tenantOrgId),
  ]);
  const vSigs = vDocs.length
    ? await db.select().from(validationSignatures)
        .where(inArray(validationSignatures.docId, vDocs.map((d) => d.id))).orderBy(asc(validationSignatures.id))
    : [];

  // The qualification work and what it read.
  const procIds = [...new Set(taskRows.flatMap((t) => (t.procedureId !== null ? [t.procedureId] : [])))];
  const procRows = procIds.length
    ? await db.select({ id: procedures.id, kind: procedures.kind, qualification: procedures.qualification })
        .from(procedures).where(inArray(procedures.id, procIds))
    : [];
  const qualOf = (t: { procedureId: number | null }) =>
    procRows.find((p) => p.id === t.procedureId)?.qualification ?? "";
  const qualTasks = taskRows.filter((t) => qualOf(t) !== "");
  const resultRows = qualTasks.length
    ? await db.select().from(taskResults).where(inArray(taskResults.taskId, qualTasks.map((t) => t.id)))
    : [];

  const today = shopToday();
  const requiredTypes = packageForSystem(vocabRows, inst.category, moduleRows);
  const rows = packageRows(requiredTypes, vDocs);
  const dated = attachRows.filter((a) => a.expiresOn);
  const expiry = expiryAttention(
    [...attachRows, ...vDocs.filter((d) => d.state !== "Superseded").map((d) => ({ expiresOn: d.reviewOn }))],
    today,
  );
  const standing = qualStanding({
    quals: qualsOf(taskRows.map((t) => ({ qualification: qualOf(t), state: t.state }))),
    expired: expiry.expired.length,
    expiringSoon: expiry.soon.length,
    packageComplete: packageComplete(requiredTypes, vDocs),
  });
  // Failed readings ARE the deviation list - recorded, attributed, resolvable.
  const deviations = resultRows.filter((r) => r.passed === false);

  const sigLine = (docId: number) => {
    const active = vSigs.filter((x) => x.docId === docId && x.revokedAt === null);
    return active.length
      ? active.map((x) => `${x.role}: ${x.signerName}${x.signerTitle ? ` (${x.signerTitle})` : ""} ${shopMonthDay(x.createdAt)}`).join(" · ")
      : "unsigned";
  };

  return (
    <div className="container page">
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Link href={`/instruments/${inst.id}`} className="mut" style={{ fontSize: 13, textDecoration: "none" }}>
          ← Back to {inst.externalId}
        </Link>
        <span style={{ marginLeft: "auto" }} />
        <PrintButton />
      </div>

      <div className="card">
        <PrintHeader logoUrl={brand.operatorLogoUrl} operator={brand.operatorName}
          title="Validation binder" date={shopMonthDay(new Date())} docId={inst.externalId} />

        <Row label="System ID" value={inst.externalId} />
        <Row label="System" value={systemLabel(inst, moduleRows)} />
        <Row label="Client" value={inst.client} />
        <Row label="Location" value={inst.location} />
        <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "3px 0", alignItems: "center" }}>
          <span className="mut" style={{ width: 90, flexShrink: 0 }}>Standing</span>
          <span className={`pill ${STANDING_TONE[standing.tone]}`}>
            {standing.label}
          </span>
          {standing.reasons.length > 0 && <span className="mut" style={{ fontSize: 12 }}>{standing.reasons.join("; ")}</span>}
        </div>
        <Row label="Printed" value={`${shopMonthDay(new Date())} by ${user.name || user.email}`} />

        <div className="eyebrow" style={{ margin: "16px 0 6px" }}>Assets</div>
        {moduleRows.map((m) => (
          <div key={m.id} style={{ fontSize: 13 }}>
            {m.kind}: {[m.model, m.serial ? `SN ${m.serial}` : ""].filter(Boolean).join(" · ") || "-"}
          </div>
        ))}
        {moduleRows.length === 0 && <div className="mut" style={{ fontSize: 13 }}>None listed.</div>}

        {/* ── The package ─────────────────────────────────────────────── */}
        <div className="eyebrow" style={{ margin: "16px 0 6px" }}>Validation documents</div>
        {rows.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No package declared and nothing filed.</div>}
        {rows.map((r) => (
          <div key={r.docType} style={{ marginBottom: 8, breakInside: "avoid" }}>
            <div style={{ fontSize: 13, fontWeight: 700, display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              {r.docType}
              {r.required && !r.satisfied && <span style={{ color: "#A32D2D", fontWeight: 400, fontSize: 12 }}>— {r.docs.length ? "not approved" : "MISSING"}</span>}
              {!r.required && <span className="mut" style={{ fontWeight: 400, fontSize: 11 }}>beyond the declared package</span>}
            </div>
            {r.docs.map((d) => {
              const st = DOC_STATE_TONE[d.state] ?? DOC_STATE_TONE.Draft;
              // Every superseded revision prints under its successor - the
              // binder is the record, and the record includes what v1 said.
              const chain = [];
              let cur = d.supersedesId;
              while (cur !== null) {
                const prev = vDocs.find((x) => x.id === cur);
                if (!prev) break;
                chain.push(prev);
                cur = prev.supersedesId;
              }
              return (
                <div key={d.id} style={{ fontSize: 12, marginLeft: 12, padding: "2px 0" }}>
                  <span className={`pill ${st}`} style={{ marginRight: 6 }}>{d.state}</span>
                  <b>{d.title}</b> v{d.version}
                  {d.reviewOn && <span className="mut"> · review by {d.reviewOn}</span>}
                  <div className="mut" style={{ marginLeft: 2 }}>{sigLine(d.id)}</div>
                  {chain.map((h) => (
                    <div key={h.id} className="mut" style={{ marginLeft: 12 }}>
                      superseded: v{h.version} — {sigLine(h.id)}
                    </div>
                  ))}
                </div>
              );
            })}
            {r.docs.length === 0 && <div className="mut" style={{ fontSize: 12, marginLeft: 12 }}>Nothing on file.</div>}
          </div>
        ))}

        {/* ── The qualification work and its readings ─────────────────── */}
        {QUALIFICATIONS.map((q) => {
          const mine = qualTasks.filter((t) => qualOf(t) === q);
          if (!mine.length) return null;
          return (
            <div key={q} style={{ breakInside: "avoid" }}>
              <div className="eyebrow" style={{ margin: "16px 0 6px" }}>{QUAL_LABEL[q]}</div>
              {mine.map((t) => {
                const r = resultRows.find((x) => x.taskId === t.id);
                return (
                  <div key={t.id} style={{ fontSize: 13, marginBottom: 6, breakInside: "avoid" }}>
                    <div style={{ fontWeight: 700 }}>
                      {t.state === "Done" ? "✓" : "○"} {t.title}
                      {t.completedAt && <span className="mut" style={{ fontWeight: 400 }}> - {shopMonthDay(t.completedAt)}</span>}
                      {t.state !== "Done" && <span style={{ color: "#8A5410", fontWeight: 400 }}> - {t.state.toLowerCase()}</span>}
                    </div>
                    {r && (
                      <div style={{ fontSize: 12, fontWeight: 600, marginLeft: 16 }}>
                        {r.passed === true ? "PASS" : r.passed === false ? "FAIL" : "Recorded"}: {r.value}
                        {r.target ? <span className="mut" style={{ fontWeight: 400 }}> (target {r.target}{r.tolerancePct ? ` ± ${r.tolerancePct}%` : ""})</span> : null}
                        {r.note ? <span className="mut" style={{ fontWeight: 400 }}> - {r.note}</span> : null}
                        <span className="mut" style={{ fontWeight: 400 }}> - {r.recordedBy}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* ── Deviations ──────────────────────────────────────────────── */}
        <div className="eyebrow" style={{ margin: "16px 0 6px" }}>Deviations</div>
        {deviations.length === 0 && <div className="mut" style={{ fontSize: 13 }}>None recorded.</div>}
        {deviations.map((r) => {
          const t = taskRows.find((x) => x.id === r.taskId);
          return (
            <div key={r.id} style={{ fontSize: 13, marginBottom: 4 }}>
              <b style={{ color: "#A32D2D" }}>FAIL</b> {t?.title ?? `task #${r.taskId}`}: {r.value}
              {r.target && <span className="mut"> (target {r.target}{r.tolerancePct ? ` ± ${r.tolerancePct}%` : ""})</span>}
              {r.note && <span className="mut"> - {r.note}</span>}
              <span className="mut"> - {r.recordedBy}, {shopMonthDay(r.recordedAt)}</span>
            </div>
          );
        })}

        {/* ── Dated paper ─────────────────────────────────────────────── */}
        <div className="eyebrow" style={{ margin: "16px 0 6px" }}>Dated documents</div>
        {dated.length === 0 && <div className="mut" style={{ fontSize: 13 }}>None on file.</div>}
        {dated.map((a) => (
          <div key={a.id} style={{ fontSize: 13 }}>
            {a.fileName} <span className="mut">({a.kind})</span> — valid until {a.expiresOn}
            {a.expiresOn < today && <b style={{ color: "#A32D2D" }}> · {expiryLabel(a.expiresOn, today)}</b>}
          </div>
        ))}

        <div className="mut" style={{ fontSize: 11, marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
          Generated from the live record. Standing, readings and signatures are as of the moment of printing;
          superseded document versions are retained above under their own numbers.
        </div>
      </div>
    </div>
  );
}
