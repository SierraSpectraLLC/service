// The long document: a service proposal, as blocks.
//
// A quote is a price. A PROPOSAL is the twelve-page argument for it - covered
// systems, coverage tiers side by side, what parts coverage actually means,
// how a remote-first shop makes a Houston instrument work, what the paperwork
// looks like to an auditor, and which tier we think they should buy and why.
// The shop wrote one of these in Word, per client, by copying last year's and
// editing every paragraph. The parts that are genuinely the same every time -
// the parts policy, the geography, the compliance section, the terms - got
// re-proofread each time, and the parts that must change got missed.
//
// So the document is DATA plus HOUSE PROSE, and the house prose is copied into
// the proposal when it is created rather than read live. That is the whole
// design decision here: a template that is read live rewrites what a client
// already read the next time somebody improves a sentence. A proposal is a
// document that was sent; it keeps the words it was sent with.
//
// Pure. The page hands in the rows and gets blocks back, the way lib/
// demandLetter does - so the builder, the print view and any future PDF
// assembler render the same words in the same order.

import { formatCents } from "@/lib/money";

/** One machine the contract covers. */
export type SystemRow = {
  /** What it is: "Sciex TripleTOF Mass Spectrometer". */
  name: string;
  model: string;
  /** "ESI source; APCI familiarization included" - the caveat that earns a row. */
  note: string;
};

/** One line of a tier's comparison column: "Preventive Maintenance | 2 / year". */
export type TierFeature = { label: string; value: string };

/** One coverage level, priced. */
export type Tier = {
  /** Stable slug, so a recommendation points at a tier and not at its name. */
  key: string;
  name: string;
  annualCents: number;
  /** "Best for:" - the sentence that tells a reader to stop reading this one. */
  bestFor: string;
  /** What it includes, one bullet per line. */
  includes: string;
  /** What it does not, one bullet per line. Empty on tiers that cover it all. */
  notIncluded: string;
  /** The comparison column: "Label | Value" per line. See parseFeatures. */
  features: string;
};

/**
 * What a section IS.
 *
 * Four of the five are placeholders: they carry a heading and the document
 * renders the proposal's own rows in their place. That is what lets the shop
 * move the systems table above the tier comparison, or drop the recommendation
 * from a proposal that has only one tier, without any of it being wired into
 * the order of a function.
 */
export const SECTION_KINDS = ["prose", "systems", "tiers", "tier_detail", "recommendation"] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export const SECTION_KIND_LABEL: Record<string, string> = {
  prose: "Words",
  systems: "The covered systems table",
  tiers: "The tier comparison",
  tier_detail: "Tier by tier, in detail",
  recommendation: "What we recommend",
};

export type Section = {
  kind: string;
  heading: string;
  /** Prose. See parseBody for the three things a line can be. */
  body: string;
};

export type ProposalBlock =
  | { kind: "title"; text: string; sub: string }
  | { kind: "facts"; rows: [string, string][] }
  | { kind: "head"; text: string }
  | { kind: "sub"; text: string }
  | { kind: "para"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "callout"; text: string; body: string[] };

/**
 * A section's body, as the three things a line can be.
 *
 * A leading "# " is a subheading, "- " or "• " is a bullet, anything else is a
 * paragraph, and a blank line ends whatever was running. Three marks rather
 * than a markup language: this is a text box a service engineer types into
 * between visits, and every convention in it has to be guessable from looking
 * at the box.
 */
export function parseBody(body: string): ProposalBlock[] {
  const out: ProposalBlock[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length) out.push({ kind: "list", items });
    items = [];
  };
  for (const raw of (body ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.startsWith("# ")) { flush(); out.push({ kind: "sub", text: line.slice(2).trim() }); continue; }
    if (/^[-•*]\s+/.test(line)) { items.push(line.replace(/^[-•*]\s+/, "")); continue; }
    flush();
    out.push({ kind: "para", text: line });
  }
  flush();
  return out;
}

/** "Label | Value" per line, for one tier's column of the comparison. */
export function parseFeatures(text: string): TierFeature[] {
  return (text ?? "").split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("|");
      return i < 0
        ? { label: l, value: "Included" }
        : { label: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    })
    .filter((f) => f.label);
}

/** Bullets, one per line, however somebody marked them. */
export const parseBullets = (text: string): string[] =>
  (text ?? "").split(/\r?\n/).map((l) => l.replace(/^[-•*]\s+/, "").trim()).filter(Boolean);

