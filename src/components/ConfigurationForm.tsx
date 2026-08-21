"use client";

import { useRef, useState, useTransition } from "react";
import {
  addStage, setStageColor, renameStage, deleteStage,
  setBranding, setOperatorOrg, setModule, setDigestHour, sendDigestNow,
  setPlatformAppearance,
} from "@/app/actions";
import {
  DEFAULT_HEADER, DEFAULT_SPECTRUM_HEIGHT, DEFAULT_STOPS, MAX_SPECTRUM_HEIGHT, MAX_STOPS,
  gradientCss, type Stop,
} from "@/lib/appearance";
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

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      {hint && <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>{hint}</div>}
      {children}
    </div>
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
  const [digestMsg, setDigestMsg] = useState("");
  const [digestErr, setDigestErr] = useState(false);
  const sendDigest = () => {
    if (!confirm(`Email the internal digest now to ${props.digestTo.join(", ") || "nobody"}?`)) return;
    setDigestMsg(""); setDigestErr(false);
    startTransition(async () => {
      const res = await sendDigestNow(null);
      setDigestErr(!!res?.error);
      setDigestMsg(res?.error ?? `Sent to ${res.to}`);
    });
  };

  const [brandDraft, setBrandDraft] = useState({ name: props.platformName, tagline: props.platformTagline });
  const [brandError, setBrandError] = useState("");
  const [brandSaved, setBrandSaved] = useState(false);
  const saveBrand = () => {
    setBrandError(""); setBrandSaved(false);
    startTransition(async () => {
      const res = await setBranding(brandDraft);
      if (res?.error) setBrandError(res.error);
      else setBrandSaved(true);
    });
  };

  // ---- Appearance -------------------------------------------------------
  // Every control writes to local state and the preview redraws from it, so
  // what the strip shows is what saving would store - the same gradientCss the
  // page itself will render, not an approximation of it.
  const [header, setHeader] = useState(props.appearance.headerColor || DEFAULT_HEADER);
  const [headerDefault, setHeaderDefault] = useState(!props.appearance.headerColor);
  const [bandH, setBandH] = useState(props.appearance.spectrumHeight);
  const [stops, setStops] = useState<Stop[]>(props.appearance.spectrumStops);
  const [lookMsg, setLookMsg] = useState("");
  const [lookErr, setLookErr] = useState(false);

  const effectiveHeader = headerDefault ? DEFAULT_HEADER : header;
  const headerOk = isValidHex(effectiveHeader);
  const previewFg = headerOk ? readableTextOn(effectiveHeader) : "#fff";
  const setStop = (i: number, patch: Partial<Stop>) => {
    setLookMsg("");
    setStops((list) => list.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  };
  const addStop = () => {
    setLookMsg("");
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
    setLookMsg(""); setLookErr(false);
    setHeaderDefault(true); setHeader(DEFAULT_HEADER);
    setBandH(DEFAULT_SPECTRUM_HEIGHT); setStops(DEFAULT_STOPS);
  };
  const saveLook = () => {
    setLookMsg(""); setLookErr(false);
    if (!headerDefault && !isValidHex(header)) {
      setLookErr(true); setLookMsg("The header colour needs to be a hex like #1D9E75");
      return;
    }
    startTransition(async () => {
      const res = await setPlatformAppearance({
        headerColor: headerDefault ? "" : header,
        spectrumHeight: bandH,
        spectrumStops: stops,
      });
      setLookErr(!!res?.error);
      setLookMsg(res?.error ?? "Saved \u2713");
    });
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
  const doRename = (s: StageRow) => {
    const next = window.prompt(`Rename stage "${s.name}" to:`, s.name);
    if (!next || next.trim() === s.name) return;
    setStageError("");
    startTransition(async () => {
      const res = await renameStage(s.id, next);
      if (res?.error) setStageError(res.error);
    });
  };
  const doDelete = (s: StageRow) => {
    if (!window.confirm(`Delete stage "${s.name}"? It will be removed from any system that has it.`)) return;
    setStageError("");
    startTransition(async () => {
      const res = await deleteStage(s.id);
      if (res?.error) setStageError(res.error);
    });
  };

  return (
    <>
      <Section title="This instance"
        hint="The portal's name, who operates it, and which optional workflows are switched on.">
        <div className="pf2" style={{ marginBottom: 8 }}>
          <div>
            <label>Name</label>
            <input value={brandDraft.name} onChange={(e) => { setBrandSaved(false); setBrandDraft({ ...brandDraft, name: e.target.value }); }}
              placeholder="e.g. Instrapath" />
          </div>
          <div>
            <label>Tagline</label>
            <input value={brandDraft.tagline} onChange={(e) => { setBrandSaved(false); setBrandDraft({ ...brandDraft, tagline: e.target.value }); }}
              placeholder="instrument portal" />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn sm accent" onClick={saveBrand} disabled={pending || !brandDraft.name.trim()}>
            {pending ? "Saving..." : "Save name"}
          </button>
          {brandSaved && <span className="mut" style={{ fontSize: 12 }}>Saved.</span>}
          <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            <span className="mut" style={{ fontSize: 12 }}>Operated by</span>
            <select value={props.operatorOrgId ?? ""} disabled={pending}
              onChange={(e) => {
                const next = e.target.value ? parseInt(e.target.value) : null;
                setBrandError("");
                startTransition(async () => {
                  const res = await setOperatorOrg(next);
                  if (res?.error) setBrandError(res.error);
                });
              }}
              style={{ width: "auto", fontSize: 12 }}>
              <option value="">nobody - use the platform name</option>
              {props.orgs.filter((o) => o.kind === "provider").map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </span>
        </div>
        <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
          The operator is named on sign-off packets and reports; systems staff create are shared with it.
        </div>
        {brandError && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{brandError}</div>}

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
                      setDigestHourState(next); setDigestMsg(""); setDigestErr(false);
                      startTransition(async () => {
                        const res = await setDigestHour(null, next);
                        if (res?.error) { setDigestErr(true); setDigestMsg(res.error); }
                      });
                    }}
                    style={{ width: "auto", fontSize: 12 }}>
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{clockLabel(h)}</option>)}
                  </select>
                  <span className="mut" style={{ fontSize: 12 }}>shop time</span>
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
      </Section>

      {/* What the platform LOOKS like, as distinct from what it is called.
          Both are the instance's own, so they sit in the same tab; the preview
          is the point, since nobody can pick a five-stop gradient from a list
          of hex codes. */}
      <Section title="Appearance"
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
              onChange={(e) => { setHeaderDefault(e.target.checked); setLookMsg(""); }}
              style={{ width: "auto", margin: 0 }} />
            Use the default
          </label>
          <input type="color" value={isValidHex(header) ? header : DEFAULT_HEADER} disabled={pending || headerDefault}
            onChange={(e) => { setHeader(e.target.value.toUpperCase()); setLookMsg(""); }}
            style={{ width: 44, height: 30, padding: 2 }} />
          <input className="mono" value={header} disabled={pending || headerDefault}
            onChange={(e) => { setHeader(e.target.value.toUpperCase()); setLookMsg(""); }}
            style={{ width: 110, fontSize: 12 }} />
          {!headerDefault && !isValidHex(header) && (
            <span style={{ fontSize: 12, color: "#A32D2D" }}>needs to be #RRGGBB</span>
          )}
        </div>

        <SubHead>Spectrum</SubHead>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <span className="mut" style={{ fontSize: 12 }}>Thickness</span>
          <input type="range" min={0} max={MAX_SPECTRUM_HEIGHT} value={bandH} disabled={pending}
            onChange={(e) => { setBandH(parseInt(e.target.value)); setLookMsg(""); }}
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
              onClick={() => { setLookMsg(""); setStops((l) => l.filter((_, n) => n !== i)); }}
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
          <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {lookMsg && (
              <span style={{ fontSize: 12, color: lookErr ? "#A32D2D" : "#2E6B2E" }}>{lookMsg}</span>
            )}
            <button className="btn sm accent" onClick={saveLook} disabled={pending}>
              {pending ? "Saving..." : "Save appearance"}
            </button>
          </span>
        </div>
        <div className="mut" style={{ fontSize: 11, marginTop: 8 }}>
          Buttons, titles and tabs keep the house navy on purpose - one colour applied to
          every accent is a redesign rather than a brand, and it is how a readable interface
          stops being one.
        </div>
      </Section>

      {/* Equipment vocabulary - system types and models - lives in Settings >
          Catalog; stages are workflow, so they stay with the instance. */}
      <Section title="Stages">

        {props.stageDefs.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)" }}>
            <span className="pill" style={{ background: colors[s.id] ?? s.bg, color: s.fg }}>{s.name}</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              {!s.builtin && (
                <>
                  <button className="btn link" style={{ fontSize: 11 }} disabled={pending} onClick={() => doRename(s)}>rename</button>
                  <button className="btn link" style={{ fontSize: 11, color: "#A32D2D" }} disabled={pending} onClick={() => doDelete(s)}>delete</button>
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
        {stageError && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{stageError}</div>}
      </Section>
    </>
  );
}
