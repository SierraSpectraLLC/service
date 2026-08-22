"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { applyMention, matchMentions, mentionQuery, type Candidate } from "@/lib/mentions";

/**
 * A comment box that knows who you can mention.
 *
 * Type "@ni" and the people whose names start that way appear; arrow keys and
 * Enter pick one, and the full name lands in the text so lib/notify recognises
 * it. Wraps an input or a textarea rather than replacing them, so every box
 * that already had its own Enter-to-post or auto-grow behaviour keeps it - the
 * only key this steals is one pressed while the list is actually open.
 *
 * The rules (what counts as a mention, who matches, where the caret lands)
 * are lib/mentions, so this file is only the list and the keyboard.
 */
export default function MentionBox({
  value, onChange, people, multiline = false, onEnter, onKeyDown: callerKeyDown, ...rest
}: {
  value: string;
  onChange: (next: string) => void;
  /** Who may be mentioned here - already scoped by the page to who can see it. */
  people: Candidate[];
  multiline?: boolean;
  /** Enter with no dropdown open. Shift+Enter never fires it. */
  onEnter?: () => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement> & React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange">) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Dismissed with Escape: stays shut until the token changes, so a box that
  // was closed on purpose does not reopen on the next keystroke.
  const [muted, setMuted] = useState("");

  const query = useMemo(() => mentionQuery(value, caret), [value, caret]);
  const hits = useMemo(
    () => (query && query.text !== muted ? matchMentions(people, query.text) : []),
    [query, people, muted],
  );
  const open = hits.length > 0;

  useEffect(() => { setActive(0); }, [query?.text]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setMuted(query?.text ?? "");
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open, query?.text]);

  const choose = (name: string) => {
    if (!query) return;
    const next = applyMention(value, query, name);
    onChange(next.text);
    setMuted("");
    // The caret has to be placed after React writes the new value, or the
    // browser leaves it at the end and the next word lands in the wrong place.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  const track = (el: HTMLInputElement | HTMLTextAreaElement) => setCaret(el.selectionStart ?? 0);

  /**
   * Ours first, the caller's after - and only if we did not consume the key.
   * The spread below would otherwise let a caller's own onKeyDown replace this
   * one outright and silently disable the dropdown's arrows and Enter.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % hits.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + hits.length) % hits.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(hits[active]?.name ?? hits[0].name); return; }
      if (e.key === "Escape") { e.preventDefault(); setMuted(query?.text ?? ""); return; }
    }
    // Only now is Enter the box's own again.
    if (e.key === "Enter" && !e.shiftKey && onEnter) { e.preventDefault(); onEnter(); return; }
    callerKeyDown?.(e as React.KeyboardEvent<HTMLInputElement> & React.KeyboardEvent<HTMLTextAreaElement>);
  };

  const shared = {
    ...rest,
    ref,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setMuted("");
      onChange(e.target.value);
      track(e.target);
    },
    onKeyUp: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => track(e.currentTarget),
    onClick: (e: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => track(e.currentTarget),
    onKeyDown,
    autoComplete: "off",
  };

  return (
    <div ref={box} style={{ position: "relative", flex: rest.style?.flex ?? undefined }}>
      {multiline
        ? <textarea {...(shared as React.TextareaHTMLAttributes<HTMLTextAreaElement> & { ref: typeof ref })} />
        : <input {...(shared as React.InputHTMLAttributes<HTMLInputElement> & { ref: typeof ref })} />}
      {open && (
        <div role="listbox" aria-label="People you can mention" style={{
          position: "absolute", zIndex: 60, left: 0, bottom: "calc(100% + 4px)",
          background: "#fff", border: "1px solid var(--line)", borderRadius: 10,
          boxShadow: "0 8px 28px rgba(15,23,42,.16)", minWidth: 240, maxWidth: 340,
          maxHeight: 240, overflowY: "auto", padding: 4,
        }}>
          {hits.map((h, i) => (
            <button key={h.email || h.name} type="button" role="option" aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              // mousedown, not click: blurring the box first would close the
              // list out from under the finger.
              onMouseDown={(e) => { e.preventDefault(); choose(h.name); }}
              style={{
                display: "flex", gap: 8, alignItems: "baseline", width: "100%", textAlign: "left",
                padding: "7px 9px", border: "none", borderRadius: 7, cursor: "pointer",
                background: i === active ? "#F1F5F9" : "#fff",
              }}>
              <span className="t-body" style={{ fontWeight: 700, color: "var(--navy)" }}>{h.name}</span>
              {h.org && <span className="mut t-meta">{h.org}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
