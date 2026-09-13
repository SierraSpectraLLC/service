"use client";

import AddressField from "@/components/AddressField";
import { worksitesByOrg, type WorksiteChoice } from "@/lib/sites";

/**
 * Where somebody's trips start: an address of their own, looked up as they
 * type, or - for an engineer stationed at a client - one of that client's
 * labs, picked from the organizations this workspace works with.
 *
 * Picking a lab copies its address into the field, so what is saved is one
 * plain address either way (see lib/sites.worksiteChoices). The select shows
 * the lab whose address the field currently holds, and drops back to the
 * prompt the moment the address is edited into something else.
 */
export default function HomeBasePicker({ value, onChange, sites, placeholder, ariaLabel, disabled, id }: {
  value: string;
  onChange: (address: string) => void;
  /** Client labs on offer. Empty hides the picker and leaves the plain field. */
  sites: WorksiteChoice[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  id?: string;
}) {
  const current = sites.find((s) => s.address === value)?.address ?? "";
  return (
    <div>
      <AddressField id={id} value={value} onChange={onChange} disabled={disabled}
        ariaLabel={ariaLabel ?? "Home base address"}
        placeholder={placeholder ?? "Street address - autocompletes when maps are configured"} />
      {sites.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <select value={current} aria-label="Use a client site" disabled={disabled}
            onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
            className="t-small" style={{ width: "auto", maxWidth: "100%" }}>
            <option value="">...or a lab of a client we work with</option>
            {worksitesByOrg(sites).map((g) => (
              <optgroup key={g.orgName} label={g.orgName}>
                {g.sites.map((s) => (
                  <option key={`${g.orgName}\n${s.label}\n${s.address}`} value={s.address}>{s.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
