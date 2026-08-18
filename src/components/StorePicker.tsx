"use client";

import { useRouter } from "next/navigation";

/**
 * Whose store is on screen. A dropdown rather than a row of chips: nine client
 * chips were a third of the first screen, spent on a switch most visits never
 * touch. Staff only - everybody else has exactly one store and sees no control.
 */
export default function StorePicker({ options, viewing }: {
  options: { id: number | null; name: string }[];
  viewing: number | null;
}) {
  const router = useRouter();
  return (
    <select value={viewing === null ? "" : String(viewing)} aria-label="Whose file store to show"
      onChange={(e) => router.push(e.target.value === "" ? "/documents" : `/documents?store=${e.target.value}`)}
      style={{ width: "auto", fontSize: 12 }}>
      {options.map((o) => (
        <option key={o.id ?? "own"} value={o.id === null ? "" : String(o.id)}>{o.name}</option>
      ))}
    </select>
  );
}
