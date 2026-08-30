import Link from "next/link";
import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { forTenant, readTenant } from "@/lib/tenancy";
import { fmtWhen } from "@/lib/when";
import { shopToday } from "@/lib/shopday";
import {
  RESTORATION_SOURCES, RESTORATION_SOURCE_LABEL, RESTORATION_STAGES,
  RESTORATION_STAGE_LABEL, SOURCE_ID_PREFIX, daysInStage, nextStagedId,
  queueStageTone, type RestorationStage,
} from "@/lib/restoration";
import { restorationQueue } from "@/lib/restorationData";
import { getSystemLabels } from "@/lib/systemLabel";
import { DataTable, FacetStrip, Id, Legend, PageHead, Pill, Toolbar } from "@/components/ui";
import type { DataRow } from "@/components/ui/DataTable";
import NewRestorationButton from "@/components/NewRestorationButton";

export const dynamic = "force-dynamic";

/**
 * The restoration queue - every system moving through Receive → Restore →
 * Verify → Ship → Commission, most recently worked first. Staff only: this
 * is the shop's pipeline; a buyer's window onto their own system is the
 * portal surface, not this list.
 */
export default async function RestorationsPage({ searchParams }: {
  searchParams: Promise<{ stage?: string; who?: string; source?: string }>;
}) {
  let user;
  try { user = await requireStaff(); } catch { redirect("/"); }
  const { stage, who, source } = await searchParams;
  const now = new Date();
  const today = shopToday();

  const rows = await restorationQueue(user);

  // What a new restoration can open on: workspace systems not already in the
  // pipeline. The queue's own rows are the exclusion list.
  const busy = rows.filter((r) => r.project.stage !== "complete").map((r) => r.project.instrumentId);
  const candidates = await db.select({
    id: instruments.id, externalId: instruments.externalId, name: instruments.name,
    model: instruments.model, archived: instruments.archived,
  }).from(instruments)
    .where(forTenant(instruments.tenantOrgId, readTenant(user)))
    .orderBy(asc(instruments.externalId));
  const openable = candidates.filter((c) => !c.archived && !busy.includes(c.id));
  const openLabels = await getSystemLabels(openable);
  // The staging tag each source suggests - computed over everything on the
  // books (archived included) so a freed number is never re-suggested.
  const allIds = candidates.map((c) => c.externalId);
  const suggestions = Object.fromEntries(
    RESTORATION_SOURCES.map((s) => [s, nextStagedId(allIds, SOURCE_ID_PREFIX[s])]),
  ) as Record<string, string>;

  const wanted = (r: (typeof rows)[number]) =>
    (!stage || r.project.stage === stage)
    && (!who || (who === "-" ? !r.project.assignee.trim()
      : r.project.assignee.trim().toLowerCase() === who.trim().toLowerCase()))
    && (!source || r.project.source === source);
  const shown = rows.filter(wanted);

  const href = (params: { stage?: string; who?: string; source?: string }) => {
    const p = new URLSearchParams();
    const s = "stage" in params ? params.stage : stage;
    const w = "who" in params ? params.who : who;
    const src = "source" in params ? params.source : source;
    if (s) p.set("stage", s);
    if (w) p.set("who", w);
    if (src) p.set("source", src);
    const q = p.toString();
    return q ? `/restorations?${q}` : "/restorations";
  };

  const inStage = (s: string) => rows.filter((r) => r.project.stage === s).length;
  const names = [...new Set(rows.map((r) => r.project.assignee.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  const toRow = (r: (typeof rows)[number]): DataRow => {
    const p = r.project;
    const days = daysInStage(p.stageSince, now);
    return {
      key: p.id,
      href: `/restorations/${p.id}`,
      cells: {
        sys: <Id>{r.externalId}</Id>,
        label: <b style={{ fontWeight: 600 }}>{r.label || "Unnamed system"}</b>,
        stage: (
          <Pill tone={queueStageTone(p.stage, p.stageSince, now)}>
            {RESTORATION_STAGE_LABEL[p.stage as RestorationStage] ?? p.stage}
          </Pill>
        ),
        prov: <span className="mono">{r.pct}%</span>,
        due: r.dueOn
          ? (r.dueOn < today && p.stage !== "complete"
              ? <Pill tone="bad">{r.dueOn}</Pill>
              : <span className="mono t-small">{r.dueOn}</span>)
          : null,
        days: p.stage === "complete" ? null
          : <span className="mut">{days === 0 ? "today" : `${days} d`}</span>,
        who: <span className="mut">{p.assignee.trim() || "unassigned"}</span>,
        buyer: <span className="mut">{r.buyerName}</span>,
        updated: <span className="mut">{fmtWhen(p.updatedAt)}</span>,
      },
    };
  };

  return (
    <div className="container wide">
      <PageHead title="Restoration queue"
        crumb={<><Link href="/assets">Assets</Link> / <b>Restoration queue</b></>} />
      <Toolbar
        actions={<NewRestorationButton
          systems={openable.map((s) => ({
            id: s.id, externalId: s.externalId, label: openLabels.get(s.id) ?? s.model,
          }))}
          suggestions={suggestions}
        />}
        facets={
          <>
            <FacetStrip facets={[
              { key: "all", label: "Every stage", on: !stage, href: href({ stage: undefined }) },
              ...RESTORATION_STAGES.map((s) => ({
                key: s,
                label: RESTORATION_STAGE_LABEL[s],
                count: inStage(s) || undefined,
                on: stage === s,
                href: href({ stage: s }),
              })),
            ]} />
            {names.length > 0 && (
              <FacetStrip facets={[
                { key: "all", label: "Everyone", on: !who, href: href({ who: undefined }) },
                ...names.map((n) => ({
                  key: n, label: n === user.name ? "Mine" : n,
                  on: who?.trim().toLowerCase() === n.toLowerCase(), href: href({ who: n }),
                })),
                { key: "unassigned", label: "Unassigned", on: who === "-", href: href({ who: "-" }) },
              ]} />
            )}
            <FacetStrip facets={RESTORATION_SOURCES.map((s) => ({
              key: s, label: RESTORATION_SOURCE_LABEL[s], on: source === s,
              href: href({ source: source === s ? undefined : s }),
            }))} />
          </>
        }
      />
      <DataTable
        cols={[
          { key: "sys", label: "System", width: "88px" },
          { key: "label", label: "", width: "minmax(170px, 1.6fr)" },
          { key: "stage", label: "Stage", width: "132px" },
          { key: "prov", label: "Provenance", width: "96px", align: "right", hideMobile: true },
          { key: "due", label: "Promised", width: "104px", hideMobile: true },
          { key: "days", label: "In stage", width: "84px", hideMobile: true },
          { key: "who", label: "Assignee", width: "110px", hideMobile: true },
          { key: "buyer", label: "Buyer", width: "minmax(90px, 1fr)", hideMobile: true },
          { key: "updated", label: "Updated", width: "120px", hideMobile: true },
        ]}
        rows={shown.map(toRow)}
        empty={rows.length
          ? "Nothing matches these filters"
          : "No systems in restoration yet - receive one and its record starts here"}
      />
      <Legend items={[
        { tone: "info", label: "in flight" },
        { tone: "warn", label: "sitting in a stage too long" },
        { tone: "good", label: "complete" },
      ]} />
    </div>
  );
}
