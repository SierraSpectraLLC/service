"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import {
  setOrgAppearance, updateEodRecipients, updateDigestRecipients, setDigestHour, sendDigestNow,
  addClientAccess, addClientPerson, removeClientAccess,
  setClientAccessRole, setClientSeesAgreements, removeOrg, setSheetOrg, setOrgStorageLimit,
  setOrgRemoteAccess, setOrgStage, setOrgResale, setOrgShowNameDownstream, setClientTempPassword, clearClientTempPassword, setClientSeesPayroll,
  resendInvite,
  setClientSeesMoney,
  setStartView,
} from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { heldOutOfFleet, ORG_STAGES, stageHint, STAGE_WORD, type OrgStage } from "@/lib/orgStage";
import { TEMP_DAYS_DEFAULT, TEMP_DAYS_MAX } from "@/lib/tempPassword";
import { confirmDialog, confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import Panel from "@/components/ui/Panel";
import SaveBar from "@/components/ui/SaveBar";
import { isValidHex, readableTextOn } from "@/lib/theme";
import {
  clampHeight, gradientCss, parseStops, serializeStops, type Stop,
} from "@/lib/appearance";
import SpectrumEditor from "@/components/SpectrumEditor";
import { STORAGE_TIERS, type Quota } from "@/lib/storage";
import StorageMeter from "@/components/StorageMeter";
import { DAY_LABELS, WEEK_ORDER, parseDigestDays } from "@/lib/digestDays";

const MAX_LOGO_BYTES = 1024 * 1024; // a header logo, not a tune file

type Entry = {
  id: number; entry: string; canEdit: boolean; canSeeAgreements: boolean;
  /** From their account row, blank until somebody fills the profile in. */
  name?: string;
  title?: string;
  canSeePayroll?: boolean;
  canSeeMoney?: boolean;
  startView?: string;
  /** The view they picked for themselves, which outranks startView. "" = none. */
  ownView?: string;
  /** Whether they have ever actually been here. */
  signedIn?: boolean;
  /** "their own" | "expired" | "6d left" | "" - see lib/tempPassword. */
  password?: string;
};

/** A stored recipient list as addresses; the store is text, this is the list. */
const splitEmails = (s: string) => s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

/** "7:00 AM" - an hour of the day as somebody would say it out loud. */
const clockLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`;

/**
 * One organization's own settings page. It serves two audiences with the same
 * controls: the platform owner configuring any organization, and an
 * organization's own editors configuring theirs. Which of the two you are
 * decides what renders - `isOwner` gates the operator-level pieces (roles,
 * report recipients, sheet sync, removal) rather than hiding them behind a
 * second page that would drift from this one.
 */
export default function OrgSettingsForm({ org, people, sites = [], isStaff = false, platformName, platformSpectrum, isOwner, showRecipients, showSheetSync, showRemote = false, showDigest = false }: {
  org: {
    id: number; name: string; kind: string; themeColor: string; logoUrl: string;
    /** Blank = follow the platform. See lib/appearance.resolveLook. */
    spectrumStops: string;
    /** Null = follow the platform. Zero is a real answer: no bar at all. */
    spectrumHeight: number | null;
    eodRecipients: string; digestRecipients: string; digestHour: number; digestDays: string;
    systems: number; isOperator: boolean; isSheetOrg: boolean;
    storageLimitMb: number; quota: Quota;
    remoteAccessEnabled: boolean; remoteDevices: number;
    resaleEnabled: boolean;
    /** Whether their name follows their work downstream. Off by policy; theirs to turn on. */
    showNameDownstream: boolean;
    /** Where we stand with them: client | prospect | former. See lib/orgStage. */
    stage: OrgStage;
    /** Systems they OWN - what the fleet holds back at a non-client stage.
        Not `systems` above, which counts what has been shared with them. */
    ownedSystems: number;
  };
  /** Whether the instance has the remote-support module on at all. */
  showRemote?: boolean;
  /** Whether the instance has the daily-digest module on at all. */
  showDigest?: boolean;
  people: Entry[];
  /** This organization's own labs, for saying where a person sits. */
  sites?: { id: number; name: string }[];
  /**
   * Whether the viewer is the service team rather than the client themselves.
   * Temporary passwords are theirs alone to mint: a client's editor may invite
   * a colleague, but a credential that skips the mailbox is the shop's call.
   */
  isStaff?: boolean;
  platformName: string;
  /** What this workspace inherits when it has made no choice of its own. */
  platformSpectrum: { stops: Stop[]; height: number };
  isOwner: boolean;
  showRecipients: boolean;
  showSheetSync: boolean;
}) {
  const [pending, startTransition] = useTransition();

  // The page's one save bar: the panels edit drafts, the bar compares them to
  // the last stored state and saves whatever differs. Instant controls (roles,
  // toggles, invitations) stay instant - the bar carries only the drafts.
  const [base, setBase] = useState(() => ({
    themeColor: org.themeColor, logoUrl: org.logoUrl,
    spectrumStops: org.spectrumStops, spectrumHeight: org.spectrumHeight,
    eodRecipients: org.eodRecipients,
    digestTo: splitEmails(org.digestRecipients),
    hour: org.digestHour,
    days: (() => { const d = parseDigestDays(org.digestDays); return d.length ? d : [...WEEK_ORDER]; })(),
    limitMb: org.storageLimitMb,
  }));
  const [barMsg, setBarMsg] = useState("");
  const [barErr, setBarErr] = useState("");
  const clearBar = () => { setBarMsg(""); setBarErr(""); };

  // Appearance
  const [color, setColor] = useState(org.themeColor || "#172A4A");
  const [useDefault, setUseDefault] = useState(!org.themeColor);
  const [logo, setLogo] = useState(org.logoUrl);
  /* Inheriting is its own state, not a value. Blank stops mean "follow the
     platform, including when the platform moves", which no set of stops can
     express - so the checkbox is the control and the editor below it starts
     from whatever they would inherit. */
  const [ownBar, setOwnBar] = useState(org.spectrumStops.trim() !== "" || org.spectrumHeight !== null);
  const [stops, setStops] = useState<Stop[]>(
    org.spectrumStops.trim() ? parseStops(org.spectrumStops) : platformSpectrum.stops);
  const [bandH, setBandH] = useState(org.spectrumHeight ?? platformSpectrum.height);
  const [lookError, setLookError] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const effective = useDefault ? "#172A4A" : color;
  const fg = isValidHex(effective) ? readableTextOn(effective) : "#fff";

  const pickLogo = async (file: File) => {
    setLookError(""); clearBar();
    if (!/^image\/(png|jpeg|svg\+xml|webp)$/.test(file.type)) { setLookError("Logo must be a PNG, JPEG, SVG or WebP image"); return; }
    if (file.size > MAX_LOGO_BYTES) { setLookError("Logo must be under 1 MB"); return; }
    setUploading(true);
    try {
      const blob = await upload(`logos/${org.name}-${file.name}`, file, { access: "public", handleUploadUrl: "/api/upload" });
      setLogo(blob.url);
    } catch (e) {
      setLookError((e as Error).message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  // Remote support tier
  // The fleet pages read the flag server-side, so the switch has to make the
  // app go and look again rather than just repaint this card.
  const router = useRouter();
  const [stage, setStage] = useState<OrgStage>(org.stage);
  const [stageMsg, setStageMsg] = useState("");
  const [remoteOn, setRemoteOn] = useState(org.remoteAccessEnabled);
  // Resale: off unless this organization is actually in that business.
  const [resaleOn, setResaleOn] = useState(org.resaleEnabled);
  const [resaleMsg, setResaleMsg] = useState("");
  // Name downstream: the provider's own call, off until they make it.
  const [nameOn, setNameOn] = useState(org.showNameDownstream);
  const [nameMsg, setNameMsg] = useState("");
  const [remoteMsg, setRemoteMsg] = useState("");

  // Storage ceiling
  const [limitMb, setLimitMb] = useState(org.storageLimitMb);

  // Recipients
  const [recipients, setRecipients] = useState(org.eodRecipients);

  // The partner edition of the daily digest: who gets it, and when.
  //
  // Held as a LIST rather than the stored comma string. Typing addresses into
  // a text box is how a stray comma becomes a recipient nobody can see is
  // wrong; the people who could receive it are already known, so they are
  // ticked instead.
  const [digestTo, setDigestTo] = useState<string[]>(splitEmails(org.digestRecipients));
  const [digestExtra, setDigestExtra] = useState("");
  const [hour, setHour] = useState(org.digestHour);
  // [] means every day - the stored blank. The picker shows all seven ticked.
  const [sendDays, setSendDays] = useState<number[]>(() => {
    const d = parseDigestDays(org.digestDays);
    return d.length ? d : [...WEEK_ORDER];
  });
  const [digestMsg, setDigestMsg] = useState("");
  const [digestErr, setDigestErr] = useState(false);
  // Everyone who can be ticked: this organization's own logins, plus any
  // address already on the list that isn't one - a shared purchasing inbox is
  // a perfectly good recipient and must not silently vanish from the picker.
  const digestPeople = [...new Set([
    ...people.map((p) => p.entry.trim().toLowerCase()).filter((e) => e && !e.startsWith("@")),
    ...digestTo,
  ])];
  const digestDirty = digestTo.join(", ") !== base.digestTo.join(", ")
    || hour !== base.hour
    || [...sendDays].sort().join() !== [...base.days].sort().join();
  const toggleDay = (d: number) => {
    setDigestMsg(""); clearBar();
    setSendDays((list) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d]));
  };
  const toggleDigest = (email: string) => {
    setDigestMsg(""); clearBar();
    setDigestTo((list) => (list.includes(email) ? list.filter((x) => x !== email) : [...list, email]));
  };
  const addDigestExtra = () => {
    const v = digestExtra.trim().toLowerCase();
    if (!v) return;
    setDigestMsg(""); clearBar();
    setDigestTo((list) => (list.includes(v) ? list : [...list, v]));
    setDigestExtra("");
  };
  const sendDigest = async () => {
    if (!digestTo.length) { setDigestErr(true); setDigestMsg("Tick somebody first"); return; }
    if (digestDirty) { setDigestErr(true); setDigestMsg("Save your changes first"); return; }
    // Outward-facing and unrecallable, so it asks - and names the addresses,
    // because "send now" is only safe if you can see who now means.
    if (!(await confirmDialog({
      title: `Email ${org.name}'s digest now?`,
      body: `Goes to ${digestTo.join(", ")}.`,
      action: "Send digest",
    }))) return;
    setDigestMsg(""); setDigestErr(false);
    startTransition(async () => {
      const res = await sendDigestNow(org.id);
      setDigestErr(!!res?.error);
      setDigestMsg(res?.error ?? `Sent to ${res.to}`);
    });
  };

  const barStops = ownBar ? serializeStops(stops) : "";
  const barHeight = ownBar ? clampHeight(bandH) : null;
  const lookDirty = (useDefault ? "" : color) !== base.themeColor || logo !== base.logoUrl
    || barStops !== base.spectrumStops || barHeight !== base.spectrumHeight;
  const recipientsDirty = recipients !== base.eodRecipients;
  const limitDirty = limitMb !== base.limitMb;
  const dirty = lookDirty || recipientsDirty || digestDirty || limitDirty;

  const saveAll = () => {
    clearBar();
    startTransition(async () => {
      if (lookDirty) {
        const res = await setOrgAppearance({
          themeColor: useDefault ? "" : color, logoUrl: logo,
          spectrum: ownBar ? { stops, height: bandH } : null,
        }, org.id);
        if (res?.error) { setBarErr(res.error); return; }
      }
      if (recipientsDirty) {
        const res = await updateEodRecipients(org.id, recipients);
        if (res?.error) { setBarErr(res.error); return; }
      }
      if (digestDirty) {
        const res = await updateDigestRecipients(org.id, digestTo.join(", "));
        const res2 = res?.error ? null : await setDigestHour(org.id, hour, sendDays);
        const err = res?.error ?? res2?.error;
        if (err) { setBarErr(err); return; }
      }
      if (limitDirty) {
        const res = await setOrgStorageLimit(org.id, limitMb);
        if (res?.error) { setBarErr(res.error); return; }
      }
      setBase({
        themeColor: useDefault ? "" : color, logoUrl: logo,
        spectrumStops: barStops, spectrumHeight: barHeight,
        eodRecipients: recipients,
        digestTo: [...digestTo], hour, days: [...sendDays],
        limitMb,
      });
      setBarMsg("Saved");
    });
  };
  const discardAll = () => {
    clearBar(); setLookError("");
    setColor(base.themeColor || "#172A4A");
    setUseDefault(!base.themeColor);
    setLogo(base.logoUrl);
    setOwnBar(base.spectrumStops !== "" || base.spectrumHeight !== null);
    setStops(base.spectrumStops ? parseStops(base.spectrumStops) : platformSpectrum.stops);
    setBandH(base.spectrumHeight ?? platformSpectrum.height);
    setRecipients(base.eodRecipients);
    setDigestTo([...base.digestTo]);
    setHour(base.hour);
    setSendDays([...base.days]);
    setLimitMb(base.limitMb);
  };

  // People
  const [entry, setEntry] = useState("");
  const [role, setRole] = useState("viewer");
  const [peopleError, setPeopleError] = useState("");
  const [sent, setSent] = useState("");
  const invite = () => {
    const v = entry.trim();
    if (!v) return;
    setPeopleError(""); setSent("");
    startTransition(async () => {
      const res = await addClientAccess(v, org.id, role === "editor");
      if (res?.error) setPeopleError(res.error);
      else { setSent(v); setEntry(""); }
    });
  };

  // The whole person, typed once. The one-line invite above stays for the fast
  // case - an address, a role, done - and this is for setting a company up.
  const BLANK = {
    first: "", last: "", title: "", email: "", siteId: 0,
    role: "viewer", agreements: true, withPassword: false, days: TEMP_DAYS_DEFAULT,
  };
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(BLANK);
  const [addError, setAddError] = useState("");
  /**
   * A password, held on screen exactly as long as the person who set it needs
   * to read it out. It is never mailed and never stored in the clear, so this
   * is the only moment it exists anywhere a human can see it - which is the
   * whole point, and the reason the card says so out loud.
   */
  const [minted, setMinted] = useState<null | { who: string; password: string; expiresOn: string; mailed?: boolean; failed?: boolean }>(null);
  const addPerson = (invite: boolean) => {
    setAddError("");
    startTransition(async () => {
      const res = await addClientPerson(org.id, {
        firstName: draft.first, lastName: draft.last, title: draft.title, email: draft.email,
        siteId: draft.siteId || null, canEdit: draft.role === "editor",
        canSeeAgreements: draft.agreements, invite,
        withPassword: draft.withPassword, tempDays: draft.days,
      });
      if (res?.error) { setAddError(res.error); return; }
      const who = [draft.first, draft.last].filter(Boolean).join(" ") || draft.email.trim();
      toast({
        message: invite ? `Added ${who} and sent their invitation` : `Added ${who}`,
      });
      if (res.password && res.expiresOn) setMinted({ who, password: res.password, expiresOn: res.expiresOn });
      setAdding(false); setDraft(BLANK);
    });
  };
  const addProblem = !draft.email.trim() ? "their email address" : null;

  const [dangerError, setDangerError] = useState("");

  return (
    <>
      <Panel title={<>People at {org.name}</>}
        hint="Sign-in is by email code. Editors change; viewers read."
        actions={
          <button className="btn sm primary" onClick={() => { setDraft(BLANK); setAddError(""); setAdding(true); }}>
            + New
          </button>
        }>
        {people.map((r) => {
          const domain = r.entry.trim().startsWith("@");
          return (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
              {r.name ? (
                <span className="t-body" style={{ fontWeight: 600 }}>
                  {r.name}
                  {r.title && <span className="mut t-meta" style={{ fontWeight: 400 }}> · {r.title}</span>}
                </span>
              ) : null}
              <span className="mono t-body">{r.entry}</span>
              {domain && <span className="pill info">whole domain</span>}
              {/* Whether a password is standing in for the codes, and how much
                  longer. A loan nobody can see is a loan nobody takes back. */}
              {r.password === "expired" && <span className="pill bad" title="Their temporary password has expired">password expired</span>}
              {r.password && r.password !== "expired" && r.password !== "their own" && (
                <span className="pill warn" title="A temporary password an owner set">temp password · {r.password}</span>
              )}
              {isOwner ? (
                <select value={r.canEdit ? "editor" : "viewer"} disabled={pending} aria-label={`Role for ${r.entry}`}
                  onChange={(e) => startTransition(async () => { await setClientAccessRole(r.id, e.target.value === "editor"); })}
                  className="t-meta" style={{ width: "auto", padding: "1px 4px" }}>
                  <option value="viewer">viewer</option>
                  <option value="editor">editor</option>
                </select>
              ) : (
                <span className={`pill ${r.canEdit ? "good" : "neutral"}`}>
                  {r.canEdit ? "editor" : "viewer"}
                </span>
              )}
              {/* Seeing the systems and seeing what they cost are different
                  questions; one org has people on both sides of that line. */}
              {isOwner ? (
                <label className="t-meta" style={{ display: "flex", alignItems: "center", gap: 4, margin: 0, fontWeight: 400, color: "var(--slate)", textTransform: "none", letterSpacing: 0 }}
                  title="Whether this person may read this organization's agreements - contract value, allowances, the signed paper">
                  <input type="checkbox" checked={r.canSeeAgreements} disabled={pending} style={{ width: 14, height: 14 }}
                    onChange={(e) => startTransition(async () => { await setClientSeesAgreements(r.id, e.target.checked); })} />
                  agreements
                </label>
              ) : r.canSeeAgreements ? (
                <span className="pill neutral">agreements</span>
              ) : null}
              {/* Their organization's PAYROLL - everybody's pay, not just
                  their own, which they can always see. Off by default and
                  turned on one person at a time; granting it gives the shop
                  nothing, because the shop cannot read that payroll either. */}
              {isOwner ? (
                <label className="t-meta" style={{ display: "flex", alignItems: "center", gap: 4, margin: 0, fontWeight: 400, color: "var(--slate)", textTransform: "none", letterSpacing: 0 }}
                  title="Whether this person may read their own organization's payroll - what everyone there is paid. Nobody at your company can read it either way.">
                  <input type="checkbox" checked={!!r.canSeePayroll} disabled={pending || domain} style={{ width: 14, height: 14 }}
                    onChange={(e) => startTransition(async () => {
                      const res = await setClientSeesPayroll(r.id, e.target.checked);
                      if (res?.error) setPeopleError(res.error);
                      else toast({ message: e.target.checked ? `${r.entry} may read the payroll` : `${r.entry} no longer reads the payroll` });
                    })} />
                  payroll
                </label>
              ) : r.canSeePayroll ? (
                <span className="pill neutral">payroll</span>
              ) : null}
              {/* What their organization has been quoted and billed. On by
                  default - unlike payroll, and for the reason in
                  setClientSeesMoney: their org has no owner role to fall back
                  on, so this is taken away from a named person rather than
                  withheld from everybody. */}
              {isOwner ? (
                <label className="t-meta" style={{ display: "flex", alignItems: "center", gap: 4, margin: 0, fontWeight: 400, color: "var(--slate)", textTransform: "none", letterSpacing: 0 }}
                  title="Whether this person may read their own organization's quotes and invoices - what the work has cost them">
                  <input type="checkbox" checked={r.canSeeMoney !== false} disabled={pending} style={{ width: 14, height: 14 }}
                    onChange={(e) => startTransition(async () => {
                      const res = await setClientSeesMoney(r.id, e.target.checked);
                      if (res?.error) setPeopleError(res.error);
                      else toast({ message: e.target.checked ? `${r.entry} may read the quotes and invoices` : `${r.entry} no longer reads the quotes and invoices` });
                    })} />
                  quotes &amp; invoices
                </label>
              ) : r.canSeeMoney !== false ? (
                <span className="pill neutral">quotes &amp; invoices</span>
              ) : null}
              {/* WHERE THEY START. Every organization now has at least two
                  views - the card landing and the board - so the picker is a
                  real question for everybody; the pipeline joins the list only
                  where the company sells. A starting point only: the moment
                  they pick for themselves, theirs wins. See lib/viewMode. */}
              {isOwner && !domain && (
                <label className="t-meta" style={{ display: "flex", alignItems: "center", gap: 4, margin: 0, fontWeight: 400, color: "var(--slate)", textTransform: "none", letterSpacing: 0 }}
                  title="Which view this person opens the app in, until they choose for themselves">
                  starts in
                  <select value={r.startView ?? ""} disabled={pending}
                    aria-label={`Starting view for ${r.entry}`}
                    className="t-meta" style={{ width: "auto", padding: "1px 4px" }}
                    onChange={(e) => startTransition(async () => {
                      const res = await setStartView(r.id, e.target.value);
                      if (res?.error) setPeopleError(res.error);
                      else toast({ message: "Saved the starting view" });
                    })}>
                    <option value="">their company&apos;s default</option>
                    <option value="lab">Equipment</option>
                    <option value="board">The board</option>
                    {resaleOn && <option value="reseller">Sales pipeline</option>}
                  </select>
                  {/* A starting point loses to what the person chose for
                      themselves - said HERE, or an operator changes a setting
                      and watches nothing happen. */}
                  {!!r.ownView && (
                    <span className="mut" title="They picked a view for themselves, and their own choice wins over the starting view">
                      · they chose {r.ownView === "lab" ? "Equipment"
                        : r.ownView === "board" ? "the board"
                          : "the sales pipeline"}
                    </span>
                  )}
                </label>
              )}
              {isStaff && !domain && (
                <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                  {/* The invitation that matters is rarely the first one. Until
                      now the only way to send another was to remove the person
                      and add them back - a destructive edit standing in for a
                      resend, which also threw away everything set on the row. */}
                  <button className="btn link" disabled={pending}
                    title="Email their invitation again, with a new temporary password in it"
                    onClick={async () => {
                      if (!(await confirmDialog({
                        title: `Resend ${r.entry}'s invitation?`,
                        body: "They get the invitation again with a NEW temporary password printed in it. Any password they have now stops working.",
                        action: "Send it",
                      }))) return;
                      setPeopleError("");
                      startTransition(async () => {
                        const res = await resendInvite(r.id);
                        if (res?.error) { setPeopleError(res.error); return; }
                        setMinted({
                          who: r.name || r.entry, password: res.password!, expiresOn: res.expiresOn!,
                          mailed: res.mailed, failed: !res.mailed,
                        });
                        toast(res.mailed
                          ? { message: `Invitation resent to ${r.entry}` }
                          : { message: "Password set, but the email did not go out", tone: "bad" });
                      });
                    }}>resend invite</button>
                  <button className="btn link" disabled={pending}
                    title="Set a password they can use while sign-in codes are not arriving"
                    onClick={() => {
                      setPeopleError("");
                      startTransition(async () => {
                        const res = await setClientTempPassword(r.id);
                        if (res?.error) { setPeopleError(res.error); return; }
                        setMinted({ who: r.name || r.entry, password: res.password!, expiresOn: res.expiresOn! });
                      });
                    }}>
                    {r.password && r.password !== "their own" ? "new temp password" : "temp password"}
                  </button>
                  {r.password && r.password !== "their own" && (
                    <button className="btn link mut" disabled={pending}
                      onClick={async () => {
                        if (!(await confirmDialog({
                          title: `Remove ${r.entry}'s password?`,
                          body: "They go back to signing in by emailed code. Their access is unchanged.",
                          action: "Remove it",
                        }))) return;
                        startTransition(async () => {
                          const res = await clearClientTempPassword(r.id);
                          if (res?.error) { setPeopleError(res.error); return; }
                          toast({ message: `${r.entry} is back to codes` });
                        });
                      }}>clear</button>
                  )}
                </span>
              )}
              {(isOwner || !domain) && (
                <button className="btn link" style={{ marginLeft: isStaff && !domain ? 0 : "auto", color: "var(--t-bad-fg)" }} disabled={pending}
                  onClick={async () => {
                    if (!(await confirmDialog({
                      title: `Remove ${r.entry}?`,
                      body: "Anyone covered only by this entry is signed out immediately.",
                      action: `Remove ${r.entry}`, tone: "bad",
                    }))) return;
                    setPeopleError("");
                    startTransition(async () => {
                      await removeClientAccess(r.id);
                      toast({ message: `Removed ${r.entry}` });
                    });
                  }}>remove</button>
              )}
            </div>
          );
        })}
        {people.length === 0 && (
          <div className="mut t-small" style={{ padding: "6px 0" }}>Nobody here can sign in yet.</div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <input className="mono t-body" value={entry} onChange={(e) => setEntry(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") invite(); }}
            placeholder={isOwner ? "jane@company.com or @company.com" : "colleague@company.com"}
            style={{ flex: "1 1 190px" }} />
          <select value={role} onChange={(e) => setRole(e.target.value)} className="t-small" style={{ width: "auto" }}>
            <option value="viewer">viewer</option>
            <option value="editor">editor</option>
          </select>
          <button className="btn sm accent" onClick={invite} disabled={pending || !entry.trim()}>
            {pending ? "Inviting..." : "Invite"}
          </button>
        </div>
        {sent && <div className="t-small" style={{ color: "var(--t-good-fg)", marginTop: 6 }}>Invited {sent} - they got an email with a sign-in link.</div>}
        {peopleError && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{peopleError}</div>}

        {/* The one moment the password exists in the open. It was never mailed
            - mail is the thing that is broken - so this card is where somebody
            reads it off and says it down a phone. Dismissing it is the end of
            it: nothing here can show it again. */}
        {minted && (
          <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8, background: "#FAF0DC", border: "1px solid #E4CFA1" }}>
            <div className="t-small" style={{ fontWeight: 700, color: "var(--t-warn-fg)" }}>
              Temporary password for {minted.who}
            </div>
            <div className="mono t-page" style={{ letterSpacing: "0.02em", margin: "6px 0", userSelect: "all" }}>
              {minted.password}
            </div>
            <div className="mut t-meta">
              Works until {minted.expiresOn}, then sign-in goes back to emailed codes.{" "}
              {/* The same card serves both buttons, and the two differ on the
                  one fact somebody needs: whether they still have to make the
                  phone call. Saying "not in any email" after a resend mailed it
                  would be the app describing the opposite of what it just did. */}
              {minted.failed
                ? "The invitation email did NOT go out, and the password they had before has already stopped working - so this has to be read to them. It is the only time it is shown."
                : minted.mailed
                  ? "It is in the invitation they were just sent - this copy is here so you can read it to them as well."
                  : "Read it to them - it is not in any email, and this is the only time it is shown."}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn sm" onClick={() => {
                navigator.clipboard?.writeText(minted.password)
                  .then(() => toast({ message: "Copied" }))
                  .catch(() => toast({ message: "Select it and copy by hand", tone: "bad" }));
              }}>Copy</button>
              <button className="btn sm" onClick={() => setMinted(null)}>Done</button>
            </div>
          </div>
        )}
      </Panel>

      {adding && (
        <Dialog open onClose={() => setAdding(false)} title={`Add somebody at ${org.name}`} size="md"
          context="Their profile, what they may see, and how they get in."
          footer={
            <>
              <DialogStatus error={addError} problem={addProblem} ok="Ready to add." />
              <button className="btn" onClick={() => setAdding(false)} disabled={pending}>Cancel</button>
              <button className="btn" disabled={pending || !!addProblem} onClick={() => addPerson(false)}>
                Add quietly
              </button>
              <button className="btn accent" disabled={pending || !!addProblem} onClick={() => addPerson(true)}>
                {pending ? "Adding..." : "Add & invite"}
              </button>
            </>
          }>
          <div className="dialog-section">Who they are</div>
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div>
              <label>First name</label>
              <input value={draft.first} autoFocus placeholder="Rita"
                onChange={(e) => setDraft({ ...draft, first: e.target.value })} />
            </div>
            <div>
              <label>Last name</label>
              <input value={draft.last} placeholder="Alvarez"
                onChange={(e) => setDraft({ ...draft, last: e.target.value })} />
            </div>
            <div>
              <label>Job title</label>
              <input value={draft.title} placeholder="Lab manager"
                onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </div>
          </div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Email *</label>
              <input value={draft.email} inputMode="email" className="mono" placeholder="rita@company.com"
                onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            </div>
            {sites.length > 0 && (
              <div>
                <label>Which lab</label>
                <select value={draft.siteId || ""} aria-label="Which lab they sit at"
                  onChange={(e) => setDraft({ ...draft, siteId: parseInt(e.target.value) || 0 })}>
                  <option value="">Not saying</option>
                  {sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </div>
            )}
          </div>

          <div className="dialog-section">What they may do</div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}
              aria-label="Privileges" style={{ width: "auto" }}>
              <option value="viewer">Viewer - reads their systems and jobs</option>
              <option value="editor">Editor - reads, and asks for work</option>
            </select>
            <label className="t-body" style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
              <input type="checkbox" checked={draft.agreements} style={{ width: 15, height: 15 }}
                onChange={(e) => setDraft({ ...draft, agreements: e.target.checked })} />
              may read the agreements
            </label>
          </div>

          {isStaff && (
            <>
              <div className="dialog-section">How they get in</div>
              <label className="t-body" style={{ display: "flex", alignItems: "center", gap: 6, margin: "0 0 4px", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                <input type="checkbox" checked={draft.withPassword} style={{ width: 15, height: 15 }}
                  onChange={(e) => setDraft({ ...draft, withPassword: e.target.checked })} />
                Also set a temporary password
              </label>
              <div className="mut t-meta" style={{ marginBottom: draft.withPassword ? 8 : 0 }}>
                Normally they type their email and we mail a code. Tick this when mail is not
                getting through: we generate a password, show it to you once to read out, and it
                stops working on its own.
              </div>
              {draft.withPassword && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <label style={{ margin: 0 }}>Good for</label>
                  <input type="number" min={1} max={TEMP_DAYS_MAX} value={draft.days} aria-label="Days the password lasts"
                    onChange={(e) => setDraft({ ...draft, days: parseInt(e.target.value) || TEMP_DAYS_DEFAULT })}
                    style={{ width: 80 }} />
                  <span className="mut t-meta">days, then codes only</span>
                </div>
              )}
            </>
          )}
        </Dialog>
      )}

      <Panel title="Workspace appearance"
        hint={<>Applies to everyone signing in as {org.name}. Nobody else&apos;s workspace changes.</>}>

        {/* Live preview using the same color math AND the same gradient function
            as the real header, so what this shows is what the layout will
            paint - see lib/appearance.resolveLook, which both go through. */}
        <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid var(--line)", marginBottom: 10 }}>
          <div style={{
            height: ownBar ? bandH : platformSpectrum.height,
            background: gradientCss(ownBar ? stops : platformSpectrum.stops),
          }} />
          <div style={{ background: effective, color: fg, display: "flex", alignItems: "center", gap: 10, padding: "10px 14px" }}>
            {logo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt={`${org.name} logo`} style={{ height: 22, maxWidth: 100, objectFit: "contain" }} />
            )}
            {/* Exactly what the header renders - wordmark, then × and the
                workspace. It used to print the platform name twice, once as the
                wordmark and again inside the lockup, which is not what anybody
                sees on the page it is previewing. */}
            <span className="t-lead" style={{ fontWeight: 700, letterSpacing: 0.3 }}>{platformName.toUpperCase()}</span>
            <span className="t-meta" style={{ opacity: 0.75 }}>× {org.name}</span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label className="t-small" style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, fontWeight: 400, color: "var(--ink)" }}>
            <input type="checkbox" checked={useDefault} style={{ width: "auto" }}
              onChange={(e) => { setUseDefault(e.target.checked); clearBar(); }} />
            Default look
          </label>
          {!useDefault && (
            <label className="t-small" style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, fontWeight: 400, color: "var(--ink)" }}>
              Header color
              <input type="color" value={isValidHex(color) ? color : "#172A4A"}
                onChange={(e) => { setColor(e.target.value); clearBar(); }}
                style={{ width: 34, height: 28, padding: 2, border: "1px solid var(--line)", borderRadius: 6, background: "#fff", cursor: "pointer" }} />
            </label>
          )}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) pickLogo(f); }} />
          <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? "Uploading..." : logo ? "Replace logo" : "Add logo"}
          </button>
          {logo && <button className="btn link" onClick={() => { setLogo(""); clearBar(); }}>remove logo</button>}
        </div>
        {lookError && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{lookError}</div>}

        {/* The spectrum: the thin gradient above the header, and the one piece
            of the design that is purely identity. The same editor the platform
            gets, so the two cannot drift into different behaviours over one
            validated shape. */}
        <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <div className="t-small" style={{ fontWeight: 700, color: "var(--navy)", marginBottom: 6 }}>
            Spectrum
          </div>
          <SpectrumEditor
            stops={stops} height={bandH} disabled={pending}
            inheriting={!ownBar}
            inheritLabel={`Follow ${platformName}'s spectrum`}
            onInheriting={(follow) => {
              clearBar();
              setOwnBar(!follow);
              // Starting from what they were inheriting, so turning the switch
              // on changes nothing until they move a control - the alternative
              // is a workspace repainted by a checkbox.
              if (follow) { setStops(platformSpectrum.stops); setBandH(platformSpectrum.height); }
            }}
            onStops={(next) => { clearBar(); setStops(next); }}
            onHeight={(next) => { clearBar(); setBandH(next); }}
          />
        </div>
      </Panel>

      {isOwner && showRecipients && (
        <Panel title="Daily report"
          hint={<>Where {org.name}&apos;s daily update goes. Comma-separated; empty means no report is sent for them.</>}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input className="mono t-small" value={recipients}
              onChange={(e) => { setRecipients(e.target.value); clearBar(); }}
              placeholder="nobody - no report is sent" style={{ flex: "1 1 220px" }} />
          </div>
        </Panel>
      )}

      {isOwner && showDigest && (
        <Panel title="Daily digest"
          hint={<>Who at {org.name} receives their edition each morning - their systems&apos; status,
            yesterday&apos;s work, and what&apos;s waiting on whom. Nobody ticked means their
            digest stays internal.</>}>
          {digestPeople.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 8 }}>
              {digestPeople.map((email) => (
                <label key={email} style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer", padding: "2px 0" }}>
                  <input type="checkbox" checked={digestTo.includes(email)} disabled={pending}
                    onChange={() => toggleDigest(email)} style={{ width: "auto", margin: 0 }} />
                  <span className="mono t-small">{email}</span>
                  {!people.some((p) => p.entry.trim().toLowerCase() === email) && (
                    <span className="mut t-meta">not a login here</span>
                  )}
                </label>
              ))}
            </div>
          ) : (
            <div className="mut t-small" style={{ marginBottom: 8 }}>
              Nobody from {org.name} can sign in yet - add their address below, or invite them under People.
            </div>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
            <input className="mono t-small" value={digestExtra} placeholder="another address"
              onChange={(e) => { setDigestExtra(e.target.value); setDigestMsg(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDigestExtra(); } }}
              style={{ flex: "1 1 200px" }} />
            <button className="btn sm" onClick={addDigestExtra} disabled={pending || !digestExtra.trim()}>Add</button>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
            <span className="mut t-small">Sends at</span>
            <select value={hour} disabled={pending}
              onChange={(e) => { setHour(parseInt(e.target.value)); setDigestMsg(""); }}
              className="t-small" style={{ width: "auto" }}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{clockLabel(h)}</option>)}
            </select>
            <span className="mut t-small">shop time, on</span>
            {WEEK_ORDER.map((d) => (
              <label key={d} className="t-meta" style={{ display: "flex", gap: 3, alignItems: "center", margin: 0, fontWeight: 400, cursor: "pointer" }}>
                <input type="checkbox" checked={sendDays.includes(d)} disabled={pending}
                  onChange={() => toggleDay(d)} style={{ width: "auto", margin: 0 }} />
                {DAY_LABELS[d]}
              </label>
            ))}
          </div>
          {sendDays.length > 0 && sendDays.length < 7 && (
            <div className="mut t-meta" style={{ marginTop: -4, marginBottom: 10 }}>
              Days it rests fold into the next edition - Monday&apos;s digest covers the weekend&apos;s
              work under its own days, and says nothing extra if there was none.
            </div>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <a className="btn sm" href={`/api/digest/preview?org=${org.id}`} target="_blank" rel="noreferrer">Preview</a>
            <button className="btn sm" onClick={sendDigest} disabled={pending}>Send now</button>
          </div>
          <div className="mut t-meta" style={{ marginTop: 6 }}>
            Preview shows today&apos;s edition with real data and sends nothing. Send now emails it
            immediately and counts as today&apos;s, so the schedule won&apos;t send a second copy.
          </div>
          {digestMsg && (
            <div className="t-small" style={{ marginTop: 6, color: digestErr ? "#A32D2D" : "#2E6B2E" }}>{digestMsg}</div>
          )}
        </Panel>
      )}

      {isOwner && (
        <Panel title="Resale"
          hint={<>Off unless {org.name} deals in used equipment. When it is off, systems and units
            carry no listing controls at all - anything already listed keeps its own, so
            turning this off never strands a live listing.</>}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button className={`btn sm${resaleOn ? "" : " accent"}`} disabled={pending}
              onClick={() => {
                const next = !resaleOn;
                setResaleOn(next); setResaleMsg("");
                startTransition(async () => {
                  const res = await setOrgResale(org.id, next);
                  if (res?.error) { setResaleOn(!next); setResaleMsg(res.error); }
                });
              }}>
              {resaleOn ? "Turn resale off" : "Turn resale on"}
            </button>
            <span className={`pill ${resaleOn ? "good" : "neutral"}`}>
              {resaleOn ? "can list equipment for sale" : "not a reseller"}
            </span>
          </div>
          {resaleMsg && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{resaleMsg}</div>}
        </Panel>
      )}

      {/* THE PROVIDER'S NAME, THEIR CALL. When a machine they serviced changes
          hands, the record of that work goes with it. The holder is anonymized
          by rule; whether the shop that did the work is named is the shop's
          decision, and nobody makes it for them. Off is the policy default
          (ADR 0001) because a shop that services four instruments in one
          county is identified by its own name in one guess. */}
      {isOwner && (
        <Panel title="Your name travels with your work"
          hint={<>When an instrument {org.name} has worked on is sold, the record of that work goes
            with it. The owner at the time is never named. Whether {org.name} is - as the author
            of those service lines - is up to {org.name}.</>}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button className={`btn sm${nameOn ? "" : " accent"}`} disabled={pending}
              onClick={() => {
                const next = !nameOn;
                setNameOn(next); setNameMsg("");
                startTransition(async () => {
                  const res = await setOrgShowNameDownstream(org.id, next);
                  if (res?.error) { setNameOn(!next); setNameMsg(res.error); }
                });
              }}>
              {nameOn ? "Withhold our name" : "Let our name travel"}
            </button>
            <span className={`pill ${nameOn ? "good" : "neutral"}`}>
              {nameOn ? "named on work that changes hands" : "shown as \u201cService provider (name withheld)\u201d"}
            </span>
          </div>
          <div className="field-hint" style={{ marginTop: 8 }}>
            Worth knowing before turning it on: a shop that services a handful of instruments in one
            area can be identified from its name alone, even with every customer anonymized. A
            national outfit gets free advertising; a regional one gets found. The choice is yours
            and can be changed any time - it applies to records that travel from then on.
          </div>
          {nameMsg && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{nameMsg}</div>}
        </Panel>
      )}

      {/* The state the app had no word for, and then the second one. Quoting a
          company means creating it and its systems, and those systems joined
          the working fleet - so one quote put a stranger's machines on the
          board, in the metrics and on the maintenance calendar. A company that
          STOPPED buying left its machines there for the opposite reason.

          Three buttons rather than a toggle, because there are three states
          and a toggle can only hold two - which is what sent the shop asking
          for the third. Nothing here moves or deletes anything at any stage;
          it changes which systems the fleet queries ask for. */}
      {isOwner && !org.isOperator && org.kind === "client" && (
        <Panel title="Where we stand with them" hint={stageHint(stage, org.name, org.ownedSystems)}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {ORG_STAGES.map((k) => (
              <button key={k} className={`btn sm${stage === k ? " accent" : ""}`}
                disabled={pending || stage === k}
                onClick={() => {
                  const was = stage;
                  setStage(k); setStageMsg("");
                  startTransition(async () => {
                    const res = await setOrgStage(org.id, k);
                    if (res?.error) { setStage(was); setStageMsg(res.error); }
                    else router.refresh();
                  });
                }}>
                {STAGE_WORD[k]}
              </button>
            ))}
            {/* No pill. The accented button and the sentence above it already
                say which stage this is, and a third copy beside them was just
                the word twice in a row. The roster keeps its pill, where it
                is the only thing saying so. */}
            {org.ownedSystems > 0 && (
              <span className="mut t-meta">
                {org.ownedSystems} system{org.ownedSystems === 1 ? "" : "s"} on file
                {heldOutOfFleet(stage) ? ", held out of the fleet" : ""}
              </span>
            )}
          </div>
          {/* The half of "former client" that is not about hiding anything.
              Said here because the button is where somebody decides, and the
              worry it answers - that marking them former loses the history -
              is the reason a shop would leave a dead account in the fleet. */}
          {stage === "former" && (
            <div className="mut t-small" style={{ marginTop: 8 }}>
              Their records are untouched and stay editable: you can still file what you
              learn about those machines, and hand the provenance on with them if they
              are sold. Making them a client again puts everything straight back.
            </div>
          )}
          {stageMsg && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{stageMsg}</div>}
        </Panel>
      )}

      {isOwner && showRemote && (
        <Panel title="Remote support"
          hint={<>Lets {org.name}&apos;s own editors connect to their machines. Ours is unaffected.{" "}
            {org.remoteDevices > 0
              ? `${org.remoteDevices} machine${org.remoteDevices === 1 ? "" : "s"} enrolled.`
              : "No machines enrolled."}</>}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button className={`btn sm${remoteOn ? "" : " accent"}`} disabled={pending}
              onClick={() => {
                const next = !remoteOn;
                setRemoteOn(next); setRemoteMsg("");
                startTransition(async () => {
                  const res = await setOrgRemoteAccess(org.id, next);
                  if (res?.error) { setRemoteOn(!next); setRemoteMsg(res.error); }
                });
              }}>
              {remoteOn ? "Turn client access off" : "Turn client access on"}
            </button>
            <span className={`pill ${remoteOn ? "good" : "neutral"}`}>
              {remoteOn ? "their editors can connect" : "support only"}
            </span>
          </div>
          {remoteMsg && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{remoteMsg}</div>}
        </Panel>
      )}

      {isOwner && (
        <Panel title="File storage">
          <StorageMeter quota={org.quota} hint="" />
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
            <select value={STORAGE_TIERS.some((t) => t.mb === limitMb) ? String(limitMb) : "custom"}
              aria-label={`File storage limit for ${org.name}`} className="t-small" style={{ width: "auto" }}
              onChange={(e) => { if (e.target.value !== "custom") { setLimitMb(parseInt(e.target.value)); clearBar(); } }}>
              {STORAGE_TIERS.map((t) => <option key={t.mb} value={t.mb}>{t.label}</option>)}
              {!STORAGE_TIERS.some((t) => t.mb === limitMb) && <option value="custom">{limitMb} MB (custom)</option>}
            </select>
            <input value={String(limitMb)} inputMode="numeric" aria-label="Limit in megabytes"
              onChange={(e) => { setLimitMb(Math.max(0, parseInt(e.target.value.replace(/\D/g, "")) || 0)); clearBar(); }}
              className="t-small" style={{ width: 90 }} />
            <span className="mut t-meta">MB · 0 = no limit</span>
          </div>
        </Panel>
      )}

      {isOwner && (
        <Panel title="Operator controls"
          hint={org.isOperator
            ? `${org.name} operates this instance, so it is named on sign-off packets and reports.`
            : `${org.name} is one of the organizations on this instance.`}>
          {/* Offered to clients, and always to whoever is currently syncing: an
              organization switched from client to provider while named here would
              otherwise take the only control with it. */}
          {showSheetSync && (org.kind === "client" || org.isSheetOrg) && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
              <span className="t-body">Google Sheet tracker</span>
              {org.isSheetOrg ? (
                <>
                  <span className="pill good">syncing with {org.name}</span>
                  {/* The way back out. Setting the tracker was reversible in the
                      action all along; there was simply no control for it, so the
                      first organization named here became permanent. */}
                  <button className="btn sm" style={{ marginLeft: "auto" }} disabled={pending}
                    onClick={async () => {
                      if (!(await confirmDialog({
                        title: `Stop syncing the tracker sheet with ${org.name}?`,
                        body: "Their systems stay exactly as they are - only the sheet stops being read and written.",
                        action: "Stop syncing",
                      }))) return;
                      startTransition(async () => {
                        await setSheetOrg(null);
                        // Setting the tracker was reversible in the action all
                        // along (see the comment above) - so Undo is real.
                        toast({ message: "Stopped syncing the tracker sheet", undo: () => { void setSheetOrg(org.id); } });
                      });
                    }}>stop syncing</button>
                </>
              ) : (
                <button className="btn sm" disabled={pending}
                  onClick={() => startTransition(async () => { await setSheetOrg(org.id); })}>
                  use {org.name}&apos;s sheet
                </button>
              )}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
            <span className="t-body">Remove this organization</span>
            <span className="mut t-meta">
              {people.length} sign-in{people.length === 1 ? "" : "s"} stop working, access to {org.systems} system
              {org.systems === 1 ? "" : "s"} ends. The systems and their history are untouched.
            </span>
            <button className="btn sm" style={{ marginLeft: "auto", color: "var(--t-bad-fg)" }} disabled={pending}
              onClick={async () => {
                const reason = await confirmReason({
                  title: `Remove ${org.name}?`,
                  body: `${org.isOperator ? "It operates this instance - reports and packets lose their operator name. " : ""}Their ${people.length} sign-in entr${people.length === 1 ? "y" : "ies"} stop working and they lose access to ${org.systems} system${org.systems === 1 ? "" : "s"}.`,
                  action: "Remove", tone: "bad",
                });
                if (!reason) return;
                setDangerError("");
                startTransition(async () => {
                  const res = await removeOrg(org.id, reason);
                  if (res?.error) setDangerError(res.error);
                  // This page is about an organization that no longer exists.
                  else window.location.assign("/settings/organizations");
                });
              }}>remove</button>
          </div>
          {dangerError && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{dangerError}</div>}
        </Panel>
      )}

      {/* Roles, toggles and invitations save themselves; the bar carries the
          drafts - look, recipients, digest, storage. */}
      <SaveBar dirty={dirty} saving={pending} message={barMsg} error={barErr}
        label="Save changes" onSave={saveAll} onDiscard={discardAll} />
    </>
  );
}
