"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { markNotificationRead } from "@/app/actions";

type Fresh = { id: number; kind: string; title: string; href: string };

const POLL_MS = 45_000;
const TOAST_MS = 9_000;
const DESKTOP_KEY = "notify:desktop"; // "on" once the person enabled OS alerts

/**
 * The nav's live inbox: badge, toast popups for new arrivals, and opt-in OS
 * notifications for when the tab is in the background.
 *
 * "Live" is polling (~45s, plus a poll on tab-focus), because a serverless
 * function can't hold a socket open. That cadence is honest for a shop: an
 * assignment arriving 30 seconds late costs nothing, and the fallback is the
 * email that already went out.
 *
 * OS notifications are double-gated: the browser's own permission AND an
 * explicit toggle here, stored per browser. Permission is only ever requested
 * from the toggle click - never on page load, which is how sites get
 * permanently blocked.
 */
export default function NotificationCenter({ initialUnread }: { initialUnread: number }) {
  const [unread, setUnread] = useState(initialUnread);
  const [toasts, setToasts] = useState<Fresh[]>([]);
  const [desktop, setDesktop] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const cursor = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    setDesktop(typeof Notification !== "undefined"
      && Notification.permission === "granted"
      && window.localStorage.getItem(DESKTOP_KEY) === "on");
  }, []);

  useEffect(() => {
    let stopped = false;

    const dismissLater = (id: number) => {
      timers.current.set(id, setTimeout(() => {
        setToasts((ts) => ts.filter((t) => t.id !== id));
        timers.current.delete(id);
      }, TOAST_MS));
    };

    const poll = async () => {
      try {
        const res = await fetch(`/api/notifications/poll?after=${cursor.current}`, { cache: "no-store" });
        if (!res.ok || stopped) return;
        const j = (await res.json()) as { unread: number; cursor: number; fresh: Fresh[] };
        setUnread(j.unread);
        cursor.current = j.cursor;
        if (j.fresh.length) {
          setToasts((ts) => [...ts, ...j.fresh].slice(-4)); // never a wall of toasts
          j.fresh.forEach((f) => dismissLater(f.id));
          if (document.visibilityState === "hidden"
            && typeof Notification !== "undefined" && Notification.permission === "granted"
            && window.localStorage.getItem(DESKTOP_KEY) === "on") {
            for (const f of j.fresh) {
              const n = new Notification(f.title, { tag: `portal-${f.id}` });
              n.onclick = () => { window.focus(); if (f.href) window.location.href = f.href; };
            }
          }
        }
      } catch { /* offline or asleep - the next tick tries again */ }
    };

    void poll();
    const iv = setInterval(poll, POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    const t = timers.current;
    return () => {
      stopped = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
      t.forEach(clearTimeout); t.clear();
    };
  }, []);

  const enableDesktop = async () => {
    if (typeof Notification === "undefined") return;
    const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (perm === "granted") {
      window.localStorage.setItem(DESKTOP_KEY, "on");
      setDesktop(true);
    }
  };
  const disableDesktop = () => { window.localStorage.setItem(DESKTOP_KEY, "off"); setDesktop(false); };

  const dismiss = (id: number) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
    setToasts((ts) => ts.filter((x) => x.id !== id));
  };

  return (
    <>
      <span style={{ position: "relative", display: "inline-flex" }}>
        <Link className="btn sm" href="/inbox" style={{ textDecoration: "none", fontWeight: unread ? 700 : undefined }}
          onContextMenu={(e) => { e.preventDefault(); setMenuOpen((v) => !v); }}>
          Inbox{unread ? ` (${unread})` : ""}
        </Link>
        <button aria-label="Notification options" className="btn sm" style={{ padding: "8px 6px", marginLeft: 2 }}
          onClick={() => setMenuOpen((v) => !v)}>▾</button>
        {menuOpen && (
          <>
            <span onClick={() => setMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
            <span style={{
              position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 31, background: "#fff",
              border: "1px solid var(--line)", borderRadius: 10, boxShadow: "0 8px 24px rgba(23,42,74,0.14)",
              padding: "10px 12px", minWidth: 230, color: "var(--ink)",
            }}>
              <span className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Alerts</span>
              {typeof Notification === "undefined" ? (
                <span className="mut" style={{ fontSize: 12 }}>This browser can&apos;t show desktop alerts.</span>
              ) : desktop ? (
                <button className="btn sm" onClick={disableDesktop} style={{ width: "100%" }}>
                  Turn off desktop alerts
                </button>
              ) : (
                <button className="btn sm primary" onClick={enableDesktop} style={{ width: "100%" }}>
                  Enable desktop alerts
                </button>
              )}
              <span className="mut" style={{ display: "block", fontSize: 11, marginTop: 6 }}>
                Pops up on this computer when something lands in your inbox while
                you&apos;re in another tab. Per-kind email switches live in the inbox.
              </span>
            </span>
          </>
        )}
      </span>

      {toasts.length > 0 && (
        <div aria-live="polite" style={{
          position: "fixed", right: 14, bottom: 14, zIndex: 60,
          display: "flex", flexDirection: "column", gap: 8, maxWidth: 360,
        }}>
          {toasts.map((t) => (
            <div key={t.id} style={{
              background: "#fff", border: "1px solid var(--line)", borderLeft: "3px solid var(--navy)",
              borderRadius: 10, boxShadow: "0 8px 24px rgba(23,42,74,0.18)", padding: "10px 12px",
              display: "flex", gap: 8, alignItems: "baseline",
            }}>
              {t.href ? (
                <Link href={t.href} style={{ fontSize: 13, textDecoration: "none", color: "var(--ink)", fontWeight: 600, flex: 1 }}
                  onClick={() => { void markNotificationRead(t.id); dismiss(t.id); }}>
                  {t.title}
                </Link>
              ) : (
                <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{t.title}</span>
              )}
              <button className="btn link" aria-label="Dismiss" style={{ fontSize: 13, padding: "0 2px" }}
                onClick={() => dismiss(t.id)}>×</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
