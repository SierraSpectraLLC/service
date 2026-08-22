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
  DEFAULT_HEADER, DEFAULT_SPECTRUM_HEIGHT, DEFAULT_STOPS, MAX_SPECTRUM_HEIGHT, MAX_STOPS,
  gradientCss, type Stop,
} from "@/lib/appearance";
import { DAY_LABELS, WEEK_ORDER, parseDigestDays } from "@/lib/digestDays";
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
  platformName: string; platformTagline: string; operatorOrgId: number | null;
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
    name: props.platformName, tagline: props.platformTagline,
    headerColor: props.appearance.headerColor,
    spectrumHeight: props.appearance.spectrumHeight,
    spectrumStops: props.appearance.spectrumStops,
  });
  const [barMsg, setBarMsg] = useState("");
  const [barErr, setBarErr] = useState("");
  const clearBar = () => { setBarMsg(""); setBarErr(""); };

  const [brandDraft, setBrandDraft] = useState({ name: props.platformName, tagline: props.platformTagline });
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
  const setStop = (i: number, patch: Partial<Stop>) => {
    clearBar();
    setStops((list) => list.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  };
  const addStop = () => {
    clearBar();
    setStops((list) => {
      if (list.length >= MAX_STOPS) return list;
      // Drop the new band in the widest gap, which is where a person is
      // reaching when they press add - not always on the end.
      const sorted = [...list].sort((a, b) => a.at - b.at);
      let at = 50, gap = -1;
      for (let i = 0; i < sorted.length - 1; i++) {
        const g = sorted[i + 1].at - sorted[i].at;
        if (g > gap) { gap = g; at = Math.round(sorted[i].at + g / 2); }
      }
      return [...list, { c: sorted[Math.floor(sorted.length / 2)]?.c ?? DEFAULT_HEADER, at }]
        .sort((a, b) => a.at - b.at);
    });
  };
  const resetLook = () => {
    clearBar();
    setHeaderDefault(true); setHeader(DEFAULT_HEADER);
    setBandH(DEFAULT_SPECTRUM_HEIGHT); setStops(DEFAULT_STOPS);
  };

  const brandDirty = brandDraft.name !== base.name || brandDraft.tagline !== base.tagline;
  const lookDirty = (headerDefault ? "" : header) !== base.headerColor
    || bandH !== base.spectrumHeight
    || JSON.stringify(stops) !== JSON.stringify(base.spectrumStops);
  const dirty = brandDirty || lookDirty;

  const saveAll = () => {
    clearBar();
    if (brandDirty && !brandDraft.name.trim()) { setBarErr("The platform needs a name"); return; }
    if (lookDirty && !headerDefault && !isValidHex(header)) {
      setBarErr("The header colour needs to be a hex like #1D9E75");
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
        name: brandDraft.name, tagline: brandDraft.tagline,
        headerColor: headerDefault ? "" : header,
        spectrumHeight: bandH, spectrumStops: stops,
      });
      setBarMsg("Saved");
    });
  };
  const discardAll = () => {
    clearBar();
    setBrandDraft({ name: base.name, tagline: base.tagline });
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
        hint="The portal's name, who operates it, and which optional workflows are switched on.">
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
        {/* Names an operator the moment it's picked - who runs the instance is
            not a draft to sit unsaved behind a bar. */}
        <Field label="Operated by"
          hint="The operator is named on sign-off packets and reports; systems staff create are shared with it."
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
            style={{ width: "auto", fontSize: 12 }}>
            <option value="">nobody - use the platform name</option>
            {props.orgs.filter((o) => o.kind === "provider").map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </Field>

        <SubHead>Modules</SubHead>
        <div className="mut" style={{ fontSize: 11, marginBottom: 6 }}>
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
              <div style={{ fontSize: 13, fontWeight: 700 }}>{label}</div>
            </div>
            {/* The digest's own schedule sits with its switch: an email that
                goes out every morning is worth being able to time, preview and
                send by hand from the place you turned it on. */}
            {key === "digest" && (moduleState[key] ?? on) && (
              <div style={{ margin: "8px 0 4px 54px" }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="mut" style={{ fontSize: 12 }}>Sends at</span>
                  <select value={digestHour} disabled={pending}
                    onChange={(e) => {
                      const next = parseInt(e.target.value);
                      setDigestHourState(next);
                      saveDigestSchedule(next, digestDaysSel);
                    }}
                    style={{ width: "auto", fontSize: 12 }}>
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{clockLabel(h)}</option>)}
                  </select>
                  <span className="mut" style={{ fontSize: 12 }}>shop time, on</span>
                  {WEEK_ORDER.map((d) => (
                    <label key={d} style={{ display: "flex", gap: 3, alignItems: "center", fontSize: 11, margin: 0, fontWeight: 400, cursor: "pointer" }}>
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
                <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
                  {props.digestTo.length
                    ? `Goes to ${props.digestTo.join(", ")}. Each client's own edition is scheduled on their page.`
                    : "Nobody receives it yet - add staff under Settings > Personnel."}
                </div>
                {digestMsg && (
                  <div style={{ fontSize: 12, marginTop: 4, color: digestErr ? "#A32D2D" : "#2E6B2E" }}>{digestMsg}</div>
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
        hint="The header bar and the spectrum above it. Organizations that set their own colour keep it - this is what everyone else sees.">

        <div style={{ border: "1px solid var(--line)", borderRadius: "var(--radius)", overflow: "hidden", marginBottom: 12 }}>
          <div style={{ height: bandH, background: gradientCss(stops) }} />
          <div style={{ background: headerOk ? effectiveHeader : "var(--navy)", color: previewFg, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 800, letterSpacing: "-0.2px" }}>{(props.platformName || "Ridgeline").toUpperCase()}</span>
            <span style={{ opacity: 0.7, fontSize: 12 }}>× a client workspace</span>
          </div>
          <div style={{ background: headerOk ? tint(effectiveHeader, 0.93) : "var(--bg)", padding: "12px 14px", fontSize: 12, color: "var(--mut)" }}>
            The page behind it takes a wash of the same colour, exactly as an organization&apos;s does.
          </div>
        </div>

        <SubHead>Header colour</SubHead>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={headerDefault} disabled={pending}
              onChange={(e) => { setHeaderDefault(e.target.checked); clearBar(); }}
              style={{ width: "auto", margin: 0 }} />
            Use the default
          </label>
          <input type="color" value={isValidHex(header) ? header : DEFAULT_HEADER} disabled={pending || headerDefault}
            onChange={(e) => { setHeader(e.target.value.toUpperCase()); clearBar(); }}
            style={{ width: 44, height: 30, padding: 2 }} />
          <input className="mono" value={header} disabled={pending || headerDefault}
            onChange={(e) => { setHeader(e.target.value.toUpperCase()); clearBar(); }}
            style={{ width: 110, fontSize: 12 }} />
          {!headerDefault && !isValidHex(header) && (
            <span style={{ fontSize: 12, color: "var(--t-bad-fg)" }}>needs to be #RRGGBB</span>
          )}
        </div>

        <SubHead>Spectrum</SubHead>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <span className="mut" style={{ fontSize: 12 }}>Thickness</span>
          <input type="range" min={0} max={MAX_SPECTRUM_HEIGHT} value={bandH} disabled={pending}
            onChange={(e) => { setBandH(parseInt(e.target.value)); clearBar(); }}
            style={{ width: 160 }} />
          <span className="mono" style={{ fontSize: 12, minWidth: 34 }}>{bandH}px</span>
          {bandH === 0 && <span className="mut" style={{ fontSize: 12 }}>hidden</span>}
        </div>
        {stops.map((st, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderTop: "1px solid var(--line)" }}>
            <input type="color" value={isValidHex(st.c) ? st.c : DEFAULT_HEADER} disabled={pending}
              onChange={(e) => setStop(i, { c: e.target.value.toUpperCase() })}
              style={{ width: 40, height: 26, padding: 2 }} />
            <input className="mono" value={st.c} disabled={pending}
              onChange={(e) => setStop(i, { c: e.target.value.toUpperCase() })}
              style={{ width: 100, fontSize: 12 }} />
            <input type="range" min={0} max={100} value={st.at} disabled={pending}
              onChange={(e) => setStop(i, { at: parseInt(e.target.value) })}
              style={{ flex: "1 1 90px", minWidth: 80 }} />
            <span className="mono" style={{ fontSize: 12, minWidth: 34 }}>{st.at}%</span>
            <button className="btn link" disabled={pending || stops.length <= 1}
              onClick={() => { clearBar(); setStops((l) => l.filter((_, n) => n !== i)); }}
              style={{ fontSize: 12 }}>remove</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
          <button className="btn sm" onClick={addStop} disabled={pending || stops.length >= MAX_STOPS}>
            Add colour
          </button>
          <button className="btn link" onClick={resetLook} disabled={pending} style={{ fontSize: 12 }}>
            reset to the default look
          </button>
        </div>
        <div className="mut" style={{ fontSize: 11, marginTop: 8 }}>
          Buttons, titles and tabs keep the house navy on purpose - one colour applied to
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
                  <button className="btn link" style={{ fontSize: 11 }} disabled={pending} onClick={() => doRename(s)}>rename</button>
                  <button className="btn link" style={{ fontSize: 11, color: "var(--t-bad-fg)" }} disabled={pending} onClick={() => doDelete(s)}>delete</button>
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
            placeholder="New stage name" style={{ flex: 1, fontSize: 13 }} />
          <input type="color" value={stageDraft.bg} onChange={(e) => setStageDraft({ ...stageDraft, bg: e.target.value })}
            style={{ width: 34, height: 30, padding: 2, border: "1px solid var(--line)", borderRadius: 6, background: "#fff", cursor: "pointer" }} />
          <button className="btn sm accent" onClick={submitStage} disabled={pending || !stageDraft.name.trim()}>Add</button>
        </div>
        {stageError && <div style={{ fontSize: 12, color: "var(--t-bad-fg)", marginTop: 6 }}>{stageError}</div>}
      </Panel>

      {/* Modules, stages and the operator save themselves; the bar carries the
          drafts - the name and the look. */}
      <SaveBar dirty={dirty} saving={pending} message={barMsg} error={barErr}
        label="Save configuration" onSave={saveAll} onDiscard={discardAll} />
    </>
  );
}