/**
 * The comparison table: every feature any tier names, against every tier.
 *
 * Labels keep the order they first appear in, reading the tiers left to right,
 * so the row order is the order somebody typed rather than an alphabetisation
 * nobody asked for. A tier that says nothing about a feature gets a dash - not
 * a blank, which reads as an oversight, and not "No", which is a claim the
 * shop did not make.
 */
export function tierMatrix(tiers: Tier[]): { head: string[]; rows: string[][] } {
  const labels: string[] = [];
  const byTier = tiers.map((t) => {
    const map = new Map<string, string>();
    for (const f of parseFeatures(t.features)) {
      if (!labels.includes(f.label)) labels.push(f.label);
      map.set(f.label, f.value);
    }
    return map;
  });
  return {
    head: ["Feature", ...tiers.map((t) => t.name)],
    rows: [
      // Generated, never typed: the price is on the tier, and a matrix row that
      // could disagree with the tier's own detail section is a document that
      // quotes two prices for one thing.
      ["Annual Investment", ...tiers.map((t) => (t.annualCents > 0 ? formatCents(t.annualCents) : "-"))],
      ...labels.map((l) => [l, ...byTier.map((m) => m.get(l) ?? "-")]),
    ],
  };
}

export type ProposalInput = {
  /** "Service Contract Proposal" and the line under it. */
  title: string;
  subtitle: string;
  /** The facts table at the top. */
  customer: string;
  contact: string;
  date: string;
  quoteNumber: string;
  /** "30 days from issue", or a date. */
  pricingValid: string;
  systems: SystemRow[];
  tiers: Tier[];
  /** The tier `key` the recommendation is for. */
  recommendedTier: string;
  sections: Section[];
};

/**
 * The whole document, in reading order.
 *
 * Sections whose rows are missing are DROPPED rather than rendered empty: a
 * proposal with one tier has no comparison table to show, and a heading over
 * nothing reads as a document somebody abandoned halfway.
 */
export function proposalBlocks(p: ProposalInput): ProposalBlock[] {
  const out: ProposalBlock[] = [
    { kind: "title", text: p.title, sub: p.subtitle },
    {
      kind: "facts",
      rows: ([
        ["Customer", p.customer],
        ["Date", p.date],
        ["Contact", p.contact],
        ["Quote #", p.quoteNumber],
        ["System", systemSummary(p.systems)],
        ["Pricing Valid", p.pricingValid],
      ] as [string, string][]).filter(([, v]) => v.trim()),
    },
  ];

  for (const s of p.sections) {
    const heading = s.heading.trim();
    if (s.kind === "systems") {
      if (!p.systems.length) continue;
      if (heading) out.push({ kind: "head", text: heading });
      out.push(...parseBody(s.body));
      out.push({
        kind: "table",
        head: ["#", "Instrument", "Model", "Notes"],
        rows: p.systems.map((r, i) => [String(i + 1), r.name, r.model || "(included)", r.note]),
      });
      continue;
    }
    if (s.kind === "tiers") {
      // One tier is a price, not a choice. The comparison is what a reader uses
      // to argue with themselves, and it needs somebody to argue against.
      if (p.tiers.length < 2) continue;
      if (heading) out.push({ kind: "head", text: heading });
      out.push(...parseBody(s.body));
      out.push({ kind: "table", ...tierMatrix(p.tiers) });
      continue;
    }
    if (s.kind === "tier_detail") {
      if (!p.tiers.length) continue;
      for (const t of p.tiers) {
        out.push({ kind: "head", text: `${heading || "Tier Detail"}: ${t.name}` });
        if (t.annualCents > 0) {
          out.push({ kind: "para", text: `Annual Investment: ${formatCents(t.annualCents)}` });
        }
        if (t.bestFor.trim()) out.push({ kind: "para", text: `Best for: ${t.bestFor.trim()}` });
        const inc = parseBullets(t.includes);
        if (inc.length) {
          out.push({ kind: "sub", text: "Includes" });
          out.push({ kind: "list", items: inc });
        }
        const not = parseBullets(t.notIncluded);
        if (not.length) {
          out.push({ kind: "sub", text: "Not Included (Billed Separately)" });
          out.push({ kind: "list", items: not });
        }
      }
      continue;
    }
    if (s.kind === "recommendation") {
      const t = p.tiers.find((x) => x.key === p.recommendedTier);
      // Nothing recommended is a real answer - a proposal can present three
      // tiers and let the client choose - and it is not a heading over silence.
      if (!t || !s.body.trim()) continue;
      if (heading) out.push({ kind: "head", text: heading });
      out.push({
        kind: "callout",
        text: `Recommended Tier: ${t.name}${t.annualCents > 0 ? ` (${formatCents(t.annualCents)}/year)` : ""}`,
        body: parseBody(s.body).flatMap((b) =>
          b.kind === "para" ? [b.text] : b.kind === "list" ? b.items : b.kind === "sub" ? [b.text] : []),
      });
      continue;
    }
    // Plain words. A heading with nothing under it is somebody's unfinished
    // thought, not a section.
    const body = parseBody(s.body);
    if (!body.length) continue;
    if (heading) out.push({ kind: "head", text: heading });
    out.push(...body);
  }
  return out;
}

