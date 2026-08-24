"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { dismissWhatsNew } from "@/app/actions";

/** Dates cross the boundary as data; images are plain /public paths. */
export type WhatsNewCard = {
  key: string; date: string; title: string; body: string;
  image?: string; href?: string;
};

const mdY = (iso: string) => {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x));
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "long", day: "numeric" });
};

/**
 * The What's-new overlay: one card per change, swiped or arrowed through,
 * gone for good once dismissed.
 *
 * A horizontal scroll-snap strip rather than a stateful carousel, so a thumb
 * on a phone and a trackpad on a desk both just work; the dots and arrows
 * read and drive the same scroll position. Dismissing anywhere - button,
 * scrim, Escape - marks the whole batch seen: a changelog that reappears
 * because somebody closed it the "wrong" way is a nag, and this must never
 * be one. It renders nothing at all once dismissed, no flicker on reload.
 */
export default function WhatsNew({ cards }: { cards: WhatsNewCard[] }) {
  const [gone, setGone] = useState(false);
  const [page, setPage] = useState(0);
  const strip = useRef<HTMLDivElement>(null);
  const [, startTransition] = useTransition();

  // Optimistic: the overlay leaves instantly, the marker writes behind it. If
  // the write fails the worst case is seeing the cards once more - the right
  // failure direction for furniture like this.
  const dismiss = () => {
    setGone(true);
    startTransition(async () => { await dismissWhatsNew(); });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (gone || cards.length === 0) return null;

  const go = (dir: number) => {
    const el = strip.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth, behavior: "smooth" });
  };
  const jump = (i: number) => {
    const el = strip.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="What's new in Baseline"
      onClick={dismiss}
      style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(23,42,74,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 14, width: "min(560px, 94vw)", boxShadow: "0 18px 60px rgba(23,42,74,.35)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div className="row-2" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
          <span className="t-lead" style={{ fontWeight: 800, color: "var(--navy)" }}>What&apos;s new in Baseline</span>
          {cards.length > 1 && (
            <span className="mut t-small">{page + 1} of {cards.length}</span>
          )}
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={dismiss}>Dismiss</button>
        </div>

        <div ref={strip}
          onScroll={(e) => {
            const el = e.currentTarget;
            setPage(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
          }}
          style={{ display: "flex", overflowX: "auto", scrollSnapType: "x mandatory", scrollbarWidth: "none" }}>
          {cards.map((c) => (
            <div key={c.key} style={{ flex: "0 0 100%", scrollSnapAlign: "start", scrollSnapStop: "always" }}>
              {c.image && (
                /* A fixed-height window onto the screenshot: cards stay the
                   same size however the pictures are shaped, so the strip
                   never jumps height mid-swipe. */
                <div style={{ height: 240, background: "var(--t-faint-bg)", borderBottom: "1px solid var(--line)", overflow: "hidden", display: "flex", alignItems: "flex-start", justifyContent: "center" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={c.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top center" }} />
                </div>
              )}
              <div style={{ padding: "14px 18px 6px" }}>
                <div className="mut t-meta" style={{ textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{mdY(c.date)}</div>
                <div style={{ fontWeight: 800, fontSize: 16, color: "var(--navy)", marginBottom: 6 }}>{c.title}</div>
                <p className="t-body" style={{ lineHeight: 1.55, margin: 0 }}>{c.body}</p>
                {c.href && (
                  <a href={c.href} className="btn link t-small" style={{ paddingLeft: 0 }}>Take a look →</a>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="row-3" style={{ padding: "10px 16px 14px" }}>
          {cards.length > 1 && (
            <>
              <button className="btn sm" aria-label="Previous card" onClick={() => go(-1)} disabled={page === 0}>‹</button>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {cards.map((c, i) => (
                  <button key={c.key} aria-label={`Card ${i + 1}`} onClick={() => jump(i)}
                    style={{ width: 8, height: 8, borderRadius: "50%", border: "none", cursor: "pointer", padding: 0, background: i === page ? "var(--navy)" : "#CBD5E1" }} />
                ))}
              </span>
              <button className="btn sm" aria-label="Next card" onClick={() => go(1)} disabled={page === cards.length - 1}>›</button>
            </>
          )}
          <button className="btn sm primary" style={{ marginLeft: "auto" }}
            onClick={page === cards.length - 1 || cards.length === 1 ? dismiss : () => go(1)}>
            {page === cards.length - 1 || cards.length === 1 ? "Got it" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
