import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/authz";
import { getModules } from "@/lib/flags";
import { shopTime } from "@/lib/shopday";
import { TRAIL_KEEP_DAYS, groupErrors, maySeeTrail, routeShape, trailSummary } from "@/lib/trail";
import { trailCount, trailSince } from "@/lib/trailData";
import TrailControls from "@/components/TrailControls";
import { EmptyState, FacetStrip, Id, PageHead, Panel, Pill, Toolbar } from "@/components/ui";

export const dynamic = "force-dynamic";

/** The windows on offer, in hours. A day is the useful default for a bug. */
const WINDOWS = [
  { key: "24", label: "24 hours", hours: 24 },
  { key: "72", label: "3 days", hours: 72 },
  { key: "168", label: "7 days", hours: 168 },
  { key: "720", label: "30 days", hours: 720 },
];

/**
 * Settings > Access > Trail: where the errors are.
 *
 * Built around the question rather than around the table. The first thing on
 * the page is errors GROUPED - one person hitting one bug fifteen times is one
 * bug, and fifteen rows in a list reads as fifteen problems. Under it is the
 * raw stream, which only helps once you know whose afternoon to read.
 *
 * ONE ADDRESS MAY READ IT. Not owners, not platform staff - the single account
 * named in lib/trail, because this is the movements of people who work for
 * other companies and a role is too broad a key for that.
 */
export default async function TrailPage({ searchParams }: {
  searchParams: Promise<{ w?: string; who?: string; kind?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  // Absent rather than forbidden: a page that refuses you by name has still
  // told you it exists and whose it is.
  if (!maySeeTrail(user.email)) redirect("/settings/catalog");

  const { w = "24", who = "", kind = "" } = await searchParams;
  const win = WINDOWS.find((x) => x.key === w) ?? WINDOWS[0];
  const modules = await getModules();

  const since = new Date(Date.now() - win.hours * 3_600_000);
  const [rows, kept] = await Promise.all([trailSince(since), trailCount()]);

  const people = [...new Set(rows.map((r) => r.email).filter(Boolean))].sort();
  const shown = rows.filter((r) => (!who || r.email === who) && (!kind || r.kind === kind));
  const groups = groupErrors(shown);
  const sum = trailSummary(shown);

  const href = (next: { w?: string; who?: string; kind?: string }) => {
    const p = new URLSearchParams();
    const nw = next.w ?? w;
    const nwho = next.who ?? who;
    const nk = next.kind ?? kind;
    if (nw && nw !== "24") p.set("w", nw);
    if (nwho) p.set("who", nwho);
    if (nk) p.set("kind", nk);
    return p.size ? `/settings/trail?${p}` : "/settings/trail";
  };

  return (
    <div className="container wide">
      <PageHead
        title="Trail"
        sub={`Pages opened and errors thrown, kept for ${TRAIL_KEEP_DAYS} days. Only this account can read it.`}
      />

      <TrailControls on={modules.trail} kept={kept} />

      {!modules.trail && (
        <EmptyState
          title="The trail is off."
          body="Nothing is being recorded right now. Anything captured before it was switched off is still here." />
      )}

      <Toolbar
        facets={
          <FacetStrip facets={WINDOWS.map((x) => ({
            key: x.key, label: x.label, on: win.key === x.key, href: href({ w: x.key }),
          }))} />
        }
        actions={
          <span className="mut t-meta">
            {sum.errors} error{sum.errors === 1 ? "" : "s"} · {sum.pages} page
            {sum.pages === 1 ? "" : "s"} · {sum.people} {sum.people === 1 ? "person" : "people"}
          </span>
        }
      />

      {people.length > 0 && (
        <Toolbar
          facets={
            <FacetStrip facets={[
              { key: "", label: "Everyone", count: rows.length, on: who === "", href: href({ who: "" }) },
              ...people.map((p) => ({
                key: p, label: p.split("@")[0], on: who === p, href: href({ who: p }),
                count: rows.filter((r) => r.email === p).length,
              })),
            ]} />
          }
        />
      )}

      {/* What broke, and how often. The reason this page exists. */}
      <Panel title="What is failing" count={groups.length}
        hint="Grouped by page and message: one bug hit fifteen times is one row, not fifteen. Open one for the stack."
        empty={modules.trail ? "No errors in this window." : "Nothing recorded yet."}>
        {groups.map((g) => (
          <details key={g.key} className="ledger" style={{ display: "block" }}>
            <summary style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", cursor: "pointer" }}>
              <Pill tone={g.count > 5 ? "bad" : "warn"}>{g.count}×</Pill>
              <span className="mono t-small" style={{ fontWeight: 700 }}>{g.route}</span>
              <span className="t-body" style={{ flex: "1 1 200px" }}>{g.message}</span>
              <span className="mut t-meta">
                {g.people.length} {g.people.length === 1 ? "person" : "people"} · last {shopTime(g.last)}
              </span>
            </summary>
            <div className="mut t-small" style={{ marginTop: 6 }}>{g.people.join(", ")}</div>
            {g.detail && (
              <pre className="mono t-meta" style={{
                marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-word",
                background: "var(--t-faint-bg)", padding: "8px 10px", borderRadius: 8,
              }}>{g.detail}</pre>
            )}
          </details>
        ))}
      </Panel>

      {/* The stream. Useful once you know whose afternoon to read. */}
      <Panel title="Everything, newest first" count={shown.length}
        actions={
          <FacetStrip facets={[
            { key: "", label: "All", on: kind === "", href: href({ kind: "" }) },
            { key: "error", label: "Errors", on: kind === "error", href: href({ kind: "error" }) },
            { key: "page", label: "Pages", on: kind === "page", href: href({ kind: "page" }) },
          ]} />
        }
        empty="Nothing in this window.">
        {shown.slice(0, 500).map((r) => (
          <div key={r.id} className="ledger">
            <span className="mut t-meta" style={{ minWidth: 92 }}>{shopTime(r.at)}</span>
            <span className="grow">
              <span className="mono t-small" style={{ fontWeight: 600 }}>
                {r.route}{r.query ? `?${r.query}` : ""}
              </span>
              <span className="sub">
                {r.email}
                {r.role ? ` · ${r.role}` : ""}
                {r.orgName ? ` · ${r.orgName}` : ""}
                {/* The banner over that mode promises the real name is what
                    gets recorded. This is where the promise is kept. */}
                {r.viewingAs ? ` · viewing as ${r.viewingAs}` : ""}
                {r.message ? ` — ${r.message}` : ""}
              </span>
            </span>
            {r.kind === "error"
              ? <Pill tone="bad">error</Pill>
              : <Pill tone="neutral">{routeShape(r.route) === r.route ? "page" : "record"}</Pill>}
          </div>
        ))}
        {shown.length > 500 && (
          <div className="mut t-small" style={{ marginTop: 8 }}>
            Showing the newest 500 of {shown.length}. Narrow the window, or pick a person.
          </div>
        )}
      </Panel>

      <div className="mut t-meta" style={{ marginTop: 14 }}>
        Search terms are not recorded - a query string keeps its keys and loses
        the words somebody typed (<Id>lib/trail</Id>). Rows older than{" "}
        {TRAIL_KEEP_DAYS} days are deleted on their own.{" "}
        <Link href="/settings/activity" className="plain">Sign-ins are a separate list.</Link>
      </div>
    </div>
  );
}
