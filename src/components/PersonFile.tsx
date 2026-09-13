"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  addPayrollEntry, addPerk, createStipend, deletePerk, endPerk, removeMemberPaper, revokeHouseMember,
  saveMemberProfile, setHouseMember, updateStipend, uploadMemberPapers,
} from "@/app/actions";
import { fmtBytes } from "@/lib/storage";
import { siteLabel, worksitesByOrg } from "@/lib/sites";
import { PAY_KINDS, type PayRow } from "@/lib/payroll";
import { CADENCE_LABEL, PERK_CADENCES, perkActiveOn, perkMonthlyCents, type PerkRow } from "@/lib/perks";
import { formatCents } from "@/lib/money";
import {
  STIPEND_SHAPES, WEEKDAY_NAMES, checkStipend, previewFirstCycle, shapeTerms, stipendCadenceLabel,
} from "@/lib/stipends";
import AddressField from "@/components/AddressField";
import type { WorksiteChoice } from "@/lib/sites";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { confirmDialog, confirmReason } from "@/components/ui/ConfirmDialog";
import { Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

export type PersonProfile = {
  /** The roster name - what reports and the directory call them. */
  name: string;
  /** Their job title, on the account row: their own profile page shows it back to them. */
  title: string;
  /** Where they live. The tax forms' address, and where trips start unless a site location says otherwise. */
  homeAddress: string; phone: string; emergencyName: string; emergencyPhone: string;
  startedOn: string;
  /** Their site location - one of the company's own sites or a client lab - or null for "works from home". */
  siteId: number | null;
};

/** One of the company's own sites, for the staffed-location picker. */
export type OwnSite = { id: number; name: string; address: string; archived: boolean };

/** A paper on the person file: the contract, an offer letter, a certification. */
export type PaperRow = { id: number; fileName: string; kind: string; size: number; when: string };

/** One standing reimbursement of theirs, worded as the roster's card words it. */
export type StipendLine = {
  id: number; label: string; amountCents: number; cadence: string; active: boolean; nextOn: string;
};

/** What a paper on the file can be called. Free text on the row; these are the offers. */
const PAPER_KINDS = ["Contract", "Offer letter", "Certification", "Other"] as const;

/**
 * One employee, the whole file: who they are, what they are paid, what else
 * they get.
 *
 * The pay half reuses the register's own action (addPayrollEntry), so a raise
 * recorded here is byte-for-byte the raise the register records - effective-
 * dated, superseding, history kept. This dialog is a doorway into that
 * machinery with the person already chosen, not a second copy of it.
 *
 * What is shown is decided by the CALLER: `seesPay` comes from the same rule
 * the register runs on, and a reader without it gets the profile half only -
 * HR facts, no figures.
 */
/** One of their kits, and what is counted in it. */
export type KitRow = { id: number; name: string; lines: number; units: number; short: number };

export default function PersonFile({
  email, name, role, profile, pay, perks, kits, seesPay, orgId, today, onClose,
  sites = [], ownSites = [], papers = [], stipends = [], canManage = false, isMe = false, categories = [],
}: {
  email: string;
  name: string;
  role: string;
  profile: PersonProfile;
  /** The pay row in force today, when the reader may see it. */
  pay: PayRow | null;
  perks: PerkRow[];
  /** The vans and field kits this person keeps. Empty for most people. */
  kits: KitRow[];
  /** Client labs, for an engineer whose day starts at a client rather than at home. */
  sites?: WorksiteChoice[];
  /** The company's own site locations - the other places somebody can be stationed. */
  ownSites?: OwnSite[];
  /** The paperwork on their file. */
  papers?: PaperRow[];
  /** Their standing reimbursements. Set up here by the owner, or on the roster's card. */
  stipends?: StipendLine[];
  /** Expense categories, for a standing reimbursement set up from here. */
  categories?: string[];
  seesPay: boolean;
  /** The employing workspace - where a pay change is filed. Null hides the editors. */
  orgId: number | null;
  today: string;
  onClose: () => void;
  /** Owner: may change their privileges or revoke them from here, and commit standing money. */
  canManage?: boolean;
  /** Their own file - nobody edits their own access. */
  isMe?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [p, setP] = useState(profile);
  const [payOpen, setPayOpen] = useState(false);
  const [payDraft, setPayDraft] = useState({
    kind: pay?.kind ?? "hourly", amount: "", hoursPerWeek: String(pay?.hoursPerWeek ?? 40),
    title: pay?.title ?? "", effectiveOn: today,
  });
  const [perkOpen, setPerkOpen] = useState(false);
  const [perkDraft, setPerkDraft] = useState({
    title: "", amount: "", cadence: "monthly", startsOn: today, note: "",
  });
  const [paperKind, setPaperKind] = useState<string>(PAPER_KINDS[0]);
  const blankStipend = () => ({
    label: "", amount: "",
    kind: categories.find((c) => /phone|internet/i.test(c)) ?? categories[0] ?? "Other",
    shape: "m1-1", dayOfMonth: "1", weekday: "1",
    // The 1st of the current month: "starting this month" is what somebody
    // setting one of these up almost always means, and lib/stipends pays the
    // month it was set up in rather than the month after.
    startsOn: `${today.slice(0, 7)}-01`, endsOn: "",
  });
  const [stipOpen, setStipOpen] = useState(false);
  const [stipDraft, setStipDraft] = useState(blankStipend);
  const [busy, setBusy] = useState("");

  /**
   * Paperwork goes straight from the browser to Blob against the token
   * /api/upload mints, then the record is made - the same two steps an
   * agreement's paper takes, with the employee already chosen.
   */
  const filePapers = async (files: File[]) => {
    if (!files.length) return;
    setError("");
    try {
      const done: { fileName: string; url: string; size: number }[] = [];
      for (const f of files) {
        setBusy(`Uploading ${f.name}...`);
        const blob = await upload(f.name, f, { access: "public", handleUploadUrl: "/api/upload" });
        done.push({ fileName: f.name, url: blob.url, size: f.size });
      }
      const res = await uploadMemberPapers(email, done, paperKind);
      if (res?.error) { setError(res.error); return; }
      toast({ message: done.length === 1 ? `Filed ${done[0].fileName}` : `Filed ${done.length} papers` });
      router.refresh();
    } catch (e) {
      setError((e as Error).message || "The upload failed");
    } finally {
      setBusy("");
    }
  };

  const run = (fn: () => Promise<{ error?: string } | void>, ok: string, after?: () => void) =>
    startTransition(async () => {
      setError("");
      const res = await fn();
      if (res && "error" in res && res.error) { setError(res.error); return; }
      if (ok) toast({ message: ok });
      after?.();
      router.refresh();
    });

  // The reimbursement draft, judged by the same rule the roster's card and the
  // action use, so this form cannot accept what createStipend refuses.
  const stipCents = Math.round(parseFloat(stipDraft.amount.replace(/[^0-9.]/g, "")) * 100) || 0;
  const { shape: stipShape, picksDay, terms: stipTerms } = shapeTerms(stipDraft.shape, stipDraft.dayOfMonth, stipDraft.weekday);
  const stipProblem = checkStipend({
    person: name, label: stipDraft.label, amountCents: stipCents,
    ...stipTerms, startsOn: stipDraft.startsOn, endsOn: stipDraft.endsOn,
  });
  const stipFirstOn = previewFirstCycle(stipDraft.startsOn, stipTerms.dayOfMonth, stipTerms.cadence, stipTerms.weekday);
  // Client labs that are not also one of our own sites, so the shop's own
  // yard is offered once, under "Our sites", and not again under our name.
  const labs = sites.filter((s) => !ownSites.some((o) => o.id === s.id));
  const stationKnown = p.siteId === null || ownSites.some((o) => o.id === p.siteId) || labs.some((s) => s.id === p.siteId);

  const active = perks.filter((x) => perkActiveOn(x, today));
  const past = perks.filter((x) => !perkActiveOn(x, today));
  const perksMonthly = active.reduce((n, x) => n + perkMonthlyCents(x), 0);

  return (
    <Dialog open onClose={onClose} size="md" title={name || email}
      context={`${role === "owner" ? "Owner" : "Staff"} · ${email}`}
      footer={<>
        <DialogStatus error={error} ok="" />
        <button className="btn" onClick={onClose} disabled={pending}>Close</button>
        <button className="btn accent" disabled={pending}
          onClick={() => run(() => saveMemberProfile(email, p), "Saved their file")}>
          {pending ? "Saving..." : "Save the file"}
        </button>
      </>}>

      <div className="dialog-section">The person</div>
      <div className="pf2" style={{ marginBottom: 8 }}>
        <div>
          <label>Name</label>
          <input value={p.name} aria-label="Name" disabled={pending} placeholder="Bill Harner"
            onChange={(e) => setP({ ...p, name: e.target.value })} />
        </div>
        <div>
          <label>Title</label>
          <input value={p.title} aria-label="Title" disabled={pending} placeholder="Field service engineer"
            onChange={(e) => setP({ ...p, title: e.target.value })} />
        </div>
      </div>
      <div className="pf2">
        <div>
          <label>Phone</label>
          <input value={p.phone} aria-label="Phone" disabled={pending}
            onChange={(e) => setP({ ...p, phone: e.target.value })} />
        </div>
        <div>
          <label>Email</label>
          {/* Their sign-in identity, so it is shown rather than typed here:
              the roster, the register and their account all key on it, and
              moving it is Settings › People & ownership's job. */}
          <input value={email} aria-label="Email" readOnly className="mono t-small" />
        </div>
      </div>
      <div className="pf2" style={{ marginTop: 8 }}>
        <div>
          <label>Started on</label>
          <input type="date" value={p.startedOn} aria-label="Started on" disabled={pending}
            onChange={(e) => setP({ ...p, startedOn: e.target.value })} />
        </div>
        <div>
          <label>Site location</label>
          {/* WHERE THEIR DAY STARTS when it is not their front door: the
              shop, an office, or a client's lab for an engineer stationed
              there. An OVERRIDE of the home address for routed miles and the
              per-diem radius - never a replacement for it. The home stays on
              file as the home, which is what the tax forms want. */}
          <select value={p.siteId ?? ""} aria-label="Site location" disabled={pending}
            onChange={(e) => setP({ ...p, siteId: e.target.value ? parseInt(e.target.value, 10) : null })}>
            <option value="">Works from home</option>
            {ownSites.some((x) => !x.archived || x.id === p.siteId) && (
              <optgroup label="Our sites">
                {ownSites.filter((x) => !x.archived || x.id === p.siteId).map((x) => (
                  <option key={x.id} value={x.id}>{siteLabel(x)}{x.archived ? " (closed)" : ""}</option>
                ))}
              </optgroup>
            )}
            {worksitesByOrg(labs).map((g) => (
              <optgroup key={g.orgName} label={g.orgName}>
                {g.sites.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </optgroup>
            ))}
            {/* A lab since closed is still where they were put; dropping it
                from its own picker is how an unrelated save clears a field. */}
            {!stationKnown && <option value={p.siteId!}>A site since closed</option>}
          </select>
        </div>
      </div>
      <div className="field-hint">
        Their primary site, when they have one: trips and the per-diem radius are measured
        from it instead of from home. Leave it on &quot;Works from home&quot; for an engineer
        whose day starts at their front door.
        {ownSites.length === 0 && <> No sites of our own on file yet - add the shop and the offices under My organization › Site locations.</>}
      </div>
      <label style={{ marginTop: 8 }}>Home address</label>
      <AddressField value={p.homeAddress} ariaLabel="Home address" disabled={pending}
        placeholder="Street address - autocompletes when maps are configured"
        onChange={(homeAddress) => setP({ ...p, homeAddress })} />
      <div className="field-hint">
        Where they live - what payroll and the tax forms need, and where trips start unless a
        site location above says otherwise. They can also set it themselves.
      </div>
      <div className="pf2" style={{ marginTop: 8 }}>
        <div>
          <label>Emergency contact</label>
          <input value={p.emergencyName} aria-label="Emergency contact" disabled={pending}
            placeholder="who to call" onChange={(e) => setP({ ...p, emergencyName: e.target.value })} />
        </div>
        <div>
          <label>Their number</label>
          <input value={p.emergencyPhone} aria-label="Emergency phone" disabled={pending}
            onChange={(e) => setP({ ...p, emergencyPhone: e.target.value })} />
        </div>
      </div>

      {/* Who they are TO THE SHOP. The same two actions Settings › People &
          ownership runs, offered here so an owner has one place to go about
          a person. memberGuard still refuses the root owner, the last owner,
          and anybody editing their own access. */}
      {canManage && (
        <>
          <div className="dialog-section" style={{ marginTop: 16 }}>Access</div>
          {isMe ? (
            <div className="mut t-small">You can&apos;t change your own access - ask another owner.</div>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ margin: 0 }}>Privileges</label>
              <select value={role} disabled={pending} aria-label="Privileges" style={{ width: "auto" }}
                onChange={(e) => {
                  const next = e.target.value;
                  run(() => setHouseMember(email, next, name), `Made ${name || email} ${next}`);
                }}>
                <option value="staff">Staff - every system, every job</option>
                <option value="owner">Owner - staff plus settings, money and deletions</option>
              </select>
              <button className="btn link" style={{ marginLeft: "auto", color: "var(--t-bad-fg)" }} disabled={pending}
                onClick={async () => {
                  const why = await confirmReason({
                    title: `Revoke ${email}'s access to the whole shop?`,
                    body: "They lose their login and this file today. Their work in the record stays.",
                    action: "Revoke access", tone: "bad",
                  });
                  if (!why) return;
                  run(() => revokeHouseMember(email, why), `Revoked ${email}`, onClose);
                }}>Revoke access</button>
            </div>
          )}
          <div className="field-hint">
            Temporary passwords and the root owner are handled under Settings › People &amp; ownership.
          </div>
        </>
      )}

      {/* The paper: the contract they signed, the offer letter, a
          certification. Kept on the person file rather than the shelf - see
          uploadMemberPapers - so only whoever administers the people, and
          the person themselves, can open it. */}
      <div className="dialog-section" style={{ marginTop: 16 }}>Contract &amp; paperwork</div>
      {papers.length === 0 && (
        <div className="mut t-small" style={{ marginBottom: 8 }}>Nothing filed yet.</div>
      )}
      {papers.map((f) => (
        <div key={f.id} className="row-2" style={{ alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
          <a href={`/api/files/${f.id}`} target="_blank" rel="noopener" className="t-body" style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>
            {f.fileName}
          </a>
          <Pill tone="neutral">{f.kind}</Pill>
          <span className="mut t-meta">{fmtBytes(f.size)} · {f.when}</span>
          <button className="btn link danger" disabled={pending || !!busy}
            onClick={async () => {
              const why = await confirmReason({
                title: `Remove ${f.fileName} from their file?`,
                body: "The file is deleted from storage, not just unfiled. For a paper filed on the wrong person or superseded by a signed copy.",
                action: "Remove it", tone: "bad",
              });
              if (why) run(() => removeMemberPaper(f.id, why), "Removed");
            }}>×</button>
        </div>
      ))}
      <div className="row-2" style={{ marginTop: 8, alignItems: "center" }}>
        <select value={paperKind} aria-label="Paper kind" style={{ width: "auto" }} disabled={!!busy}
          onChange={(e) => setPaperKind(e.target.value)}>
          {PAPER_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <label className="btn sm" style={{ margin: 0, cursor: busy ? "default" : "pointer" }}>
          {busy || "+ File a document"}
          <input type="file" multiple hidden aria-label="File a document" disabled={!!busy}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void filePapers(files);
            }} />
        </label>
      </div>
      <div className="field-hint">
        Readable by you, the owner, and them - never by their colleagues. Their signed agreement
        goes here; the terms it states go in Pay below.
      </div>

      {/* What the company pays them back every month whether or not they file
          anything - internet, phone, tools. The same createStipend the
          roster's card runs, with the person already chosen: owner only,
          because it is a standing commitment of company money. HR reads. */}
      <div className="dialog-section" style={{ marginTop: 16 }}>Monthly reimbursements</div>
      {stipends.length === 0 && (
        <div className="mut t-small" style={{ marginBottom: 8 }}>
          No standing reimbursements.{canManage ? "" : " The owner sets these up."}
        </div>
      )}
      {stipends.map((x) => (
        <div key={x.id} className="row-2" style={{ alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
          <span className="t-body" style={{ flex: 1, minWidth: 0 }}>
            {x.label}
            <span className="mut t-meta">{` · ${formatCents(x.amountCents)} ${x.cadence}`}</span>
          </span>
          {x.active
            ? <span className="mut t-meta">{x.nextOn ? `next ${x.nextOn}` : "no further cycles"}</span>
            : <Pill tone="faint">paused</Pill>}
          {canManage && (
            <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
              onClick={async () => {
                if (x.active && !(await confirmDialog({
                  title: `Pause ${x.label}?`,
                  body: "It stops raising a row each month. What it has already paid stays on the record, and restarting it later does not back-pay the gap.",
                  action: "Pause it",
                }))) return;
                run(() => updateStipend(x.id, { active: !x.active }), x.active ? "Paused" : "Running again");
              }}>{x.active ? "pause" : "restart"}</button>
          )}
        </div>
      ))}
      {canManage && !stipOpen && (
        name.trim()
          ? <button className="btn sm" style={{ marginTop: 8 }} onClick={() => { setStipDraft(blankStipend()); setStipOpen(true); }}>
              + Reimbursement
            </button>
          : <div className="field-hint">Give them a name above and save the file first - a reimbursement is filed in it.</div>
      )}
      {canManage && stipOpen && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, marginTop: 8 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ display: "block", flex: "1 1 160px" }}>
              <span className="mut t-meta" style={{ display: "block" }}>What</span>
              <input value={stipDraft.label} aria-label="What it is" placeholder="Internet stipend" autoFocus
                onChange={(e) => setStipDraft({ ...stipDraft, label: e.target.value })} />
            </label>
            <label style={{ display: "block" }}>
              <span className="mut t-meta" style={{ display: "block" }}>Amount ($)</span>
              <input className="mono t-small" style={{ width: 90 }} value={stipDraft.amount} inputMode="decimal"
                aria-label="Amount" placeholder="35.00"
                onChange={(e) => setStipDraft({ ...stipDraft, amount: e.target.value })} />
            </label>
            <label style={{ display: "block" }}>
              <span className="mut t-meta" style={{ display: "block" }}>Category</span>
              <select value={stipDraft.kind} aria-label="Category" style={{ width: "auto" }}
                onChange={(e) => setStipDraft({ ...stipDraft, kind: e.target.value })}>
                {(categories.length ? categories : [stipDraft.kind]).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label style={{ display: "block" }}>
              <span className="mut t-meta" style={{ display: "block" }}>How often</span>
              <select value={stipDraft.shape} aria-label="How often" style={{ width: "auto" }}
                onChange={(e) => setStipDraft({ ...stipDraft, shape: e.target.value })}>
                {STIPEND_SHAPES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
            </label>
            {/* Only the shape that needs one asks for one. */}
            {picksDay && (
              <label style={{ display: "block" }}>
                <span className="mut t-meta" style={{ display: "block" }}>Day of the month</span>
                <input className="mono t-small" style={{ width: 60 }} value={stipDraft.dayOfMonth} inputMode="numeric"
                  aria-label="Day of the month"
                  onChange={(e) => setStipDraft({ ...stipDraft, dayOfMonth: e.target.value })} />
              </label>
            )}
            {stipShape.cadence === "weeks" && (
              <label style={{ display: "block" }}>
                <span className="mut t-meta" style={{ display: "block" }}>Which day</span>
                <select value={stipDraft.weekday} aria-label="Which day" style={{ width: "auto" }}
                  onChange={(e) => setStipDraft({ ...stipDraft, weekday: e.target.value })}>
                  {WEEKDAY_NAMES.map((d, i) => <option key={d} value={String(i)}>{d}</option>)}
                </select>
              </label>
            )}
            <label style={{ display: "block" }}>
              <span className="mut t-meta" style={{ display: "block" }}>Starting</span>
              <input type="date" value={stipDraft.startsOn} aria-label="Starting"
                onChange={(e) => setStipDraft({ ...stipDraft, startsOn: e.target.value })} />
            </label>
            <label style={{ display: "block" }}>
              <span className="mut t-meta" style={{ display: "block" }}>Until (optional)</span>
              <input type="date" value={stipDraft.endsOn} aria-label="Until"
                onChange={(e) => setStipDraft({ ...stipDraft, endsOn: e.target.value })} />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn sm accent" disabled={pending || stipProblem !== null}
              onClick={() => run(() => createStipend({
                person: name, label: stipDraft.label, amount: stipDraft.amount, kind: stipDraft.kind,
                ...stipTerms, startsOn: stipDraft.startsOn, endsOn: stipDraft.endsOn, note: "",
              }), `Set up - it pays first on ${stipFirstOn}`, () => setStipOpen(false))}>
              Set it up
            </button>
            <button className="btn sm" onClick={() => setStipOpen(false)} disabled={pending}>Cancel</button>
          </div>
          {/* The schedule said back as a sentence, plus the date it actually
              lands on - shown before anybody commits standing company money.
              The draft's objection takes the same line, so the disabled
              button always has its reason next to it. */}
          <div className="mut t-meta" style={{ marginTop: 8 }}>
            {stipProblem
              ? stipProblem
              : stipFirstOn
                ? <>It pays <b>{stipendCadenceLabel(stipTerms)}</b>, first on <b>{stipFirstOn}</b>, onto their
                    monthly perks claim at Reimbursements - you still mark the claim paid. Not payroll: money owed back, not wages.</>
                : "Pick the day it starts."}
          </div>
        </div>
      )}

      {/*
        What they are carrying.
        
        Here rather than only on the inventory page because this is where
        somebody asks it: a tech is out for a fortnight, or leaving, and the
        question is what of the shop's is in their van. The counts link to the
        room itself, which is where anything is actually done about it.
      */}
      {kits.length > 0 && (
        <>
          <div className="dialog-section" style={{ marginTop: 14 }}>What they carry</div>
          {kits.map((k) => (
            <div key={k.id} style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", padding: "4px 0" }}>
              <a href={`/stock/${k.id}`} className="t-body" style={{ fontWeight: 600 }}>{k.name}</a>
              <span className="mut t-small">
                {k.lines} line{k.lines === 1 ? "" : "s"} · {k.units} unit{k.units === 1 ? "" : "s"}
              </span>
              {k.short > 0 && <span className="pill bad">{k.short} short</span>}
            </div>
          ))}
        </>
      )}

      {seesPay && (
        <>
          <div className="dialog-section" style={{ marginTop: 14 }}>Pay</div>
          {pay ? (
            <div className="t-body" style={{ marginBottom: 6 }}>
              <b>{formatCents(pay.amountCents)}</b>
              <span className="mut"> {PAY_KINDS.find((k) => k.key === pay.kind)?.unit ?? pay.kind}</span>
              {pay.kind === "hourly" && <span className="mut"> · {pay.hoursPerWeek}h weeks</span>}
              {pay.title && <span className="mut"> · {pay.title}</span>}
              <span className="mut"> · since {pay.effectiveOn}</span>
            </div>
          ) : (
            <div className="mut t-small" style={{ marginBottom: 6 }}>
              Not on the payroll register yet.
            </div>
          )}
          {orgId !== null && !payOpen && (
            <button className="btn sm" onClick={() => setPayOpen(true)}>
              {pay ? "Change their pay" : "Put them on the payroll"}
            </button>
          )}
          {orgId !== null && payOpen && (
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>Kind</span>
                  <select value={payDraft.kind} aria-label="Pay kind" style={{ width: "auto" }}
                    onChange={(e) => setPayDraft({ ...payDraft, kind: e.target.value })}>
                    {PAY_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                  </select>
                </label>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>
                    Amount, {PAY_KINDS.find((k) => k.key === payDraft.kind)?.unit}
                  </span>
                  <input className="mono t-small" style={{ width: 110 }} value={payDraft.amount}
                    aria-label="Pay amount" placeholder={payDraft.kind === "hourly" ? "42.50" : "95,000"}
                    onChange={(e) => setPayDraft({ ...payDraft, amount: e.target.value })} />
                </label>
                {payDraft.kind === "hourly" && (
                  <label style={{ display: "block" }}>
                    <span className="mut t-meta" style={{ display: "block" }}>Hours a week</span>
                    <input className="mono t-small" style={{ width: 60 }} value={payDraft.hoursPerWeek}
                      aria-label="Hours a week"
                      onChange={(e) => setPayDraft({ ...payDraft, hoursPerWeek: e.target.value })} />
                  </label>
                )}
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>From</span>
                  <input type="date" value={payDraft.effectiveOn} aria-label="Effective on"
                    onChange={(e) => setPayDraft({ ...payDraft, effectiveOn: e.target.value })} />
                </label>
              </div>
              <label style={{ marginTop: 8 }}>Job title</label>
              <input value={payDraft.title} aria-label="Job title" placeholder="Field service engineer"
                onChange={(e) => setPayDraft({ ...payDraft, title: e.target.value })} />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn sm accent" disabled={pending}
                  onClick={() => run(() => addPayrollEntry(orgId, {
                    name: name || email, personEmail: email, title: payDraft.title,
                    kind: payDraft.kind, amount: payDraft.amount,
                    hoursPerWeek: parseInt(payDraft.hoursPerWeek, 10) || 40,
                    ftePct: pay?.ftePct ?? 100, burdenPct: pay?.burdenPct ?? 0,
                    effectiveOn: payDraft.effectiveOn, note: "",
                  }), pay ? "Pay changed - the old rate is closed out, history kept" : "On the payroll",
                  () => setPayOpen(false))}>
                  {pay ? "Record the change" : "Put them on"}
                </button>
                <button className="btn sm" onClick={() => setPayOpen(false)} disabled={pending}>Cancel</button>
              </div>
              {/* Said before the button, because it is the whole design. */}
              <div className="mut t-meta" style={{ marginTop: 6 }}>
                A change starts a new row and closes the old one the day before - what last
                quarter cost stays what last quarter cost.
              </div>
            </div>
          )}

          <div className="dialog-section" style={{ marginTop: 14 }}>
            Perks{perksMonthly > 0 ? <span className="mut t-meta"> · {formatCents(perksMonthly)} a month</span> : null}
          </div>
          {active.length === 0 && past.length === 0 && (
            <div className="mut t-small" style={{ marginBottom: 6 }}>Nothing on top of pay.</div>
          )}
          {[...active, ...past].map((x) => (
            <div key={x.id} className="row-2" style={{ alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
              <span className="t-body" style={{ flex: 1, minWidth: 0 }}>
                {x.title}
                <span className="mut t-meta">
                  {` · ${formatCents(x.amountCents)} ${CADENCE_LABEL[(x.cadence as "monthly")] ?? x.cadence}`}
                  {x.startsOn ? ` · from ${x.startsOn}` : ""}
                </span>
              </span>
              {!perkActiveOn(x, today) && <Pill tone="faint">{x.cadence === "one_off" ? "paid" : `ended ${x.endsOn}`}</Pill>}
              {perkActiveOn(x, today) && x.cadence !== "one_off" && orgId !== null && (
                <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
                  onClick={() => run(() => endPerk(x.id, today), "Ended - the history stays")}>end it</button>
              )}
              {orgId !== null && (
                <button className="btn link" style={{ fontSize: 12, color: "var(--t-bad-fg)" }} disabled={pending}
                  onClick={async () => {
                    const why = await confirmReason({
                      title: `Delete ${x.title}?`,
                      body: "For a row typed wrong - a perk that stopped should be ended, so the months it ran still say so.",
                      action: "Delete it", tone: "bad",
                    });
                    if (why) run(() => deletePerk(x.id, why), "Deleted");
                  }}>×</button>
              )}
            </div>
          ))}
          {orgId !== null && !perkOpen && (
            <button className="btn sm" style={{ marginTop: 6 }} onClick={() => setPerkOpen(true)}>+ Perk</button>
          )}
          {orgId !== null && perkOpen && (
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10, marginTop: 6 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                <label style={{ display: "block", flex: "1 1 160px" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>What</span>
                  <input value={perkDraft.title} aria-label="Perk" placeholder="Phone stipend"
                    onChange={(e) => setPerkDraft({ ...perkDraft, title: e.target.value })} />
                </label>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>Worth</span>
                  <input className="mono t-small" style={{ width: 90 }} value={perkDraft.amount}
                    aria-label="Perk amount" placeholder="85"
                    onChange={(e) => setPerkDraft({ ...perkDraft, amount: e.target.value })} />
                </label>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>Per</span>
                  <select value={perkDraft.cadence} aria-label="Perk cadence" style={{ width: "auto" }}
                    onChange={(e) => setPerkDraft({ ...perkDraft, cadence: e.target.value })}>
                    {PERK_CADENCES.map((c) => (
                      <option key={c} value={c}>{c === "one_off" ? "one-off" : c === "annual" ? "year" : "month"}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>From</span>
                  <input type="date" value={perkDraft.startsOn} aria-label="Perk starts"
                    onChange={(e) => setPerkDraft({ ...perkDraft, startsOn: e.target.value })} />
                </label>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn sm accent" disabled={pending}
                  onClick={() => run(() => addPerk(email, perkDraft), "Granted",
                    () => { setPerkOpen(false); setPerkDraft({ title: "", amount: "", cadence: "monthly", startsOn: today, note: "" }); })}>
                  Grant it
                </button>
                <button className="btn sm" onClick={() => setPerkOpen(false)} disabled={pending}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
