"use client";

/** A name that is nobody on the roster - a subcontractor, or a room named
 *  before this picker existed. Kept rather than silently dropped. */
const OFF_ROSTER = "~off-roster";

export type KeeperDraft = { keeper: string; keeperEmail: string };

/**
 * Whose kit this is, picked off the roster rather than typed.
 *
 * A name is not an identity - a shop can employ two Steve Joneses, which
 * lib/hr learned the hard way - so what gets stored is the address, and the
 * displayed name comes back off the roster row at save. That link is what
 * makes "what is Bill carrying" a question the app can answer on Bill's own
 * file instead of by reading every room's keeper field and hoping.
 *
 * Three answers, all real:
 *   - nobody in particular, which is what a shop shelf always is;
 *   - somebody on the roster, the case this exists for;
 *   - a name that is on no roster, preserved where a room already has one, so
 *     opening the form on a van kept by a subcontractor and saving something
 *     else does not quietly wipe the only record of who has it.
 *
 * With no roster to offer - a client's editor keeping their own cage - it
 * falls back to the free text box this replaced, which is still the honest
 * control when there is nobody to pick.
 */
export default function KeeperPicker({ value, roster, onChange, disabled }: {
  value: KeeperDraft;
  roster: { email: string; name: string }[];
  onChange: (next: KeeperDraft) => void;
  disabled?: boolean;
}) {
  if (!roster.length) {
    return (
      <div>
        <label>Kept by</label>
        <input value={value.keeper} disabled={disabled} aria-label="Kept by"
          placeholder="Whose van"
          onChange={(e) => onChange({ keeper: e.target.value, keeperEmail: "" })} />
      </div>
    );
  }

  const offRoster = !value.keeperEmail && !!value.keeper.trim();
  return (
    <div>
      <label>Kept by</label>
      <select aria-label="Kept by" disabled={disabled}
        value={value.keeperEmail || (offRoster ? OFF_ROSTER : "")}
        onChange={(e) => {
          const v = e.target.value;
          if (v === OFF_ROSTER) return; // already what it is
          // The name is left to the server, which takes it off the roster row
          // so the stored name and the roster cannot drift apart.
          onChange(v ? { keeperEmail: v, keeper: "" } : { keeperEmail: "", keeper: "" });
        }}>
        <option value="">Nobody in particular</option>
        {offRoster && <option value={OFF_ROSTER}>{value.keeper} (not on the roster)</option>}
        {roster.map((m) => (
          <option key={m.email} value={m.email}>{m.name || m.email}</option>
        ))}
      </select>
    </div>
  );
}
