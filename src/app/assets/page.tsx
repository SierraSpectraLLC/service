import { redirect } from "next/navigation";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { ASSET_COLOR, ASSET_STATES, MODULE_KINDS } from "@/lib/stages";
import AssetRegistryFilter from "@/components/AssetRegistryFilter";
import NewAssetForm from "@/components/NewAssetForm";

export const dynamic = "force-dynamic";

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ q?: string; kind?: string; status?: string; owner?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { q = "", kind = "", status = "", owner = "" } = await searchParams;

  const [rows, insts] = await Promise.all([
    db.select().from(assets).orderBy(asc(assets.kind), asc(assets.model), asc(assets.id)),
    db.select({ id: instruments.id, externalId: instruments.externalId, client: instruments.client }).from(instruments),
  ]);
  const home = new Map(insts.map((i) => [i.id, i]));
  // Owner picker options: whoever already owns stock, plus the clients we work for.
  const owners = [...new Set([...rows.map((a) => a.owner), ...insts.map((i) => i.client)].filter(Boolean))].sort();

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

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Assets</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Every unit we track - in a system, on the shelf, or retired. Tap one for its full service
          history.{unattached > 0 ? ` ${unattached} not in a system right now.` : ""}
        </div>
        {user.role !== "client_viewer" && <NewAssetForm owners={owners} />}
        <AssetRegistryFilter q={q} kind={kind} status={status} owner={owner}
          kinds={[...MODULE_KINDS]} statuses={[...ASSET_STATES]} owners={owners} />

        {filtered.map((a) => {
          const c = ASSET_COLOR[a.status] ?? ASSET_COLOR.Spare;
          const sys = a.instrumentId !== null ? home.get(a.instrumentId) : undefined;
          return (
            <Link key={a.id} href={`/assets/${a.id}`} className="row-hover"
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 4px", borderTop: "1px solid var(--line)", flexWrap: "wrap", textDecoration: "none", color: "inherit" }}>
              <span title={a.status} style={{ width: 10, height: 10, borderRadius: "50%", background: c.fg, flexShrink: 0 }} />
              <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>{a.kind}</span>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{a.model || <span className="mut">(no model)</span>}</span>
              {a.serial && <span className="mono mut" style={{ fontSize: 12 }}>SN {a.serial}</span>}
              {a.owner && <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>{a.owner}</span>}
              <span className="mut" style={{ fontSize: 12, marginLeft: "auto" }}>
                {sys ? `in ${sys.externalId}` : a.status === "Decommissioned" ? "retired" : `On the shelf${a.location ? ` · ${a.location}` : ""}`}
              </span>
              <span className="pill" style={{ background: c.bg, color: c.fg }}>{a.status}</span>
            </Link>
          );
        })}
        {filtered.length === 0 && <div className="mut" style={{ fontSize: 13, marginTop: 8 }}>No assets match.</div>}
      </div>
    </div>
  );
}
