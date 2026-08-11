"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { markNotificationRead } from "@/app/actions";
import { DESKTOP_KEY } from "@/lib/inbox";

type Fresh = { id: number; kind: string; title: string; href: string };

const POLL_MS = 45_000;
const TOAST_MS = 9_000;

/**
 * The nav's live inbox: one link with an unread count, and toast popups for new
 * arrivals. Raises OS notifications too when the tab is hidden and the person
 * has opted in on the inbox page - the switch lives there rather than behind a
 * caret in the header, which is a permanent button for a setting nobody
 * changes twice.
 *
 * "Live" is polling (~45s, plus a poll on tab-focus), because a serverless
 * function can't hold a socket open. That cadence is honest for a shop: an
 * assignment arriving 30 seconds late costs nothing, and the fallback is the
 * email that already went out.
 */
export default function NotificationCenter({ initialUnread }: { initialUnread: number }) {
  const [unread, setUnread] = useState(initialUnread);
  const [toasts, setToasts] = useState<Fresh[]>([]);
  const cursor = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

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

  const dismiss = (id: number) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
    setToasts((ts) => ts.filter((x) => x.id !== id));
  };

  return (
    <>
      <Link className="btn sm" href="/inbox" style={{ textDecoration: "none", fontWeight: unread ? 700 : undefined }}>
        Inbox{unread ? ` (${unread})` : ""}
      </Link>

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
