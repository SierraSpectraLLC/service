import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, instruments, orgs, restorationProjects } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { forTenant, readTenant } from "@/lib/tenancy";
import { fmtWhen } from "@/lib/when";
import {
  RESTORATION_SOURCE_LABEL, RESTORATION_STAGES, RESTORATION_STAGE_LABEL,
  daysInStage, nextStage, queueStageTone, stageIndex, type RestorationStage,
} from "@/lib/restoration";
import { evaluateRestorationGate, provenanceForProjects } from "@/lib/restorationData";
import { getSystemLabels } from "@/lib/systemLabel";
import { PageHead, Pill } from "@/components/ui";
import ActivityFeed from "@/components/ActivityFeed";
import RestorationGateCard from "@/components/RestorationGateCard";

export const dynamic = "force-dynamic";

/** What each stage's working surface will hold, until its phase lands. */
const STAGE_PREVIEW: Record<string, string> = {
  receive: "Serial-first component intake, condition grades, findings, the provenance interview, and the handoff kit land here next.",
  restore: "The task list from findings, parts used, and outside work land here next.",
  verify: "Bench setup, the checkout verdict, the application check, and data hygiene land here next.",
  ship: "Destination, prep checklist, crates and manifest, and carrier cover land here next.",
  commission: "Install dispatch, the on-site checklist, and buyer acceptance land here next.",
  complete: "This restoration is complete - the record has transferred with the serial.",
};

/**
 * One restoration project: the pipeline across the top, the viewed stage's
 * cards in the main column, and the computed provenance beside it. Earlier
 * stages stay viewable; only the current stage is workable.
 */
export default async function RestorationPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ s?: string }>;
}) {
  let user;
  try { user = await requireStaff(); } catch { redirect("/"); }
  const { id: idRaw } = await params;
  const id = parseInt(idRaw);
  if (!Number.isFinite(id)) notFound();

  const [project] = await db.select().from(restorationProjects)
    .where(and(eq(restorationProjects.id, id), forTenant(restorationProjects.tenantOrgId, readTenant(user))));
  if (!project) notFound();

  const [inst] = await db.select().from(instruments).where(eq(instruments.id, project.instrumentId));
  if (!inst) notFound();
  const labels = await getSystemLabels([inst]);
  const title = labels.get(inst.id) || inst.model || inst.externalId;

  const currentIdx = stageIndex(project.stage);
  const { s } = await searchParams;
  // Which stage is on screen: the current one, or an earlier one read-only.
  // A stage the project has not reached has nothing to show yet.
  const viewed = s && stageIndex(s) >= 0 && stageIndex(s) <= currentIdx ? (s as RestorationStage) : (project.stage as RestorationStage);
  const viewingCurrent = viewed === project.stage;

  const [gate, provenance, buyer, ledger] = await Promise.all([
    viewingCurrent && project.stage !== "complete" ? evaluateRestorationGate(project) : Promise.resolve(null),
    provenanceForProjects([project]).then((m) => m.get(project.id)!),
    project.buyerOrgId !== null
      ? db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, project.buyerOrgId)).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    db.select().from(auditLog)
      .where(and(eq(auditLog.entityType, "restoration"), eq(auditLog.entityId, String(project.id))))
      .orderBy(desc(auditLog.createdAt)).limit(100),
  ]);

  const next = nextStage(project.stage);
  const advanceLabel = next === "complete" ? "Complete the restoration"
    : next === "commission" ? "Mark shipped - Commission"
    : next ? `Advance to ${next.charAt(0).toUpperCase()}${next.slice(1)}` : "";
  const now = new Date();
  const days = daysInStage(project.stageSince, now);

  // The pipeline shows the five working stages; "complete" is the state after
  // the last of them, worn by the pill rather than a sixth box.
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
          // Reached stages link; the road ahead is visible but not a door.
          return i <= currentIdx || project.stage === "complete"
            ? <Link key={st} className={cls} href={`/restorations/${project.id}?s=${st}`} aria-current={st === viewed ? "page" : undefined}>{body}</Link>
            : <span key={st} className={cls}>{body}</span>;
        })}
      </nav>

      <div className="proj-grid">
        <main>
          <section className="card">
            <h2 className="card-title">
              {RESTORATION_STAGE_LABEL[viewed]}
              {!viewingCurrent && <span className="eyebrow">read-only - an earlier stage</span>}
            </h2>
            <div className="empty">
              <b>{viewingCurrent ? "The working surface for this stage is on its way" : "This stage is on the record"}</b>
              {STAGE_PREVIEW[viewed]}
              {!viewingCurrent && <div className="empty-act">
                <Link className="btn sm" href={`/restorations/${project.id}`}>Back to {RESTORATION_STAGE_LABEL[project.stage as RestorationStage]}</Link>
              </div>}
            </div>
          </section>

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