/** "Sciex TripleTOF 6600 + Shimadzu UHPLC" - the systems, as one line. */
export function systemSummary(systems: SystemRow[]): string {
  const names = systems.map((s) => (s.model.trim() || s.name.trim())).filter(Boolean);
  if (names.length <= 2) return names.join(" + ");
  return `${names.slice(0, 2).join(" + ")} +${names.length - 2} more`;
}

/**
 * What the document is worth, for the list of proposals.
 *
 * The recommended tier where there is one, the cheapest otherwise: a proposal
 * showing $32k to $46k has no single number, and the one worth sorting a
 * pipeline by is the one the shop actually put its name to.
 */
export function proposalValueCents(tiers: Tier[], recommendedTier: string): number {
  const rec = tiers.find((t) => t.key === recommendedTier);
  if (rec) return rec.annualCents;
  const priced = tiers.map((t) => t.annualCents).filter((c) => c > 0);
  return priced.length ? Math.min(...priced) : 0;
}

// ---------------------------------------------------------------------------
// The house template.
//
// Copied INTO a proposal when it is created, never read live - see the note at
// the top of this file. Everything here is Sierra Spectra's own standing
// position: what parts coverage means, how a remote-first shop works a machine
// nine hundred miles away, what an auditor gets, and what the terms are. The
// client-specific sections ship as empty prompts rather than as last client's
// words, because a paragraph about the wrong company's December deadline is
// the single worst thing that can be in one of these.
// ---------------------------------------------------------------------------

