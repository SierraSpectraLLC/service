"use client";

import { useRef, useState, useTransition } from "react";
import {
  addStage, setStageColor, renameStage, deleteStage,
  setBranding, setOperatorOrg, setModule, setDigestHour, sendDigestNow,
  setPlatformAppearance,
} from "@/app/actions";
import { confirmDialog, inputDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import Panel from "@/components/ui/Panel";
import Field from "@/components/ui/Field";
import SaveBar from "@/components/ui/SaveBar";
import {
  DEFAULT_HEADER, DEFAULT_SPECTRUM_HEIGHT, DEFAULT_STOPS,
  gradientCss, type Stop,
} from "@/lib/appearance";
import { DAY_LABELS, WEEK_ORDER, parseDigestDays } from "@/lib/digestDays";
import SpectrumEditor from "@/components/SpectrumEditor";
import { isValidHex, readableTextOn, tint } from "@/lib/theme";

/** "7:00 AM" - an hour of the day as somebody would say it out loud. */
const clockLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`;

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label}
      style={{ width: 42, height: 24, borderRadius: 999, border: "none", cursor: "pointer", background: on ? "var(--coral)" : "var(--line)", position: "relative", flexShrink: 0, padding: 0 }}>
      <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 120ms" }} />
    </button>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>{children}</div>;
}

type StageRow = { id: number; name: string; bg: string; fg: string; builtin: boolean };
type OrgRow = { id: number; name: string; kind: string };

/**
 * The instance itself: what it's called, who operates it, which optional
 * workflows run, and the stages work moves through. Nothing here is about a
 * particular person or company (that's Personnel) or a piece of equipment
 * (that's Catalog).
 */
export default function ConfigurationForm(props: {
  stageDefs: StageRow[];
  orgs: OrgRow[];
  modules: { sheetSync: boolean; eod: boolean; digest: boolean; remote: boolean; publicCatalog: boolean };
  platformName: string; platformTagline: string; publicContactEmail: string; operatorOrgId: number | null;
  /** When the internal edition of the daily digest goes out, in shop time. */
  digestHour: number;
  /** Which weekdays, as stored ("" = every day). */
  digestDays: string;
  /** Who it goes to today, for the line under the schedule. Display only. */
  digestTo: string[];
  /** The look, as stored: blank header colour means "the stock navy". */
  appearance: { headerColor: string; spectrumHeight: number; spectrumStops: Stop[] };
}) {
  const [moduleState, setModuleState] = useState<Record<string, boolean>>({});
  const [pending, startTransition] = useTransition();

  // The internal digest's schedule. Its recipients are the workspace's staff
  // (Settings > Personnel), so this shows them rather than offering a second
  // list that would drift from who actually works here.
  const [digestHour, setDigestHourState] = useState(props.digestHour);
  const [digestDaysSel, setDigestDaysSel] = useState<number[]>(() => {
    const d = parseDigestDays(props.digestDays);
    return d.length ? d : [...WEEK_ORDER];
  });
  const [digestMsg, setDigestMsg] = useState("");
  const [digestErr, setDigestErr] = useState(false);
  const saveDigestSchedule = (hour: number, days: number[]) => {
    setDigestMsg(""); setDigestErr(false);
    startTransition(async () => {
      const res = await setDigestHour(null, hour, days);
      if (res?.error) { setDigestErr(true); setDigestMsg(res.error); }
    });
  };
  const sendDigest = async () => {
    if (!(await confirmDialog({
      title: "Email the internal digest now?",
      body: `Goes to ${props.digestTo.join(", ") || "nobody"}.`,
      action: "Send digest",
    }))) return;
    setDigestMsg(""); setDigestErr(false);
    startTransition(async () => {
      const res = await sendDigestNow(null);
      setDigestErr(!!res?.error);
      setDigestMsg(res?.error ?? `Sent to ${res.to}`);
    });
  };

  // The page's one save bar. Panels edit a draft; the bar compares it to the
  // last stored state and saves whatever differs, so there is exactly one
  // Save on the page however many panels it grows.
  const [base, setBase] = useState({
    name: props.platformName, tagline: props.platformTagline, contactEmail: props.publicContactEmail,
    headerColor: props.appearance.headerColor,
    spectrumHeight: props.appearance.spectrumHeight,
    spectrumStops: props.appearance.spectrumStops,
  });
  const [barMsg, setBarMsg] = useState("");
  const [barErr, setBarErr] = useState("");
  const clearBar = () => { setBarMsg(""); setBarErr(""); };

  const [brandDraft, setBrandDraft] = useState({
    name: props.platformName, tagline: props.platformTagline, contactEmail: props.publicContactEmail,
  });
  const [opError, setOpError] = useState("");

  // ---- Appearance -------------------------------------------------------
  // Every control writes to local state and the preview redraws from it, so
  // what the strip shows is what saving would store - the same gradientCss the
  // page itself will render, not an approximation of it.
  const [header, setHeader] = useState(props.appearance.headerColor || DEFAULT_HEADER);
  const [headerDefault, setHeaderDefault] = useState(!props.appearance.headerColor);
  const [bandH, setBandH] = useState(props.appearance.spectrumHeight);
  const [stops, setStops] = useState<Stop[]>(props.appearance.spectrumStops);

  const effectiveHeader = headerDefault ? DEFAULT_HEADER : header;
  const headerOk = isValidHex(effectiveHeader);
  const previewFg = headerOk ? readableTextOn(effectiveHeader) : "#fff";
  const resetLook = () => {
    clearBar();
    setHeaderDefault(true); setHeader(DEFAULT_HEADER);
    setBandH(DEFAULT_SPECTRUM_HEIGHT); setStops(DEFAULT_STOPS);
  };

  const brandDirty = brandDraft.name !== base.name || brandDraft.tagline !== base.tagline
    || brandDraft.contactEmail !== base.contactEmail;
  const lookDirty = (headerDefault ? "" : header) !== base.headerColor
    || bandH !== base.spectrumHeight
    || JSON.stringify(stops) !== JSON.stringify(base.spectrumStops);
  const dirty = brandDirty || lookDirty;

  const saveAll = () => {
    clearBar();
    if (brandDirty && !brandDraft.name.trim()) { setBarErr("The platform needs a name"); return; }
    if (lookDirty && !headerDefault && !isValidHex(header)) {
      setBarErr("The header color needs to be a hex like #1D9E75");
      return;
    }
    startTransition(async () => {
      if (brandDirty) {
        const res = await setBranding(brandDraft);
        if (res?.error) { setBarErr(res.error); return; }
      }
      if (lookDirty) {
        const res = await setPlatformAppearance({
          headerColor: headerDefault ? "" : header,
          spectrumHeight: bandH,
          spectrumStops: stops,
        });
        if (res?.error) { setBarErr(res.error); return; }
      }
      setBase({
        name: brandDraft.name, tagline: brandDraft.tagline, contactEmail: brandDraft.contactEmail,
        headerColor: headerDefault ? "" : header,
        spectrumHeight: bandH, spectrumStops: stops,
      });
      setBarMsg("Saved");
    });
  };
  const discardAll = () => {
    clearBar();
    setBrandDraft({ name: base.name, tagline: base.tagline, contactEmail: base.contactEmail });
    setHeader(base.headerColor || DEFAULT_HEADER);
    setHeaderDefault(!base.headerColor);
    setBandH(base.spectrumHeight);
    setStops(base.spectrumStops);
  };

  const [stageDraft, setStageDraft] = useState({ name: "", bg: "#C9DAF8" });
  const [stageError, setStageError] = useState("");
  const [colors, setColors] = useState<Record<number, string>>({});
  const colorTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const changeColor = (id: number, bg: string) => {
    setColors((c) => ({ ...c, [id]: bg }));
    if (colorTimers.current[id]) clearTimeout(colorTimers.current[id]);
    colorTimers.current[id] = setTimeout(() => startTransition(() => setStageColor(id, bg)), 600);
  };
  const submitStage = () => {
    if (!stageDraft.name.trim()) return;
    setStageError("");
    startTransition(async () => {
      const res = await addStage(stageDraft.name, stageDraft.bg);
      if (res?.error) setStageError(res.error);
      else setStageDraft({ name: "", bg: "#C9DAF8" });
    });
  };
  const doRename = async (s: StageRow) => {
    const next = await inputDialog({
      title: `Rename stage "${s.name}"`, action: "Rename",
      label: "New name", initial: s.name,
    });
    if (!next || next === s.name) return;
    setStageError("");
    startTransition(async () => {
      const res = await renameStage(s.id, next);
      if (res?.error) setStageError(res.error);
    });
  };
  const doDelete = async (s: StageRow) => {
    if (!(await confirmDialog({
      title: `Delete stage "${s.name}"?`,
      body: "It will be removed from any system that has it.",
      action: `Delete ${s.name}`, tone: "bad",
    }))) return;
    setStageError("");
    startTransition(async () => {
      const res = await deleteStage(s.id);
      if (res?.error) setStageError(res.error);
      else toast({ message: `Deleted the ${s.name} stage` });
    });
  };

  return (
    <>
      <Panel title="This instance"
        hint="">
        <div className="pf2">
          <Field label="Name">
            <input value={brandDraft.name} onChange={(e) => { clearBar(); setBrandDraft({ ...brandDraft, name: e.target.value }); }}
              placeholder="e.g. Instrapath" />
          </Field>
          <Field label="Tagline">
            <input value={brandDraft.tagline} onChange={(e) => { clearBar(); setBrandDraft({ ...brandDraft, tagline: e.target.value }); }}
              placeholder="instrument portal" />
          </Field>
        </div>
        {/* The one address a stranger can reach. Blank on purpose takes the
            inquiry buttons off the landing page rather than mailing nowhere. */}
        <Field label="Public contact address"
          hint="Where inquiries from the home page go. Leave blank to show no contact button.">
          <input type="email" value={brandDraft.contactEmail}
            onChange={(e) => { clearBar(); setBrandDraft({ ...brandDraft, contactEmail: e.target.value }); }}
            placeholder="hello@ridgelinefield.com" />
        </Field>
        {/* Names an operator the moment it's picked - who runs the instance is
            not a draft to sit unsaved behind a bar. */}
        <Field label="Operated by"
          hint="Named on sign-off packets and reports."
          error={opError || undefined}>
          <select value={props.operatorOrgId ?? ""} disabled={pending}
            onChange={(e) => {
              const next = e.target.value ? parseInt(e.target.value) : null;
              setOpError("");
              startTransition(async () => {
                const res = await setOperatorOrg(next);
                if (res?.error) setOpError(res.error);
              });
            }}
            className="t-small" style={{ width: "auto" }}>
            <option value="">nobody - use the platform name</option>
            {props.orgs.filter((o) => o.kind === "provider").map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </Field>

        <SubHead>Modules</SubHead>
        <div className="mut t-meta" style={{ marginBottom: 6 }}>
          Off hides their pages and silences their scheduled runs.
        </div>
        {([
          ["sheetSync", "Google Sheet tracker sync", props.modules.sheetSync],
          ["eod", "Daily client reports", props.modules.eod],
          ["digest", "Daily staff digest", props.modules.digest],
          ["remote", "Remote support", props.modules.remote],
          ["publicCatalog", "Public equipment library", props.modules.publicCatalog],
        ] as const).map(([key, label, on]) => (
          <div key={key} style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <Toggle on={moduleState[key] ?? on} label={label}
                onClick={() => {
                  const next = !(moduleState[key] ?? on);
                  setModuleState((m) => ({ ...m, [key]: next }));
                  startTransition(async () => { await setModule(key, next); });
                }} />
              <div className="t-body" style={{ fontWeight: 700 }}>{label}</div>
            </div>
            {/* The digest's own schedule sits with its switch: an email that
                goes out every morning is worth being able to time, preview and
                send by hand from the place you turned it on. */}
            {key === "digest" && (moduleState[key] ?? on) && (
              <div style={{ margin: "8px 0 4px 54px" }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="mut t-small">Sends at</span>
                  <select value={digestHour} disabled={pending}
                    onChange={(e) => {
                      const next = parseInt(e.target.value);
                      setDigestHourState(next);
                      saveDigestSchedule(next, digestDaysSel);
                    }}
                    className="t-small" style={{ width: "auto" }}>
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{clockLabel(h)}</option>)}
                  </select>
                  <span className="mut t-small">shop time, on</span>
                  {WEEK_ORDER.map((d) => (
                    <label key={d} className="t-meta" style={{ display: "flex", gap: 3, alignItems: "center", margin: 0, fontWeight: 400, cursor: "pointer" }}>
                      <input type="checkbox" checked={digestDaysSel.includes(d)} disabled={pending}
                        onChange={() => {
                          const next = digestDaysSel.includes(d)
                            ? digestDaysSel.filter((x) => x !== d)
                            : [...digestDaysSel, d];
                          setDigestDaysSel(next);
                          if (next.length) saveDigestSchedule(digestHour, next);
                          else { setDigestErr(true); setDigestMsg("Pick at least one day"); }
                        }} style={{ width: "auto", margin: 0 }} />
                      {DAY_LABELS[d]}
                    </label>
                  ))}
                  <a className="btn sm" href="/api/digest/preview" target="_blank" rel="noreferrer">Preview</a>
                  <button className="btn sm" onClick={sendDigest} disabled={pending}>Send now</button>
                </div>
                <div className="mut t-meta" style={{ marginTop: 4 }}>
                  {props.digestTo.length
                    ? `Goes to ${props.digestTo.join(", ")}. Each client's own edition is scheduled on their page.`
                    : "Nobody receives it yet - add staff under Settings > Personnel."}
                </div>
                {digestMsg && (
                  <div className="t-small" style={{ marginTop: 4, color: digestErr ? "#A32D2D" : "#2E6B2E" }}>{digestMsg}</div>
                )}
              </div>
            )}
          </div>
        ))}
      </Panel>

      {/* What the platform LOOKS like, as distinct from what it is called.
          Both are the instance's own, so they sit in the same tab; the preview
          is the point, since nobody can pick a five-stop gradient from a list
          of hex codes. */}
      <Panel title="Appearance"
        hint="Header colors.">

        <div style={{ border: "1px solid var(--line)", borderRadius: "var(--radius)", overflow: "hidden", marginBottom: 12 }}>
          <div style={{ height: bandH, background: gradientCss(stops) }} />
          <div style={{ background: headerOk ? effectiveHeader : "var(--navy)", color: previewFg, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 800, letterSpacing: "-0.2px" }}>{(props.platformName || "Ridgeline").toUpperCase()}</span>
            <span className="t-small" style={{ opacity: 0.7 }}>× a client workspace</span>
          </div>
          <div className="t-small" style={{ background: headerOk ? tint(effectiveHeader, 0.93) : "var(--bg)", padding: "12px 14px", color: "var(--mut)" }}>
            The page behind it takes a wash of the same color, exactly as an organization&apos;s does.
          </div>
        </div>

        <SubHead>Header color</SubHead>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label className="t-body" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={headerDefault} disabled={pending}
              onChange={(e) => { setHeaderDefault(e.target.checked); clearBar(); }}
              style={{ width: "auto", margin: 0 }} />
            Use the default
          </label>
          <input type="color" value={isValidHex(header) ? header : DEFAULT_HEADER} disabled={pending || headerDefault}
            onChange={(e) => { setHeader(e.target.value.toUpperCase()); clearBar(); }}
            style={{ width: 44, height: 30, padding: 2 }} />
          <input className="mono t-small" value={header} disabled={pending || headerDefault}
            onChange={(e) => { setHeader(e.target.value.toUpperCase()); clearBar(); }}
            style={{ width: 110 }} />
          {!headerDefault && !isValidHex(header) && (
            <span className="t-small" style={{ color: "var(--t-bad-fg)" }}>needs to be #RRGGBB</span>
          )}
        </div>

        <SubHead>Spectrum</SubHead>
        {/* The same editor an organization gets, so the platform's controls and
            a tenant's cannot drift into two behaviours over one shape. */}
        <SpectrumEditor
          stops={stops} height={bandH} disabled={pending}
          onStops={(next) => { clearBar(); setStops(next); }}
          onHeight={(next) => { clearBar(); setBandH(next); }}
        />
        <div style={{ marginTop: 10 }}>
          <button className="btn link" onClick={resetLook} disabled={pending} style={{ fontSize: 12 }}>
            reset to the default look
          </button>
        </div>
        <div className="mut t-meta" style={{ marginTop: 8 }}>
          Buttons, titles and tabs keep the house navy on purpose - one color applied to
          every accent is a redesign rather than a brand, and it is how a readable interface
          stops being one.
        </div>
      </Panel>

      {/* Equipment vocabulary - system types and models - lives in Settings >
          Catalog; stages are workflow, so they stay with the instance. */}
      <Panel title="Stages">

        {props.stageDefs.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)" }}>
            <span className="pill" style={{ background: colors[s.id] ?? s.bg, color: s.fg }}>{s.name}</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              {!s.builtin && (
                <>
                  <button className="btn link" disabled={pending} onClick={() => doRename(s)}>rename</button>
                  <button className="btn link" style={{ color: "var(--t-bad-fg)" }} disabled={pending} onClick={() => doDelete(s)}>delete</button>
                </>
              )}
              <input type="color" value={colors[s.id] ?? s.bg} onChange={(e) => changeColor(s.id, e.target.value)}
                disabled={s.id < 0} title={s.id < 0 ? "Available after the next deploy seeds the stage table" : "Stage color"}
                style={{ width: 34, height: 26, padding: 2, border: "1px solid var(--line)", borderRadius: 6, background: "#fff", cursor: "pointer" }} />
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
          <input value={stageDraft.name} onChange={(e) => setStageDraft({ ...stageDraft, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submitStage(); }}
            placeholder="New stage name" className="t-body" style={{ flex: 1 }} />
          <input type="color" value={stageDraft.bg} onChange={(e) => setStageDraft({ ...stageDraft, bg: e.target.value })}
            style={{ width: 34, height: 30, padding: 2, border: "1px solid var(--line)", borderRadius: 6, background: "#fff", cursor: "pointer" }} />
          <button className="btn sm accent" onClick={submitStage} disabled={pending || !stageDraft.name.trim()}>Add</button>
        </div>
        {stageError && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{stageError}</div>}
      </Panel>

      {/* Modules, stages and the operator save themselves; the bar carries the
          drafts - the name and the look. */}
      <SaveBar dirty={dirty} saving={pending} message={barMsg} error={barErr}
        label="Save configuration" onSave={saveAll} onDiscard={discardAll} />
    </>
  );
}
