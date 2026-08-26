"use client";

import { useTransition } from "react";
import { clearTrail, setModule } from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { Panel, Pill } from "@/components/ui";
import { TRAIL_KEEP_DAYS } from "@/lib/trail";

/**
 * The switch, and the sentence that should be read before it is flipped.
 *
 * The disclosure is not decoration. On a multi-tenant instance most of the
 * people this records work for somebody else's company, and whether their
 * employer has told them their portal use is logged is a question the operator
 * has to answer, not one this app can answer for them. Saying so at the switch
 * is the only moment it will actually be read.
 */
export default function TrailControls({ on, kept }: { on: boolean; kept: number }) {
  const [busy, start] = useTransition();

  const flip = () => start(async () => {
    const res = await setModule("trail", !on);
    if (res?.error) toast({ message: res.error, tone: "bad" });
    else toast({ message: on ? "Trail off - nothing is being recorded" : "Trail on" });
  });

  const wipe = async () => {
    const ok = await confirmDialog({
      title: "Delete everything recorded?",
      body: `All ${kept} row${kept === 1 ? "" : "s"} go, including errors nobody has looked at yet. Recording carries on if the trail is on.`,
      action: "Delete it all",
      tone: "bad",
    });
    if (!ok) return;
    start(async () => {
      const res = await clearTrail();
      if (res?.error) toast({ message: res.error, tone: "bad" });
      else toast({ message: `Cleared ${res.cleared ?? 0} rows` });
    });
  };

  return (
    <Panel title="Recording"
      actions={<Pill tone={on ? "good" : "neutral"}>{on ? "On" : "Off"}</Pill>}>
      <div className="t-body" style={{ marginBottom: 8 }}>
        Records the page each person opens and every error thrown at them, for{" "}
        {TRAIL_KEEP_DAYS} days. It does not record clicks, and it does not record
        what anybody types into a search box.
      </div>
      <div className="mut t-small" style={{ marginBottom: 10 }}>
        Most of the people this records work for your clients, not for you.
        Whether their employer has told them their portal use is logged is
        yours to answer before this goes on.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button className={`btn sm${on ? "" : " accent"}`} onClick={flip} disabled={busy}>
          {busy ? "Saving..." : on ? "Turn it off" : "Turn it on"}
        </button>
        {kept > 0 && (
          <>
            <span className="mut t-meta">{kept} row{kept === 1 ? "" : "s"} kept</span>
            <button className="btn sm link danger" onClick={wipe} disabled={busy}>Delete them</button>
          </>
        )}
      </div>
    </Panel>
  );
}
