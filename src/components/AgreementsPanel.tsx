"use client";

import { useState, useTransition } from "react";
import {
  addAgreement, fileAgreementPaper, listCatalogPartsForPicker, listLibraryFiles,
  removeAgreement, unfileAgreementPaper, updateAgreement,
} from "@/app/actions";
import { promptReason } from "@/lib/reason";
import {
  AGREEMENT_KINDS, KIND_LABEL, STANDING_COLOR, STANDING_LABEL, allowance, kitStates, parseKits,
  renewalLine, standing, type IncludedKit, type Standing,
} from "@/lib/agreements";
import { formatCents } from "@/lib/money";
import { formatHours } from "@/lib/hours";

export type AgreementRow = {
  id: number; orgId: number; orgName: string;
  kind: string; number: string; title: string; status: string;
  startsOn: string; endsOn: string; renewNoticeDays: number;
  visitsIncluded: number; partsAllowanceCents: number; laborIncludedMinutes: number;
  visitsUnlimited: boolean; partsUnlimited: boolean; pmPartsIncluded: boolean;
  /** JSON [{partNumber, name, qty}] - what the paper includes in kind. */
  includedKits: string;
  hourlyRateCents: number | null;
  /** Which of the client's systems this paper covers. [] = all of them. */
  instrumentIds: number[];
  valueCents: number | null; note: string;
  /** Summed from the work, never stored - see lib/agreementUsage. */
  used: { partsCents: number; visits: number; laborMinutes: number; pmPartsCents?: number; kitUsed?: Record<string, number> };
};

const emptyDraft = {
  kind: "contract", number: "", title: "", status: "active",
  startsOn: "", endsOn: "", renewNoticeDays: "60",
  visitsIncluded: "0", partsAllowance: "", laborIncludedHours: "",
  visitsUnlimited: false, partsUnlimited: false, pmPartsIncluded: false, hourlyRate: "",
  includedKits: [] as IncludedKit[],
  instrumentIds: [] as number[],
  value: "", note: "",
};

const pill = (c: { bg: string; fg: string }) => ({ background: c.bg, color: c.fg });

/**
 * A bar for one entitlement, or nothing at all.
 *
 * Nothing at all is the important case: zero included means the entitlement is
 * not part of this agreement, and drawing an instantly-full bar for it would
 * report every unlimited contract as blown through on day one.
 */
