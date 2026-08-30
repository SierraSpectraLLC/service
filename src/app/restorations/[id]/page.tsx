import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { acceptances, auditLog, instruments, orgs, restorationProjects, shipments } from "@/db/schema";
import { requireStaff, requireUser, type SessionUser } from "@/lib/authz";
import { forTenant, readTenant } from "@/lib/tenancy";
import { fmtWhen } from "@/lib/when";
import {
  RESTORATION_SOURCE_LABEL, RESTORATION_STAGES, RESTORATION_STAGE_LABEL,
  daysInStage, nextStage, queueStageTone, stageIndex, type RestorationStage,
} from "@/lib/restoration";
import {
  evaluateRestorationGate, provenanceForProjects, restorationCommissionData,
  restorationReceiveData, restorationRestoreData, restorationShipData, restorationVerifyData,
} from "@/lib/restorationData";
import { getSystemLabels } from "@/lib/systemLabel";
import { PageHead, Pill } from "@/components/ui";
import ActivityFeed from "@/components/ActivityFeed";
import BuyerAcceptanceCard from "@/components/BuyerAcceptanceCard";
import RestorationCommission from "@/components/RestorationCommission";
import RestorationGateCard from "@/components/RestorationGateCard";
import RestorationReceive from "@/components/RestorationReceive";
import RestorationRestore from "@/components/RestorationRestore";
import RestorationShip from "@/components/RestorationShip";
import RestorationVerify from "@/components/RestorationVerify";

export const dynamic = "force-dynamic";

/**
 * One restoration project. Two audiences share the URL: the shop gets the
 * full working surface; a member of the BUYING organization gets the portal
 * view - shipment status while it ships, the acceptance signature when it
 * commissions. Both are authenticated sessions; there is no share-token path
 * to this page on purpose.
 */
