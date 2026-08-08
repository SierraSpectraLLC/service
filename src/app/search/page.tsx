import { redirect } from "next/navigation";
import Link from "next/link";
import { desc, ilike, or, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  instruments, tasks, parts, attachments, discussionPosts, assets, auditLog,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getSystemLabels } from "@/lib/systemLabel";
import SearchBox from "@/components/SearchBox";

export const dynamic = "force-dynamic";

// Work can live on a system or on a standalone asset, so each hit carries its
// own link and a "where it lives" line rather than an id we reinterpret.
type Hit = { id: number; group: string; title: string; sub: string; href: string; where: string };

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
        // Asset models/serials are searched through the assets table below;
        // the system itself is found by ID, client, notes, location or lead.
        ilike(instruments.externalId, like), ilike(instruments.client, like),
        ilike(instruments.notes, like), ilike(instruments.location, like), ilike(instruments.lead, like),
      )).limit(25),
      db.select().from(tasks).where(or(ilike(tasks.title, like), ilike(tasks.body, like), ilike(tasks.assignee, like))).limit(25),
      db.select().from(parts).where(or(
        ilike(parts.name, like), ilike(parts.partNumber, like), ilike(parts.serial, like),
        ilike(parts.vendor, like), ilike(parts.po, like), ilike(parts.note, like), ilike(parts.specs, like),
      )).limit(25),
      db.select().from(attachments).where(or(ilike(attachments.fileName, like), ilike(attachments.description, like))).limit(25),
      db.select().from(discussionPosts).where(ilike(discussionPosts.body, like)).orderBy(desc(discussionPosts.createdAt)).limit(25),
      db.select().from(assets).where(or(
        ilike(assets.model, like), ilike(assets.serial, like), ilike(assets.note, like), ilike(assets.manufacturer, like),
      )).limit(25),
      db.select().from(auditLog).where(ilike(auditLog.action, like)).orderBy(desc(auditLog.createdAt)).limit(15),
    ]);

    const ids = new Set<number>([
      ...instRows.map((i) => i.id),
      ...[...taskRows, ...partRows, ...attachRows, ...postRows, ...auditRows]
        .flatMap((r) => (r.instrumentId ? [r.instrumentId] : [])),
      ...moduleRows.flatMap((m) => (m.instrumentId ? [m.instrumentId] : [])),
    ]);
    // Assets referenced by asset-owned work, so those rows can say whose they are.
    const assetIds = new Set<number>([
      ...moduleRows.map((m) => m.id),
      ...[...taskRows, ...partRows, ...attachRows, ...auditRows].flatMap((r) => (r.assetId ? [r.assetId] : [])),
    ]);
    const assetRows = assetIds.size
      ? await db.select({ id: assets.id, kind: assets.kind, model: assets.model, serial: assets.serial })
          .from(assets).where(inArray(assets.id, [...assetIds]))
      : [];
    const assetLabels = new Map(assetRows.map((a) => [a.id, `${a.kind} — ${a.model || a.serial || "(no model)"}`]));
    const named = ids.size
      ? await db.select({ id: instruments.id, externalId: instruments.externalId, model: instruments.model })
          .from(instruments).where(inArray(instruments.id, [...ids]))
      : [];
    const composed = await getSystemLabels(named);
    labels = new Map(named.map((n) => {
      const label = composed.get(n.id) ?? "";
      return [n.id, label ? `${n.externalId} - ${label}` : n.externalId];
    }));

    const join = (parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" · ");
    // Where a row of work lives: its system, else the asset that owns it.
    const place = (r: { instrumentId: number | null; assetId?: number | null }) =>
      r.instrumentId
        ? { href: `/instruments/${r.instrumentId}`, where: labels.get(r.instrumentId) ?? "" }
        : r.assetId
          ? { href: `/assets/${r.assetId}`, where: assetLabels.get(r.assetId) ?? "Asset" }
          : { href: "/discussions", where: "General discussion" };
    hits = [
      ...instRows.map((i) => ({ id: i.id, group: "Systems", title: labels.get(i.id) ?? i.externalId, sub: join([i.client, i.location, i.lead && `lead ${i.lead}`]), href: `/instruments/${i.id}`, where: i.client })),
      ...taskRows.map((t) => ({ id: t.id, group: "Tasks", title: t.title, sub: join([t.state, t.assignee, t.body]), ...place(t) })),
      ...partRows.map((p) => ({ id: p.id, group: p.kind === "consumable" ? "Consumables" : "Parts", title: p.name, sub: join([p.partNumber && `PN ${p.partNumber}`, p.serial && `SN ${p.serial}`, p.vendor, p.status]), ...place(p) })),
      ...moduleRows.map((m) => ({ id: m.id, group: "Assets", title: `${m.kind}: ${m.model || "(no model)"}`, sub: join([m.serial && `SN ${m.serial}`, m.status, m.note]), href: `/assets/${m.id}`, where: m.instrumentId ? labels.get(m.instrumentId) ?? "" : "On the shelf" })),
      ...attachRows.map((a) => ({ id: a.id, group: "Files", title: a.fileName, sub: join([a.kind, a.description]), ...place(a) })),
      ...postRows.map((p) => ({ id: p.id, group: "Discussion", title: p.body.slice(0, 120), sub: p.author, ...place({ instrumentId: p.instrumentId }) })),
      ...auditRows.map((a) => ({ id: a.id, group: "History", title: a.action.slice(0, 120), sub: a.actor.split("@")[0], ...place(a) })),
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
            <Link key={`${g}-${h.id}`} href={h.href} className="row-hover"
              style={{ display: "block", padding: "7px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit" }}>
              <div style={{ fontSize: 13 }}>{h.title}</div>
              <div className="mut" style={{ fontSize: 11 }}>
                {h.where}{h.sub ? ` · ${h.sub}` : ""}
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
