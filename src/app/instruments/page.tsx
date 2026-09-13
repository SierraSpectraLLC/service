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
import SystemRegistryList from "@/components/SystemRegistryList";
import { FacetStrip, Legend, PageHead, Toolbar } from "@/components/ui";
import type { Tone } from "@/lib/tones";

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
 *
 * Dressed as /assets is: one wide card, rows grouped under a heading with a
 * count, a dot for where each system stands and a legend saying what the dots
 * mean. Two lists read the same way should look the same.
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
  const stageDef = (name: string) => defs.find((x) => x.name === name) ?? null;
  const stateWord = SYSTEM_STATES.reduce((m, s) => m.set(s.key, s.label), new Map<string, string>());
  // In the fleet is the ordinary case, so it is the dot only; the others are
  // named on the row as well, because a prospect's machine is not a job.
  const STATE_TONE: Record<string, Tone> = { active: "good", prospect: "warn", former: "neutral", archived: "faint" };

  return (
    <div className="container split">
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
      <div className="card">
        <SystemRegistryList
          rows={shown.map((i) => {
            const first = i.stages[0] ? stageDef(i.stages[0]) : null;
            return {
              id: i.id, externalId: i.externalId, label: i.label,
              client: i.client, model: i.model, location: i.location, lead: i.lead,
              stateTone: STATE_TONE[i.state] ?? "neutral",
              stateWord: i.state === "active" ? null : stateWord.get(i.state) ?? i.state,
              // A stage the vocabulary no longer names still shows, in the
              // neutral pill's colors, rather than vanishing from the row.
              stage: i.stages[0] ? (first ?? { name: i.stages[0], bg: "var(--t-neutral-bg)", fg: "var(--t-neutral-fg)" }) : null,
              moreStages: Math.max(0, i.stages.length - 1),
            };
          })}
          empty={q.trim() || state
            ? <><b>No systems match</b>Adjust the search or the facets above.</>
            : <><b>No systems on record</b>A system arrives with its first job, or by import.</>}
        />
      </div>
      <Legend items={SYSTEM_STATES.map((s) => ({ tone: STATE_TONE[s.key] ?? "neutral", label: s.label.toLowerCase() }))} />
    </div>
  );
}
