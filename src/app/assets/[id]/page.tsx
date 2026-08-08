import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { assets, assetEvents, tasks, parts, timeEntries, instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { shopTime } from "@/lib/shopday";
import { formatHours } from "@/lib/hours";
import { mergeAssetHistory } from "@/lib/assetHistory";
import AssetControls from "@/components/AssetControls";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = { event: "", task: "Task", part: "Part", time: "Time" };

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const assetId = parseInt(id);
  if (isNaN(assetId)) notFound();

  const [[asset], events, taggedTasks, taggedParts, taggedTime, insts, ownerRows] = await Promise.all([
    db.select().from(assets).where(eq(assets.id, assetId)),
    db.select().from(assetEvents).where(eq(assetEvents.assetId, assetId)),
    db.select().from(tasks).where(eq(tasks.assetId, assetId)),
    db.select().from(parts).where(eq(parts.assetId, assetId)),
    db.select().from(timeEntries).where(eq(timeEntries.assetId, assetId)),
    db.select({ id: instruments.id, externalId: instruments.externalId, model: instruments.model, client: instruments.client, archived: instruments.archived })
      .from(instruments).orderBy(asc(instruments.externalId)),
    db.selectDistinct({ owner: assets.owner }).from(assets),
  ]);
  if (!asset) notFound();

  const canEdit = user.role !== "client_viewer";
  const isStaff = user.role === "owner" || user.role === "staff";
  const label = new Map(insts.map((i) => [i.id, i.externalId]));
  const home = asset.instrumentId !== null ? insts.find((i) => i.id === asset.instrumentId) : undefined;
  const totalMinutes = taggedTime.reduce((n, t) => n + t.minutes, 0);

  const history = mergeAssetHistory(
    events.map((e) => ({ kind: e.kind, instrumentId: e.instrumentId, detail: e.detail, actor: e.actor, at: e.at })),
    taggedTasks.map((t) => ({ title: t.title, state: t.state, instrumentId: t.instrumentId, createdAt: t.createdAt, completedAt: t.completedAt })),
    taggedParts.map((p) => ({ name: p.name, status: p.status, instrumentId: p.instrumentId, createdAt: p.createdAt })),
    taggedTime.map((t) => ({ person: t.person, minutes: t.minutes, note: t.note, instrumentId: t.instrumentId, createdAt: t.createdAt })),
    formatHours,
  );

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <Link href="/assets" className="mut" style={{ fontSize: 13, textDecoration: "none", display: "inline-block", marginBottom: 10 }}>
        ← Assets
      </Link>

      <div className="card">
        <div style={{ fontSize: 18, fontWeight: 700, color: "var(--navy)" }}>
          {asset.kind} — {asset.model || "(no model)"}
        </div>
        <div className="mut" style={{ fontSize: 12, marginTop: 2 }}>
          {[asset.serial && `SN ${asset.serial}`, asset.manufacturer, asset.owner && `for ${asset.owner}`,
            asset.location && `@ ${asset.location}`].filter(Boolean).join(" · ") || "No identifiers yet."}
        </div>
        <div style={{ fontSize: 13, margin: "8px 0 10px" }}>
          {home ? (
            <>Currently in{" "}
              <Link href={`/instruments/${home.id}`} style={{ fontWeight: 700, textDecoration: "none" }}>
                {home.externalId} — {home.model}
              </Link>
            </>
          ) : (
            <span className="mut">{asset.status === "Decommissioned" ? "Retired - not attached to any system." : "Not attached to a system."}</span>
          )}
          {totalMinutes > 0 && <span className="mut"> · {formatHours(totalMinutes)} logged lifetime</span>}
        </div>
        {asset.note && <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>{asset.note}</div>}
        <AssetControls
          asset={{ id: asset.id, kind: asset.kind, model: asset.model, serial: asset.serial, manufacturer: asset.manufacturer, owner: asset.owner, location: asset.location, note: asset.note, status: asset.status, instrumentId: asset.instrumentId }}
          systems={insts.filter((i) => !i.archived).map((i) => ({ id: i.id, externalId: i.externalId }))}
          owners={[...new Set([...ownerRows.map((o) => o.owner), ...insts.map((i) => i.client)].filter(Boolean))].sort()}
          canEdit={canEdit} isStaff={isStaff}
        />
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Service history</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Lifecycle plus every task, part, and hour tagged to this asset - across all systems it has lived in.
        </div>
        {history.map((h, i) => (
          <div key={i} style={{ display: "flex", gap: 8, padding: "7px 0", borderTop: "1px solid var(--line)", fontSize: 13, flexWrap: "wrap", alignItems: "baseline" }}>
            <span className="mut mono" style={{ fontSize: 11, flexShrink: 0, width: 108 }}>{shopTime(h.at)}</span>
            {h.instrumentId !== null && label.get(h.instrumentId) && (
              <Link href={`/instruments/${h.instrumentId}`} className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--navy)", textDecoration: "none", flexShrink: 0 }}>
                {label.get(h.instrumentId)}
              </Link>
            )}
            {KIND_LABEL[h.kind] && <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>{KIND_LABEL[h.kind]}</span>}
            <span style={{ flex: 1, minWidth: 160 }}>
              {h.text}
              {h.detail && <span className="mut" style={{ fontSize: 12 }}> — {h.detail}</span>}
            </span>
          </div>
        ))}
        {history.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No history yet.</div>}
      </div>
    </div>
  );
}
