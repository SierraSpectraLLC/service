"use client";

import { useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import {
  addAgreement, fileAgreementPaper, listCatalogPartsForPicker, listLibraryFiles,
  removeAgreement, unfileAgreementPaper, updateAgreement, uploadAgreementPapers,
} from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import {
  AGREEMENT_KINDS, KIND_LABEL, STANDING_LABEL, STANDING_TONE, allowance, kitStates, parseKits,
  shapeOf,
  renewalLine, standing, type IncludedKit, type Standing,
} from "@/lib/agreements";
import { formatCents } from "@/lib/money";
import { formatHours } from "@/lib/hours";

export type AgreementRow = {
  id: number; orgId: number; orgName: string;
  kind: string; number: string; title: string; status: string;
  startsOn: string; endsOn: string; renewNoticeDays: number;
  visitsIncluded: number; partsAllowanceCents: number; laborIncludedMinutes: number;
  visitsUnlimited: boolean; partsUnlimited: boolean; laborUnlimited: boolean; pmPartsIncluded: boolean;
  /** JSON [{partNumber, name, qty}] - what the paper includes in kind. */
  includedKits: string;
  hourlyRateCents: number | null;
  /** Who provides it. Null is us - see agreements.provider_org_id. */
  providerName: string | null;
  /** Which of the client's systems this paper covers. [] = all of them. */
  instrumentIds: number[];
  valueCents: number | null; note: string;
  /** Summed from the work, never stored - see lib/agreementUsage. */
  used: { partsCents: number; visits: number; laborMinutes: number; pmPartsCents?: number; kitUsed?: Record<string, number> };
};

const emptyDraft = {
  kind: "contract", number: "", title: "", status: "active",
  // Blank means us. See agreements.provider_org_id: naming a third party is
  // what turns a row from "what we owe them" into "what somebody else does".
  providerName: "",
  startsOn: "", endsOn: "", renewNoticeDays: "60",
  visitsIncluded: "0", partsAllowance: "", laborIncludedHours: "",
  visitsUnlimited: false, partsUnlimited: false, laborUnlimited: false, pmPartsIncluded: false, hourlyRate: "",
  includedKits: [] as IncludedKit[],
  instrumentIds: [] as number[],
  value: "", note: "",
};

type Draft = typeof emptyDraft;

/**
 * The dialog's step rail, in body order.
 *
 * The "included" step wears the kind's own heading - "What's included" on a
 * contract, "Amount" on the three kinds that have a figure and no
 * entitlements. See lib/agreements.AGREEMENT_SHAPE, which is the one place
 * that says what each kind of paper has.
 */
type StepKey = "terms" | "paper" | "included" | "coverage" | "note";
const stepLabels = (kind: string): Record<StepKey, string> => ({
  terms: "Terms", paper: "The paper", included: shapeOf(kind).amountSection,
  coverage: "Coverage", note: "Note",
});

/** Filled with something that isn't a number. Blank is fine - blank means untracked. */
const badNumber = (v: string) => v.trim() !== "" && !Number.isFinite(Number(v.trim()));

/** The numeric fields, in the order the problem chain reports them. */
const NUMERIC_FIELDS: {
  key: "partsAllowance" | "visitsIncluded" | "laborIncludedHours" | "hourlyRate" | "value" | "renewNoticeDays";
  label: string; step: StepKey;
  /** Only asked for on kinds that have it - entitlements, or a renewal. */
  needs?: "entitlements" | "renewal";
}[] = [
  { key: "partsAllowance", label: "Parts allowance", step: "included", needs: "entitlements" },
  { key: "visitsIncluded", label: "Service visits", step: "included", needs: "entitlements" },
  { key: "laborIncludedHours", label: "Labor hours included", step: "included", needs: "entitlements" },
  { key: "hourlyRate", label: "Hourly rate", step: "included", needs: "entitlements" },
  { key: "value", label: "Amount", step: "included" },
  { key: "renewNoticeDays", label: "Renewal notice days", step: "terms", needs: "renewal" },
];

/**
 * Which numeric fields this kind is actually asked for.
 *
 * The gate matters as much as the rendering: a draft that was a contract and
 * is now a quote still carries whatever was typed into the boxes the quote no
 * longer shows, and validating those would refuse to save over a field nobody
 * can see to fix.
 */
const asked = (d: Draft) => {
  const shape = shapeOf(d.kind);
  return NUMERIC_FIELDS.filter((f) => !f.needs || shape[f.needs]);
};

/**
 * The first reason this draft can't save, or null. One sentence at a time, in
 * the order the form reads, so the footer names the next thing to fix rather
 * than a pile of everything wrong at once.
 */
function firstProblem(d: Draft): string | null {
  if (!d.number.trim()) return "give it a number";
  if (!d.title.trim()) return "say what it covers";
  if (d.startsOn && d.endsOn && d.endsOn < d.startsOn) return "the end date is before the start";
  for (const f of asked(d)) {
    if (badNumber(d[f.key])) {
      return `${f.key === "value" ? shapeOf(d.kind).amountLabel.replace(" ($)", "") : f.label} must be a number`;
    }
  }
  if (!shapeOf(d.kind).entitlements) return null;
  if (d.partsAllowance.trim() !== "" && d.partsUnlimited) return "parts are marked unlimited and capped at once";
  if (d.laborIncludedHours.trim() !== "" && d.laborUnlimited) return "labor is marked unlimited and capped at once";
  return null;
}

/** The same checks, scoped to one step, for the rail's warn marks. */
function stepProblem(step: StepKey, d: Draft): boolean {
  const shape = shapeOf(d.kind);
  if (step === "terms") {
    return !d.number.trim() || !d.title.trim()
      || !!(d.startsOn && d.endsOn && d.endsOn < d.startsOn)
      || (shape.renewal && badNumber(d.renewNoticeDays));
  }
  if (step === "included") {
    return asked(d).some((f) => f.step === "included" && badNumber(d[f.key]))
      || (shape.entitlements && d.partsAllowance.trim() !== "" && d.partsUnlimited)
      || (shape.entitlements && d.laborIncludedHours.trim() !== "" && d.laborUnlimited);
  }
  return false; // paper, coverage and note have nothing to get wrong
}

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
        <div className="mut t-meta" style={{ marginBottom: 3 }}>{label}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span className="pill good">unlimited</span>
          <span className="t-meta" style={{ fontWeight: 700 }}>{fmt(a.used)} used</span>
        </div>
      </div>
    );
  }
  return (
    <div style={BLOCK}>
      <div className="t-meta" style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 3 }}>
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
      <div className="mut" style={{ fontSize: 11, marginTop: 2 }}>
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
        {note && <span className="mut t-meta">{note}</span>}
      </div>
      <div className="mut t-meta" style={{ margin: "7px 0 3px" }}>
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

