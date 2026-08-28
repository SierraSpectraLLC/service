"use client";

import { useState, useTransition } from "react";
import { saveProviderProfile } from "@/app/actions";
import { MAX_BLURB, parseTags, profileProblems } from "@/lib/providerDirectory";
import { Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

type Draft = {
  listed: boolean; blurb: string; services: string; regions: string;
  contactName: string; contactEmail: string; contactPhone: string; website: string;
};

/**
 * This shop's own entry in the directory.
 *
 * Off until somebody fills it in, and the copy says why rather than hiding the
 * switch: operators are deliberately invisible to each other everywhere else in
 * this application, and a directory that enrolled every workspace on its own
 * would undo that decision on the owner's behalf.
 *
 * The listing carries what a shop DOES and never who it does it for. A
 * shopfront, not a client list.
 */
export default function ProviderProfileForm({ orgName, profile, canEdit }: {
  orgName: string; profile: Draft; canEdit: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [base, setBase] = useState(profile);
  const [d, setD] = useState(profile);

  const problems = profileProblems({
    listed: d.listed, services: parseTags(d.services), regions: parseTags(d.regions),
    blurb: d.blurb, contactEmail: d.contactEmail,
  });
  const dirty = JSON.stringify(d) !== JSON.stringify(base);

  const save = () =>
    startTransition(async () => {
      const res = await saveProviderProfile(d);
      if (res?.error) { toast({ message: res.error }); return; }
      setBase(d);
      toast({ message: d.listed ? "Listed - other shops can find you" : "Removed from the directory" });
    });

  const field = (label: string, key: keyof Draft, hint = "", placeholder = "") => (
    <div>
      <label>{label}</label>
      <input value={String(d[key])} aria-label={label} disabled={pending || !canEdit}
        placeholder={placeholder}
        onChange={(e) => setD({ ...d, [key]: e.target.value })} />
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );

  return (
    <Panel
      title="How we are listed"
      hint="What other service companies see when they search. Nothing here says who your clients are."
    >
      <div className="row-2" style={{ alignItems: "center", marginBottom: 10 }}>
        <span className="t-body" style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{orgName}</span>
        <Pill tone={base.listed ? "good" : "faint"}>{base.listed ? "Listed" : "Not listed"}</Pill>
      </div>

      <label className="t-small" style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
        <input type="checkbox" className="check" checked={d.listed} disabled={pending || !canEdit}
          onChange={(e) => setD({ ...d, listed: e.target.checked })} />
        list us in the directory
      </label>

      <div className="pf2">
        {field("What we service", "services", "Commas. \"LC-MS, GC-MS, Dissolution\".", "LC-MS, GC-MS")}
        {field("Where we work", "regions", "Commas. Regions, states, metros.", "Northern California, Reno")}
      </div>

      <label style={{ marginTop: 10 }}>A sentence about the shop</label>
      <input value={d.blurb} aria-label="Blurb" disabled={pending || !canEdit}
        placeholder="Sciex and Agilent specialists, 20 years on triple quads"
        onChange={(e) => setD({ ...d, blurb: e.target.value })} />
      <div className="field-hint">{d.blurb.length}/{MAX_BLURB}</div>

      <div className="pf2" style={{ marginTop: 10 }}>
        {field("Who to ask for", "contactName", "", "Joe Harris")}
        {field("Contact email", "contactEmail", "", "hello@yourshop.com")}
      </div>
      <div className="pf2" style={{ marginTop: 10 }}>
        {field("Phone", "contactPhone")}
        {field("Website", "website", "", "yourshop.com")}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
        <button className="btn accent" disabled={pending || !dirty || problems.length > 0 || !canEdit}
          onClick={save}>
          {pending ? "Saving..." : "Save"}
        </button>
        {dirty && canEdit && (
          <button className="btn" disabled={pending} onClick={() => setD(base)}>Discard</button>
        )}
        {problems.length > 0 && (
          <span className="t-small" style={{ color: "var(--t-bad-fg)" }}>{problems[0]}</span>
        )}
        {!canEdit && <span className="mut t-small">Only the owner publishes the listing.</span>}
      </div>
    </Panel>
  );
}
