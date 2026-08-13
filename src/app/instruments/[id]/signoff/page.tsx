import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { instruments, tasks, checklistItems, parts, attachments, assets, procedures, signoffs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { systemLabel } from "@/lib/systemLabel";
import { shopMonthDay, shopTime } from "@/lib/shopday";
import { parseSpecs } from "@/lib/partSpecs";
import { brandForTenant } from "@/lib/brand";
import PrintButton from "@/components/PrintButton";
import SignoffPanel, { type SignatureRow } from "@/components/SignoffPanel";
import SignatureBlock from "@/components/SignatureBlock";
import { signoffGate, signatureIsStale, type SignoffSnapshot } from "@/lib/signoff";

export const dynamic = "force-dynamic";

const Row = ({ label, value }: { label: string; value: string }) => (
  <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "3px 0" }}>
    <span className="mut" style={{ width: 90, flexShrink: 0 }}>{label}</span>
    <b>{value || "-"}</b>
  </div>
);

export default async function SignoffPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (user.role !== "owner" && user.role !== "staff") redirect("/");
  const { id } = await params;
  const instId = parseInt(id);
  if (isNaN(instId)) notFound();

  const [[inst], taskRows, partRows, attachRows, moduleRows] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.id, instId)),
    db.select().from(tasks).where(eq(tasks.instrumentId, instId)).orderBy(asc(tasks.sortOrder), asc(tasks.id)),
    db.select().from(parts).where(eq(parts.instrumentId, instId)).orderBy(asc(parts.id)),
    db.select().from(attachments).where(eq(attachments.instrumentId, instId)).orderBy(asc(attachments.createdAt)),
    db.select().from(assets).where(eq(assets.instrumentId, instId)).orderBy(asc(assets.sortOrder), asc(assets.id)),
  ]);
  if (!inst) notFound();
  // The company that signs this is the one whose system it is - see brandForTenant.
  const brand = await brandForTenant(inst.tenantOrgId);

  const taskIds = taskRows.map((t) => t.id);
  const items = taskIds.length
    ? await db.select().from(checklistItems).where(inArray(checklistItems.taskId, taskIds)).orderBy(asc(checklistItems.sortOrder), asc(checklistItems.id))
    : [];
  const done = taskRows.filter((t) => t.state === "Done");
  const openTasks = taskRows.length - done.length;

  // Release readiness spans the system AND its installed assets - a pump with a
  // failed test is not a shippable system. Recomputed here, and again server-side
  // when anyone actually signs.
  const assetIds = moduleRows.map((m) => m.id);
  const gateTasks = await db.select().from(tasks).where(
    assetIds.length ? or(eq(tasks.instrumentId, instId), inArray(tasks.assetId, assetIds)) : eq(tasks.instrumentId, instId)
  );
  const gateProcIds = [...new Set(gateTasks.flatMap((t) => (t.procedureId !== null ? [t.procedureId] : [])))];
  const [gateProcs, signRows] = await Promise.all([
    gateProcIds.length
      ? db.select({ id: procedures.id, kind: procedures.kind, required: procedures.required })
          .from(procedures).where(inArray(procedures.id, gateProcIds))
      : [],
    db.select().from(signoffs).where(and(eq(signoffs.instrumentId, instId), isNull(signoffs.revokedAt)))
      .orderBy(asc(signoffs.createdAt)),
  ]);
  const gateTaskIds = gateTasks.map((t) => t.id);
  const reportRows = gateTaskIds.length
    ? await db.select({ taskId: attachments.taskId }).from(attachments).where(inArray(attachments.taskId, gateTaskIds))
    : [];
  const reportsByTask = new Map<number, number>();
  for (const r of reportRows) if (r.taskId !== null) reportsByTask.set(r.taskId, (reportsByTask.get(r.taskId) ?? 0) + 1);
  const gate = signoffGate(
    gateTasks.map((t) => {
      const pr = gateProcs.find((x) => x.id === t.procedureId);
      return { id: t.id, title: t.title, state: t.state, required: pr?.required ?? false, kind: pr?.kind ?? "task" };
    }),
    reportsByTask,
  );
  const signatures: SignatureRow[] = signRows.map((r) => {
    const snap = r.data as SignoffSnapshot;
    return {
      id: r.id, signedBy: r.signedBy, signerName: r.signerName, signerTitle: r.signerTitle,
      meaning: r.meaning, note: r.note, when: shopTime(r.createdAt),
      stale: signatureIsStale(snap, gate), snapshot: snap,
    };
  });
  const relevantParts = partRows.filter((p) => p.status === "Installed" || p.status === "Received" || p.status === "Removed");

  return (
    <div className="container page">
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Link href={`/instruments/${inst.id}`} className="mut" style={{ fontSize: 13, textDecoration: "none" }}>
          ← Back to {inst.externalId}
        </Link>
        <span style={{ marginLeft: "auto" }} />
        <PrintButton />
      </div>
      {openTasks > 0 && (
        <div className="no-print" style={{ fontSize: 12, color: "#8A5410", background: "#FAF0DC", border: "1px solid #F0C9A0", borderRadius: 8, padding: "8px 12px", marginBottom: 10 }}>
          Heads up: {openTasks} task{openTasks === 1 ? " is" : "s are"} not Done - only completed work prints below.
        </div>
      )}

      <div className="card">
        <div style={{ borderBottom: "3px solid var(--navy)", paddingBottom: 10, marginBottom: 12 }}>
          {brand.operatorLogoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.operatorLogoUrl} alt="" style={{ height: 34, maxWidth: 160, objectFit: "contain", marginBottom: 4 }} />
          )}
          <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: 0.4, color: "var(--navy)" }}>{brand.operatorName.toUpperCase()}</div>
          <div className="mut" style={{ fontSize: 13 }}>Instrument delivery &amp; sign-off</div>
        </div>

        <Row label="System ID" value={inst.externalId} />
        {/* Composed from the assets listed below, which carry the serials. */}
        <Row label="System" value={systemLabel(inst, moduleRows)} />
        <Row label="Client" value={inst.client} />
        <Row label="Location" value={inst.location} />
        <Row label="Intake" value={shopMonthDay(inst.createdAt)} />
        <Row label="Stages" value={inst.stages.join(", ")} />
        <Row label="Prepared" value={`${shopTime(new Date())} by ${user.name}`} />

        <div className="eyebrow" style={{ margin: "16px 0 6px" }}>Assets</div>
        {moduleRows.map((m) => (
          <div key={m.id} style={{ fontSize: 12, padding: "2px 0" }}>
            {m.kind}: <b>{m.model || "(no model)"}</b>{m.serial ? ` · SN ${m.serial}` : ""}
            {m.note ? <span className="mut"> - {m.note}</span> : null}
          </div>
        ))}
        {moduleRows.length === 0 && <div className="mut" style={{ fontSize: 13 }}>None listed.</div>}

        <div className="eyebrow" style={{ margin: "16px 0 6px" }}>Completed work</div>
        {done.map((t) => {
          const list = items.filter((c) => c.taskId === t.id);
          return (
            <div key={t.id} style={{ marginBottom: 10, breakInside: "avoid" }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                ✓ {t.title}
                {t.completedAt && <span className="mut" style={{ fontWeight: 400 }}> - {shopMonthDay(t.completedAt)}</span>}
              </div>
              {t.body && <div className="mut" style={{ fontSize: 12 }}>{t.body}</div>}
              {list.map((c) => (
                <div key={c.id} style={{ fontSize: 12, marginLeft: 16 }}>{c.done ? "☑" : "☐"} {c.text}</div>
              ))}
            </div>
          );
        })}
        {done.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No completed tasks recorded.</div>}

        <div className="eyebrow" style={{ margin: "16px 0 6px" }}>Parts</div>
        {relevantParts.map((p) => {
          const specs = parseSpecs(p.specs);
          return (
            <div key={p.id} style={{ fontSize: 12, padding: "3px 0", breakInside: "avoid" }}>
              <b>{p.name}</b>
              {p.qty ? ` ×${p.qty}` : ""}
              {p.kind === "consumable" ? <span className="mut"> (consumable)</span> : null}
              {p.partNumber ? ` · PN ${p.partNumber}` : ""}
              {p.serial ? ` · SN ${p.serial}` : ""}
              {specs.length ? ` · ${specs.map((s) => `${s.k} ${s.v}`).join(", ")}` : ""}
              {" · "}{p.status === "Removed" ? `Removed ${p.removedAt}` : p.status === "Installed" ? `Installed ${p.installedAt}` : `Received ${p.receivedAt}`}
              {p.note ? <span className="mut"> - {p.note}</span> : null}
            </div>
          );
        })}
        {relevantParts.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No parts recorded.</div>}

        <div className="eyebrow" style={{ margin: "16px 0 6px" }}>Documents on file</div>
        {attachRows.map((a) => (
          <div key={a.id} style={{ fontSize: 12, padding: "2px 0" }}>
            {a.kind}: {a.fileName} <span className="mut">({shopMonthDay(a.createdAt)})</span>
          </div>
        ))}
        {attachRows.length === 0 && <div className="mut" style={{ fontSize: 13 }}>None.</div>}

        <SignatureBlock signatures={signatures} operatorName={brand.operatorName} clientName={inst.client || "Client"} />
      </div>

      <SignoffPanel target={{ instrumentId: inst.id, assetId: null }}
        ready={gate.ready} blockers={gate.blockers} signatures={signatures}
        canSign isOwner={user.role === "owner"} myEmail={user.email} myName={user.name} />
    </div>
  );
}
