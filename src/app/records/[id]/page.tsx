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

  return (
    <div className="container page">
      <div style={{ marginBottom: 10 }}>
        <Link href="/" className="mut" style={{ fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      </div>

      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", background: "#EEF1F5", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>
          <span className="pill neutral">Frozen record</span>
          <span className="mut" style={{ fontSize: 12 }}>
            {handoff
              ? `Handed on ${shopTime(rec.revokedAt)}. Your tenure as it stood that day - it never updates, and the live system has moved on without it.`
              : `Engagement ended ${shopTime(rec.revokedAt)}. Never updates.`}
          </span>
          {rec.supersededAt !== null && (
            <span className="mut" style={{ fontSize: 12 }}>
              · Superseded {shopTime(rec.supersededAt)}
              {current && <> — <Link href={`/records/${current.id}`}>the current record</Link> covers this system</>}
            </span>
          )}
        </div>

        <div className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--mut)" }}>
          {d.system.externalId}{d.system.client ? ` · ${d.system.client}` : ""}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--navy)" }}>
            {d.label || <span className="mut" style={{ fontWeight: 400, fontSize: 15 }}>No assets were listed</span>}
          </div>
          {d.system.category && <span className="pill info">{d.system.category}</span>}
          {d.system.stages.map((s) => <span key={s} className="pill neutral">{s}</span>)}
        </div>
        {d.system.location && <div className="mut" style={{ fontSize: 12, marginTop: 2 }}>{d.system.location}</div>}
        {d.system.notes && <div className="mut" style={{ fontSize: 13, marginTop: 6, whiteSpace: "pre-wrap" }}>{d.system.notes}</div>}

        {d.assets.length > 0 && (
          <>
            <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>Assets</div>
            {d.assets.map((a, i) => (
              <div key={i} style={{ padding: "6px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
                <b>{a.kind}</b>{a.model ? ` — ${a.model}` : ""}{a.serial ? <span className="mono mut"> SN {a.serial}</span> : ""}
                <span className="mut"> · {a.status}</span>
                {a.asFound && <div className="mut" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>As found: {a.asFound}</div>}
                {a.note && <div className="mut" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{a.note}</div>}
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
      </div>

      {d.tasks.length > 0 && (
        <div className="card">
          <div className="card-title">Tasks ({d.tasks.length})</div>
          {d.tasks.map((t, i) => (
            <div key={i} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <b style={{ fontSize: 13 }}>{t.title}</b>
                <span className={`pill ${t.state === "Done" ? "good" : "neutral"}`}>{t.state}</span>
                {t.assignee && <span className="mut" style={{ fontSize: 12 }}>{t.assignee}</span>}
                {t.dueDate && <span className="mut" style={{ fontSize: 12 }}>due {t.dueDate}</span>}
                <span className="mut" style={{ fontSize: 11, marginLeft: "auto" }}>{when(t.createdAt)}</span>
              </div>
              {t.body && <div className="mut" style={{ fontSize: 12, whiteSpace: "pre-wrap", marginTop: 2 }}>{t.body}</div>}
              {t.checklist.map((c, j) => (
                <div key={j} style={{ fontSize: 12, marginTop: 2, paddingLeft: 12 }}>
                  {c.done ? "☑" : "☐"} {c.text}
                  {c.notes.map((n, k) => (
                    <div key={k} className="mut" style={{ paddingLeft: 18, fontSize: 11 }}>{n.author}: {n.text}</div>
                  ))}
                </div>
              ))}
              {t.notes.map((n, j) => (
                <div key={j} className="mut" style={{ fontSize: 12, marginTop: 2, paddingLeft: 12 }}>{n.author}: {n.text} <span style={{ fontSize: 10 }}>· {when(n.createdAt)}</span></div>
              ))}
            </div>
          ))}
        </div>
      )}

      {d.parts.length > 0 && (
        <div className="card">
          <div className="card-title">Parts &amp; consumables ({d.parts.length})</div>
          {d.parts.map((p, i) => (
            <div key={i} style={{ padding: "6px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
              <b>{p.name}</b>
              {p.partNumber && <span className="mono mut"> {p.partNumber}</span>}
              {p.serial && <span className="mono mut"> SN {p.serial}</span>}
              <span className="pill neutral" style={{ marginLeft: 6 }}>{p.status}</span>
              <div className="mut" style={{ fontSize: 12 }}>
                {[p.vendor, p.qty && `qty ${p.qty}`, p.installedAt && `installed ${p.installedAt}`, p.removedAt && `removed ${p.removedAt}`].filter(Boolean).join(" · ")}
              </div>
              {p.note && <div className="mut" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{p.note}</div>}
            </div>
          ))}
        </div>
      )}

      {d.attachments.length > 0 && (
        <div className="card">
          <div className="card-title">Files ({d.attachments.length})</div>
          <div className="mut" style={{ fontSize: 11, marginBottom: 6 }}>
            Links point at the files as they were shared then; one deleted since may no longer open.
          </div>
          {d.attachments.map((a, i) => (
            <div key={i} style={{ padding: "5px 0", borderTop: "1px solid var(--line)", fontSize: 13, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
              <a href={a.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>{a.fileName}</a>
              <span className="pill neutral">{a.kind}</span>
              {a.description && <span className="mut" style={{ fontSize: 12 }}>{a.description}</span>}
              <span className="mut" style={{ fontSize: 11, marginLeft: "auto" }}>{fmtSize(a.size)} · {when(a.createdAt)}</span>
            </div>
          ))}
        </div>
      )}

      {d.discussion.length > 0 && (
        <div className="card">
          <div className="card-title">Discussion ({d.discussion.length})</div>
          {d.discussion.map((p, i) => (
            <div key={i} style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>{p.author} <span className="mut" style={{ fontWeight: 400, fontSize: 11 }}>· {when(p.createdAt)}</span></div>
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{p.body}</div>
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
