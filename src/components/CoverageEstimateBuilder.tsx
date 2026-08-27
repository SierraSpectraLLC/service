"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { applyCoverageEstimate, lookupModelKit } from "@/app/actions";
import {
  estimate, periodWindows, type CoverageInput, type CoverageSite,
} from "@/lib/coveragePrice";
import { kitIsEmpty, type ModelKit } from "@/lib/pmKit";
import { centsToInput, formatCents, parseMoney } from "@/lib/money";
import { Panel } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

export type ModelOption = { model: string; assetType: string; manufacturer: string; categories: string[] };

type SystemRow = {
  name: string;
  category: string;
  visits: string;
  hours: string;
  parts: string;
  /** What the catalog said when this model was looked up. */
  kit?: ModelKit | null;
  looking?: boolean;
};

type SiteRow = {
  name: string;
  tripCost: string;
  tripHours: string;
  batched: boolean;
  systems: SystemRow[];
};

const blankSystem = (): SystemRow => ({ name: "", category: "", visits: "2", hours: "", parts: "" });
const blankSite = (): SiteRow => ({ name: "", tripCost: "", tripHours: "8", batched: true, systems: [blankSystem()] });

const money = (s: string) => parseMoney(s) ?? 0;
const num = (s: string) => {
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const pct = (s: string) => Math.round(num(s) * 100);   // percent in, bps out

/**
 * Pricing a coverage contract off a plan.
 *
 * Everything about this panel is arranged around one fact people get wrong when
 * they price this work by hand: A VISIT IS NOT A TRIP. So the journey count
 * sits at the top of each building in words - "2 journeys a year" - and moves
 * as systems are added, because watching it NOT move when a fifth instrument
 * joins a site is the moment the whole idea lands. Four mass specs on two PMs a
 * year is two flights, not eight, and the fifth system on a site we are already
 * standing in costs its hours and its kit and no travel at all.
 *
 * The estimate is computed here as somebody types, and computed AGAIN on the
 * server from the same inputs when it is applied. What lands on a client's
 * quote is the server's number.
 */
export default function CoverageEstimateBuilder({ quoteId, models, defaultStart }: {
  quoteId: number;
  models: ModelOption[];
  defaultStart: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  // Its own transition: a model lookup must not make the apply button say
  // "Pricing...", which is a different and much more alarming claim.
  const [, startLookup] = useTransition();
  const [error, setError] = useState("");

  const [sites, setSites] = useState<SiteRow[]>([blankSite()]);
  const [startsOn, setStartsOn] = useState(defaultStart);
  const [a, setA] = useState({
    laborCost: "95", laborBill: "225", partsMarkup: "30",
    overhead: "12", margin: "32", escalation: "3", periods: "5",
    resTrips: "2", resHours: "8", resTrip: "2100", resParts: "4000",
  });

  const input: CoverageInput = {
    sites: sites.map((s): CoverageSite => ({
      name: s.name.trim() || "Unnamed site",
      tripCostCents: money(s.tripCost),
      tripHours: num(s.tripHours),
      batched: s.batched,
      systems: s.systems
        .filter((x) => x.name.trim())
        .map((x) => ({
          name: x.name.trim(),
          visitsPerYear: num(x.visits),
          hoursPerVisit: num(x.hours),
          partsCentsPerVisit: money(x.parts),
        })),
    })),
    laborCostPerHourCents: money(a.laborCost),
    laborBillPerHourCents: money(a.laborBill),
    partsMarkupBps: pct(a.partsMarkup),
    reserve: {
      tripsPerYear: num(a.resTrips), hoursPerTrip: num(a.resHours),
      tripCostCents: money(a.resTrip), partsCents: money(a.resParts),
    },
    overheadBps: pct(a.overhead),
    marginBps: pct(a.margin),
    periods: num(a.periods),
    escalationBps: pct(a.escalation),
  };
  const out = estimate(input);
  const windows = periodWindows(startsOn, out.periods.length);

  /*
   * Functional updates, not `sites.map(...)`. A lookup resolves a second or so
   * after the row that started it, against whatever `sites` was when look() was
   * created - so filling in three systems one after another had each arriving
   * answer overwrite the two before it, and all three rows sat on "looking it
   * up..." for ever. Only visible by doing it.
   */
  const setSite = (i: number, patch: Partial<SiteRow>) =>
    setSites((prev) => prev.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  const setSystem = (si: number, xi: number, patch: Partial<SystemRow>) =>
    setSites((prev) => prev.map((s, n) => (n === si
      ? { ...s, systems: s.systems.map((x, m) => (m === xi ? { ...x, ...patch } : x)) }
      : s)));

  /**
   * The lookup. Picking a model fills in what the catalog already knows -
   * hours from the procedures' own estimates, parts from the kit priced
   * through the price book - and leaves anything it could not answer ALONE
   * rather than zeroing it, so a half-written catalog degrades to a form
   * somebody types into instead of to a bid full of confident noughts.
   */
  const look = (si: number, xi: number, model: string) => {
    const opt = models.find((m) => m.model === model);
    const category = opt?.categories[0] ?? "";
    setSystem(si, xi, { name: model, category, looking: true, kit: null });
    startLookup(async () => {
      const res = await lookupModelKit(model, category);
      const kit = res.kit ?? null;
      const patch: Partial<SystemRow> = { looking: false, kit };
      if (kit) {
        // Per VISIT, at the visit rate the catalog implies - so the three
        // fields are consistent with each other and visits x per-visit is the
        // year the catalog described.
        if (kit.visitsPerYear !== null) patch.visits = String(kit.visitsPerYear);
        if (kit.minutesPerVisit > 0) patch.hours = String(Math.round((kit.minutesPerVisit / 60) * 10) / 10);
        if (kit.partsCentsPerVisit > 0) patch.parts = centsToInput(kit.partsCentsPerVisit);
      }
      setSystem(si, xi, patch);
    });
  };

  const apply = () => {
    setError("");
    startTransition(async () => {
      const res = await applyCoverageEstimate(quoteId, input, startsOn);
      if (res.error) { setError(res.error); return; }
      toast({ message: `Priced ${res.added} period${res.added === 1 ? "" : "s"} onto the quote` });
      setOpen(false);
      router.refresh();
    });
  };

  if (!open) {
    return (
      <Panel title="Coverage estimate"
        hint="Price a contract off a plan - systems, sites and visits - rather than off what a client has spent before.">
        <button className="btn" onClick={() => setOpen(true)}>Build a coverage estimate</button>
      </Panel>
    );
  }

  const field = (label: string, key: keyof typeof a, width = 76, suffix = "") => (
    <label style={{ display: "block" }}>
      <span className="mut t-meta" style={{ display: "block" }}>{label}</span>
      <input className="mono t-small" style={{ width }} value={a[key]} aria-label={label}
        onChange={(e) => setA({ ...a, [key]: e.target.value })} />
      {suffix && <span className="mut t-meta"> {suffix}</span>}
    </label>
  );

  return (
    <Panel title="Coverage estimate"
      hint="A visit is not a trip. Everything at one address is serviced on the same journey, so the fifth system there costs its hours and its kit and no travel.">

      {sites.map((site, si) => {
        const cost = out.sites[si];
        return (
          <div key={si} style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 10, marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <label style={{ flex: "2 1 200px" }}>
                <span className="mut t-meta" style={{ display: "block" }}>Place of performance</span>
                <input value={site.name} aria-label={`Site ${si + 1}`} style={{ width: "100%" }}
                  placeholder="NIST Gaithersburg, MD"
                  onChange={(e) => setSite(si, { name: e.target.value })} />
              </label>
              <label>
                <span className="mut t-meta" style={{ display: "block" }}>Cost per journey</span>
                <input className="mono t-small" style={{ width: 96 }} value={site.tripCost}
                  aria-label={`Trip cost ${si + 1}`} placeholder="1850"
                  onChange={(e) => setSite(si, { tripCost: e.target.value })} />
              </label>
              <label>
                <span className="mut t-meta" style={{ display: "block" }}>Hours door to door</span>
                <input className="mono t-small" style={{ width: 64 }} value={site.tripHours}
                  aria-label={`Trip hours ${si + 1}`}
                  onChange={(e) => setSite(si, { tripHours: e.target.value })} />
              </label>
              <label className="t-small" style={{ display: "flex", gap: 5, alignItems: "center", paddingBottom: 6 }}>
                <input type="checkbox" checked={site.batched}
                  onChange={(e) => setSite(si, { batched: e.target.checked })} />
                serviced on one journey
              </label>
              {sites.length > 1 && (
                <button className="btn link" style={{ fontSize: 12, paddingBottom: 8 }}
                  onClick={() => setSites(sites.filter((_, n) => n !== si))}>remove site</button>
              )}
            </div>

            {/* The number the whole feature exists to get right, said in words
                and kept where it can be watched while systems are added. */}
            <div className="t-small" style={{ margin: "8px 0" }}>
              <b>{cost?.trips ?? 0} journey{cost?.trips === 1 ? "" : "s"} a year</b>
              <span className="mut">
                {" · "}{cost?.onsiteHours ?? 0}h on systems, {cost?.travelHours ?? 0}h traveling
                {cost ? ` · ${formatCents(cost.totalCents)} a year` : ""}
                {site.batched && site.systems.filter((x) => x.name.trim()).length > 1
                  ? " · everything here rides on the same trip" : ""}
              </span>
            </div>

            {site.systems.map((x, xi) => {
              /* By position among the NAMED rows, not by name: two units of the
                 same model at one address are two rows, and matching on the
                 name gave both of them the first one's numbers. */
              const named = site.systems.filter((r) => r.name.trim());
              const share = cost?.systems[named.indexOf(x)];
              return (
                <div key={xi} style={{ borderTop: "1px solid var(--line)", padding: "6px 0" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <input list="coverage-models" style={{ flex: "2 1 180px", minWidth: 140 }}
                      value={x.name} aria-label={`System ${si + 1}.${xi + 1}`} placeholder="model, e.g. API 5000"
                      onChange={(e) => setSystem(si, xi, { name: e.target.value })}
                      onBlur={(e) => { if (e.target.value.trim() && !x.kit) look(si, xi, e.target.value.trim()); }} />
                    <input className="mono t-small" style={{ width: 54 }} value={x.visits}
                      aria-label={`Visits a year ${si + 1}.${xi + 1}`}
                      onChange={(e) => setSystem(si, xi, { visits: e.target.value })} />
                    <span className="mut t-meta">/yr</span>
                    <input className="mono t-small" style={{ width: 54 }} value={x.hours}
                      aria-label={`Hours a visit ${si + 1}.${xi + 1}`} placeholder="h"
                      onChange={(e) => setSystem(si, xi, { hours: e.target.value })} />
                    <span className="mut t-meta">h/visit</span>
                    <input className="mono t-small" style={{ width: 84 }} value={x.parts}
                      aria-label={`Parts a visit ${si + 1}.${xi + 1}`} placeholder="parts $"
                      onChange={(e) => setSystem(si, xi, { parts: e.target.value })} />
                    {share && <span className="mut t-small">{formatCents(share.totalCents)}/yr</span>}
                    {site.systems.length > 1 && (
                      <button className="btn link" style={{ fontSize: 12 }}
                        onClick={() => setSites(sites.map((s, n) => (n === si
                          ? { ...s, systems: s.systems.filter((_, m) => m !== xi) } : s)))}>
                        remove
                      </button>
                    )}
                  </div>
                  <KitNote row={x} share={share?.travelCents} />
                </div>
              );
            })}
            <button className="btn sm" style={{ marginTop: 6 }}
              onClick={() => setSite(si, { systems: [...site.systems, blankSystem()] })}>
              + System
            </button>
          </div>
        );
      })}

      <button className="btn sm" onClick={() => setSites([...sites, blankSite()])}>+ Place of performance</button>

      <datalist id="coverage-models">
        {models.map((m) => (
          <option key={m.model} value={m.model}>
            {[m.manufacturer, m.assetType].filter(Boolean).join(" ")}
          </option>
        ))}
      </datalist>

      <div className="dialog-section" style={{ marginTop: 12 }}>What we assume</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {field("Our cost/hour", "laborCost", 76)}
        {field("Bills at/hour", "laborBill", 76)}
        {field("Parts markup %", "partsMarkup", 60)}
        {field("Overhead %", "overhead", 60)}
        {field("Margin %", "margin", 60)}
        {field("Escalation %/yr", "escalation", 60)}
        {field("Periods", "periods", 54)}
        <label style={{ display: "block" }}>
          <span className="mut t-meta" style={{ display: "block" }}>First period starts</span>
          <input type="date" className="mono t-small" value={startsOn} aria-label="First period starts"
            onChange={(e) => setStartsOn(e.target.value)} />
        </label>
      </div>

      <div className="dialog-section" style={{ marginTop: 10 }}>
        What the response promise is worth
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        {field("Callouts/yr", "resTrips", 54)}
        {field("Hours each", "resHours", 54)}
        {field("Cost per callout", "resTrip", 84)}
        {field("Parts reserve", "resParts", 84)}
        {/* An emergency contract is an option we are writing. Priced as its own
            line because it is the assumption a losing bid is usually wrong
            about, and because a client asks what it costs to drop it. */}
        <span className="mut t-small" style={{ paddingBottom: 6 }}>
          {formatCents(out.reserveCents)} a year of the price
        </span>
      </div>

      <div className="dialog-section" style={{ marginTop: 12 }}>What it comes to</div>
      <div className="mut t-small" style={{ marginBottom: 6 }}>
        Direct {formatCents(out.directCents)} · response reserve {formatCents(out.reserveCents)}
        {" "}· overhead {formatCents(out.overheadCents)} = <b>{formatCents(out.costCents)}</b> a year to us.
      </div>
      {out.periods.map((p, i) => (
        <div key={p.index} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "3px 0", borderTop: "1px solid var(--line)" }}>
          <span className="mono t-small" style={{ width: 78 }}>CLIN {String(i + 1).padStart(4, "0")}</span>
          <span className="t-body" style={{ flex: 1, minWidth: 0 }}>{p.label}</span>
          <span className="mut t-meta">{windows[i]?.from ? `${windows[i].from} – ${windows[i].to}` : ""}</span>
          <b className="t-body" style={{ width: 100, textAlign: "right" }}>{formatCents(p.priceCents)}</b>
        </div>
      ))}
      {out.line && <div className="t-small" style={{ marginTop: 8 }}>{out.line}</div>}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
        <button className="btn accent" disabled={pending || out.problems.length > 0} onClick={apply}>
          {pending ? "Pricing..." : `Put ${out.periods.length} line${out.periods.length === 1 ? "" : "s"} on the quote`}
        </button>
        <button className="btn" disabled={pending} onClick={() => setOpen(false)}>Close</button>
        {out.problems.length > 0 && (
          <span className="t-small" style={{ color: "var(--t-bad-fg)" }}>{out.problems[0]}</span>
        )}
        {error && <span className="t-small" style={{ color: "var(--t-bad-fg)" }}>{error}</span>}
      </div>
    </Panel>
  );
}

/**
 * What the catalog knew, under the row it filled in.
 *
 * Says what it could NOT answer as loudly as what it could. A model whose
 * procedures carry no time estimate, or whose kit has a part nobody has priced,
 * produces a number that is short - and a bid is exactly the wrong place to
 * find that out later.
 */
function KitNote({ row, share }: { row: SystemRow; share?: number }) {
  if (row.looking) return <div className="mut t-meta">looking it up...</div>;
  if (!row.kit) return null;
  const k = row.kit;
  if (kitIsEmpty(k)) {
    return (
      <div className="mut t-meta">
        Nothing recurring written up for {k.model} yet - type the hours and parts, or add its PM to the catalog.
      </div>
    );
  }
  return (
    <div className="t-meta" style={{ marginTop: 2 }}>
      <span className="mut">
        a year: {k.lines.map((l) => (l.qty > 1 ? `${l.qty} × ${l.name || l.partNumber}` : l.name || l.partNumber)).join(" + ")}
        {k.partsCentsPerYear > 0 ? ` = ${formatCents(k.partsCentsPerYear)}` : ""}
        {k.minutesPerYear > 0 ? ` · ${Math.round((k.minutesPerYear / 60) * 10) / 10}h` : ""}
        {share ? ` · ${formatCents(share)} of travel` : ""}
      </span>
      {k.unpriced.length > 0 && (
        <span style={{ color: "var(--t-warn-fg)" }}> · no price on file for {few(k.unpriced)}</span>
      )}
      {k.untimed.length > 0 && (
        <span style={{ color: "var(--t-warn-fg)" }}> · no time estimate on {few(k.untimed)}</span>
      )}
    </div>
  );
}

/**
 * Three names and a count.
 *
 * A shop whose catalog has never been timed produced a warning naming nine
 * procedures, which wrapped to three lines under every system and buried the
 * one that mattered. The count is the part that decides whether to go and fix
 * the catalog; the names are only there to say which end to start at.
 */
const few = (names: string[]): string =>
  names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