function Bar({ label, included, used, fmt, unlimited = false }: {
  label: string; included: number; used: number; fmt: (n: number) => string; unlimited?: boolean;
}) {
  const a = allowance(included, used, unlimited);
  if (!a.tracked) return null;
  if (a.unlimited) {
    // Covered with no number to burn: usage is information, not drawdown.
    return (
      <div style={{ flex: "1 1 160px", minWidth: 140 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
          <span className="mut">{label}</span>
          <span style={{ fontWeight: 700 }}>{fmt(a.used)} used</span>
        </div>
        <span className="pill" style={{ background: "#E8F3EC", color: "#2E6B2E" }}>unlimited</span>
      </div>
    );
  }
  return (
    <div style={{ flex: "1 1 160px", minWidth: 140 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
        <span className="mut">{label}</span>
        <span style={{ fontWeight: 700, color: a.over ? "#A32D2D" : "var(--ink)" }}>
          {fmt(a.used)} / {fmt(a.included)}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 99, background: "#EEF1F5", overflow: "hidden" }}>
        <div style={{
          width: `${a.pct}%`, height: "100%",
          background: a.over ? "#A32D2D" : a.pct >= 80 ? "#8A5410" : "#2E6B2E",
        }} />
      </div>
      <div className="mut" style={{ fontSize: 10.5, marginTop: 2 }}>
        {a.over ? `${fmt(-a.remaining)} over` : `${fmt(a.remaining)} left`}
      </div>
    </div>
  );
}

/**
 * The paper behind the work: contracts, POs, quotes, invoices - and how much of
 * each is left.
 *
 * The three bars are summed from the work every time this renders rather than
 * stored, which is the whole design (see lib/agreements). It costs a query; it
 * buys never having to explain why two screens disagree about the same money.
 */
export type AgreementPaper = {
  id: number; agreementId: number; fileName: string; kind: string;
  size: number; uploadedBy: string; when: string;
};

export default function AgreementsPanel({ rows, today, orgs, systems = [], canEdit, papers = [], title = "Agreements" }: {
  rows: AgreementRow[];
  today: string;
  /** The signed documents filed against these agreements. */
  papers?: AgreementPaper[];
  /** Organizations an agreement may be written against. Empty = one org page. */
  orgs: { id: number; name: string }[];
  /** The clients' systems, for assigning a contract to specific ones. */
  systems?: { id: number; ownerOrgId: number | null; externalId: string; label: string }[];
  canEdit: boolean;
  title?: string;
}) {
  const [sheet, setSheet] = useState<null | { id?: number; orgId: number }>(null);
  // The parts book, for naming an included kit instead of typing its number.
  const [book, setBook] = useState<{ partNumber: string; name: string; kind: string }[] | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState("");
  // Which agreement is having a document filed against it, and the library to
  // pick from - fetched once, on demand.
  const [filing, setFiling] = useState<number | null>(null);
  const [lib, setLib] = useState<{ id: number; fileName: string; kind: string; size: number }[] | null>(null);
  const [pending, startTransition] = useTransition();

  const openFiling = (agreementId: number) => {
    setFiling(filing === agreementId ? null : agreementId);
    setError("");
    if (lib === null) {
      startTransition(async () => {
        try { setLib((await listLibraryFiles()).files); } catch { setLib([]); }
      });
    }
  };

  const loadBook = () => {
    if (book !== null) return;
    startTransition(async () => {
      try { setBook((await listCatalogPartsForPicker()).parts); } catch { setBook([]); }
    });
  };
  const openAdd = (orgId: number) => { setDraft(emptyDraft); setError(""); setSheet({ orgId }); loadBook(); };
  const openEdit = (r: AgreementRow) => {
    setDraft({
      kind: r.kind, number: r.number, title: r.title, status: r.status,
      startsOn: r.startsOn, endsOn: r.endsOn, renewNoticeDays: String(r.renewNoticeDays),
      visitsIncluded: String(r.visitsIncluded),
      partsAllowance: r.partsAllowanceCents ? (r.partsAllowanceCents / 100).toFixed(2) : "",
      laborIncludedHours: r.laborIncludedMinutes ? (r.laborIncludedMinutes / 60).toFixed(1) : "",
      visitsUnlimited: r.visitsUnlimited, partsUnlimited: r.partsUnlimited,
      pmPartsIncluded: r.pmPartsIncluded,
      includedKits: parseKits(r.includedKits),
      hourlyRate: r.hourlyRateCents != null ? (r.hourlyRateCents / 100).toFixed(2) : "",
      instrumentIds: [...r.instrumentIds],
      value: r.valueCents != null ? (r.valueCents / 100).toFixed(2) : "",
      note: r.note,
    });
    setError(""); setSheet({ id: r.id, orgId: r.orgId }); loadBook();
  };

  const save = () => {
    if (!sheet) return;
    setError("");
    startTransition(async () => {
      const res = sheet.id
        ? await updateAgreement(sheet.id, draft)
        : await addAgreement(sheet.orgId, draft);
      if (res?.error) { setError(res.error); return; }
      setSheet(null);
    });
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <div className="card-title">{title}</div>
        {canEdit && orgs.length === 1 && (
          <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => openAdd(orgs[0].id)}>
            ＋ Agreement
          </button>
        )}
      </div>

      {rows.map((r) => {
        const s: Standing = standing(r, today);
        return (
          <div key={r.id} style={{
            border: "1px solid var(--line)", borderRadius: 10, padding: "9px 11px", marginBottom: 8,
            borderLeft: s === "expired" ? "3px solid #A32D2D" : s === "expiring" ? "3px solid #8A5410" : undefined,
          }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>
                {[r.number, r.title].filter(Boolean).join(" ") || KIND_LABEL[r.kind]}
              </span>
              <span className="pill" style={pill(STANDING_COLOR[s])}>{STANDING_LABEL[s]}</span>
              <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>{KIND_LABEL[r.kind]}</span>
              {orgs.length !== 1 && <span className="mut" style={{ fontSize: 12 }}>{r.orgName}</span>}
              {r.valueCents != null && (
                <span className="mono" style={{ fontSize: 11, color: "var(--slate)" }}
                  title="Contract value">{formatCents(r.valueCents)}</span>
              )}
              {r.hourlyRateCents != null && (
                <span className="mono" style={{ fontSize: 11, color: "var(--slate)" }}
                  title="Hourly rate">{formatCents(r.hourlyRateCents)}/hr</span>
              )}
              {canEdit && (
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button className="btn link" style={{ fontSize: 11 }} onClick={() => openEdit(r)}>edit</button>
                  <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                    onClick={() => {
                      const why = promptReason(`Remove ${r.number || KIND_LABEL[r.kind]}?`);
                      if (why === null) return;
                      startTransition(async () => {
                        const res = await removeAgreement(r.id, why);
                        if (res?.error) setError(res.error);
                      });
                    }}>remove</button>
                </span>
              )}
            </div>
            <div className="mut" style={{ fontSize: 11.5, marginTop: 2 }}>{renewalLine(r, today)}</div>

            {/* The signed paper itself, beside the terms it contains. */}
            {(() => {
              const mine = papers.filter((p) => p.agreementId === r.id);
              if (!mine.length && !canEdit) return null;
              return (
                <div style={{ marginTop: 4 }}>
                  {mine.map((pp) => (
                    <div key={pp.id} style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap", fontSize: 11.5 }}>
                      <a href={`/api/files/${pp.id}`} target="_blank" rel="noreferrer" className="mono">{pp.fileName}</a>
                      <span className="mut">{pp.kind} · {pp.uploadedBy} · {pp.when}</span>
                      {canEdit && (
                        <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                          title="Unfile it - the document stays in your library"
                          onClick={() => startTransition(async () => {
                            const res = await unfileAgreementPaper(pp.id);
                            if (res?.error) setError(res.error);
                          })}>unfile</button>
                      )}
                    </div>
                  ))}
                  {canEdit && (
                    <button className="btn link" style={{ fontSize: 11 }} onClick={() => openFiling(r.id)}>
                      {filing === r.id ? "cancel" : mine.length ? "+ another document" : "+ attach the signed agreement"}
                    </button>
                  )}
                  {canEdit && filing === r.id && (
                    <div style={{ marginTop: 4, padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 8, background: "#FAFBFD" }}>
                      {lib === null && <span className="mut" style={{ fontSize: 11 }}>Loading your files...</span>}
                      {lib?.length === 0 && (
                        <span className="mut" style={{ fontSize: 11 }}>
                          Nothing in your library yet - upload it under Files first, then file it here.
                        </span>
                      )}
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {(lib ?? []).filter((f) => !papers.some((p) => p.id === f.id)).slice(0, 40).map((f) => (
                          <button key={f.id} className="btn sm mono" style={{ fontSize: 11 }} disabled={pending}
                            onClick={() => startTransition(async () => {
                              const res = await fileAgreementPaper(r.id, f.id);
                              if (res?.error) { setError(res.error); return; }
                              setFiling(null);
                            })}>{f.fileName}</button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
            {/* Which systems the paper covers. Silence would read as "all of
                them", which is true only when nothing is assigned. */}
            {r.instrumentIds.length > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                <span className="mut" style={{ fontSize: 11 }}>covers</span>
                {r.instrumentIds.map((id) => {
                  const sys = systems.find((s2) => s2.id === id);
                  return (
                    <span key={id} className="pill mono" style={{ background: "#E7F2FA", color: "#1D6396" }}>
                      {sys?.externalId ?? `#${id}`}
                    </span>
                  );
                })}
              </div>
            )}

            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8 }}>
              <Bar label="Parts" included={r.partsAllowanceCents} used={r.used.partsCents} fmt={formatCents}
                unlimited={r.partsUnlimited} />
              <Bar label="Visits" included={r.visitsIncluded} used={r.used.visits} fmt={(n) => String(n)}
                unlimited={r.visitsUnlimited} />
              <Bar label="Labour hours" included={r.laborIncludedMinutes} used={r.used.laborMinutes} fmt={formatHours} />
            </div>
            {/* What the paper includes in kind, and how much of it is left. */}
            {(() => {
              const states = kitStates(parseKits(r.includedKits), r.used.kitUsed ?? {});
              if (!states.length) return null;
              return (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                  {states.map((k) => (
                    <span key={k.partNumber} className="pill" title={k.partNumber}
                      style={{
                        background: k.over ? "#FBE9E9" : k.remaining === 0 ? "#FAF0DC" : "#E8F3EC",
                        color: k.over ? "#A32D2D" : k.remaining === 0 ? "#8A5410" : "#2E6B2E",
                      }}>
                      🧰 {k.name || k.partNumber} {k.used}/{k.qty}
                      {k.over ? ` · ${k.used - k.qty} billable` : ""}
                    </span>
                  ))}
                </div>
              );
            })()}

            {/* Reported, never hidden: the money was really spent, the client
                just isn't being charged for it out of this allowance. */}
            {r.pmPartsIncluded && (r.used.pmPartsCents ?? 0) > 0 && (
              <div className="mut" style={{ fontSize: 11, marginTop: 6 }}>
                Plus {formatCents(r.used.pmPartsCents ?? 0)} in PM parts, covered by the contract.
              </div>
            )}
            {r.note && <div className="mut" style={{ fontSize: 11.5, marginTop: 6, whiteSpace: "pre-wrap" }}>{r.note}</div>}
          </div>
        );
      })}

      {rows.length === 0 && (
        <div className="mut" style={{ fontSize: 13 }}>
          Nothing on file. An agreement is what a renewal date, a visit count and a parts
          allowance hang off - and what makes those numbers answerable on the phone.
        </div>
      )}

      {sheet && (
        <>
          <div className="scrim" onClick={() => setSheet(null)} />
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Agreement">
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy)", marginBottom: 10 }}>
              {sheet.id ? "Edit" : "New"} agreement
            </div>

            <div className="seg" role="group" aria-label="Kind" style={{ marginBottom: 8 }}>
              {AGREEMENT_KINDS.map((k) => (
                <button key={k} type="button" aria-pressed={draft.kind === k}
                  onClick={() => setDraft({ ...draft, kind: k })}>{KIND_LABEL[k]}</button>
              ))}
            </div>

            <div className="pf2" style={{ marginBottom: 8 }}>
              <div>
                <label>Number</label>
                <input className="mono" value={draft.number} placeholder="PO-4417"
                  onChange={(e) => setDraft({ ...draft, number: e.target.value })} />
              </div>
              <div>
                <label>Status</label>
                <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            </div>

            <label>What it covers</label>
            <input value={draft.title} placeholder="Annual service contract - 4 systems"
              onChange={(e) => setDraft({ ...draft, title: e.target.value })} style={{ marginBottom: 8 }} />

            <div className="pf2" style={{ marginBottom: 8 }}>
              <div>
                <label>Starts</label>
                <input type="date" value={draft.startsOn}
                  onChange={(e) => setDraft({ ...draft, startsOn: e.target.value })} />
              </div>
              <div>
                <label>Ends</label>
                <input type="date" value={draft.endsOn}
                  onChange={(e) => setDraft({ ...draft, endsOn: e.target.value })} />
              </div>
            </div>

            <label>Tell me this many days before it ends</label>
            <input type="number" min={0} max={3650} value={draft.renewNoticeDays} style={{ marginBottom: 8 }}
              onChange={(e) => setDraft({ ...draft, renewNoticeDays: e.target.value })} />

            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2 }}>What it includes</div>
            <div className="mut" style={{ fontSize: 11, marginBottom: 6 }}>
              Leave one blank when it is not part of this agreement. Blank means untracked,
              not zero - an unlimited contract and a nothing-included one are different things.
            </div>
            <div className="pf2" style={{ marginBottom: 8 }}>
              <div>
                <label>Parts allowance ($)</label>
                <input value={draft.partsAllowance} placeholder="5000" disabled={draft.partsUnlimited}
                  onChange={(e) => setDraft({ ...draft, partsAllowance: e.target.value })} />
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, margin: "5px 0 0", fontWeight: 400, color: "var(--ink)" }}>
                  <input type="checkbox" checked={draft.partsUnlimited} style={{ width: 15, height: 15 }}
                    onChange={(e) => setDraft({ ...draft, partsUnlimited: e.target.checked })} />
                  Unlimited - parts are covered, spend isn&apos;t tracked against a cap
                </label>
                {/* The PM's own parts are part of the PM. Without this, an
                    included PM's kit gets billed twice - once in the PM, once
                    out of the allowance. */}
                <label style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12, margin: "5px 0 0", fontWeight: 400, color: "var(--ink)" }}>
                  <input type="checkbox" checked={draft.pmPartsIncluded} style={{ width: 15, height: 15, marginTop: 2 }}
                    onChange={(e) => setDraft({ ...draft, pmPartsIncluded: e.target.checked })} />
                  <span>
                    PM parts are included
                    <span className="mut" style={{ display: "block", fontSize: 10.5 }}>
                      Parts fitted on an included PM are reported but never drawn from this allowance.
                    </span>
                  </span>
                </label>
              </div>
              <div>
                <label>Service visits</label>
                <input type="number" min={0} value={draft.visitsIncluded} disabled={draft.visitsUnlimited}
                  onChange={(e) => setDraft({ ...draft, visitsIncluded: e.target.value })} />
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, margin: "5px 0 0", fontWeight: 400, color: "var(--ink)" }}>
                  <input type="checkbox" checked={draft.visitsUnlimited} style={{ width: 15, height: 15 }}
                    onChange={(e) => setDraft({ ...draft, visitsUnlimited: e.target.checked })} />
                  Unlimited visits
                </label>
              </div>
            </div>
            {/* What the paper includes IN KIND. A PM contract is sold as
                "two PMs, each with its kit", so this is the entitlement -
                counted, not costed, and not a dollar figure that goes stale
                when a kit's price moves. */}
            <label>PM kits included</label>
            <div style={{ marginBottom: 8 }}>
              {draft.includedKits.map((k, idx) => (
                <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                  <input type="number" min={1} value={k.qty} aria-label="How many"
                    onChange={(e) => setDraft({ ...draft, includedKits: draft.includedKits.map((x, i) =>
                      (i === idx ? { ...x, qty: parseInt(e.target.value) || 1 } : x)) })}
                    style={{ width: 62, fontSize: 12 }} />
                  <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{k.partNumber}</span>
                  <span className="mut" style={{ fontSize: 11, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.name}</span>
                  <button className="btn link" aria-label={`Remove ${k.partNumber}`} style={{ marginLeft: "auto", color: "#A32D2D", fontSize: 13 }}
                    onClick={() => setDraft({ ...draft, includedKits: draft.includedKits.filter((_, i) => i !== idx) })}>×</button>
                </div>
              ))}
              <select value="" aria-label="Add an included kit"
                onChange={(e) => {
                  const hit = (book ?? []).find((b) => b.partNumber === e.target.value);
                  if (!hit) return;
                  if (draft.includedKits.some((k) => k.partNumber.toLowerCase() === hit.partNumber.toLowerCase())) return;
                  setDraft({ ...draft, includedKits: [...draft.includedKits, { partNumber: hit.partNumber, name: hit.name, qty: 1 }] });
                }}
                style={{ fontSize: 12 }}>
                <option value="">＋ Add a kit from the parts book...</option>
                {(book ?? []).map((b) => (
                  <option key={b.partNumber} value={b.partNumber}>
                    {b.kind === "kit" ? "🧰 " : ""}{b.partNumber}{b.name ? ` - ${b.name}` : ""}
                  </option>
                ))}
              </select>
              <div className="mut" style={{ fontSize: 10.5, marginTop: 3 }}>
                Fitting one of these draws down its count instead of the money above. Past the
                included quantity, extras bill as ordinary parts.
              </div>
            </div>

            <div className="pf2" style={{ marginBottom: 8 }}>
              <div>
                <label>Labour hours included</label>
                <input value={draft.laborIncludedHours} placeholder="40"
                  onChange={(e) => setDraft({ ...draft, laborIncludedHours: e.target.value })} />
                <div className="mut" style={{ fontSize: 10.5, marginTop: 3 }}>
                  Hours of work the contract includes; logged time draws it down.
                </div>
              </div>
              <div>
                <label>Hourly rate ($/hr)</label>
                <input value={draft.hourlyRate} placeholder="150"
                  onChange={(e) => setDraft({ ...draft, hourlyRate: e.target.value })} />
                <div className="mut" style={{ fontSize: 10.5, marginTop: 3 }}>
                  What an hour beyond the included ones bills at.
                </div>
              </div>
            </div>
            <label>Contract value ($)</label>
            <input value={draft.value} placeholder="18000" style={{ marginBottom: 8 }}
              onChange={(e) => setDraft({ ...draft, value: e.target.value })} />

            {/* Which systems this paper covers. The client with a full-service
                contract on the TOC and a PM-only one on the UV-Vis assigns each
                system to its contract; none selected = the whole fleet. */}
            {(() => {
              const theirs = systems.filter((s2) => s2.ownerOrgId === sheet.orgId);
              if (theirs.length === 0) return null;
              return (
                <div style={{ marginBottom: 8 }}>
                  <label>Systems it covers <span className="mut" style={{ fontWeight: 400 }}>(none = all of theirs)</span></label>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {theirs.map((s2) => {
                      const on = draft.instrumentIds.includes(s2.id);
                      return (
                        <button key={s2.id} type="button" className={on ? "btn sm primary" : "btn sm"}
                          style={{ fontSize: 11 }} title={s2.label}
                          onClick={() => setDraft({
                            ...draft,
                            instrumentIds: on ? draft.instrumentIds.filter((x) => x !== s2.id) : [...draft.instrumentIds, s2.id],
                          })}>
                          {s2.externalId}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            <label>Note</label>
            <textarea value={draft.note} rows={3} style={{ width: "100%", marginBottom: 8 }}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })} />

            {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 4 }}>{error}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
              <button className="btn sm" onClick={() => setSheet(null)} disabled={pending}>Cancel</button>
              <button className="btn sm accent" onClick={save} disabled={pending}>
                {pending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
