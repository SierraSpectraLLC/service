"use client";

import { useEffect, useState } from "react";
import { reportTrail } from "@/app/actions";
import { SHADOW_REFUSAL } from "@/lib/viewAs";
import { REPORT_EVENT } from "@/lib/reportEvent";

/**
 * The page that appears when a page throws, and the one place a render error
 * can be caught at all.
 *
 * Two jobs, and the second is the one that was missing: say something a person
 * can act on, and FILE THE ERROR. A React render error never reaches
 * window.onerror - the boundary swallows it - so before this, the most
 * common kind of failure in a Next app was the one kind nothing recorded.
 *
 * The report is best-effort and silent. A trail that could fail this boundary
 * would replace a broken page with a blank one.
 */
export default function ErrorPage({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  /* The one "error" that is not one: a write refused because the operator is
     standing in somebody's shoes. Their screen still shows their buttons -
     that IS their screen - so pressing one is an easy mistake, and it should
     read as a polite decline rather than as a crash on top of the bug being
     chased. Recognised by message so every action gets it at once. */
  const refused = error.message === SHADOW_REFUSAL;
  const [said, setSaid] = useState(false);

  useEffect(() => {
    if (refused) return;
    void reportTrail({
      kind: "error",
      route: window.location.pathname,
      search: window.location.search,
      message: error.message || "Render error",
      // The digest is how a server-side message, which production replaces
      // with a generic string, is matched back to the server log.
      detail: `${error.digest ? `digest ${error.digest}\n` : ""}${error.stack ?? ""}`.trim(),
    }).catch(() => {});
  }, [error, refused]);

  if (refused) {
    return (
      <div className="container">
        <div className="card" style={{ marginTop: 40, padding: "22px 24px" }}>
          <div className="card-title" style={{ marginBottom: 6 }}>
            Nothing can be changed from here.
          </div>
          <div className="t-body mut" style={{ marginBottom: 14 }}>
            You are looking at somebody else&apos;s screen. Their controls are
            shown because that is what they see - but this mode only reads.
            Leave it from the banner at the top to act as yourself.
          </div>
          <button className="btn accent" onClick={() => reset()}>Back to their screen</button>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card" style={{ marginTop: 40, padding: "22px 24px" }}>
        <div className="card-title" style={{ marginBottom: 6 }}>That page did not load.</div>
        <div className="t-body mut" style={{ marginBottom: 14 }}>
          The failure has been recorded with the page you were on. Trying again
          often works - the same page twice in a row means it is not you.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn accent" onClick={() => reset()}>Try again</button>
          <a className="btn" href="/">Back to the start</a>
          {/* The floating button is mounted in the layout, which is still
              standing when a PAGE throws - but somebody looking at a broken
              page should not have to go hunting for a 34px circle. Same
              dialog, opened by the same shortcut it advertises everywhere
              else, so pressing this is the thing they already half know. */}
          <button className="btn link" style={{ fontSize: 13 }} disabled={said}
            onClick={() => {
              setSaid(true);
              window.dispatchEvent(new Event(REPORT_EVENT));
            }}>
            {said ? "thanks" : "tell somebody what you were doing"}
          </button>
        </div>
        {error.digest && (
          <div className="mut t-meta" style={{ marginTop: 12 }}>
            Reference <span className="mono">{error.digest}</span>
          </div>
        )}
      </div>
    </div>
  );
}
