"use client";

import { WEEKDAYS, daysLabel } from "@/lib/pmRequest";

/**
 * Which days of the week suit them.
 *
 * One component for both places a client asks for service - the calendar and
 * the button on a system's own page - because it is one question and two
 * spellings of it would drift. Chips rather than a multi-select: three taps,
 * all five options visible at once, and it works with a thumb.
 *
 * Picking none is a real answer and the ordinary one. It means "whenever suits
 * you", so it is never a validation error, and the line underneath says which
 * of the two they have said rather than leaving an empty row to interpret.
 */
export default function WeekdayPicker({ value, onChange, disabled }: {
  /** Weekday numbers, 0 = Sunday. */
  value: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
}) {
  const toggle = (key: number) =>
    onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key].sort((a, b) => a - b));

  return (
    <>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} role="group" aria-label="Days that suit you">
        {WEEKDAYS.map((d) => {
          const on = value.includes(d.key);
          return (
            <button key={d.key} type="button" disabled={disabled}
              className={on ? "btn sm accent" : "btn sm"}
              aria-pressed={on} aria-label={d.label}
              onClick={() => toggle(d.key)}
              style={{ flex: "1 1 60px" }}>
              {d.short}
            </button>
          );
        })}
      </div>
      <div className="field-hint" style={{ marginTop: 4 }}>
        {value.length
          ? `We will aim for ${daysLabel(value)}.`
          : "Pick none and we will suggest whatever suits. Weekends are not on the list -"
            + " ask in the box below if you need one and we will tell you what is possible."}
      </div>
    </>
  );
}