export default async function RestorationPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ s?: string }>;
}) {
  const { id: idRaw } = await params;
  const id = parseInt(idRaw);
  if (!Number.isFinite(id)) notFound();

  let staff: SessionUser | null = null;
  let user: SessionUser;
  try { user = staff = await requireStaff(); } catch {
    try { user = await requireUser(); } catch { redirect("/login"); }
  }

  if (!staff) return BuyerView({ user, projectId: id });

  const [project] = await db.select().from(restorationProjects)
    .where(and(eq(restorationProjects.id, id), forTenant(restorationProjects.tenantOrgId, readTenant(staff))));
  if (!project) notFound();

  const [inst] = await db.select().from(instruments).where(eq(instruments.id, project.instrumentId));
  if (!inst) notFound();
  const labels = await getSystemLabels([inst]);
  const title = labels.get(inst.id) || inst.model || inst.externalId;

  const currentIdx = stageIndex(project.stage);
  const { s } = await searchParams;
  const viewed = s && stageIndex(s) >= 0 && stageIndex(s) <= currentIdx ? (s as RestorationStage) : (project.stage as RestorationStage);
  const viewingCurrent = viewed === project.stage;
  const canEdit = viewingCurrent;

  const [gate, provenance, buyer, ledger, stageData] = await Promise.all([
    viewingCurrent && project.stage !== "complete" ? evaluateRestorationGate(project) : Promise.resolve(null),
    provenanceForProjects([project]).then((m) => m.get(project.id)!),
    project.buyerOrgId !== null
      ? db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, project.buyerOrgId)).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    db.select().from(auditLog)
      .where(and(eq(auditLog.entityType, "restoration"), eq(auditLog.entityId, String(project.id))))
      .orderBy(desc(auditLog.createdAt)).limit(100),
    viewed === "receive" ? restorationReceiveData(project)
      : viewed === "restore" ? restorationRestoreData(project)
      : viewed === "verify" ? restorationVerifyData(project)
      : viewed === "ship" ? restorationShipData(project, staff)
      : viewed === "commission" ? restorationCommissionData(project)
      : Promise.resolve(null),
  ]);

  const next = nextStage(project.stage);
  const advanceLabel = next === "complete" ? "Complete the restoration"
    : next === "commission" ? "Mark shipped - Commission"
    : next ? `Advance to ${next.charAt(0).toUpperCase()}${next.slice(1)}` : "";
  const now = new Date();
  const days = daysInStage(project.stageSince, now);
  const pipeline = RESTORATION_STAGES.slice(0, 5) as readonly RestorationStage[];

  return (
    <div className="container wide">
      <PageHead
        title={title}
        crumb={<><Link href="/assets">Assets</Link> / <Link href="/restorations">Restoration queue</Link> / <b>{inst.externalId}</b></>}
        status={
          <>
            <span className="sysid">{inst.externalId}</span>{" "}
            <Pill tone={queueStageTone(project.stage, project.stageSince, now)}>
              {RESTORATION_STAGE_LABEL[project.stage as RestorationStage] ?? project.stage}
            </Pill>
          </>
        }
      />

      <nav className="pipeline" aria-label="Restoration stages">
        {pipeline.map((st, i) => {
          const cls = ["stage",
            i < currentIdx || project.stage === "complete" ? "done" : "",
            st === viewed ? "active" : "",
            i > currentIdx ? "ahead" : "",
          ].filter(Boolean).join(" ");
          const body = (
            <>
              <span className="num">{String(i + 1).padStart(2, "0")}</span>
              <span className="nm">{st.charAt(0).toUpperCase() + st.slice(1)}</span>
            </>
          );
          return i <= currentIdx || project.stage === "complete"
            ? <Link key={st} className={cls} href={`/restorations/${project.id}?s=${st}`} aria-current={st === viewed ? "page" : undefined}>{body}</Link>
            : <span key={st} className={cls}>{body}</span>;
        })}
      </nav>

      <div className="proj-grid">
        <main>
          {!viewingCurrent && viewed !== "complete" && (
            <div className="crumb" style={{ marginBottom: 8 }}>
              Viewing the {RESTORATION_STAGE_LABEL[viewed]} record read-only ·{" "}
              <Link href={`/restorations/${project.id}`}>back to {RESTORATION_STAGE_LABEL[project.stage as RestorationStage]}</Link>
            </div>
          )}
          {viewed === "receive" && stageData && (
            <RestorationReceive projectId={project.id} data={stageData as Awaited<ReturnType<typeof restorationReceiveData>>}
              canEdit={canEdit && project.stage === "receive"} />
          )}
          {viewed === "restore" && stageData && (
            <RestorationRestore projectId={project.id} data={stageData as Awaited<ReturnType<typeof restorationRestoreData>>}
              canEdit={canEdit && project.stage === "restore"} />
          )}
          {viewed === "verify" && stageData && (
            <RestorationVerify projectId={project.id} data={stageData as Awaited<ReturnType<typeof restorationVerifyData>>}
              canEdit={canEdit && project.stage === "verify"} />
          )}
          {viewed === "ship" && stageData && (
            <RestorationShip projectId={project.id} data={stageData as Awaited<ReturnType<typeof restorationShipData>>}
              canEdit={canEdit && project.stage === "ship"} />
          )}
          {viewed === "commission" && stageData && (
            <RestorationCommission projectId={project.id} data={stageData as Awaited<ReturnType<typeof restorationCommissionData>>}
              canEdit={canEdit && project.stage === "commission"} externalId={inst.externalId} />
          )}
          {viewed === "complete" && (
            <section className="card">
              <h2 className="card-title">Complete <span className="eyebrow">the record transferred with the serial</span></h2>
              <div className="empty">
                <b>This restoration is done</b>
                The full history moved to {buyer?.name ?? "the buyer"}; this workspace keeps a frozen provider copy.
              </div>
            </section>
          )}

          {gate && <RestorationGateCard projectId={project.id} items={gate} advanceLabel={advanceLabel} />}

          <section className="card">
            <h2 className="card-title">Ledger <span className="eyebrow">the story so far</span></h2>
            <ActivityFeed items={ledger.map((a) => ({
              id: a.id, actor: a.actor, action: a.action, field: a.field ?? "",
              newValue: a.newValue ?? "", when: fmtWhen(a.createdAt),
            }))} />
          </section>
        </main>

        <aside className="side-wrap">
          <section className="card">
            <h2 className="card-title">Provenance</h2>
            <div className="prov-figure">{provenance.pct}<span className="unit">%</span></div>
            <div className="prov-sub">of this system&apos;s history is documented</div>
            <div className="meter-track"><div className="meter-fill prov" style={{ width: `${provenance.pct}%` }} /></div>
            <ul className="prov-list" style={{ marginTop: 12 }}>
              {provenance.lines.map((l) => (
                <li key={l.key}>{l.label} <Pill tone={l.tone}>{l.value}</Pill></li>
              ))}
            </ul>
            <div className="prov-note">
              Every gap is a question the next buyer will ask. Computed from the
              record, never stored - it moves the moment the record does.
            </div>
          </section>
          <section className="card">
            <h2 className="card-title">Session</h2>
            <div className="row al-baseline sp-2 t-body" style={{ justifyContent: "space-between" }}>
              <span className="mut">Assignee</span><span>{project.assignee.trim() || "unassigned"}</span>
            </div>
            <div className="row al-baseline sp-2 t-body" style={{ justifyContent: "space-between" }}>
              <span className="mut">Source</span>
              <span>{RESTORATION_SOURCE_LABEL[project.source as keyof typeof RESTORATION_SOURCE_LABEL] ?? project.source}</span>
            </div>
            <div className="row al-baseline sp-2 t-body" style={{ justifyContent: "space-between" }}>
              <span className="mut">Opened</span><span>{fmtWhen(project.createdAt)}</span>
            </div>
            <div className="row al-baseline sp-2 t-body" style={{ justifyContent: "space-between" }}>
              <span className="mut">In this stage</span><span>{days === 0 ? "since today" : `${days} d`}</span>
            </div>
            {buyer && (
              <div className="row al-baseline sp-2 t-body" style={{ justifyContent: "space-between" }}>
                <span className="mut">Buyer</span><span>{buyer.name}</span>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

/**
 * What the buying organization sees: where their system is, and - once
 * commissioning proves out - the acceptance signature. Their own session is
 * the credential; a session from any other org gets "not found".
 */
async function BuyerView({ user, projectId }: { user: SessionUser; projectId: number }) {
  const [project] = await db.select().from(restorationProjects).where(eq(restorationProjects.id, projectId));
  if (!project || project.buyerOrgId === null || user.orgId !== project.buyerOrgId) notFound();

  const [inst] = await db.select().from(instruments).where(eq(instruments.id, project.instrumentId));
  if (!inst) notFound();
  const labels = await getSystemLabels([inst]);
  const [shipment] = await db.select().from(shipments).where(eq(shipments.projectId, projectId));
  const [acc] = await db.select().from(acceptances).where(eq(acceptances.projectId, projectId));
  const stage = project.stage as RestorationStage;
  const shippedOn = stageIndex(stage) >= stageIndex("ship");

  return (
    <div className="container page">
      <PageHead
        title={labels.get(inst.id) || inst.model || inst.externalId}
        crumb={<b>Your incoming system</b>}
        status={<Pill tone={queueStageTone(project.stage, project.stageSince, new Date())}>{RESTORATION_STAGE_LABEL[stage]}</Pill>}
      />
      <section className="card">
        <h2 className="card-title">Where it is</h2>
        {shippedOn && shipment ? (
          <>
            {shipment.carrier && (
              <div className="row al-baseline sp-2 t-body" style={{ justifyContent: "space-between" }}>
                <span className="mut">Carrier</span><span>{shipment.carrier}</span>
              </div>
            )}
            {shipment.trackingNumber && (
              <div className="row al-baseline sp-2 t-body" style={{ justifyContent: "space-between" }}>
                <span className="mut">Tracking</span><span className="mono">{shipment.trackingNumber}</span>
              </div>
            )}
            {shipment.pickupOn && (
              <div className="row al-baseline sp-2 t-body" style={{ justifyContent: "space-between" }}>
                <span className="mut">Pickup</span><span>{shipment.pickupOn}{shipment.pickupNote ? ` · ${shipment.pickupNote}` : ""}</span>
              </div>
            )}
            {!shipment.carrier && !shipment.trackingNumber && (
              <div className="mut t-body">Being prepared for shipment - carrier and tracking appear here.</div>
            )}
          </>
        ) : (
          <div className="mut t-body">
            Being restored and verified. It ships when every gate passes - you
            will see carrier and tracking here the moment it does.
          </div>
        )}
      </section>
      {stage === "commission" && acc?.requestedAt && (
        <section className="card">
          <h2 className="card-title">Acceptance</h2>
          {acc.signedAt ? (
            <div className="gate-item">
              <span className="gate-mark ok">✓</span>
              Signed by {acc.signedBy} · {fmtWhen(acc.signedAt)}
            </div>
          ) : (
            <BuyerAcceptanceCard projectId={project.id} />
          )}
        </section>
      )}
      {stage === "complete" && (
        <section className="card">
          <div className="empty">
            <b>Commissioned and yours</b>
            The full service record transferred with the system - find it under your equipment.
          </div>
        </section>
      )}
    </div>
  );
}
