"use client";

import { useEffect, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import {
  CardGrid, DataTable, Dot, EmptyState, EntityCard, FacetStrip, Field, Legend,
  PageHead, Panel, Pill, RowActions, SaveBar, SectionHead, Seg, Tabs, Toolbar, Id,
} from "@/components/ui";
import MobileNav from "@/components/MobileNav";
import SettingsNav from "@/components/SettingsNav";
import type { Tone } from "@/lib/tones";

/* The nav components gate themselves by viewport (burger and tab bar exist
   under 640px, the settings sidebar from 900px up). The frames below unhide
   both variants and pin the fixed pieces in place, so the inventory shows
   every state at any width. Dev route only - production never loads this. */
const NAV_FRAME_CSS = `
  .navframe { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; margin-bottom: 12px; background: var(--bg); }
  .navframe-bar { background: var(--navy); color: #fff; display: flex; align-items: center; gap: 10px; padding: 8px 12px; flex-wrap: wrap; }
  .navframe .mnav-burger { display: inline-flex; }

  /* The tab bar and drawer live in the frame's flow, styled as they are on a
     phone; the app pins them to the viewport instead. */
  .navframe .mnav-tabbar {
    display: flex; position: static; order: 10; flex-basis: calc(100% + 24px);
    background: var(--card); border-top: 1px solid var(--line);
    padding: 6px 4px 8px; margin: 8px -12px -8px;
  }
  .navframe .mnav-tabbar a {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
    font-size: 10.5px; font-weight: 600; color: var(--mut); text-decoration: none;
  }
  .navframe .mnav-tabbar a.active { color: var(--navy); }
  .navframe .mnav-drawer { display: block; position: static; order: 5; flex-basis: calc(100% + 24px); margin: 8px -12px 0; }
  .navframe .scrim { display: none; }
  .navframe .mnav-pane {
    position: static; width: auto; box-shadow: none;
    background: var(--card); padding: 10px 0 20px; border-top: 1px solid var(--line);
  }
  .navframe .mnav-id { padding: 8px 18px 12px; border-bottom: 1px solid var(--line); color: var(--ink); }
  .navframe .mnav-group {
    padding: 14px 18px 4px; font-size: 10.5px; font-weight: 700;
    letter-spacing: 0.6px; text-transform: uppercase; color: var(--mut);
  }
  .navframe .mnav-pane a { display: block; padding: 9px 18px; font-size: 14px; font-weight: 500; color: var(--ink); text-decoration: none; }
  .navframe .mnav-pane a.active { background: var(--t-info-bg); color: var(--navy); font-weight: 600; }

  /* Sidebar and drilldown side by side, whatever the viewport. */
  .navframe .settings-shell { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 12px 20px; padding: 12px; }
  .navframe .settings-side { display: block; position: static; grid-column: 1; grid-row: 1 / span 2; }
  .navframe .settings-shell > div { grid-column: 2; grid-row: 1; min-width: 0; }
  .navframe .settings-mobnav {
    display: block; grid-column: 2; grid-row: 2;
    background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
  }
  .navframe .settings-mobnav > summary {
    list-style: none; cursor: pointer; padding: 11px 14px;
    font-size: 13.5px; font-weight: 600; color: var(--navy);
    display: flex; justify-content: space-between; align-items: center;
  }
  .navframe .settings-mobnav nav { border-top: 1px solid var(--line); padding-bottom: 8px; }
  @media (max-width: 639px) {
    .navframe .settings-shell { grid-template-columns: minmax(0, 1fr); }
    .navframe .settings-side, .navframe .settings-shell > div, .navframe .settings-mobnav { grid-column: 1; grid-row: auto; }
  }
`;

const TONES: Tone[] = ["neutral", "faint", "info", "good", "warn", "accent", "bad"];

/**
 * The living component inventory behind /dev/ui (development only - the route
 * 404s in production). Every kit piece with fixture props, one dialog per
 * ?d= key so each can be linked to and screenshotted:
 *
 *   ?d=dialog-md      a create form in the standard Dialog
 *   ?d=dialog-sm      the small variant
 *   ?d=dialog-steps   the stepped variant (rail on desktop, bar on phone)
 *   ?d=confirm-bad    a destructive ConfirmDialog with a consequence list
 *   ?d=confirm-plain  a non-destructive ConfirmDialog
 *   ?d=toast          the toast rack
 *
 * Fixture data only. Nothing here talks to the server.
 */
export default function DevUiGallery() {
  const [show, setShow] = useState("");
  const [seg, setSeg] = useState("open");
  const [tab, setTab] = useState("procedures");
  const [facets, setFacets] = useState<{ key: string; label: string; count?: number; on?: boolean }[]>([
    { key: "open", label: "Open", count: 14, on: true },
    { key: "mine", label: "Mine", count: 6 },
    { key: "blocked", label: "Blocked", count: 2 },
    { key: "closed", label: "Closed" },
  ]);

  useEffect(() => {
    setShow(new URLSearchParams(window.location.search).get("d") ?? "");
  }, []);
  const close = () => {
    setShow("");
    window.history.replaceState(null, "", window.location.pathname);
  };

  useEffect(() => {
    if (show === "confirm-bad") {
      void confirmDialog({
        title: "Decommission #33?",
        body: (
          <>
            Its history stays. It leaves the active pool and stops generating maintenance.
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              <li>cancels 2 overdue PM tasks</li>
              <li>removes it from the Lab Zen escrow count</li>
            </ul>
          </>
        ),
        action: "Decommission #33",
        tone: "bad",
        cancel: "Keep it",
      });
    } else if (show === "confirm-plain") {
      void confirmDialog({
        title: "Send PO-118 to Agilent?",
        body: "Lines lock after this.",
        action: "Send PO-118",
      });
    } else if (show === "toast") {
      toast({ message: "Saved procedure" });
      toast({ message: "Decommissioned #33", undo: () => {} });
      toast({ message: "The handoff didn't go through: server error", tone: "bad" });
    }
  }, [show]);

  const anchor = (k: string, label: string) => (
    <a key={k} className="facet" href={`?d=${k}`} onClick={(e) => { e.preventDefault(); setShow(k); window.history.replaceState(null, "", `?d=${k}`); }}>
      {label}
    </a>
  );

  return (
    <div className="container wide">
      <PageHead title="UI inventory" sub="Every kit component with fixture props. Development only."
        crumb={<span>dev › <b>ui</b></span>}
        actions={<span className="facets">
          {anchor("dialog-md", "Dialog md")}
          {anchor("dialog-sm", "Dialog sm")}
          {anchor("dialog-steps", "Dialog steps")}
          {anchor("confirm-bad", "Confirm bad")}
          {anchor("confirm-plain", "Confirm plain")}
          {anchor("toast", "Toasts")}
        </span>} />

      <SectionHead label="Tones" count={7} />
      <div className="card">
        <div className="row-2" id="pills">
          {TONES.map((t) => <Pill key={t} tone={t}>{t}</Pill>)}
          <Pill tone="info" mono>PO-118</Pill>
        </div>
        <div className="row-3" style={{ marginTop: 10 }} id="dots">
          {TONES.map((t) => <Dot key={t} tone={t} label={t} />)}
        </div>
        <div style={{ marginTop: 10 }} id="legend">
          <Legend items={[
            { tone: "good", label: "our move" }, { tone: "warn", label: "waiting on client" },
            { tone: "bad", label: "blocked" }, { tone: "info", label: "with supplier" },
            { tone: "neutral", label: "parked" },
          ]} />
        </div>
      </div>

      <SectionHead label="Type scale and identifiers" />
      <div className="card" id="type">
        <div className="t-page">Page title 22</div>
        <div className="t-title">Card title 16</div>
        <div className="t-lead">Lead 14</div>
        <div className="t-body">Body 13</div>
        <div className="t-small mut">Small 12</div>
        <div className="t-meta mut">Meta 11</div>
        <div style={{ marginTop: 8 }}>
          <Id>US24051113</Id> · <Id dim>G7167B</Id> · serial and model read as designations
        </div>
      </div>

      <SectionHead label="Toolbar, facets, controls" />
      <div className="card" id="controls">
        <Toolbar
          search={<input placeholder="Serial, client, model or WO number" />}
          facets={<FacetStrip facets={facets}
            onToggle={(k) => setFacets(facets.map((f) => f.key === k ? { ...f, on: !f.on } : f))} />}
          actions={<button className="btn primary">+ Work order</button>} />
        <div className="row-3">
          <Seg options={[{ value: "open", label: "Open" }, { value: "all", label: "All" }, { value: "closed", label: "Closed" }]}
            value={seg} onChange={setSeg} />
          <button className="btn">Button</button>
          <button className="btn primary">Primary</button>
          <button className="btn accent">Accent</button>
          <button className="btn danger">Danger</button>
          <button className="btn link">link</button>
          <button className="btn link danger">danger link</button>
        </div>
        <div style={{ marginTop: 10 }}>
          <Tabs active={tab} onSelect={setTab} items={[
            { key: "procedures", label: "Procedures", count: 7 },
            { key: "specs", label: "Specs", count: 0, warn: true },
            { key: "parts", label: "Parts", count: 3 },
            { key: "fleet", label: "Fleet", count: 1 },
          ]} />
        </div>
      </div>

      <SectionHead label="DataTable" count={5} action={<button className="btn link">Export</button>} />
      <div id="datatable">
        <DataTable
          cols={[
            { key: "dot", label: "", width: "12px" },
            { key: "wo", label: "WO", width: "90px" },
            { key: "system", label: "System", width: "minmax(160px,1.6fr)" },
            { key: "stage", label: "Stage", width: "110px" },
            { key: "updated", label: "Updated", width: "90px", hideMobile: true },
          ]}
          rows={[
            { key: 1, group: "Lab Zen", cells: { dot: <Dot tone="bad" />, wo: <Id>WO-0412</Id>, system: <b>Agilent 6495C</b>, stage: <Pill tone="bad">Blocked</Pill>, updated: "2 h" },
              actions: [{ label: "Open", onClick: () => {} }] },
            { key: 2, group: "Lab Zen", cells: { dot: <Dot tone="warn" />, wo: <Id>WO-0411</Id>, system: <b>Thermo ISQ 7000</b>, stage: <Pill tone="warn">Their move</Pill>, updated: "1 d" },
              actions: [{ label: "Open", onClick: () => {} }] },
            { key: 3, group: "Lab Zen", cells: { dot: <Dot tone="good" />, wo: <Id>WO-0408</Id>, system: <b>Shimadzu LCMS-8060</b>, stage: <Pill tone="good">Ours</Pill>, updated: "3 h" },
              actions: [{ label: "Open", onClick: () => {} }] },
            { key: 4, group: "Coastal Analytical", cells: { dot: <Dot tone="info" />, wo: <Id>WO-0409</Id>, system: <b>PerkinElmer Optima 8300</b>, stage: <Pill tone="info">Quoted</Pill>, updated: "2 d" },
              actions: [{ label: "Open", onClick: () => {} }, { label: "Close out", onClick: () => {} }, { label: "Cancel", onClick: () => {}, tone: "bad" }] },
            { key: 5, group: "Coastal Analytical", cells: { dot: <Dot tone="neutral" />, wo: <Id>WO-0388</Id>, system: <b>Peak N2 generator</b>, stage: <Pill tone="faint">Parked</Pill>, updated: "9 d" },
              actions: [{ label: "Open", onClick: () => {} }] },
          ]} />
      </div>

      <SectionHead label="CardGrid" count={3} />
      <div id="cardgrid">
        <CardGrid>
          <EntityCard eyebrow="Agilent" title="G6495C" mono meta="Triple quad · LC-MS"
            pills={<><Pill>8 procedures</Pill><Pill>4 parts</Pill></>}
            kebab={<RowActions items={[{ label: "Edit model", onClick: () => {} }]} inline={0} />} />
          <EntityCard eyebrow="Shimadzu" title="TOC-Lc" mono meta="Analyzer · TOC"
            pills={<><Pill tone="warn">No photo</Pill><Pill>7 procedures</Pill></>} />
          <EntityCard eyebrow="Thermo" title="ISQ 7000" mono meta="Single quad · GC-MS"
            pills={<Pill tone="bad">0 procedures</Pill>} />
        </CardGrid>
      </div>

      <SectionHead label="Navigation" />
      <style>{NAV_FRAME_CSS}</style>
      <div className="navframe" id="nav-mobile">
        <div className="navframe-bar">
          <MobileNav
            links={[
              { href: "/", label: "Dashboard" },
              { href: "/work", label: "Work orders" },
              { href: "/assets", label: "Assets" },
              { href: "/stock", label: "Inventory" },
            ]}
            groups={[
              { label: "Operations", items: [
                { href: "/eod", label: "EOD update" }, { href: "/maintenance", label: "Maintenance" },
                { href: "/purchasing", label: "Purchasing" }, { href: "/remote", label: "Remote support" },
                { href: "/metrics", label: "Metrics" }, { href: "/archive", label: "Archived" },
              ] },
              { label: "Library", items: [
                { href: "/settings/catalog", label: "Equipment catalog" }, { href: "/settings/parts", label: "Parts book" },
                { href: "/documents", label: "Files" }, { href: "/gallery", label: "Gallery" },
                { href: "/pdf", label: "PDF studio" }, { href: "/import", label: "Import spreadsheet" },
              ] },
            ]}
            settingsHref="/settings"
            userName="Rita Vasquez" orgName="Sierra Spectral" />
          <b style={{ letterSpacing: "-0.2px" }}>RIDGELINE</b>
          <span style={{ fontSize: 11, opacity: 0.75 }}>burger opens the drawer inline here</span>
        </div>
      </div>

      <div className="navframe" id="nav-settings">
        <div className="settings-shell">
          <SettingsNav isOwner isPlatform={false} />
          <div style={{ minWidth: 0 }}>
            <Panel title="Equipment catalog" hint="The page the sidebar frames - fixture body.">
              <div className="mut t-small">Sidebar from 900px up; the drilldown below is the phone variant.</div>
            </Panel>
          </div>
        </div>
      </div>

      <SectionHead label="Panel, fields, empty state" />
      <div className="panel-cols" id="panel">
        <div className="panel-slot">
          <Panel title="Parts" count={2} actions={<button className="btn link">+ Part</button>}>
            <div className="row-2 row-reveal" style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
              <Id>G1960-80039</Id>
              <span className="mut t-small">Oil exhaust mist filter · PO-118</span>
              <span className="sp" />
              <RowActions items={[{ label: "Edit", onClick: () => {} }, { label: "Remove", onClick: () => {}, tone: "bad" }]} />
            </div>
            <div className="row-2" style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
              <Id>5188-5365</Id>
              <span className="mut t-small">Septa, 11 mm, 50/pk · backordered</span>
            </div>
          </Panel>
          <Panel title="Notes" empty="No notes yet" />
        </div>
        <div className="panel-slot">
          <Panel title="Fields">
            <div className="pf2">
              <Field label="Vendor" required hint="From the maker book."><input placeholder="Agilent" /></Field>
              <Field label="Reference" optional><input placeholder="Vendor quote #" /></Field>
            </div>
            <Field label="Estimated hours" required error="Needed to quote."><input /></Field>
          </Panel>
          <div style={{ marginTop: 12 }}>
            <EmptyState title="Looking for a share link?" body="Open the link you were sent - no sign-in needed."
              action={<button className="btn primary">Email me a link</button>} />
          </div>
        </div>
      </div>

      <SectionHead label="Save bar" />
      <div id="savebar">
        <SaveBar dirty label="Save configuration" onSave={() => toast({ message: "Saved configuration" })} onDiscard={() => {}} />
      </div>

      {/* ── The dialogs, one per ?d= key ──────────────────────────────── */}
      <Dialog open={show === "dialog-md"} onClose={close} title="New site" context="Lab Zen"
        footer={
          <>
            <span className="dialog-status">Saved 2 s ago</span>
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn accent">Save site</button>
          </>
        }>
        <Field label="Name"><input placeholder="Building 4 lab" /></Field>
        <Field label="Address"><textarea rows={3} placeholder={"123 Cedar St, Suite 400\nReno NV 89501"} /></Field>
        <div className="pf2">
          <Field label="Who to ask for"><input placeholder="Rita, front desk" /></Field>
          <Field label="Phone"><input placeholder="775-555-0143" /></Field>
        </div>
        <Field label="Getting in" hint="The part nobody writes down and everybody needs at 7am.">
          <textarea rows={3} placeholder="Loading dock round the back, badge needed." />
        </Field>
      </Dialog>

      <Dialog open={show === "dialog-sm"} onClose={close} size="sm" title="Kill this link?"
        context="Anyone holding it loses access immediately."
        footer={
          <>
            <span className="dialog-status" />
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn danger">Kill link</button>
          </>
        }>
        <span />
      </Dialog>

      <Dialog open={show === "dialog-steps"} onClose={close} size="lg" title="New work order"
        context="Lab Zen · launched from #58 Agilent 6495C"
        steps={[
          { key: "system", label: "System", done: true },
          { key: "work", label: "Work", done: true },
          { key: "parts", label: "Parts & time", warn: true },
          { key: "client", label: "Client" },
        ]}
        activeStep="parts"
        onStepSelect={() => {}}
        footer={
          <>
            <span className="dialog-status err">Can&apos;t create yet - add estimated hours.</span>
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn primary" disabled>Create WO-0413</button>
          </>
        }>
        <div className="pf2">
          <Field label="Estimated hours" required error="Needed to quote."><input className="mono" /></Field>
          <Field label="Parts needed"><input placeholder="Add from the parts book..." /></Field>
        </div>
      </Dialog>
    </div>
  );
}
