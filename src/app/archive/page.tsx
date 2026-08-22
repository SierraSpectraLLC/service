import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { viewTenant, visibleSystemIds } from "@/lib/tenancy";
import { getStageDefs } from "@/lib/stageDefs";
import { getSystemLabels } from "@/lib/systemLabel";
import { shopMonthDay } from "@/lib/shopday";
import { DataTable, FacetStrip, Id, PageHead, Toolbar } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ArchivePage({ searchParams }: { searchParams: Promise<{ q?: string; client?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { q = "", client = "" } = await searchParams;
  // This page was reachable by URL for anyone signed in; now it shows only
  // what the viewer may see.
  const visible = await visibleSystemIds(user);

  const [rows, defs] = await Promise.all([
    db.select().from(instruments).where(and(eq(instruments.archived, true),
      visible === null ? undefined : visible.length ? inArray(instruments.id, visible) : sql`false`))
      .orderBy(desc(instruments.archivedAt), asc(instruments.externalId)),
    getStageDefs(await viewTenant(user)),
  ]);
  const labels = await getSystemLabels(rows);
  const color = (name: string) => defs.find((d) => d.name === name) ?? { bg: "#EEF1F5", fg: "#475569" };

  const clients = [...new Set(rows.map((i) => i.client).filter(Boolean))].sort();
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((i) =>
    (!client || i.client === client)
    && (!needle
      || i.externalId.toLowerCase().includes(needle)
      || (labels.get(i.id) ?? "").toLowerCase().includes(needle)
      || i.client.toLowerCase().includes(needle)
      || i.archivedBy.toLowerCase().includes(needle)));
  const clientHref = (c: string) => {
    const p = new URLSearchParams();
    if (needle) p.set("q", needle);
    if (c && c !== client) p.set("client", c);
    return `/archive${p.size ? `?${p}` : ""}`;
  };

  return (
    <div className="container page">
      <PageHead
        crumb={<>Operations › <b>Archived</b></>}
        title="Archived systems"
        sub="Retired from the active fleet, kept in full. Open one to restore it."
      />
      <Toolbar
        search={
          <form action="/archive">
            {client && <input type="hidden" name="client" value={client} />}
            <input name="q" defaultValue={q} placeholder="ID, model or client" aria-label="Search archived systems" />
          </form>
        }
        facets={clients.length > 1 ? (
          <FacetStrip facets={clients.map((c) => ({
            key: c, label: c,
            count: rows.filter((i) => i.client === c).length,
            on: client === c, href: clientHref(c),
          }))} />
        ) : undefined}
      />
      <DataTable
        cols={[
          { key: "id", label: "ID", width: "90px" },
          { key: "system", label: "System", width: "minmax(180px, 2fr)" },
          { key: "stage", label: "Left in", width: "minmax(120px, 0.9fr)", hideMobile: true },
          { key: "when", label: "Archived", width: "minmax(150px, 1fr)" },
        ]}
        rows={shown.map((i) => ({
          key: i.id,
          href: `/instruments/${i.id}`,
          cells: {
            id: <Id>{i.externalId}</Id>,
            system: (
              <span style={{ minWidth: 0, display: "block" }}>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {labels.get(i.id) || <span className="mut">No assets listed</span>}
                </span>
                <span className="mut t-meta">{i.client}</span>
              </span>
            ),
            stage: i.stages.length ? (
              <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <span className="pill" style={{ background: color(i.stages[0]).bg, color: color(i.stages[0]).fg }}>{i.stages[0]}</span>
                {i.stages.length > 1 && <span className="mut t-meta">+{i.stages.length - 1}</span>}
              </span>
            ) : null,
            when: (
              <span className="mut t-small">
                {i.archivedAt ? shopMonthDay(i.archivedAt) : ""}{i.archivedBy ? ` by ${i.archivedBy}` : ""}
              </span>
            ),
          },
        }))}
        empty="Nothing archived"
      />
    </div>
  );
}
