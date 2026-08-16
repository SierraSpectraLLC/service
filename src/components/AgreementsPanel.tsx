"use client";

import { useState, useTransition } from "react";
import { addAgreement, removeAgreement, updateAgreement } from "@/app/actions";
import { promptReason } from "@/lib/reason";
import {
  AGREEMENT_KINDS, KIND_LABEL, STANDING_COLOR, STANDING_LABEL, allowance, renewalLine, standing,
  type Standing,
} from "@/lib/agreements";
import { formatCents } from "@/lib/money";
import { formatHours } from "@/lib/hours";

export type AgreementRow = {
  id: number; orgId: number; orgName: string;
  kind: string; number: string; title: string; status: string;
  startsOn: string; endsOn: string; renewNoticeDays: number;
  visitsIncluded: number; partsAllowanceCents: number; laborIncludedMinutes: number;
  valueCents: number | null; note: string;
  /** Summed from the work, never stored - see lib/agreementUsage. */
  used: { partsCents: number; visits: number; laborMinutes: number };
};

const emptyDraft = {
  kind: "contract", number: "", title: "", status: "active",
  startsOn: "", endsOn: "", renewNoticeDays: "60",
  visitsIncluded: "0", partsAllowance: "", laborIncludedHours: "", value: "", note: "",
};

const pill = (c: { bg: string; fg: string }) => ({ background: c.bg, color: c.fg });

/**
 * A bar for one entitlement, or nothing at all.
 *
 * Nothing at all is the important case: zero included means the entitlement is
 * not part of this agreement, and drawing an instantly-full bar for it would
 * report every unlimited contract as blown through on day one.
 */
function Bar({ label, included, used, fmt }: {
  label: string; included: number; used: number; fmt: (n: number) => string;
}) {
  const a = allowance(included, used);
  if (!a.tracked) return null;
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
export default function AgreementsPanel({ rows, today, orgs, canEdit, title = "Agreements" }: {
  rows: AgreementRow[];
  today: string;
  /** Organizations an agreement may be written against. Empty = one org page. */
  orgs: { id: number; name: string }[];
  canEdit: boolean;
  title?: string;
}) {
  const [sheet, setSheet] = useState<null | { id?: number; orgId: number }>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const openAdd = (orgId: number) => { setDraft(emptyDraft); setError(""); setSheet({ orgId }); };
  const openEdit = (r: AgreementRow) => {
    setDraft({
      kind: r.kind, number: r.number, title: r.title, status: r.status,
      startsOn: r.startsOn, endsOn: r.endsOn, renewNoticeDays: String(r.renewNoticeDays),
      visitsIncluded: String(r.visitsIncluded),
      partsAllowance: r.partsAllowanceCents ? (r.partsAllowanceCents / 100).toFixed(2) : "",
      laborIncludedHours: r.laborIncludedMinutes ? (r.laborIncludedMinutes / 60).toFixed(1) : "",
      value: r.valueCents != null ? (r.valueCents / 100).toFixed(2) : "",
      note: r.note,
    });
    setError(""); setSheet({ id: r.id, orgId: r.orgId });
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
                <span className="mono" style={{ fontSize: 11, color: "var(--slate)" }}>{formatCents(r.valueCents)}</span>
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

            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8 }}>
              <Bar label="Parts" included={r.partsAllowanceCents} used={r.used.partsCents} fmt={formatCents} />
              <Bar label="Visits" included={r.visitsIncluded} used={r.used.visits} fmt={(n) => String(n)} />
              <Bar label="Labour" included={r.laborIncludedMinutes} used={r.used.laborMinutes} fmt={formatHours} />
            </div>
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
                <label>Parts allowance</label>
                <input value={draft.partsAllowance} placeholder="5000"
                  onChange={(e) => setDraft({ ...draft, partsAllowance: e.target.value })} />
              </div>
              <div>
                <label>Visits</label>
                <input type="number" min={0} value={draft.visitsIncluded}
                  onChange={(e) => setDraft({ ...draft, visitsIncluded: e.target.value })} />
              </div>
            </div>
            <div className="pf2" style={{ marginBottom: 8 }}>
              <div>
                <label>Labour hours</label>
                <input value={draft.laborIncludedHours} placeholder="40"
                  onChange={(e) => setDraft({ ...draft, laborIncludedHours: e.target.value })} />
              </div>
              <div>
                <label>What the paper is worth</label>
                <input value={draft.value} placeholder="18000"
                  onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
              </div>
            </div>

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
