import type { Metadata } from "next";
import Link from "next/link";
import { asc, eq, and } from "drizzle-orm";
import { db } from "@/db";
import { vocabTerms } from "@/db/schema";
import { getBrand } from "@/lib/brand";
import { appUrl } from "@/lib/appUrl";
import { metaDescription } from "@/lib/publicCatalog";
import { stockSrc } from "@/lib/photos";

export const dynamic = "force-dynamic";

/**
 * The public library's front door, grouped by manufacturer. Its real job is
 * internal linking: a model page nobody links to is a model page nobody
 * finds, and an index that names every published model gives each one a path
 * in from the site's root.
 */
export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrand();
  const url = appUrl();
  const title = `Equipment library - specs, parts and maintenance intervals | ${brand.name}`;
  return {
    title,
    description: metaDescription("", "Specifications, part numbers, PM kit contents and maintenance intervals for laboratory instrument modules - recorded from service experience."),
    alternates: url ? { canonical: `${url}/equipment` } : undefined,
    robots: { index: true, follow: true },
  };
}

export default async function EquipmentIndexPage() {
  const [rows, brand] = await Promise.all([
    db.select().from(vocabTerms)
      .where(and(eq(vocabTerms.published, true), eq(vocabTerms.kind, "model")))
      .orderBy(asc(vocabTerms.manufacturer), asc(vocabTerms.name)),
    getBrand(),
  ]);

  const makers = [...new Set(rows.map((r) => r.manufacturer).filter(Boolean))].sort();

  return (
    <div className="container page" style={{ maxWidth: 860 }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Equipment library</h1>
      <p className="mut" style={{ fontSize: 14, lineHeight: 1.6, marginTop: 0 }}>
        Specifications, part numbers, PM kit contents and maintenance intervals for the laboratory
        instrument modules {brand.operatorName} services. Written from our own service experience,
        not copied from anybody&apos;s manual.
      </p>

      {rows.length === 0 && (
        <div className="card mut" style={{ fontSize: 13 }}>
          Nothing published yet.
        </div>
      )}

      {makers.map((mk) => (
        <div key={mk} className="card">
          <h2 style={{ fontSize: 17, margin: "0 0 8px" }}>{mk}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 8 }}>
            {rows.filter((r) => r.manufacturer === mk).map((r) => (
              <Link key={r.id} href={`/equipment/${r.publicSlug}`} className="row-hover"
                style={{
                  display: "flex", gap: 8, alignItems: "center", padding: 8, textDecoration: "none",
                  color: "inherit", border: "1px solid var(--line)", borderRadius: 8,
                }}>
                {r.photoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={stockSrc(r.id)} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
                )}
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 700 }}>{r.name}</span>
                  <span className="mut" style={{ fontSize: 11 }}>{r.assetType}</span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
