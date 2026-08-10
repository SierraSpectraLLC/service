import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { engagementRecords } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isHouse } from "@/lib/tenancy";
import { shopTime } from "@/lib/shopday";
import type { SystemDossier } from "@/lib/dossier";
import ActivityFeed from "@/components/ActivityFeed";

export const dynamic = "force-dynamic";

const fmtSize = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const when = (iso: string) => shopTime(new Date(iso));

/**
 * A frozen engagement record: the system's dossier exactly as it stood when
 * the viewer's organization was taken off it. Read-only by construction - the
 * page renders stored JSON, not live rows, so nothing that happened since the
 * revocation can appear here.
 */
export default async function RecordPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const recId = parseInt(id);
  if (isNaN(recId)) notFound();
  const [rec] = await db.select().from(engagementRecords).where(eq(engagementRecords.id, recId));
  // Yours or staff's - another org's record doesn't exist as far as you know.
  if (!rec || (!isHouse(user.role) && rec.orgId !== user.orgId)) notFound();
  const d = rec.data as SystemDossier;

  return (
    <div className="container page">
      <div style={{ marginBottom: 10 }}>
        <Link href="/" className="mut" style={{ fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      </div>

      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", background: "#EEF1F5", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>
          <span className="pill" style={{ background: "#E2E8F0", color: "#475569" }}>Frozen record</span>
          <span className="mut" style={{ fontSize: 12 }}>Engagement ended {shopTime(rec.revokedAt)}. Never updates.</span>
        </div>

        <div className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--mut)" }}>
          {d.system.externalId}{d.system.client ? ` · ${d.system.client}` : ""}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--navy)" }}>
            {d.label || <span className="mut" style={{ fontWeight: 400, fontSize: 15 }}>No assets were listed</span>}
          </div>
          {d.system.category && <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>{d.system.category}</span>}
          {d.system.stages.map((s) => <span key={s} className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>{s}</span>)}
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
                <span key={i} className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>
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
                <span className="pill" style={{ background: t.state === "Done" ? "#E5F3E5" : "#EEF1F5", color: t.state === "Done" ? "#2E6B2E" : "#475569" }}>{t.state}</span>
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
              <span className="pill" style={{ marginLeft: 6, background: "#EEF1F5", color: "#475569" }}>{p.status}</span>
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
              <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>{a.kind}</span>
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
