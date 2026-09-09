import { redirect } from "next/navigation";
import { asc, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { viewTenant, visibleOrgs, visibleSystemIds } from "@/lib/tenancy";
import { getStageDefs } from "@/lib/stageDefs";
import { getSystemLabels } from "@/lib/systemLabel";
import { SYSTEM_STATES, filterSystems, systemState } from "@/lib/systemRegistry";
import { DataTable, FacetStrip, Id, PageHead, Pill, Toolbar } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Every system on record, one row each.
 *
 * The board groups the working fleet by stage and the assets page lists every
 * unit, and between them there was no flat list of SYSTEMS: a shop with sixty
 * machines on its books could reach any one of them only through the column
 * it currently sat in, or through a unit inside it. This is the flat one -
 * searchable, filterable by where a system stands, nothing folded away - the
 * same page /assets is for units.
 *
 * It is the record, not the fleet. A prospect's and a former client's systems
 * are here on purpose, marked, where the board holds them back - see
 * lib/systemRegistry and the tests/fleetPages note on which rooms are the
 * fleet. Staff only: a client has /units, which is this list in their words.
 */
export default async function SystemsPage({ searchParams }: {
  searchParams: Promise<{ q?: string; state?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/units");
  const { q = "", state = "" } = await searchParams;

  const visible = await visibleSystemIds(user);
  const [rows, orgRows, defs] = await Promise.all([
    db.select().from(instruments)
      .where(visible === null ? undefined : visible.length ? inArray(instruments.id, visible) : sql`false`)
      .orderBy(asc(instruments.externalId)),
    visibleOrgs(user),
    getStageDefs(await viewTenant(user)),
  ]);
  const labels = await getSystemLabels(rows);
  const stageOfOrg = new Map(orgRows.map((o) => [o.id, o.stage]));
  const items = rows.map((i) => ({
    id: i.id, externalId: i.externalId, label: labels.get(i.id) ?? i.model,
    client: i.client, model: i.model, serial: i.serial, location: i.location,
    lead: i.lead, category: i.category, stages: i.stages,
    // An owner the viewer cannot see reads as a client, which keeps the
    // machine on the list rather than off it - the safe direction.
    state: systemState(i, i.ownerOrgId === null ? "client" : stageOfOrg.get(i.ownerOrgId)),
  }));
  const shown = filterSystems(items, { q, state });
  const countFor = (s: string) => items.filter((i) => i.state === s).length;
  const onRecord = items.filter((i) => i.state !== "archived").length;

  // Facet hrefs keep the search in place - facet state is the URL.
  const stateHref = (s: string) => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (s && s !== state) p.set("state", s);
    return `/instruments${p.size ? `?${p}` : ""}`;
  };
  const stagePill = (name: string) => {
    const d = defs.find((x) => x.name === name);
    return d
      ? <span className="pill" style={{ background: d.bg, color: d.fg }}>{name}</span>
      : <Pill tone="neutral">{name}</Pill>;
  };
  const stateWord = SYSTEM_STATES.reduce((m, s) => m.set(s.key, s.label), new Map<string, string>());

  return (
    <div className="container page">
      <PageHead
        crumb={<>Operations › <b>Systems</b></>}
        title="Systems"
        sub={`${onRecord} system${onRecord === 1 ? "" : "s"} on record${countFor("archived") ? `, ${countFor("archived")} archived` : ""}`}
        actions={
          <>
            <a className="btn link" href="/assets">All units</a>
            <a className="btn link" href="/api/export/systems">Export systems</a>
          </>
        } />
      <Toolbar
        search={
          <form action="/instruments">
            {state && <input type="hidden" name="state" value={state} />}
            <input name="q" defaultValue={q} placeholder="ID, model, serial, client, lead, location..." aria-label="Search systems" />
          </form>
        }
        facets={
          <FacetStrip facets={SYSTEM_STATES.map((s) => ({
            key: s.key, label: s.label, count: countFor(s.key) || undefined, on: state === s.key, href: stateHref(s.key),
          }))} />
        }
      />
      <DataTable
        cols={[
          { key: "id", label: "ID", width: "90px" },
          { key: "system", label: "System", width: "minmax(180px, 2fr)" },
          { key: "stage", label: "Stage", width: "minmax(120px, 0.9fr)", hideMobile: true },
          { key: "lead", label: "Lead", width: "minmax(100px, 0.7fr)", hideMobile: true },
        ]}
        rows={shown.map((i) => ({
          key: i.id,
          href: `/instruments/${i.id}`,
          cells: {
            id: <Id>{i.externalId}</Id>,
            system: (
              <span style={{ minWidth: 0, display: "block" }}>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {i.label || <span className="mut">No assets listed</span>}
                  {i.state !== "active" && (
                    <> <Pill tone={i.state === "prospect" ? "warn" : "neutral"}>{stateWord.get(i.state)}</Pill></>
                  )}
                </span>
                <span className="mut t-meta">
                  {[i.client, i.location].filter(Boolean).join(" · ")}
                </span>
              </span>
            ),
            stage: i.stages.length ? (
              <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                {stagePill(i.stages[0])}
                {i.stages.length > 1 && <span className="mut t-meta">+{i.stages.length - 1}</span>}
              </span>
            ) : null,
            lead: i.lead ? <span className="t-small">{i.lead}</span> : <span className="mut t-small">unassigned</span>,
          },
        }))}
        empty={q.trim() || state ? "No systems match" : "No systems on record"}
      />
    </div>
  );
}