export default function AgreementsPanel({
  rows, today, orgs, systems = [], canEdit, papers = [], title = "Agreements", extra,
  operatorName,
}: {
  rows: AgreementRow[];
  today: string;
  /** The signed documents filed against these agreements. */
  papers?: AgreementPaper[];
  /** Organizations an agreement may be written against. Empty = one org page. */
  orgs: { id: number; name: string }[];
  /** The clients' systems, for assigning a contract to specific ones. */
  systems?: { id: number; ownerOrgId: number | null; externalId: string; label: string }[];
  canEdit: boolean;
  /** What to call ourselves - the default provider on every row. */
  operatorName: string;
  title?: string;
  /** One quiet line per agreement id - a renewal figure, a billing note. */
  extra?: Record<number, string>;
}) {
  const [sheet, setSheet] = useState<null | { id?: number; orgId: number }>(null);
  // The parts catalog, for naming an included kit instead of typing its number.
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
  // The step rail: which section the rail highlights, which steps have been
  // touched (so an untouched optional section doesn't claim to be done), and
  // where each section starts, for the click-to-scroll.
  const [activeStep, setActiveStep] = useState<StepKey>("terms");
  const [touched, setTouched] = useState<Set<StepKey>>(new Set());
  const sectionRefs = useRef<Partial<Record<StepKey, HTMLDivElement | null>>>({});

  const touch = (s: StepKey) =>
    setTouched((prev) => (prev.has(s) ? prev : new Set(prev).add(s)));

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
  const resetSteps = () => { setActiveStep("terms"); setTouched(new Set()); };
  const openAdd = (orgId: number) => {
    setDraft(emptyDraft); setError(""); clearHeld(); resetSteps(); setSheet({ orgId }); loadBook(); loadLib();
  };
  const openEdit = (r: AgreementRow) => {
    setDraft({
      kind: r.kind, number: r.number, title: r.title, status: r.status,
      providerName: r.providerName ?? "",
      startsOn: r.startsOn, endsOn: r.endsOn, renewNoticeDays: String(r.renewNoticeDays),
      visitsIncluded: String(r.visitsIncluded),
      partsAllowance: r.partsAllowanceCents ? (r.partsAllowanceCents / 100).toFixed(2) : "",
      laborIncludedHours: r.laborIncludedMinutes ? (r.laborIncludedMinutes / 60).toFixed(1) : "",
      visitsUnlimited: r.visitsUnlimited, partsUnlimited: r.partsUnlimited,
      laborUnlimited: r.laborUnlimited,
      pmPartsIncluded: r.pmPartsIncluded,
      includedKits: parseKits(r.includedKits),
      hourlyRate: r.hourlyRateCents != null ? (r.hourlyRateCents / 100).toFixed(2) : "",
      instrumentIds: [...r.instrumentIds],
      value: r.valueCents != null ? (r.valueCents / 100).toFixed(2) : "",
      note: r.note,
    });
    setError(""); clearHeld(); resetSteps(); setSheet({ id: r.id, orgId: r.orgId }); loadBook(); loadLib();
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
      toast({ message: sheet.id ? `Saved ${draft.number || "the agreement"}` : `Added ${draft.number || "an agreement"}` });
      setSheet(null);
    });
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <div className="card-title">{title}</div>
        {canEdit && orgs.length > 0 && (
          <button className="btn sm primary" style={{ marginLeft: "auto" }}
            onClick={() => openAdd(orgs.length === 1 ? orgs[0].id : 0)}>
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
              <span className="t-body" style={{ fontWeight: 700 }}>
                {[r.number, r.title].filter(Boolean).join(" ") || KIND_LABEL[r.kind]}
              </span>
              <span className={`pill ${STANDING_TONE[s]}`}>{STANDING_LABEL[s]}</span>
              <span className="pill neutral">{KIND_LABEL[r.kind]}</span>
              {/* Whose paper. Only when it is not ours: every row on this
                  screen used to be ours and most still are, so a pill on all
                  of them would say nothing. */}
              {r.providerName !== null && <span className="pill info">{r.providerName}</span>}
              {orgs.length !== 1 && <span className="mut t-small">{r.orgName}</span>}
              {r.valueCents != null && (
                <span className="mono t-meta" style={{ color: "var(--slate)" }}
                  title="Contract value">{formatCents(r.valueCents)}</span>
              )}
              {r.hourlyRateCents != null && (
                <span className="mono t-meta" style={{ color: "var(--slate)" }}
                  title="Hourly rate">{formatCents(r.hourlyRateCents)}/hr</span>
              )}
              {canEdit && (
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button className="btn link" onClick={() => openEdit(r)}>edit</button>
                  <button className="btn link" disabled={pending}
                    onClick={async () => {
                      const why = await confirmReason({
                        title: `Remove ${r.number || KIND_LABEL[r.kind]}?`,
                        body: "The removal is kept in the audit history.",
                        action: "Remove", tone: "bad",
                      });
                      if (why === null) return;
                      startTransition(async () => {
                        const res = await removeAgreement(r.id, why);
                        if (res?.error) setError(res.error);
                        else toast({ message: `Removed ${r.number || KIND_LABEL[r.kind]}` });
                      });
                    }}>remove</button>
                </span>
              )}
            </div>
            <div className="mut" style={{ fontSize: 12, marginTop: 2 }}>{renewalLine(r, today)}</div>
            {extra?.[r.id] && <div className="mut" style={{ fontSize: 12, marginTop: 2 }}>{extra[r.id]}</div>}

            {/* The signed paper itself, beside the terms it contains. */}
            {(() => {
              const mine = papers.filter((p) => p.agreementId === r.id);
              if (!mine.length && !canEdit) return null;
              return (
                <div style={{ marginTop: 4 }}>
                  {mine.map((pp) => (
                    <div key={pp.id} style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap", fontSize: 12 }}>
                      <a href={`/api/files/${pp.id}`} target="_blank" rel="noreferrer" className="mono">{pp.fileName}</a>
                      <span className="mut">{pp.kind} · {pp.uploadedBy} · {pp.when}</span>
                      {canEdit && (
                        <button className="btn link" disabled={pending}
                          title="Unfile it - the document stays in your library"
                          onClick={() => startTransition(async () => {
                            const res = await unfileAgreementPaper(pp.id);
                            if (res?.error) setError(res.error);
                          })}>unfile</button>
                      )}
                    </div>
                  ))}
                  {canEdit && (
                    <button className="btn link" onClick={() => openFiling(r.id)}>
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
                        toast({ message: `Filed ${f.fileName} against ${r.number || r.title || "the agreement"}` });
                      })}
                      onFiles={(files) => startTransition(async () => {
                        const why = await attachPaper(r.id, files, []);
                        if (why) { setError(why); return; }
                        setFiling(null);
                        toast({ message: `Filed ${files.length === 1 ? files[0].name : `${files.length} documents`} against ${r.number || r.title || "the agreement"}` });
                      })} />
                  )}
                </div>
              );
            })()}
            {/* Which systems the paper covers. Silence would read as "all of
                them", which is true only when nothing is assigned. */}
            {r.instrumentIds.length > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                <span className="mut t-meta">covers</span>
                {r.instrumentIds.map((id) => {
                  const sys = systems.find((s2) => s2.id === id);
                  return (
                    <span key={id} className="pill mono" style={{ background: "#E7F2FA", color: "var(--t-info-fg)" }}>
                      {sys?.externalId ?? `#${id}`}
                    </span>
                  );
                })}
              </div>
            )}

            {/* No drawdown on somebody else's paper. Every figure in these
                bars is summed from work THIS workspace recorded, so on a
                manufacturer's contract they are all zero - and "0 of 8 visits
                used" would read as eight visits still in hand rather than as
                a number we are in no position to know. What it entitles them
                to still shows above; only the burn is withheld. */}
            {/* Drawdown is a contract's. A PO, a quote and an invoice have no
                entitlements to burn - and a row written before the form stopped
                asking may still carry numbers in those columns, so the gate is
                on the KIND rather than on whether the columns happen to be
                zero. Nothing reads them either way: both coverage sites in
                lib/invoiceData test kind === "contract". */}
            {!shapeOf(r.kind).entitlements ? null : r.providerName !== null ? (
              <div className="mut t-small" style={{ marginTop: 8 }}>
                Held by {r.providerName}. What has been used against it is theirs to
                report — nothing here draws it down.
              </div>
            ) : (
            <>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8 }}>
              <Bar label="Parts" included={r.partsAllowanceCents} used={r.used.partsCents} fmt={formatCents}
                unlimited={r.partsUnlimited} />
              <Bar label="Visits" included={r.visitsIncluded} used={r.used.visits} fmt={(n) => String(n)}
                unlimited={r.visitsUnlimited} />
              <Bar label="Labor hours" included={r.laborIncludedMinutes} used={r.used.laborMinutes} fmt={formatHours} />
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
                      {k.name || k.partNumber} {k.used}/{k.qty}
                      {k.over ? ` · ${k.used - k.qty} billable` : ""}
                    </span>
                  ))}
                </div>
              );
            })()}
            {/* Reported, never hidden: the money was really spent, the client
                just isn't being charged for it out of this allowance. */}
            {r.pmPartsIncluded && (r.used.pmPartsCents ?? 0) > 0 && (
              <div className="mut t-meta" style={{ marginTop: 6 }}>
                Plus {formatCents(r.used.pmPartsCents ?? 0)} in PM parts, covered by the contract.
              </div>
            )}
            </>
            )}
            {r.note && <div className="mut" style={{ fontSize: 12, marginTop: 6, whiteSpace: "pre-wrap" }}>{r.note}</div>}
          </div>
        );
      })}

      {rows.length === 0 && (
        <div className="mut t-body">Nothing on file.</div>
      )}

      {sheet && (() => {
        const orgName = orgs.find((o) => o.id === sheet.orgId)?.name
          ?? rows.find((r) => r.id === sheet.id)?.orgName ?? "";
        const problem = !sheet.id && !sheet.orgId ? "pick the client" : firstProblem(draft);
        // done = the step's fields are valid AND somebody touched it or it
        // already holds something; warn = it has a live problem right now.
        const hasPaper = heldFiles.length > 0 || heldLib.length > 0
          || (sheet.id != null && papers.some((p) => p.agreementId === sheet.id));
        const filled: Record<StepKey, boolean> = {
          terms: draft.number.trim() !== "" && draft.title.trim() !== "",
          paper: hasPaper,
          /* Entitlements only count as "filled" on a kind that has them - a
             quote carrying a leftover allowance from when it was a contract
             must not tick its own Amount step on the strength of it. */
          included: draft.value.trim() !== "" || (shapeOf(draft.kind).entitlements && (
            draft.includedKits.length > 0
            || draft.partsUnlimited || draft.visitsUnlimited || draft.laborUnlimited || draft.pmPartsIncluded
            || [draft.partsAllowance, draft.laborIncludedHours, draft.hourlyRate]
              .some((v) => v.trim() !== "")
            || !["", "0"].includes(draft.visitsIncluded.trim()))),
          coverage: draft.instrumentIds.length > 0,
          note: draft.note.trim() !== "",
        };
        const shape = shapeOf(draft.kind);
        const labels = stepLabels(draft.kind);
        const steps = (Object.keys(labels) as StepKey[]).map((k) => {
          const warn = stepProblem(k, draft);
          return { key: k, label: labels[k], warn, done: !warn && (touched.has(k) || filled[k]) };
        });
        // The ok line: the renewal summary when there is a term to summarize,
        // else the coverage, else who the paper is for.
        const covered = draft.instrumentIds.length;
        const ok = draft.endsOn
          ? renewalLine({
              endsOn: draft.endsOn, status: draft.status,
              renewNoticeDays: parseInt(draft.renewNoticeDays, 10) || 0,
            }, today)
          : covered > 0 ? `Covers ${covered} system${covered === 1 ? "" : "s"}.`
            : orgName ? `For ${orgName}.` : "Ready to save.";
        const up = (step: StepKey, p: Partial<Draft>) => { touch(step); setDraft({ ...draft, ...p }); };
        const section = (k: StepKey) => (el: HTMLDivElement | null) => { sectionRefs.current[k] = el; };
        const theirs = systems.filter((s2) => s2.ownerOrgId === sheet.orgId);
        return (
          <Dialog open onClose={() => setSheet(null)} size="lg"
            title={sheet.id ? "Edit agreement" : "New agreement"}
            context={[orgName, draft.number.trim()].filter(Boolean).join(" · ") || undefined}
            steps={steps} activeStep={activeStep}
            onStepSelect={(k) => {
              setActiveStep(k as StepKey);
              sectionRefs.current[k as StepKey]?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            footer={
              <>
                <DialogStatus error={error} problem={problem} ok={ok} />
                <button className="btn" onClick={() => setSheet(null)} disabled={pending}>Cancel</button>
                <button className="btn accent" onClick={save} disabled={pending || !!problem}>
                  {busy ? busy : pending ? "Saving..."
                    : draft.number.trim() ? `Save ${draft.number.trim()}` : "Save agreement"}
                </button>
              </>
            }>

            <div ref={section("terms")}>
              <div className="dialog-section">Terms</div>
              {!sheet.id && orgs.length > 1 && (
                <div style={{ marginBottom: 8 }}>
                  <label>Client</label>
                  <select value={sheet.orgId || ""}
                    onChange={(e) => {
                      // A new client means their systems, not the last one's.
                      setDraft({ ...draft, instrumentIds: [] });
                      setSheet({ orgId: parseInt(e.target.value) || 0 });
                    }}>
                    <option value="">Pick the client</option>
                    {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </div>
              )}
              <div className="seg" role="group" aria-label="Kind" style={{ marginBottom: 8 }}>
                {AGREEMENT_KINDS.map((k) => (
                  <button key={k} type="button" aria-pressed={draft.kind === k}
                    onClick={() => up("terms", { kind: k })}>{KIND_LABEL[k]}</button>
                ))}
              </div>
              {/* Contract only. It is the only kind any reader consults: coverage
                  resolves a provider off a contract and nothing else, so asking
                  it of a quote collects an answer nobody looks at. */}
              {shape.provider && (
              <div style={{ marginBottom: 8 }}>
                <label>Who provides the service</label>
                <input value={draft.providerName}
                  onChange={(e) => up("terms", { providerName: e.target.value })}
                  placeholder={`${operatorName} — or name the company that does`} />
                <div className="mut t-meta" style={{ marginTop: 3 }}>
                  {/* The consequence, said where the decision is made. A row
                      naming somebody else is a record of THEIR paper: it never
                      absorbs our labour, never draws down against our work,
                      and never raises a "one visit left" flag on a job. */}
                  {draft.providerName.trim()
                    && draft.providerName.trim().toLowerCase() !== operatorName.trim().toLowerCase()
                    ? `A contract ${draft.providerName.trim()} holds. It is on the record and on the client's page, and nothing about it changes what ${operatorName} bills.`
                    : `${operatorName}'s own contract. What it includes is what we absorb.`}
                </div>
              </div>
              )}

              <div className="pf2" style={{ marginBottom: 8 }}>
                <div>
                  <label>Number</label>
                  <input className="mono" value={draft.number} placeholder={shape.numberHint}
                    onChange={(e) => up("terms", { number: e.target.value })} />
                </div>
                <div>
                  <label>Status</label>
                  <select value={draft.status} onChange={(e) => up("terms", { status: e.target.value })}>
                    <option value="draft">Draft</option>
                    <option value="active">Active</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
              </div>

              <label>What it covers</label>
              <input value={draft.title} placeholder={shape.titleHint}
                onChange={(e) => up("terms", { title: e.target.value })} style={{ marginBottom: 8 }} />

              <div className="pf2" style={{ marginBottom: 8 }}>
                <div>
                  {/* The same two columns wearing the word this kind uses:
                      a quote is "Quoted / Valid until", an invoice
                      "Invoiced / Due". One fact, the right name. */}
                  <label>{shape.startLabel}</label>
                  <input type="date" value={draft.startsOn} aria-label={shape.startLabel}
                    onChange={(e) => up("terms", { startsOn: e.target.value })} />
                </div>
                <div>
                  <label>{shape.endLabel}</label>
                  <input type="date" value={draft.endsOn} aria-label={shape.endLabel}
                    onChange={(e) => up("terms", { endsOn: e.target.value })} />
                </div>
              </div>

              {/* An invoice does not lapse, it falls due - a renewal notice on
                  one is a reminder about the wrong event. */}
              {shape.renewal && (
                <>
                  <label htmlFor="ag-renew">Tell me this many days before it ends</label>
                  <input id="ag-renew" type="number" min={0} max={3650} value={draft.renewNoticeDays}
                    style={{ marginBottom: 8 }}
                    onChange={(e) => up("terms", { renewNoticeDays: e.target.value })} />
                </>
              )}
            </div>

            {/* The paper the terms above were read off. Asked for here because
                here is where somebody has it open - sending them to Files to
                upload it first is how a contract ends up with no contract. */}
            <div ref={section("paper")}>
              <div className="dialog-section">The paper</div>
              <label>The signed agreement <span className="mut" style={{ fontWeight: 400 }}>(optional)</span></label>
              <div style={{ marginBottom: 8 }}>
                {(heldFiles.length > 0 || heldLib.length > 0) && (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
                    {heldFiles.map((f, idx) => (
                      <span key={`f${idx}`} className="pill mono" style={{ background: "#E7F2FA", color: "var(--t-info-fg)" }}>
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
                  onPick={(f) => { touch("paper"); setHeldLib([...heldLib, f]); }}
                  onFiles={(files) => { touch("paper"); setHeldFiles([...heldFiles, ...files]); }} />
                <div className="mut" style={{ fontSize: 11, marginTop: 3 }}>
                  Uploaded when you save, and filed on both this agreement and your document shelf.
                </div>
              </div>
            </div>

            {/* Entitlements are a CONTRACT's, and this is where that shows.
                A PO, a quote and an invoice each have a figure and no
                entitlements - and never did have any that anything read, since
                both coverage sites gate on kind === "contract". See
                lib/agreements.AGREEMENT_SHAPE. */}
            <div ref={section("included")}>
              <div className="dialog-section">{shape.amountSection}</div>
              {shape.entitlements && (
              <div className="mut t-meta" style={{ marginBottom: 6 }}>
                Leave one blank when it is not part of this agreement. Blank means untracked,
                not zero - an unlimited contract and a nothing-included one are different things.
              </div>
              )}
              {shape.entitlements && (<>
              <div className="pf2" style={{ marginBottom: 8 }}>
                <div>
                  <label>Parts allowance ($)</label>
                  <input value={draft.partsAllowance} placeholder="5000" disabled={draft.partsUnlimited}
                    onChange={(e) => up("included", { partsAllowance: e.target.value })} />
                  <label className="t-small" style={{ display: "flex", alignItems: "center", gap: 6, margin: "5px 0 0", fontWeight: 400, color: "var(--ink)" }}>
                    <input type="checkbox" checked={draft.partsUnlimited} style={{ width: 15, height: 15 }}
                      onChange={(e) => up("included", { partsUnlimited: e.target.checked })} />
                    Unlimited - parts are covered, spend isn&apos;t tracked against a cap
                  </label>
                  {/* The PM's own parts are part of the PM. Without this, an
                      included PM's kit gets billed twice - once in the PM, once
                      out of the allowance. */}
                  <label className="t-small" style={{ display: "flex", alignItems: "flex-start", gap: 6, margin: "5px 0 0", fontWeight: 400, color: "var(--ink)" }}>
                    <input type="checkbox" checked={draft.pmPartsIncluded} style={{ width: 15, height: 15, marginTop: 2 }}
                      onChange={(e) => up("included", { pmPartsIncluded: e.target.checked })} />
                    <span>
                      PM parts are included
                      <span className="mut" style={{ display: "block", fontSize: 11 }}>
                        Parts fitted on an included PM are reported but never drawn from this allowance.
                      </span>
                    </span>
                  </label>
                </div>
                <div>
                  <label>Service visits</label>
                  <input type="number" min={0} value={draft.visitsIncluded} disabled={draft.visitsUnlimited}
                    onChange={(e) => up("included", { visitsIncluded: e.target.value })} />
                  <label className="t-small" style={{ display: "flex", alignItems: "center", gap: 6, margin: "5px 0 0", fontWeight: 400, color: "var(--ink)" }}>
                    <input type="checkbox" checked={draft.visitsUnlimited} style={{ width: 15, height: 15 }}
                      onChange={(e) => up("included", { visitsUnlimited: e.target.checked })} />
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
                      onChange={(e) => up("included", { includedKits: draft.includedKits.map((x, i) =>
                        (i === idx ? { ...x, qty: parseInt(e.target.value) || 1 } : x)) })}
                      className="t-small" style={{ width: 62 }} />
                    <span className="mono t-small" style={{ fontWeight: 700 }}>{k.partNumber}</span>
                    <span className="mut t-meta" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.name}</span>
                    <button className="btn link" aria-label={`Remove ${k.partNumber}`} style={{ marginLeft: "auto", color: "var(--t-bad-fg)", fontSize: 13 }}
                      onClick={() => up("included", { includedKits: draft.includedKits.filter((_, i) => i !== idx) })}>×</button>
                  </div>
                ))}
                <select value="" aria-label="Add an included kit"
                  onChange={(e) => {
                    const hit = (book ?? []).find((b) => b.partNumber === e.target.value);
                    if (!hit) return;
                    if (draft.includedKits.some((k) => k.partNumber.toLowerCase() === hit.partNumber.toLowerCase())) return;
                    up("included", { includedKits: [...draft.includedKits, { partNumber: hit.partNumber, name: hit.name, qty: 1 }] });
                  }}
                  className="t-small">
                  <option value="">＋ Add a kit from the parts catalog...</option>
                  {(book ?? []).map((b) => (
                    <option key={b.partNumber} value={b.partNumber}>
                      {b.kind === "kit" ? "▣ " : ""}{b.partNumber}{b.name ? ` - ${b.name}` : ""}
                    </option>
                  ))}
                </select>
                <div className="mut" style={{ fontSize: 11, marginTop: 3 }}>
                  Fitting one of these draws down its count instead of the money above. Past the
                  included quantity, extras bill as ordinary parts.
                </div>
              </div>

              <div className="pf2" style={{ marginBottom: 8 }}>
                <div>
                  {/* Tied to its input, which the labels around it are not:
                      a bare <label> next to a bare <input> reads to a screen
                      reader as two unrelated things. Done here because this is
                      the field being changed; the rest of the form is the same
                      shape and wants the same treatment. */}
                  <label htmlFor="ag-labor-hours">Labor hours included</label>
                  <input id="ag-labor-hours" value={draft.laborIncludedHours} placeholder="40" disabled={draft.laborUnlimited}
                    onChange={(e) => up("included", { laborIncludedHours: e.target.value })} />
                  {/* The flag visits and parts already had. Without it an
                      all-in contract had no way to say so, and the client's own
                      coverage card read "Labor - not part of this agreement" on
                      a contract that covers all of it. */}
                  <label className="t-small" style={{ display: "flex", alignItems: "center", gap: 6, margin: "5px 0 0", fontWeight: 400, color: "var(--ink)" }}>
                    <input type="checkbox" checked={draft.laborUnlimited} style={{ width: 15, height: 15 }}
                      onChange={(e) => up("included", { laborUnlimited: e.target.checked })} />
                    Unlimited labor - all time is covered, hours aren&apos;t counted down
                  </label>
                  <div className="mut" style={{ fontSize: 11, marginTop: 3 }}>
                    Hours of work the contract includes; logged time draws it down.
                  </div>
                </div>
                <div>
                  <label>Hourly rate ($/hr)</label>
                  <input value={draft.hourlyRate} placeholder="150"
                    onChange={(e) => up("included", { hourlyRate: e.target.value })} />
                  <div className="mut" style={{ fontSize: 11, marginTop: 3 }}>
                    What an hour beyond the included ones bills at.
                  </div>
                </div>
              </div>
              </>)}
              {/* The one figure every kind has, under the word that kind uses
                  for it. Kept as a label rather than a column of its own: a
                  kind change then never strands a number somewhere nobody
                  reads it. */}
              <label htmlFor="ag-value">{shape.amountLabel}</label>
              <input id="ag-value" value={draft.value} placeholder="18000" style={{ marginBottom: 8 }}
                onChange={(e) => up("included", { value: e.target.value })} />
            </div>

            {/* Which systems this paper covers. The client with a full-service
                contract on the TOC and a PM-only one on the UV-Vis assigns each
                system to its contract; none selected = the whole fleet. */}
            <div ref={section("coverage")}>
              <div className="dialog-section">Coverage</div>
              {theirs.length === 0 ? (
                <div className="mut t-meta" style={{ marginBottom: 8 }}>
                  No systems on file for this client yet - the agreement covers whatever they have.
                </div>
              ) : (
                <div style={{ marginBottom: 8 }}>
                  <label>Systems it covers <span className="mut" style={{ fontWeight: 400 }}>(none = all of theirs)</span></label>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {theirs.map((s2) => {
                      const on = draft.instrumentIds.includes(s2.id);
                      return (
                        <button key={s2.id} type="button" className={on ? "btn sm primary" : "btn sm"}
                          style={{ fontSize: 11 }} title={s2.label}
                          onClick={() => up("coverage", {
                            instrumentIds: on ? draft.instrumentIds.filter((x) => x !== s2.id) : [...draft.instrumentIds, s2.id],
                          })}>
                          {s2.externalId}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div ref={section("note")}>
              <div className="dialog-section">Note</div>
              <textarea value={draft.note} rows={3} style={{ width: "100%", marginBottom: 8 }}
                onChange={(e) => up("note", { note: e.target.value })} />
            </div>

          </Dialog>
        );
      })()}
    </div>
  );
}
