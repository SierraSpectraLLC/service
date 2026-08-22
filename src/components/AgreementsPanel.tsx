"use client";

import { useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import {
  addAgreement, fileAgreementPaper, listCatalogPartsForPicker, listLibraryFiles,
  removeAgreement, unfileAgreementPaper, updateAgreement, uploadAgreementPapers,
} from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { promptReason } from "@/lib/reason";
import {
  AGREEMENT_KINDS, KIND_LABEL, STANDING_LABEL, STANDING_TONE, allowance, kitStates, parseKits,
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

/**
 * A bar for one entitlement, or nothing at all.
 *
 * Nothing at all is the important case: zero included means the entitlement is
 * not part of this agreement, and drawing an instantly-full bar for it would
 * report every unlimited contract as blown through on day one.
 *
 * Each one is a fixed-width block rather than a share of the row. Growing to
 * fill the card put "Parts" and "$0 used" at opposite ends of a thousand
 * pixels - two words with a field between them, which reads as a gap rather
 * than as a pair. A capped block keeps the label beside its number, and the
 * leftover width simply stays empty.
 */
const BLOCK = { flex: "0 1 210px", minWidth: 150 } as const;

function Bar({ label, included, used, fmt, unlimited = false }: {
  label: string; included: number; used: number; fmt: (n: number) => string; unlimited?: boolean;
}) {
  const a = allowance(included, used, unlimited);
  if (!a.tracked) return null;
  if (a.unlimited) {
    // Covered with no number to burn: usage is information, not drawdown - so
    // the pill sits beside the figure instead of under a bar that isn't there.
    return (
      <div style={BLOCK}>
        <div className="mut" style={{ fontSize: 11, marginBottom: 3 }}>{label}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span className="pill good">unlimited</span>
          <span style={{ fontSize: 11, fontWeight: 700 }}>{fmt(a.used)} used</span>
        </div>
      </div>
    );
  }
  return (
    <div style={BLOCK}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, marginBottom: 3 }}>
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

type LibFile = { id: number; fileName: string; kind: string; size: number };

/**
 * Where the signed paper comes from: your desk, or the shelf.
 *
 * Both, because both happen. The contract whose terms you are typing in is in
 * somebody's downloads folder; the one filed last quarter is already in the
 * library. Offering only the shelf - which is all this used to do - meant
 * abandoning a half-written agreement to go and upload a PDF.
 *
 * The picker only reports what was chosen. Whether that gets filed now or when
 * the form is saved is the caller's business, because on a new agreement there
 * is nothing to file it against yet.
 */
function PaperPicker({ lib, onPick, onFiles, disabled, note }: {
  /** The library, or null while it is still being fetched. */
  lib: LibFile[] | null;
  onPick: (file: LibFile) => void;
  onFiles: (files: File[]) => void;
  disabled: boolean;
  note?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div style={{ marginTop: 4, padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 8, background: "#FAFBFD" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="btn sm primary" disabled={disabled} onClick={() => ref.current?.click()}>
          ⇧ Upload a file
        </button>
        <input ref={ref} type="file" multiple style={{ display: "none" }}
          onChange={(e) => { onFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        {note && <span className="mut" style={{ fontSize: 11 }}>{note}</span>}
      </div>
      <div className="mut" style={{ fontSize: 11, margin: "7px 0 3px" }}>
        {lib === null ? "Loading your library..."
          : lib.length === 0 ? "Nothing else on the shelf yet."
            : "...or pick one already in your library:"}
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {(lib ?? []).slice(0, 40).map((f) => (
          <button key={f.id} type="button" className="btn sm mono" style={{ fontSize: 11 }} disabled={disabled}
            onClick={() => onPick(f)}>{f.fileName}</button>
        ))}
      </div>
    </div>
  );
}

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
  const [lib, setLib] = useState<LibFile[] | null>(null);
  // The paper for an agreement that does not exist yet. Files are HELD, not
  // uploaded: abandoning the form should leave nothing behind in the store.
  const [heldFiles, setHeldFiles] = useState<File[]>([]);
  const [heldLib, setHeldLib] = useState<LibFile[]>([]);
  const [busy, setBusy] = useState("");
  const [pending, startTransition] = useTransition();

  const loadLib = () => {
    if (lib !== null) return;
    startTransition(async () => {
      try { setLib((await listLibraryFiles()).files); } catch { setLib([]); }
    });
  };

  const openFiling = (agreementId: number) => {
    setFiling(filing === agreementId ? null : agreementId);
    setError("");
    loadLib();
  };

  /**
   * Put paper on an agreement that exists. Returns the reason it failed, or ""
   * - the uploads have to finish before the filing, so this is one await for
   * callers rather than a state machine at every call site.
   */
  const attachPaper = async (agreementId: number, files: File[], picked: LibFile[]): Promise<string> => {
    try {
      const done: { fileName: string; url: string; size: number }[] = [];
      for (const f of files) {
        setBusy(`Uploading ${f.name}...`);
        const blob = await upload(f.name, f, { access: "public", handleUploadUrl: "/api/upload" });
        done.push({ fileName: f.name, url: blob.url, size: f.size });
      }
      if (done.length) {
        const res = await uploadAgreementPapers(agreementId, done);
        if (res?.error) return res.error;
      }
      for (const p of picked) {
        const res = await fileAgreementPaper(agreementId, p.id);
        if (res?.error) return res.error;
      }
      // A file just uploaded is on the shelf too, so the picker's list is stale.
      setLib(null);
      return "";
    } catch (e) {
      return (e as Error).message;
    } finally {
      setBusy("");
    }
  };

  const loadBook = () => {
    if (book !== null) return;
    startTransition(async () => {
      try { setBook((await listCatalogPartsForPicker()).parts); } catch { setBook([]); }
    });
  };
  const clearHeld = () => { setHeldFiles([]); setHeldLib([]); };
  const openAdd = (orgId: number) => {
    setDraft(emptyDraft); setError(""); clearHeld(); setSheet({ orgId }); loadBook(); loadLib();
  };
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
    setError(""); clearHeld(); setSheet({ id: r.id, orgId: r.orgId }); loadBook(); loadLib();
  };

  const save = () => {
    if (!sheet) return;
    setError("");
    startTransition(async () => {
      const res = sheet.id
        ? await updateAgreement(sheet.id, draft)
        : await addAgreement(sheet.orgId, draft);
      if (res?.error) { setError(res.error); return; }
      const id = sheet.id ?? (res as { id?: number }).id;
      if (id && (heldFiles.length || heldLib.length)) {
        const why = await attachPaper(id, heldFiles, heldLib);
        if (why) {
          // The terms saved; only the document didn't. Closing the sheet on
          // this would read as "none of that worked", and it would be retyped.
          setError(`Saved - but the document didn't attach: ${why}. Attach it from the row below.`);
          clearHeld();
          return;
        }
      }
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
              <span className={`pill ${STANDING_TONE[s]}`}>{STANDING_LABEL[s]}</span>
              <span className="pill neutral">{KIND_LABEL[r.kind]}</span>
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
                    <PaperPicker
                      lib={lib === null ? null : lib.filter((f) => !papers.some((p) => p.id === f.id))}
                      disabled={pending || !!busy} note={busy}
                      onPick={(f) => startTransition(async () => {
                        const why = await attachPaper(r.id, [], [f]);
                        if (why) { setError(why); return; }
                        setFiling(null);
                      })}
                      onFiles={(files) => startTransition(async () => {
                        const why = await attachPaper(r.id, files, []);
                        if (why) { setError(why); return; }
                        setFiling(null);
                      })} />
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
                    <span key={k.partNumber} title={k.partNumber}
                      className={`pill ${k.over ? "bad" : k.remaining === 0 ? "warn" : "good"}`}>
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
        <Dialog open onClose={() => setSheet(null)} title={sheet.id ? "Edit agreement" : "New agreement"}
          footer={
            <>
              <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
              <button className="btn" onClick={() => setSheet(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending}>
                {busy ? busy : pending ? "Saving..." : "Save agreement"}
              </button>
            </>
          }>

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

            {/* The paper the terms above were read off. Asked for here because
                here is where somebody has it open - sending them to Files to
                upload it first is how a contract ends up with no contract. */}
            <label>The signed agreement <span className="mut" style={{ fontWeight: 400 }}>(optional)</span></label>
            <div style={{ marginBottom: 8 }}>
              {(heldFiles.length > 0 || heldLib.length > 0) && (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
                  {heldFiles.map((f, idx) => (
                    <span key={`f${idx}`} className="pill mono" style={{ background: "#E7F2FA", color: "#1D6396" }}>
                      {f.name}
                      <button type="button" aria-label={`Don't attach ${f.name}`} className="btn link"
                        style={{ fontSize: 12, marginLeft: 4, color: "inherit" }}
                        onClick={() => setHeldFiles(heldFiles.filter((_, i) => i !== idx))}>×</button>
                    </span>
                  ))}
                  {heldLib.map((f) => (
                    <span key={`l${f.id}`} className="pill mono" style={{ background: "#EEF1F5", color: "#475569" }}>
                      {f.fileName}
                      <button type="button" aria-label={`Don't attach ${f.fileName}`} className="btn link"
                        style={{ fontSize: 12, marginLeft: 4, color: "inherit" }}
                        onClick={() => setHeldLib(heldLib.filter((x) => x.id !== f.id))}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <PaperPicker
                lib={lib === null ? null : lib.filter((f) =>
                  !papers.some((p) => p.id === f.id) && !heldLib.some((h) => h.id === f.id))}
                disabled={pending || !!busy} note={busy}
                onPick={(f) => setHeldLib([...heldLib, f])}
                onFiles={(files) => setHeldFiles([...heldFiles, ...files])} />
              <div className="mut" style={{ fontSize: 10.5, marginTop: 3 }}>
                Uploaded when you save, and filed on both this agreement and your document shelf.
              </div>
            </div>

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

        </Dialog>
      )}
    </div>
  );
}
