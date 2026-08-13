import { redirect } from "next/navigation";
import { asc, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments, vocabTerms } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { forTenant, viewTenant, visibleAssetIds, visibleSystemIds } from "@/lib/tenancy";
import { ASSET_COLOR, ASSET_STATES } from "@/lib/stages";
import AssetRegistryFilter from "@/components/AssetRegistryFilter";
import NewAssetForm from "@/components/NewAssetForm";
import AssetGridToggle from "@/components/AssetGridToggle";
import AssetRegistryList from "@/components/AssetRegistryList";

export const dynamic = "force-dynamic";

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ q?: string; kind?: string; status?: string; owner?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { q = "", kind = "", status = "", owner = "" } = await searchParams;

  // Units on systems shared with the viewer, plus any their own org owns.
  const [seeAssets, seeSystems] = await Promise.all([visibleAssetIds(user), visibleSystemIds(user)]);
  const [rows, insts, vocab] = await Promise.all([
    db.select().from(assets)
      .where(seeAssets === null ? undefined : seeAssets.length ? inArray(assets.id, seeAssets) : sql`false`)
      .orderBy(asc(assets.kind), asc(assets.model), asc(assets.id)),
    db.select({ id: instruments.id, externalId: instruments.externalId, client: instruments.client }).from(instruments)
      .where(seeSystems === null ? undefined : seeSystems.length ? inArray(instruments.id, seeSystems) : sql`false`),
    db.select().from(vocabTerms).where(forTenant(vocabTerms.tenantOrgId, await viewTenant(user))),
  ]);
  const home = new Map(insts.map((i) => [i.id, i]));
  // Owner picker options: whoever already owns stock, plus the clients we work for.
  const owners = [...new Set([...rows.map((a) => a.owner), ...insts.map((i) => i.client)].filter(Boolean))].sort();
  // The catalog names the types; the FILTER also offers kinds only found on
  // old units, because filtering must reach everything that exists.
  const catalogKinds = vocab.filter((v) => v.kind === "asset_type").map((v) => v.name);
  const filterKinds = [...new Set([...catalogKinds, ...rows.map((a) => a.kind)].filter(Boolean))];
  // Standalone stock has no system context, so every model of the type is fair
  // game. The grid also wants each model's maker so it can fill that column in.
  const catalogModels: Record<string, string[]> = {};
  const gridModels: Record<string, { name: string; manufacturer: string }[]> = {};
  for (const v of vocab) {
    if (v.kind !== "model" || !v.assetType) continue;
    (catalogModels[v.assetType] ??= []).push(v.name);
    (gridModels[v.assetType] ??= []).push({ name: v.name, manufacturer: v.manufacturer });
  }

  const needle = q.trim().toLowerCase();
  const filtered = rows.filter((a) => {
    if (kind && a.kind !== kind) return false;
    if (status && a.status !== status) return false;
    if (owner && a.owner !== owner) return false;
    if (!needle) return true;
    const sys = a.instrumentId !== null ? home.get(a.instrumentId) : undefined;
    return [a.kind, a.model, a.serial, a.manufacturer, a.owner, a.location, a.note, sys?.externalId ?? ""]
      .join(" ").toLowerCase().includes(needle);
  });
  const unattached = rows.filter((a) => a.instrumentId === null && a.status !== "Decommissioned").length;
  // Deleting records is staff work, so only staff get the checkboxes.
  const isStaff = user.role === "owner" || user.role === "staff";

  return (
    <div className="container split">
      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <div className="card-title" style={{ marginBottom: 4 }}>Assets</div>
          <span style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            {user.role !== "client_viewer" && <a className="btn link" href="/import">Import CSV</a>}
            <a className="btn link" href="/api/export/assets">Export assets</a>
            <a className="btn link" href="/api/export/systems">Export systems</a>
          </span>
        </div>
        {unattached > 0 && (
          <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
            {unattached} not in a system right now.
          </div>
        )}
        {user.role !== "client_viewer" && (
          <>
            <NewAssetForm owners={owners} kinds={catalogKinds} models={catalogModels} />
            <AssetGridToggle instrumentId={null} kinds={catalogKinds} models={gridModels} owners={owners} />
          </>
        )}
        <AssetRegistryFilter q={q} kind={kind} status={status} owner={owner}
          kinds={filterKinds} statuses={[...ASSET_STATES]} owners={owners} />

        <AssetRegistryList
          canSelect={isStaff}
          rows={filtered.map((a) => {
            const c = ASSET_COLOR[a.status] ?? ASSET_COLOR.Spare;
            const sys = a.instrumentId !== null ? home.get(a.instrumentId) : undefined;
            return {
              id: a.id, kind: a.kind, model: a.model, serial: a.serial, manufacturer: a.manufacturer,
              owner: a.owner, location: a.location,
              status: a.status, statusBg: c.bg, statusFg: c.fg,
              whereLabel: sys ? `in ${sys.externalId}`
                : a.status === "Decommissioned" ? "retired"
                : `On the shelf${a.location ? ` · ${a.location}` : ""}`,
              // The duplicate check scopes serial-less matches to one system, so
              // it needs the system's identity rather than just its label.
              systemKey: (sys?.externalId ?? "").toLowerCase(),
            };
          })}
        />
      </div>
    </div>
  );
}
