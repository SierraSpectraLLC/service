import { redirect } from "next/navigation";
import Link from "next/link";
import { desc, ilike, or, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  instruments, tasks, parts, attachments, discussionPosts, instrumentModules, auditLog,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import SearchBox from "@/components/SearchBox";

export const dynamic = "force-dynamic";

type Hit = { id: number; instrumentId: number; group: string; title: string; sub: string };

/** One box over everything: serials, POs, parts, tasks, modules, files, posts, history. */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  try { await requireUser(); } catch { redirect("/login"); }
  const { q: raw } = await searchParams;
  const q = (raw ?? "").trim();
  const like = `%${q}%`;

  let hits: Hit[] = [];
  let labels = new Map<number, string>();

  if (q.length >= 2) {
    const [instRows, taskRows, partRows, attachRows, postRows, moduleRows, auditRows] = await Promise.all([
      db.select().from(instruments).where(or(
        ilike(instruments.externalId, like), ilike(instruments.model, like), ilike(instruments.client, like),
        ilike(instruments.notes, like), ilike(instruments.serial, like), ilike(instruments.manufacturer, like),
        ilike(instruments.location, like), ilike(instruments.lead, like),
      )).limit(25),
      db.select().from(tasks).where(or(ilike(tasks.title, like), ilike(tasks.body, like), ilike(tasks.assignee, like))).limit(25),
      db.select().from(parts).where(or(
        ilike(parts.name, like), ilike(parts.partNumber, like), ilike(parts.serial, like),
        ilike(parts.vendor, like), ilike(parts.po, like), ilike(parts.note, like), ilike(parts.specs, like),
      )).limit(25),
      db.select().from(attachments).where(or(ilike(attachments.fileName, like), ilike(attachments.description, like))).limit(25),
      db.select().from(discussionPosts).where(ilike(discussionPosts.body, like)).orderBy(desc(discussionPosts.createdAt)).limit(25),
      db.select().from(instrumentModules).where(or(
        ilike(instrumentModules.model, like), ilike(instrumentModules.serial, like), ilike(instrumentModules.note, like),
      )).limit(25),
      db.select().from(auditLog).where(ilike(auditLog.action, like)).orderBy(desc(auditLog.createdAt)).limit(15),
    ]);

    const ids = new Set<number>([
      ...instRows.map((i) => i.id),
      ...taskRows.map((t) => t.instrumentId), ...partRows.map((p) => p.instrumentId),
      ...attachRows.map((a) => a.instrumentId), ...moduleRows.map((m) => m.instrumentId),
      ...postRows.flatMap((p) => (p.instrumentId ? [p.instrumentId] : [])),
      ...auditRows.flatMap((a) => (a.instrumentId ? [a.instrumentId] : [])),
    ]);
    const named = ids.size
      ? await db.select({ id: instruments.id, externalId: instruments.externalId, model: instruments.model })
          .from(instruments).where(inArray(instruments.id, [...ids]))
      : [];
    labels = new Map(named.map((n) => [n.id, `${n.externalId} - ${n.model}`]));

    const join = (parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" · ");
    hits = [
      ...instRows.map((i) => ({ id: i.id, instrumentId: i.id, group: "Systems", title: `${i.externalId} - ${i.model}`, sub: join([i.client, i.location, i.serial && `SN ${i.serial}`]) })),
      ...taskRows.map((t) => ({ id: t.id, instrumentId: t.instrumentId, group: "Tasks", title: t.title, sub: join([t.state, t.assignee, t.body]) })),
      ...partRows.map((p) => ({ id: p.id, instrumentId: p.instrumentId, group: p.kind === "consumable" ? "Consumables" : "Parts", title: p.name, sub: join([p.partNumber && `PN ${p.partNumber}`, p.serial && `SN ${p.serial}`, p.vendor, p.status]) })),
      ...moduleRows.map((m) => ({ id: m.id, instrumentId: m.instrumentId, group: "Modules", title: `${m.kind}: ${m.model || "(no model)"}`, sub: join([m.serial && `SN ${m.serial}`, m.note]) })),
      ...attachRows.map((a) => ({ id: a.id, instrumentId: a.instrumentId, group: "Files", title: a.fileName, sub: join([a.kind, a.description]) })),
      ...postRows.map((p) => ({ id: p.id, instrumentId: p.instrumentId ?? 0, group: "Discussion", title: p.body.slice(0, 120), sub: p.author })),
      ...auditRows.map((a) => ({ id: a.id, instrumentId: a.instrumentId ?? 0, group: "History", title: a.action.slice(0, 120), sub: a.actor.split("@")[0] })),
    ];
  }

  const groups = [...new Set(hits.map((h) => h.group))];

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Search</div>
        <SearchBox initial={q} />
        {q.length >= 2 && (
          <div className="mut" style={{ fontSize: 12, marginTop: 8 }}>
            {hits.length} match{hits.length === 1 ? "" : "es"} for &ldquo;{q}&rdquo;
          </div>
        )}
      </div>

      {groups.map((g) => (
        <div key={g} className="card">
          <div className="eyebrow" style={{ marginBottom: 6 }}>{g}</div>
          {hits.filter((h) => h.group === g).map((h) => (
            <Link key={`${g}-${h.id}`} href={h.instrumentId ? `/instruments/${h.instrumentId}` : "/discussions"} className="row-hover"
              style={{ display: "block", padding: "7px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit" }}>
              <div style={{ fontSize: 13 }}>{h.title}</div>
              <div className="mut" style={{ fontSize: 11 }}>
                {h.instrumentId ? labels.get(h.instrumentId) ?? "" : "General discussion"}{h.sub ? ` · ${h.sub}` : ""}
              </div>
            </Link>
          ))}
        </div>
      ))}

      {q.length >= 2 && hits.length === 0 && (
        <div className="card"><div className="mut" style={{ fontSize: 13 }}>Nothing found.</div></div>
      )}
    </div>
  );
}
