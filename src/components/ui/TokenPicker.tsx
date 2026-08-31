"use client";

import { useMemo, useState } from "react";
import { matchesQuery } from "@/lib/search";

/**
 * Pick several things out of a list too long to draw.
 *
 * Written because "Specific models" in the parts catalog rendered a button per
 * model, and a shop with 1,100 models in its book got 1,100 buttons in a
 * dialog - the shop's word was "massive". A wall of options is also the wrong
 * shape even when it fits: past about thirty, reading them is slower than
 * typing the one you already have in mind.
 *
 * WHAT IS CHOSEN IS ALWAYS DRAWN, however long the list. The chips are the
 * answer to "what did I pick", and hiding them behind the same search that
 * hides the options would make a filled field look empty. Only the SUGGESTIONS
 * are filtered and capped.
 *
 * The cap is not a page. Somebody who types three characters and still sees
 * "…and 40 more" is being told to type a fourth, which is the right
 * instruction; paging a suggestion list is asking them to browse when they
 * came to search.
 */
export const SUGGESTION_CAP = 12;

export default function TokenPicker({
  label, name, options, chosen, onChange, placeholder, hint, tone = "primary", emptyNote, id,
}: {
  label: React.ReactNode;
  /** The field's name in words, for the search box's label. Needed because
      `label` may be a node - "Specific models (none = any model)" reads well
      on screen and not at all to a screen reader. */
  name?: string;
  options: string[];
  chosen: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  hint?: React.ReactNode;
  /** The chip's colour when picked - matches whatever the field meant before. */
  tone?: "primary" | "accent";
  /** Said instead of the box when there is nothing to pick from at all. */
  emptyNote?: string;
  id?: string;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim();

  /* Suggestions exclude what is already chosen: an option that does nothing
     when clicked is a row that costs a read and returns nothing. */
  const suggestions = useMemo(() => {
    const pool = options.filter((o) => !chosen.includes(o));
    const hits = needle ? pool.filter((o) => matchesQuery(needle, [o])) : pool;
    return { hits: hits.slice(0, SUGGESTION_CAP), more: Math.max(0, hits.length - SUGGESTION_CAP) };
  }, [options, chosen, needle]);

  const add = (o: string) => { onChange([...chosen, o]); setQ(""); };
  const drop = (o: string) => onChange(chosen.filter((x) => x !== o));

  return (
    <>
      <label htmlFor={id}>{label}</label>
      {options.length === 0 && emptyNote ? (
        <div className="mut t-meta" style={{ marginBottom: 8 }}>{emptyNote}</div>
      ) : (
        <div style={{ marginBottom: 8 }}>
          {chosen.length > 0 && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
              {chosen.map((c) => (
                <button key={c} type="button" className={`btn sm ${tone}`} style={{ fontSize: 11 }}
                  aria-label={`Remove ${c}`} title="Remove"
                  onClick={() => drop(c)}>
                  {c} ×
                </button>
              ))}
            </div>
          )}
          <input id={id} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder ?? "Type to search"} className="t-small"
            aria-label={`Search ${(name ?? (typeof label === "string" ? label : "options")).toLowerCase()}`}
            /* Enter takes the only remaining match. With one hit on screen the
               keyboard already knows what you meant, and reaching for a mouse
               to confirm it is the slowest part of typing a part number. */
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (suggestions.hits.length === 1) add(suggestions.hits[0]!);
            }} />
          {suggestions.hits.length > 0 && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
              {suggestions.hits.map((o) => (
                <button key={o} type="button" className="btn sm" style={{ fontSize: 11 }}
                  onClick={() => add(o)}>{o}</button>
              ))}
              {suggestions.more > 0 && (
                <span className="mut t-meta" style={{ alignSelf: "center" }}>
                  and {suggestions.more} more - keep typing
                </span>
              )}
            </div>
          )}
          {needle && suggestions.hits.length === 0 && (
            <div className="mut t-meta" style={{ marginTop: 4 }}>Nothing matches that.</div>
          )}
          {hint && <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>{hint}</div>}
        </div>
      )}
    </>
  );
}