export const HOUSE_TIERS: Tier[] = [
  {
    key: "pm_tm", name: "PM + T&M", annualCents: 0,
    bestFor: "laboratories with strong internal expertise, predictable usage patterns, and tolerance for on-call billing for service events outside scheduled PMs.",
    includes: [
      "Two (2) on-site preventive maintenance visits per year, semi-annually scheduled",
      "Travel, lodging, and per diem for PM visits included in annual fee",
      "Standard PM scope per manufacturer maintenance schedules",
      "Annual OQ / performance verification with documented data sheet",
      "Remote diagnostic support during business hours (Monday-Friday, 8am-5pm Pacific)",
      "Service report after every visit with summary, findings, and recommendations",
    ].join("\n"),
    notIncluded: [
      "On-site escalation visits outside scheduled PMs: day rate plus travel at cost + 10%",
      "Replacement parts: at cost + 15% handling",
      "After-hours or weekend remote support: hourly",
    ].join("\n"),
    features: [
      "Preventive Maintenance | 2 / year",
      "PM Travel & Logistics | Included",
      "Remote Support | Business hours",
      "On-Site Escalation | Billed per day",
      "Response Time (remote) | Next business day",
      "Parts (OEM/3rd party) | At cost + 15%",
      "OQ / Performance Verification | Annual, included",
    ].join("\n"),
  },
  {
    key: "essential", name: "Essential", annualCents: 0,
    bestFor: "laboratories supporting GMP work where downtime carries direct compliance and revenue risk, but emergency response within 48-72 hours is acceptable.",
    includes: [
      "Everything in PM + T&M, plus:",
      "Up to five (5) on-site escalation days per year for emergency or out-of-cycle service",
      "8-business-hour remote response time",
      "Parts coverage: uncapped annually, with a per-incident cap (see Parts & Materials)",
      "Annual baseline PM performed by a manufacturer-certified specialist engaged through us",
      "GMP-aligned documentation: each service event includes a formal service report compatible with audit requirements",
      "Priority scheduling for on-site escalation when needed",
    ].join("\n"),
    notIncluded: "",
    features: [
      "Preventive Maintenance | 2 / year",
      "PM Travel & Logistics | Included",
      "Remote Support | Business hours",
      "On-Site Escalation | 5 visits included",
      "Response Time (remote) | Same day",
      "On-Site Response (when needed) | 48-72 hours",
      "Parts (OEM/3rd party) | Uncapped annual",
      "Per-Incident Parts Cap | Set per contract",
      "OQ / Performance Verification | Annual, included",
      "GMP Documentation Support | Included",
      "Certified Specialist Engagement | Annual baseline PM",
    ].join("\n"),
  },
  {
    key: "gmp_select", name: "GMP Select", annualCents: 0,
    bestFor: "laboratories transitioning to GMP analytical work on a firm deadline, where certified specialist coverage on every PM and validation-formatted documentation are required - at a price point below comparable OEM service contracts.",
    includes: [
      "Everything in Essential, plus:",
      "Up to eight (8) on-site escalation days per year for emergency or out-of-cycle service",
      "6-business-hour remote response time; 48-72 hour on-site response for critical events",
      "Parts coverage: uncapped annually, with a higher per-incident cap (see Parts & Materials)",
      "Manufacturer-certified specialist engaged on both PM visits, not the annual baseline only",
      "Annual OQ / performance verification structured to document the parameters in the client's own IQ/OQ/PQ validation protocol",
      "GMP-aligned documentation including signed customer acknowledgment",
      "Audit documentation support: records, reports, and performance data suitable for regulatory review",
      "Quarterly review calls to assess instrument performance trends and proactively schedule preventive work",
    ].join("\n"),
    notIncluded: "",
    features: [
      "Preventive Maintenance | 2 / year",
      "PM Travel & Logistics | Included",
      "Remote Support | Business hours",
      "On-Site Escalation | 8 days included",
      "Response Time (remote) | Same day",
      "On-Site Response (when needed) | 48-72 hours",
      "Parts (OEM/3rd party) | Uncapped annual",
      "Per-Incident Parts Cap | Set per contract",
      "OQ / Performance Verification | Annual, included",
      "GMP Documentation Support | Included",
      "Certified Specialist Engagement | Both PMs",
    ].join("\n"),
  },
  {
    key: "premium", name: "Premium", annualCents: 0,
    bestFor: "laboratories with critical GMP timelines, high sample throughput, or zero tolerance for extended downtime.",
    includes: [
      "Everything in GMP Select, plus:",
      "Unlimited on-site escalation visits at no additional fee",
      "4-business-hour remote response time",
      "48-hour on-site response window for critical events",
      "Uncapped parts coverage for OEM and qualified third-party parts, with no per-incident cap",
      "Manufacturer-certified specialist on every PM visit and complex escalation",
      "Semi-annual OQ / performance verification",
      "Audit support: documentation, statements, and on-call expertise during regulatory inspections",
      "Quarterly review calls to assess instrument performance trends and proactively schedule preventive work",
    ].join("\n"),
    notIncluded: "",
    features: [
      "Preventive Maintenance | 2 / year",
      "PM Travel & Logistics | Included",
      "Remote Support | Extended hours",
      "On-Site Escalation | Unlimited",
      "Response Time (remote) | Same day",
      "On-Site Response (when needed) | 24-48 hours",
      "Parts (OEM/3rd party) | Uncapped annual",
      "Per-Incident Parts Cap | None",
      "OQ / Performance Verification | Semi-annual, included",
      "GMP Documentation Support | Included + audit support",
      "Certified Specialist Engagement | All PMs + escalations",
    ].join("\n"),
  },
];

