import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { catalogRefs, partCatalog, partKitLines, procedures, vocabTerms } from "@/db/schema";
import { getBrand } from "@/lib/brand";
import { appUrl } from "@/lib/appUrl";
import { parseModelSpecs } from "@/lib/modelSpecs";
import { parseProcParts, partsForModel } from "@/lib/procedures";
import { article, cadenceWords, metaDescription, pageTitle, productJsonLd, publicRefs } from "@/lib/publicCatalog";
import { stockSrc } from "@/lib/photos";
import SpecTable from "@/components/SpecTable";

export const dynamic = "force-dynamic";

/**
 * A model's public page: what the thing is, by the numbers, for whoever is
 * standing in front of one at four in the afternoon with a search box.
 *
 * This page must never touch the session or the tenancy helpers - like the
 * listing page, nothing here may depend on who is asking, so nothing can leak
 * by accident. What it shows is the deliberate half of the bargain in
 * lib/publicCatalog: specs, part numbers, kit contents and how often work
 * comes round go out; checklists, field-note bodies, prices, clients and units
 * do not. The last of those is not a style choice - which customer owns what
 * is the one fact a service company can never publish.
 */
async function load(slug: string) {
  const [term] = await db.select().from(vocabTerms)
    .where(and(eq(vocabTerms.publicSlug, slug), eq(vocabTerms.published, true), eq(vocabTerms.kind, "model")));
  if (!term) return null;
  return term;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  // notFound() HERE rather than only in the body: metadata resolves before the
  // render streams, and once the shell has started the status can no longer be
  // changed - a missing page would answer 200 with 404 content, which is the
  // "soft 404" that gets empty URLs indexed. The whole point of these pages is
  // how they're crawled, so the status has to be right.
  const term = await load(slug);
  if (!term) notFound();
  const brand = await getBrand();
  const url = appUrl();
  const title = pageTitle(term.manufacturer, term.name, term.assetType);
  const description = metaDescription(
    term.publicSummary,
    `${term.manufacturer} ${term.name} ${term.assetType.toLowerCase()}: specifications, part numbers and maintenance intervals.`,
  );
  return {
    title, description,
    alternates: url ? { canonical: `${url}/equipment/${slug}` } : undefined,
    openGraph: {
      title, description, type: "article",
      siteName: brand.name,
      ...(url ? { url: `${url}/equipment/${slug}` } : {}),
      ...(term.photoUrl && url ? { images: [`${url}${stockSrc(term.id)}`] } : {}),
    },
    robots: { index: true, follow: true },
  };
}

