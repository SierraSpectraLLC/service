"use client";

import { useEffect, useState } from "react";
import { DESKTOP_KEY } from "@/lib/inbox";

/**
 * The opt-in for OS-level popups when a notification lands while this tab is in
 * the background. Lives on the inbox page rather than in the header: it is a
 * setting, changed about twice ever, and it was costing a permanent button in
 * the nav bar.
 *
 * Double-gated on purpose - the browser's own permission AND this toggle, stored
 * per browser because "this computer" is what the setting means. Permission is
 * only ever requested from a click here; asking on page load is how a site gets
 * itself permanently blocked. NotificationCenter reads the same key when a poll
 * finds something new.
 */
export default function DesktopAlerts() {
  // Starts "off" on the server and on first paint, then reads the real state:
  // localStorage and Notification.permission don't exist during render.
  const [state, setState] = useState<"unknown" | "unsupported" | "on" | "off" | "blocked">("unknown");

  useEffect(() => {
    if (typeof Notification === "undefined") { setState("unsupported"); return; }
    if (Notification.permission === "denied") { setState("blocked"); return; }
    setState(Notification.permission === "granted" && window.localStorage.getItem(DESKTOP_KEY) === "on" ? "on" : "off");
  }, []);

  const enable = async () => {
    const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (perm === "granted") { window.localStorage.setItem(DESKTOP_KEY, "on"); setState("on"); }
    else setState(perm === "denied" ? "blocked" : "off");
  };
  const disable = () => { window.localStorage.setItem(DESKTOP_KEY, "off"); setState("off"); };

  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 4 }}>Desktop alerts</div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
        Pops up on this computer when something lands here while you&apos;re in another tab.
        Set per browser, so turning it on at the bench doesn&apos;t follow you home.
      </div>
      {state === "unsupported" && <div className="mut" style={{ fontSize: 13 }}>This browser can&apos;t show desktop alerts.</div>}
      {state === "blocked" && (
        <div style={{ fontSize: 13 }}>
          This browser is blocking alerts for the site. Allow notifications for it in the
          browser&apos;s own site settings, then come back.
        </div>
      )}
      {state === "on" && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "#2E6B2E", fontWeight: 700 }}>On for this browser ✓</span>
          <button className="btn sm" onClick={disable}>Turn off</button>
        </div>
      )}
      {state === "off" && <button className="btn sm primary" onClick={enable}>Enable desktop alerts</button>}
    </div>
  );
}