export const HOUSE_SECTIONS: Section[] = [
  {
    kind: "prose", heading: "Executive Summary",
    // Empty on purpose. Last client's summary in this box is how a proposal
    // goes out naming the wrong company's deadline.
    body: "",
  },
  {
    kind: "systems", heading: "Scope of Coverage",
    body: "# Covered Systems",
  },
  {
    kind: "tiers", heading: "Coverage Tier Comparison",
    body: "Tiers structured to fit different risk profiles, response needs, and budget envelopes. All tiers include semi-annual PMs and remote support.",
  },
  { kind: "tier_detail", heading: "Tier Detail", body: "" },
  {
    kind: "prose", heading: "Parts & Materials",
    body: [
      "Parts coverage under our service contracts is structured to provide meaningful protection without exposing either party to catastrophic single-event costs.",
      "",
      "# If a Per-Incident Cap is Exceeded",
      "- We cover parts costs up to the cap",
      "- Costs above the cap are quoted to the client at cost + 10% handling for review and approval",
      "- The client may authorize the additional cost, defer the repair, or pursue an alternate remedy",
      "- Labor coverage continues at no additional charge during this process",
      "",
      "# Parts Sourcing",
      "- Genuine OEM parts used wherever available and practical",
      "- Qualified third-party and reconditioned alternatives used where cost-effective, when OEM parts are out of production, or when lead times would extend downtime unacceptably",
      "- All parts documented in the service report with manufacturer and part number for service records",
      "",
      "# Excluded from Parts Coverage",
      "- Consumables: solvents, calibration standards, sample vials, septa, columns",
      "- Damage caused by improper sample handling, contaminated samples, or operator error",
      "- Manufacturer recalls or warranty-eligible repairs, handled directly by the manufacturer",
      "- Upgrades or modifications not specified in the original system configuration",
      "- Entire system replacement",
      "- Software, licensing, OS-level problems, network configuration, and PC hardware. We assist with diagnostic guidance on a remote-support basis but do not warranty PC or software components",
    ].join("\n"),
  },
  {
    kind: "prose", heading: "Geographic & Logistical Considerations",
    body: [
      "# How We Make This Work",
      "- PM visits are scheduled 2 to 4 weeks in advance, allowing efficient travel and on-site time of 1-2 days per visit",
      "- Remote-first support resolves the majority of issues without travel: remote sessions, log file review, guided diagnostics, and real-time escalation to specialists",
      "- Travel and lodging for PM visits are included in the annual fee at all tiers",
      "- On-site escalation visits include travel within their day rate or as a billable expense, transparently documented",
      "",
      "# What You Gain",
      "- Documentation and quality standards aligned with ISO/IEC 17025 practices, suitable for GMP audit support",
      "- Direct access to our principal engineer for relationship continuity - no rotating service techs",
      "- Manufacturer-certified specialist engagement structured into the contract so OEM-level expertise is built into the relationship",
    ].join("\n"),
  },
  {
    kind: "prose", heading: "Compliance & Documentation",
    body: [
      "# GMP Readiness",
      "Our service documentation is structured to support GMP compliance for analytical work in regulated environments. Each service event is documented with timestamp, engineer identity, parts used, procedures performed, results, and signed customer acknowledgment.",
      "",
      "# Documentation Provided",
      "- Service Report, issued after every visit, suitable for laboratory records",
      "- OQ / Performance Verification Report, suitable for quality system documentation",
      "- Parts Replacement Log, with manufacturer, part number, and installation date",
      "- Calibration Records, for instruments where we perform calibration verification",
      "- Annual Service Summary, a compiled record of all work performed in the contract year",
    ].join("\n"),
  },
  {
    kind: "prose", heading: "Multi-System Discount",
    body: [
      "We offer tiered per-system pricing for clients consolidating multiple systems under one service agreement, reflecting the operational efficiencies of unified account management, shared travel logistics, and consolidated documentation.",
      "",
      "Discount tiers apply to the combined annual investment when systems are simultaneously covered. Transition timing can be aligned with existing OEM contract renewal dates to avoid duplicate coverage costs.",
    ].join("\n"),
  },
  {
    kind: "prose", heading: "Engagement Terms",
    body: [
      "# Contract Term",
      "- Initial term: 12 months from effective date",
      "- Auto-renewal: annual, with 30 days written notice required to cancel prior to renewal",
      "- Mid-term tier upgrade: available at any time with prorated cost difference",
      "- Mid-term tier downgrade: available at renewal only",
      "",
      "# Billing",
      "- Annual fee billed at contract execution",
      "- Quarterly or monthly billing available upon request",
      "- On-site escalation time and materials billed monthly",
      "- Acceptable payment methods: ACH, wire transfer, corporate PO, credit card",
      "",
      "# Termination",
      "- Either party may terminate with 60 days written notice",
      "- Refund for the unused contract period prorated, less any services delivered",
      "- No early termination penalty",
    ].join("\n"),
  },
  { kind: "recommendation", heading: "Our Recommendation", body: "" },
  {
    // Empty, and deliberately not written here: who the shop IS is the one
    // section that belongs to the operator rather than to the trade, and the
    // words for it live in whoever's workspace this is - not in a library
    // shipped to all of them.
    kind: "prose", heading: "About us", body: "",
  },
  {
    kind: "prose", heading: "Next Steps",
    body: [
      "- Review this proposal and discuss internally",
      "- Schedule a follow-up call to discuss tier selection, instrument-specific questions, and any contract modifications",
      "- We provide a formal service agreement upon tier selection",
    ].join("\n"),
  },
];

/** The template a new proposal starts from: the house prose and the house ladder. */
export const houseTemplate = (): { sections: Section[]; tiers: Tier[] } => ({
  sections: HOUSE_SECTIONS.map((s) => ({ ...s })),
  tiers: HOUSE_TIERS.map((t) => ({ ...t })),
});
