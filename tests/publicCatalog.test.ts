import { describe, it, expect } from "vitest";
import {
  MIN_SPECS, MIN_SUMMARY, article, cadenceWords, canPublish, metaDescription, modelSlug,
  pageTitle, productJsonLd, publicRefs, publishBlockers, publishWarnings, uniqueSlug,
} from "@/lib/publicCatalog";

const specs = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `S${i}`, value: `${i}` }));
const summary = "x".repeat(MIN_SUMMARY);

describe("modelSlug", () => {
  it("joins maker and model, lowercased and hyphenated", () => {
    expect(modelSlug("Agilent", "G7116B")).toBe("agilent-g7116b");
  });

  it("collapses punctuation and spaces without leaving stray hyphens", () => {
    expect(modelSlug("Thermo Fisher", "TSQ Altis Plus")).toBe("thermo-fisher-tsq-altis-plus");
    expect(modelSlug("Waters", "H-Class Plus (BSM)")).toBe("waters-h-class-plus-bsm");
    expect(modelSlug("", "LC-40D X3")).toBe("lc-40d-x3");
  });

  it("never ends on a hyphen, even when the cut lands on one", () => {
    expect(modelSlug("Shimadzu", "a".repeat(120)).endsWith("-")).toBe(false);
  });
});

describe("uniqueSlug", () => {
  it("keeps a free slug", () => {
    expect(uniqueSlug("agilent-g7116b", ["waters-sqd"])).toBe("agilent-g7116b");
  });
  it("suffixes a taken one, case-insensitively", () => {
    expect(uniqueSlug("agilent-g7116b", ["Agilent-G7116B"])).toBe("agilent-g7116b-2");
    expect(uniqueSlug("a", ["a", "a-2", "a-3"])).toBe("a-4");
  });
});

describe("publishBlockers", () => {
  const ok = { manufacturer: "Agilent", name: "G7116B", summary, specs: specs(MIN_SPECS), hasPhoto: true };

  it("passes a model with a maker, a real summary and enough specs", () => {
    expect(publishBlockers(ok)).toEqual([]);
    expect(canPublish(ok)).toBe(true);
  });

  it("refuses a thin page - that refusal is the point", () => {
    expect(canPublish({ ...ok, summary: "" })).toBe(false);
    expect(canPublish({ ...ok, summary: "too short" })).toBe(false);
    expect(canPublish({ ...ok, specs: specs(MIN_SPECS - 1) })).toBe(false);
    expect(canPublish({ ...ok, manufacturer: "  " })).toBe(false);
  });

  it("lists every reason at once, so fixing is one pass", () => {
    expect(publishBlockers({ manufacturer: "", name: "X", summary: "", specs: [], hasPhoto: false })).toHaveLength(3);
  });

  it("a missing photo warns but never blocks", () => {
    expect(canPublish({ ...ok, hasPhoto: false })).toBe(true);
    expect(publishWarnings({ ...ok, hasPhoto: false })).toHaveLength(1);
    expect(publishWarnings(ok)).toEqual([]);
  });
});

describe("publicRefs", () => {
  it("passes only what provenance cleared - OEM and unreviewed never go out", () => {
    const kept = publicRefs([
      { id: 1, provenance: "original" }, { id: 2, provenance: "facts" },
      { id: 3, provenance: "oem" }, { id: 4, provenance: "" }, { id: 5, provenance: undefined },
    ]);
    expect(kept.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("metaDescription", () => {
  it("uses the summary, falling back when there is none", () => {
    expect(metaDescription("A short summary.", "fallback")).toBe("A short summary.");
    expect(metaDescription("   ", "fallback")).toBe("fallback");
  });

  it("cuts long text at a word boundary, not mid-word", () => {
    const out = metaDescription(`${"word ".repeat(60)}end`, "f");
    expect(out.length).toBeLessThanOrEqual(156);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wo…$/);
  });
});

describe("productJsonLd", () => {
  const base = {
    name: "G7116B", manufacturer: "Agilent", assetType: "Pump",
    summary: "A multisampler.", specs: [{ name: "Max pressure", value: "1300 bar" }],
    url: "https://x.test/equipment/agilent-g7116b",
  };

  it("emits Product with brand, model and specs as additionalProperty", () => {
    const d = JSON.parse(productJsonLd(base));
    expect(d["@type"]).toBe("Product");
    expect(d.brand).toEqual({ "@type": "Brand", name: "Agilent" });
    expect(d.model).toBe("G7116B");
    expect(d.additionalProperty).toEqual([
      { "@type": "PropertyValue", name: "Max pressure", value: "1300 bar" },
    ]);
  });

  it("claims no price or offer - nothing here is for sale", () => {
    const json = productJsonLd(base);
    expect(json).not.toContain("offers");
    expect(json).not.toContain("price");
  });

  it("escapes < so a spec value can't close the script tag", () => {
    const json = productJsonLd({ ...base, specs: [{ name: "Trick", value: "</script><script>alert(1)" }] });
    expect(json).not.toContain("</script>");
    expect(json).toContain("\\u003c");
  });

  it("omits image and description when there aren't any", () => {
    const d = JSON.parse(productJsonLd({ ...base, summary: "  ", specs: [] }));
    expect(d.image).toBeUndefined();
    expect(d.description).toBeUndefined();
    expect(d.additionalProperty).toBeUndefined();
  });
});

describe("pageTitle / cadenceWords", () => {
  it("titles read as a search result, not a database row", () => {
    expect(pageTitle("Agilent", "G7116B", "Pump"))
      .toBe("Agilent G7116B pump - specs, parts and maintenance");
  });

  it("turns intervals into the words people use", () => {
    expect(cadenceWords(365)).toBe("annually");
    expect(cadenceWords(180)).toBe("every six months");
    expect(cadenceWords(90)).toBe("quarterly");
    expect(cadenceWords(30)).toBe("monthly");
    expect(cadenceWords(7)).toBe("weekly");
    expect(cadenceWords(null)).toBe("as needed");
    expect(cadenceWords(730)).toBe("every 2 years");
  });
});

describe("article", () => {
  it("goes by the spoken letter, not the written vowel", () => {
    // "el-see" takes "an"; "gee" takes "a".
    expect(article("LC-30ADSF")).toBe("an");
    expect(article("G7116B")).toBe("a");
    expect(article("MS120")).toBe("an");
    expect(article("TSQ Altis")).toBe("a");
    expect(article("Altis")).toBe("an");
    expect(article("")).toBe("a");
  });
});
