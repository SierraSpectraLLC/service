"use client";

import { useEffect, useRef, useState } from "react";

/**
 * An address input that cannot be mistyped - when it has a key to work with.
 *
 * With NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY set, typing queries Google Places
 * Autocomplete (the New Places REST API, straight fetch - no SDK to load) and
 * picking a suggestion writes Google's own formatted address into the field.
 * That formatted string is the point: the server geocodes what gets SAVED,
 * and a picked address always resolves, where hand-typed ones sometimes
 * do not. Without the key this renders a plain input and costs nothing -
 * the fallback IS the old behavior.
 *
 * Sessions: Places bills an autocomplete session (all keystrokes + the pick)
 * as one unit when a session token spans them. One token per focus, retired
 * on pick, is the difference between paying per session and paying per
 * keystroke.
 */
const KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY?.trim() || "";

type Suggestion = { placeId: string; text: string };

const newToken = () =>
  (crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export default function AddressField({ value, onChange, placeholder, ariaLabel, id }: {
  value: string;
  onChange: (address: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
}) {
  const [hits, setHits] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const token = useRef(newToken());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const search = (q: string) => {
    onChange(q);
    if (!KEY) return;
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 4) { setHits([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY },
          body: JSON.stringify({ input: q, sessionToken: token.current }),
        });
        if (!res.ok) { setHits([]); return; }
        const data = await res.json() as {
          suggestions?: { placePrediction?: { placeId: string; text?: { text: string } } }[];
        };
        const list = (data.suggestions ?? [])
          .map((s) => s.placePrediction)
          .filter((p): p is NonNullable<typeof p> => !!p?.placeId)
          .map((p) => ({ placeId: p.placeId, text: p.text?.text ?? "" }))
          .filter((p) => p.text)
          .slice(0, 5);
        setHits(list);
        setOpen(list.length > 0);
      } catch { setHits([]); }
    }, 250);
  };

  const pick = async (s: Suggestion) => {
    setOpen(false);
    // The pick retires the session; details give the address as Google
    // formats it, which is the string the server's geocoder will always place.
    try {
      const res = await fetch(
        `https://places.googleapis.com/v1/places/${s.placeId}?sessionToken=${token.current}`,
        { headers: { "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": "formattedAddress" } },
      );
      const data = res.ok ? await res.json() as { formattedAddress?: string } : null;
      onChange(data?.formattedAddress || s.text);
    } catch {
      onChange(s.text);
    }
    token.current = newToken();
  };

  return (
    <div ref={box} style={{ position: "relative" }}>
      <input id={id} value={value} placeholder={placeholder} aria-label={ariaLabel}
        autoComplete="off"
        onChange={(e) => search(e.target.value)}
        onFocus={() => { if (hits.length) setOpen(true); }} />
      {open && (
        <div role="listbox" aria-label="Address suggestions" style={{
          position: "absolute", zIndex: 30, top: "100%", left: 0, right: 0, marginTop: 2,
          background: "var(--card, #fff)", border: "1px solid var(--line)", borderRadius: 8,
          boxShadow: "0 8px 18px -8px rgba(23,42,74,0.35)", overflow: "hidden",
        }}>
          {hits.map((h) => (
            <button key={h.placeId} type="button" role="option" aria-selected={false}
              onClick={() => pick(h)}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "7px 10px",
                border: "none", background: "none", cursor: "pointer", fontSize: 13,
              }}
              onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "#EEF3F9"; }}
              onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "none"; }}>
              {h.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
