import { notFound, redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { engagementRecords } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { tenantOfOrg, tenantOfSystem } from "@/lib/tenancy";
import { houseOfRecord } from "@/lib/tenants";
import { shopTime } from "@/lib/shopday";
import type { SystemDossier } from "@/lib/dossier";
import ActivityFeed from "@/components/ActivityFeed";
import { RecordHero, type HeroStat } from "@/components/ui";

export const dynamic = "force-dynamic";

const fmtSize = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const when = (iso: string) => shopTime(new Date(iso));

/**
 * A frozen engagement record: the system's dossier exactly as it stood at the
 * moment the holder's involvement changed - their share withdrawn, or the
 * system handed on to a new owner. Read-only by construction: the page renders
 * stored JSON, not live rows, so nothing recorded since can appear here.
 */
export default async function RecordPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const recId = parseInt(id);
  if (isNaN(recId)) notFound();
  const [rec] = await db.select().from(engagementRecords).where(eq(engagementRecords.id, recId));
  if (!rec) notFound();
  // Yours, or staff of the workspace that wrote it. A dossier is the whole
  // history of a system - costs, files, hours - so "staff somewhere" is not
  // enough: it has to be staff HERE. The record follows its system's tenant, or
  // the holder's when the system is gone.
  const recTenant = rec.instrumentId !== null
    ? await tenantOfSystem(rec.instrumentId)
    : await tenantOfOrg(rec.orgId);
  if (!houseOfRecord(user, recTenant) && rec.orgId !== user.orgId) notFound();
  const d = rec.data as SystemDossier;
  const handoff = rec.kind === "handoff";
  // A superseded record still reads - it is evidence, and someone may have
  // linked to it - but it says so, and points at the one that replaced it.
  const [current] = rec.supersededAt === null || rec.instrumentId === null ? [] : await db
    .select({ id: engagementRecords.id }).from(engagementRecords)
    .where(and(
      eq(engagementRecords.instrumentId, rec.instrumentId),
      eq(engagementRecords.orgId, rec.orgId),
      eq(engagementRecords.kind, rec.kind),
      isNull(engagementRecords.supersededAt),
    ));

  const heroStats: HeroStat[] = [
    { value: shopTime(rec.revokedAt), label: handoff ? "handed on" : "ended" },
    { value: d.tasks.length, label: "tasks" },
    { value: d.parts.length, label: "parts" },
    { value: d.attachments.length, label: "files" },
  ];

  return (
    <div className="container page">
      <div className="crumb">
        <Link href="/" style={{ textDecoration: "none", color: "inherit" }}>Today</Link> › <b>Engagement record</b>
      </div>

      <RecordHero
        eyebrow={`${handoff ? "Handoff" : "Engagement"} record${d.system.client ? ` · ${d.system.client}` : ""}`}
        id={d.system.externalId}
        title={d.label || "No assets were listed"}
        meta={[d.system.category, ...d.system.stages, d.system.location].filter(Boolean).join(" · ") || undefined}
        stats={heroStats}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", background: "#EEF1F5", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px" }}>
        <span className="pill neutral">{rec.kind === "sealed" ? "Sealed record" : "Frozen record"}</span>
        <span className="mut t-small">
          {handoff
            ? `Handed on ${shopTime(rec.revokedAt)}. Your tenure as it stood that day - it never updates, and the live system has moved on without it.`
            : `Engagement ended ${shopTime(rec.revokedAt)}. Never updates.`}
        </span>
        {/* Yours to take away, forever: the stored JSON, its files, and the
            hash the recipient of the machine was given. See records/[id]/export. */}
        <a className="btn sm" href={`/records/${rec.id}/export`} style={{ marginLeft: "auto", textDecoration: "none" }}>
          Download bundle
        </a>
        {rec.bundleHash && <span className="mono mut t-meta" title={rec.bundleHash}>sha256 {rec.bundleHash.slice(0, 12)}…</span>}
        {rec.supersededAt !== null && (
          <span className="mut t-small">
            · Superseded {shopTime(rec.supersededAt)}
            {current && <> - <Link href={`/records/${current.id}`}>the current record</Link> covers this system</>}
          </span>
        )}
      </div>

      {(d.system.notes || d.assets.length > 0 || d.gases.length > 0) && <div className="card">
        {d.system.notes && <div className="mut t-body" style={{ whiteSpace: "pre-wrap" }}>{d.system.notes}</div>}

        {d.assets.length > 0 && (
          <>
            <div className="eyebrow" style={{ marginTop: d.system.notes ? 14 : 0, marginBottom: 6 }}>Assets</div>
            {d.assets.map((a, i) => (
              <div key={i} className="t-body" style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                <b>{a.kind}</b>{a.model ? ` - ${a.model}` : ""}{a.serial ? <span className="mono mut"> SN {a.serial}</span> : ""}
                <span className="mut"> · {a.status}</span>
                {a.asFound && <div className="mut t-small" style={{ whiteSpace: "pre-wrap" }}>As found: {a.asFound}</div>}
                {a.note && <div className="mut t-small" style={{ whiteSpace: "pre-wrap" }}>{a.note}</div>}
              </div>
            ))}
          </>
        )}

        {d.gases.length > 0 && (
          <>
            <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>Gases</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {d.gases.map((g, i) => (
                <span key={i} className="pill neutral">
                  {g.gas} · {g.status}{g.note ? ` · ${g.note}` : ""}
                </span>
              ))}
            </div>
          </>
        )}
      </div>}

      {d.tasks.length > 0 && (
        <div className="card">
          <div className="card-title">Tasks ({d.tasks.length})</div>
          {d.tasks.map((t, i) => (
            <div key={i} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <b className="t-body">{t.title}</b>
                <span className={`pill ${t.state === "Done" ? "good" : "neutral"}`}>{t.state}</span>
                {t.assignee && <span className="mut t-small">{t.assignee}</span>}
                {t.dueDate && <span className="mut t-small">due {t.dueDate}</span>}
                <span className="mut t-meta" style={{ marginLeft: "auto" }}>{when(t.createdAt)}</span>
              </div>
              {t.body && <div className="mut t-small" style={{ whiteSpace: "pre-wrap", marginTop: 2 }}>{t.body}</div>}
              {t.checklist.map((c, j) => (
                <div key={j} className="t-small" style={{ marginTop: 2, paddingLeft: 12 }}>
                  {c.done ? "☑" : "☐"} {c.text}
                  {c.notes.map((n, k) => (
                    <div key={k} className="mut t-meta" style={{ paddingLeft: 18 }}>{n.author}: {n.text}</div>
                  ))}
                </div>
              ))}
              {t.notes.map((n, j) => (
                <div key={j} className="mut t-small" style={{ marginTop: 2, paddingLeft: 12 }}>{n.author}: {n.text} <span style={{ fontSize: 10 }}>· {when(n.createdAt)}</span></div>
              ))}
            </div>
          ))}
        </div>
      )}

      {d.parts.length > 0 && (
        <div className="card">
          <div className="card-title">Parts &amp; consumables ({d.parts.length})</div>
          {d.parts.map((p, i) => (
            <div key={i} className="t-body" style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <b>{p.name}</b>
              {p.partNumber && <span className="mono mut"> {p.partNumber}</span>}
              {p.serial && <span className="mono mut"> SN {p.serial}</span>}
              <span className="pill neutral" style={{ marginLeft: 6 }}>{p.status}</span>
              <div className="mut t-small">
                {[p.vendor, p.qty && `qty ${p.qty}`, p.installedAt && `installed ${p.installedAt}`, p.removedAt && `removed ${p.removedAt}`].filter(Boolean).join(" · ")}
              </div>
              {p.note && <div className="mut t-small" style={{ whiteSpace: "pre-wrap" }}>{p.note}</div>}
            </div>
          ))}
        </div>
      )}

      {d.attachments.length > 0 && (
        <div className="card">
          <div className="card-title">Files ({d.attachments.length})</div>
          <div className="mut t-meta" style={{ marginBottom: 6 }}>
            Links point at the files as they were shared then; one deleted since may no longer open.
          </div>
          {d.attachments.map((a, i) => (
            <div key={i} className="t-body" style={{ padding: "5px 0", borderTop: "1px solid var(--line)", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
              <a href={a.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>{a.fileName}</a>
              <span className="pill neutral">{a.kind}</span>
              {a.description && <span className="mut t-small">{a.description}</span>}
              <span className="mut t-meta" style={{ marginLeft: "auto" }}>{fmtSize(a.size)} · {when(a.createdAt)}</span>
            </div>
          ))}
        </div>
      )}

      {d.discussion.length > 0 && (
        <div className="card">
          <div className="card-title">Discussion ({d.discussion.length})</div>
          {d.discussion.map((p, i) => (
            <div key={i} style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <div className="t-small" style={{ fontWeight: 700 }}>{p.author} <span className="mut t-meta" style={{ fontWeight: 400 }}>· {when(p.createdAt)}</span></div>
              <div className="t-body" style={{ whiteSpace: "pre-wrap" }}>{p.body}</div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-title">Activity</div>
        <ActivityFeed items={d.activity.map((a, i) => ({
          id: i, actor: a.actor, action: a.action, field: a.field, newValue: a.newValue, when: when(a.createdAt),
        }))} />
      </div>
    </div>
  );
}
