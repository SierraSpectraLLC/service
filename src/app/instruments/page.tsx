import { redirect } from "next/navigation";
import { asc, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { instruments, vocabTerms } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant, viewTenant, visibleOrgs, visibleSystemIds } from "@/lib/tenancy";
import { clientOptions } from "@/lib/clientNames";
import { directoryNames, visibleDirectory } from "@/lib/directory";
import { getStageDefs } from "@/lib/stageDefs";
import { getSystemLabels } from "@/lib/systemLabel";
import { SYSTEM_STATES, filterSystems, systemOwnerName, systemState } from "@/lib/systemRegistry";
import SystemRegistryList from "@/components/SystemRegistryList";
import GroupToggle from "@/components/GroupToggle";
import { NewSystemButton } from "@/components/NewSystemDialog";
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
  searchParams: Promise<{ q?: string; state?: string; group?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/units");
  const { q = "", state = "", group = "" } = await searchParams;
  // Sectioned by type unless asked for owners - the asset registry's default,
  // so the two pages read the same way. Anything else is the default.
  const groupBy = group === "owner" ? "owner" : "category";

  const visible = await visibleSystemIds(user);
  const tenant = await viewTenant(user);
  const [rows, orgRows, defs, vocab, people] = await Promise.all([
    db.select().from(instruments)
      .where(visible === null ? undefined : visible.length ? inArray(instruments.id, visible) : sql`false`)
      .orderBy(asc(instruments.externalId)),
    visibleOrgs(user),
    getStageDefs(tenant),
    // The catalog's system categories, for the selection bar's type picker -
    // the same list the record's own picker offers.
    db.select({ kind: vocabTerms.kind, name: vocabTerms.name }).from(vocabTerms)
      .where(forTenant(vocabTerms.tenantOrgId, tenant)),
    visibleDirectory(user),
  ]);
  // What the checkboxes may set at once. Clients are the organizations we
  // work with plus whatever is already typed on a system; types the catalog's
  // plus those in use; leads the people this reader may assign.
  const bulk = {
    clients: clientOptions(orgRows.filter((o) => o.kind === "client").map((o) => o.name), rows.map((r) => r.client)),
    categories: [...new Set([...vocab.filter((v) => v.kind === "category").map((v) => v.name), ...rows.map((r) => r.category)])]
      .filter(Boolean).sort((a, b) => a.localeCompare(b)),
    people: directoryNames(people),
    // Any organization may own equipment - a service company owns its own
    // stock - which is the list the record's own Sharing section offers.
    owners: orgRows.map((o) => ({ id: o.id, name: o.name, kind: o.kind })),
  };
  const labels = await getSystemLabels(rows);
  const stageOfOrg = new Map(orgRows.map((o) => [o.id, o.stage]));
  const items = rows.map((i) => ({
    id: i.id, externalId: i.externalId, label: labels.get(i.id) ?? i.model,
    client: i.client, owner: systemOwnerName(i, orgRows), model: i.model, serial: i.serial, location: i.location,
    lead: i.lead, category: i.category, stages: i.stages,
    // An owner the viewer cannot see reads as a client, which keeps the
    // machine on the list rather than off it - the safe direction.
    state: systemState(i, i.ownerOrgId === null ? "client" : stageOfOrg.get(i.ownerOrgId)),
  }));
  const shown = filterSystems(items, { q, state });
  const countFor = (s: string) => items.filter((i) => i.state === s).length;
  const onRecord = items.filter((i) => i.state !== "archived").length;
  // Said in the subtitle, because they are on record and not on the page:
  // a count that quietly excludes seven machines reads as seven machines gone.
  const former = countFor("former");

  // Facet hrefs keep the search and the grouping in place - facet state is the URL.
  const href = (over: { state?: string; group?: string }) => {
    const p = new URLSearchParams();
    const m = { state, group: groupBy === "owner" ? "owner" : "", ...over };
    if (q.trim()) p.set("q", q.trim());
    if (m.state) p.set("state", m.state);
    if (m.group) p.set("group", m.group);
    return `/instruments${p.size ? `?${p}` : ""}`;
  };
  const stateHref = (s: string) => href({ state: s && s !== state ? s : "" });
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
        sub={`${onRecord} system${onRecord === 1 ? "" : "s"} on record${former ? `, ${former} with former clients` : ""}${countFor("archived") ? `, ${countFor("archived")} archived` : ""}`}
        actions={
          <>
            <a className="btn link" href="/assets">All units</a>
            <a className="btn link" href="/api/export/systems">Export systems</a>
            {/* The list of every system on record is where somebody goes to
                put one on it. It offers the same three lists the selection
                bar does, so the form and the bar cannot disagree. */}
            <NewSystemButton clients={bulk.clients} categories={bulk.categories} people={bulk.people} />
          </>
        } />
      <Toolbar
        search={
          <form action="/instruments">
            {state && <input type="hidden" name="state" value={state} />}
            {groupBy === "owner" && <input type="hidden" name="group" value="owner" />}
            <input name="q" defaultValue={q} placeholder="ID, model, serial, owner, lead, location..." aria-label="Search systems" />
          </form>
        }
        facets={
          <FacetStrip facets={SYSTEM_STATES.map((s) => ({
            key: s.key, label: s.label, count: countFor(s.key) || undefined, on: state === s.key, href: stateHref(s.key),
          }))} />
        }
        actions={
          <GroupToggle value={groupBy} choices={[
            { key: "category", label: "By type", href: href({ group: "" }) },
            { key: "owner", label: "By owner", href: href({ group: "owner" }) },
          ]} />
        }
      />
      <div className="card">
        <SystemRegistryList
          groupBy={groupBy}
          canSelect
          options={bulk}
          rows={shown.map((i) => {
            const first = i.stages[0] ? stageDef(i.stages[0]) : null;
            return {
              id: i.id, externalId: i.externalId, label: i.label,
              owner: i.owner, category: i.category, model: i.model, location: i.location, lead: i.lead,
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