export default async function PublicModelPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const term = await load(slug);
  if (!term) notFound();

  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const [brand, procRows, refRows, partRows] = await Promise.all([
    getBrand(),
    db.select().from(procedures)
      .where(and(eq(procedures.assetType, term.assetType), eq(procedures.tenantOrgId, term.tenantOrgId!)))
      .orderBy(asc(procedures.position)),
    db.select().from(catalogRefs)
      .where(and(eq(catalogRefs.assetType, term.assetType), eq(catalogRefs.tenantOrgId, term.tenantOrgId!))),
    db.select().from(partCatalog)
      .where(and(eq(partCatalog.archived, false), eq(partCatalog.tenantOrgId, term.tenantOrgId!)))
      .orderBy(asc(partCatalog.partNumber)),
  ]);

  const url = appUrl();
  const specs = parseModelSpecs(term.specs);

  // Recurring work only, named and timed - never the checklist that carries it out.
  const upkeep = procRows
    .filter((r) => r.intervalDays !== null
      && (r.modelScope.length === 0 || r.modelScope.some((m) => same(m, term.name))))
    .map((r) => ({
      name: r.name, every: cadenceWords(r.intervalDays),
      // Narrowed to THIS model (a procedure can map a different kit per model)
      // and deduped - "Seal kit, Seal kit, Seal kit" is what the raw list reads.
      parts: [...new Set(partsForModel(parseProcParts(r.parts), term.name)
        .map((pp) => pp.name || pp.number).filter(Boolean))],
    }));

  const parts = partRows.filter((p) =>
    p.models.some((m) => same(m, term.name))
    || (p.models.length === 0 && p.assetTypes.some((t) => same(t, term.assetType))));
  const kitIds = parts.filter((p) => p.kind === "kit").map((p) => p.id);
  const kitLines = kitIds.length
    ? await db.select().from(partKitLines)
        .where(inArray(partKitLines.kitId, kitIds)).orderBy(asc(partKitLines.sortOrder))
    : [];
  const linesFor = (kitId: number) => kitLines.filter((l) => l.kitId === kitId);

  // Titles only: what we know exists, never the text of it. That gap is the
  // reason to sign in, and it is an honest one.
  const notes = publicRefs(refRows.filter((r) => !r.model.trim() || same(r.model, term.name)));

  const jsonLd = productJsonLd({
    name: term.name, manufacturer: term.manufacturer, assetType: term.assetType,
    summary: term.publicSummary, specs,
    url: url ? `${url}/equipment/${slug}` : `/equipment/${slug}`,
    imageUrl: term.photoUrl && url ? `${url}${stockSrc(term.id)}` : undefined,
  });

  const H = ({ children }: { children: React.ReactNode }) => (
    <h2 style={{ fontSize: 17, margin: "0 0 8px" }}>{children}</h2>
  );

  return (
    <div className="container page" style={{ maxWidth: 860 }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />

      <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
        <Link href="/equipment" style={{ textDecoration: "none" }}>Equipment library</Link>
        {" / "}{term.assetType}
      </div>

      <div className="card">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
          {term.photoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={stockSrc(term.id)} alt={`${term.manufacturer} ${term.name}`}
              style={{ width: 150, height: 150, objectFit: "cover", borderRadius: 10, border: "1px solid var(--line)" }} />
          )}
          <div style={{ flex: 1, minWidth: 240 }}>
            <div className="eyebrow">{term.manufacturer}</div>
            <h1 style={{ margin: "2px 0 6px", fontSize: 27 }}>{term.name}</h1>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
              <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>{term.assetType}</span>
              {term.categories.map((c) => (
                <span key={c} className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>{c}</span>
              ))}
              {term.gases.map((g) => (
                <span key={g} className="pill" style={{ background: "#FAF0DC", color: "#8A5410" }}>{g}</span>
              ))}
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.6, margin: 0 }}>{term.publicSummary}</p>
          </div>
        </div>
      </div>

      {specs.length > 0 && (
        <div className="card">
          <H>{term.name} specifications</H>
          <SpecTable specs={specs} />
        </div>
      )}

      {upkeep.length > 0 && (
        <div className="card">
          <H>Maintenance schedule</H>
          <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
            What a {term.name} needs, and how often.
          </div>
          {upkeep.map((j) => (
            <div key={j.name} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{j.name}</span>
              <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>{j.every}</span>
              {j.parts.length > 0 && (
                <span className="mut" style={{ fontSize: 12 }}>takes {j.parts.join(", ")}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {parts.length > 0 && (
        <div className="card">
          <H>Parts and PM kits for the {term.name}</H>
          {parts.map((p) => (
            <div key={p.id} style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--navy)" }}>{p.partNumber}</span>
                <span style={{ fontSize: 13 }}>{p.name}</span>
                {p.kind === "kit" && <span className="pill" style={{ background: "#EDEBFA", color: "#4F45A3", fontSize: 10 }}>kit</span>}
                {p.manufacturer && <span className="mut" style={{ fontSize: 12 }}>{p.manufacturer}{p.mfrPartNumber ? ` ${p.mfrPartNumber}` : ""}</span>}
              </div>
              {p.kind === "kit" && linesFor(p.id).length > 0 && (
                <div className="mut" style={{ fontSize: 12, paddingLeft: 12, marginTop: 2 }}>
                  contains {linesFor(p.id).map((l) => `${l.qty > 1 ? `${l.qty}× ` : ""}${l.name || l.partNumber}`).join(" · ")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* The honest gap: we say what we hold, not what it says. */}
      {notes.length > 0 && (
        <div className="card">
          <H>Service notes on file</H>
          <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
            {notes.length} note{notes.length === 1 ? "" : "s"} our engineers have written about this equipment. Readable inside the portal.
          </div>
          {notes.slice(0, 10).map((n) => (
            <div key={n.id} style={{ fontSize: 13, padding: "4px 0", borderTop: "1px solid var(--line)" }}>
              {n.title || "Field note"}
            </div>
          ))}
        </div>
      )}

      {/* The soft sell: not "buy software" - "keep track of the one you own". */}
      <div className="card" style={{ background: "#F7F9FC" }}>
        <H>Own {article(term.name)} {term.name}?</H>
        <p style={{ fontSize: 14, lineHeight: 1.6, marginTop: 0 }}>
          Start a free record and this schedule, its parts list and its service history live in one place -
          with reminders before the work is due rather than after.
        </p>
        <Link href="/login" className="btn primary" style={{ textDecoration: "none" }}>
          Track your {term.assetType.toLowerCase()}
        </Link>
        <div className="mut" style={{ fontSize: 12, marginTop: 10 }}>
          Service this equipment for a living? This library is one shop&apos;s, kept as it works
          {brand.name !== brand.operatorName ? ` on ${brand.name}` : ""} -{" "}
          <Link href="/login">see what that looks like</Link>.
        </div>
      </div>

      <div className="mut" style={{ fontSize: 11, lineHeight: 1.6, marginTop: 4 }}>
        {term.manufacturer} and {term.name} are used to identify the equipment this page describes.{" "}
        {brand.operatorName} is an independent service provider and is not affiliated with, authorized by,
        or endorsed by {term.manufacturer}. Specifications and intervals are recorded from our own service
        experience - always confirm against the manufacturer&apos;s current documentation.
      </div>
    </div>
  );
}
