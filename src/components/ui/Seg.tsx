"use client";

/**
 * A segmented control - wraps the existing .seg pattern (bordered strip of
 * buttons, the pressed one filled navy). For a small closed set of choices
 * where a select would hide the options.
 */
export default function Seg<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
