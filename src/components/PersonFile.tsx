"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  addPayrollEntry, addPerk, deletePerk, endPerk, removeMemberPaper, revokeHouseMember, saveMemberProfile,
  setHouseMember, uploadMemberPapers,
} from "@/app/actions";
import { fmtBytes } from "@/lib/storage";
import { siteLabel } from "@/lib/sites";
import { PAY_KINDS, type PayRow } from "@/lib/payroll";
import { CADENCE_LABEL, PERK_CADENCES, perkActiveOn, perkMonthlyCents, type PerkRow } from "@/lib/perks";
import { formatCents } from "@/lib/money";
import HomeBasePicker from "@/components/HomeBasePicker";
import type { WorksiteChoice } from "@/lib/sites";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

export type PersonProfile = {
  /** The roster name - what reports and the directory call them. */
  name: string;
  /** Their job title, on the account row: their own profile page shows it back to them. */
  title: string;
  homeAddress: string; phone: string; emergencyName: string; emergencyPhone: string;
  startedOn: string;
  /** Where they are stationed - one of the company's own site locations, or null. */
  siteId: number | null;
};

/** One of the company's own sites, for the staffed-location picker. */
export type OwnSite = { id: number; name: string; address: string; archived: boolean };

/** A paper on the person file: the contract, an offer letter, a certification. */
export type PaperRow = { id: number; fileName: string; kind: string; size: number; when: string };

/** One standing reimbursement of theirs, as the roster's card describes it. */
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
  sites = [], ownSites = [], papers = [], stipends = [], canManage = false, isMe = false,
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
  /** The company's own site locations - where somebody can be STATIONED. */
  ownSites?: OwnSite[];
  /** The paperwork on their file. */
  papers?: PaperRow[];
  /** Their standing reimbursements, read here and changed on the roster's card. */
  stipends?: StipendLine[];
  seesPay: boolean;
  /** The employing workspace - where a pay change is filed. Null hides the editors. */
  orgId: number | null;
  today: string;
  onClose: () => void;
  /** Owner: may change their privileges or revoke them from here. */
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
          <label>Staffed location</label>
          {/* WHERE THEY ARE STATIONED, as distinct from where they live: the
              shop, an office, the yard - one of the company's own sites. */}
          <select value={p.siteId ?? ""} aria-label="Staffed location" disabled={pending}
            onChange={(e) => setP({ ...p, siteId: e.target.value ? parseInt(e.target.value, 10) : null })}>
            <option value="">Not stationed anywhere in particular</option>
            {ownSites.filter((x) => !x.archived || x.id === p.siteId).map((x) => (
              <option key={x.id} value={x.id}>{siteLabel(x)}{x.archived ? " (closed)" : ""}</option>
            ))}
          </select>
        </div>
      </div>
      {ownSites.length === 0 && (
        <div className="field-hint">
          No site locations on file yet - add the shop and the offices under My organization › Site locations.
        </div>
      )}
      <label style={{ marginTop: 8 }}>Home address</label>
      <HomeBasePicker value={p.homeAddress} ariaLabel="Home address" sites={sites} disabled={pending}
        onChange={(homeAddress) => setP({ ...p, homeAddress })} />
      <div className="field-hint">
        Their point zero for the travel rulebook - the stipend radius and routed miles
        measure from here. A dedicated engineer stationed at a client starts from that
        client&apos;s lab: pick it above. They can also set it themselves.
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
          anything - internet, phone, tools. Read here; set up and changed on
          the Standing reimbursements card, which is the owner's. */}
      <div className="dialog-section" style={{ marginTop: 16 }}>Monthly reimbursements</div>
      {stipends.length === 0 && (
        <div className="mut t-small" style={{ marginBottom: 8 }}>
          No standing reimbursements. The owner sets one up under Standing reimbursements on the Employees page.
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
        </div>
      ))}

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
