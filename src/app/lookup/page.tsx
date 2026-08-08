import { redirect } from "next/navigation";
import { and, eq, inArray, sql } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { assets, accessRequests } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { assetAccess, canSeeSystem } from "@/lib/tenancy";
import { normalizeSerial, serialSearchable } from "@/lib/serial";
import { MODULE_KINDS } from "@/lib/stages";
import { RequestAccessCard, CreateSystemForm } from "@/components/LookupPanels";

export const dynamic = "force-dynamic";

/**
 * Find an instrument by its exact serial number. Three outcomes:
 *  - it's on something you can already see: a link;
 *  - it's on a system in another workspace: a minimal card (unit type and
 *    model only, no owner, no ID) with a request-access flow;
 *  - nobody has it: create it as a new system and start its history.
 * Matching is exact and case-insensitive, never prefix or fuzzy - a serial is
 * a key you must already hold, not a way to browse other people's inventory.
 * Another org's shelf spares are never disclosed at all.
 */
export default async function LookupPage({ searchParams }: { searchParams: Promise<{ sn?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { sn = "" } = await searchParams;
  const norm = normalizeSerial(sn);
  const searched = serialSearchable(sn);

  const matches = searched
    ? await db.select().from(assets).where(sql`lower(btrim(${assets.serial})) = ${norm}`)
    : [];

  const visible: { assetId: number; instrumentId: number | null; desc: string }[] = [];
  const requestable = new Map<number, string>(); // instrumentId -> asset description
  for (const a of matches) {
    const desc = `${a.kind}${a.model ? ` — ${a.model}` : ""}`;
    const access = await assetAccess(user, a.id);
    if (access.see) {
      visible.push({
        assetId: a.id,
        instrumentId: a.instrumentId !== null && (await canSeeSystem(user, a.instrumentId)) ? a.instrumentId : null,
        desc,
      });
    } else if (a.instrumentId !== null) {
      requestable.set(a.instrumentId, desc);
    }
    // A hidden shelf spare in someone else's workspace stays undisclosed.
  }

  const pendingIds = user.orgId !== null && requestable.size
    ? (await db.select({ instrumentId: accessRequests.instrumentId }).from(accessRequests).where(and(
        eq(accessRequests.orgId, user.orgId), eq(accessRequests.status, "pending"),
        inArray(accessRequests.instrumentId, [...requestable.keys()]),
      ))).map((r) => r.instrumentId)
    : [];

  const nothingFound = searched && visible.length === 0 && requestable.size === 0;
  const mayCreate = user.role !== "client_viewer";
  const kinds = searched && nothingFound && mayCreate
    ? [...new Set([...MODULE_KINDS, ...(await db.selectDistinct({ kind: assets.kind }).from(assets)).map((k) => k.kind)].filter(Boolean))]
    : [];

  return (
    <div className="container">
      <div className="card">
        <div className="card-title">Find an instrument by serial number</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Exact match only. If the unit is in another workspace you can ask its owner for access; if nobody has it, you can start its service record.
        </div>
        <form method="GET" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="mono" name="sn" defaultValue={sn} placeholder="Serial number, e.g. L20505500123"
            style={{ flex: "1 1 220px", maxWidth: 340 }} autoFocus />
          <button className="btn sm accent" type="submit">Look up</button>
        </form>
        {sn && !searched && (
          <div className="mut" style={{ fontSize: 12, marginTop: 8 }}>Serial numbers are at least 4 characters.</div>
        )}

        {visible.length > 0 && (
          <>
            <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>In your workspace</div>
            {visible.map((v) => (
              <div key={v.assetId} style={{ padding: "6px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
                <Link href={v.instrumentId !== null ? `/instruments/${v.instrumentId}` : `/assets/${v.assetId}`} style={{ fontWeight: 600 }}>
                  {v.desc}
                </Link>
                <span className="mut" style={{ fontSize: 12 }}> · {v.instrumentId !== null ? "on a system you can open" : "in your asset registry"}</span>
              </div>
            ))}
          </>
        )}

        {requestable.size > 0 && (
          <>
            <div className="eyebrow" style={{ marginTop: 14, marginBottom: 0 }}>Found, in another workspace</div>
            {[...requestable.entries()].map(([instId, desc]) => (
              <RequestAccessCard key={instId} serial={sn} assetDesc={desc} requested={pendingIds.includes(instId)} />
            ))}
          </>
        )}

        {nothingFound && (
          <>
            <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>No match</div>
            <div className="mut" style={{ fontSize: 13 }}>
              No instrument on the platform carries serial <span className="mono">{sn.trim()}</span>.
            </div>
            {mayCreate && <CreateSystemForm serial={sn.trim()} kinds={kinds} />}
          </>
        )}
      </div>
    </div>
  );
}
