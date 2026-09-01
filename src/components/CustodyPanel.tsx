"use client";

import { useEffect, useState, useTransition } from "react";
import { handOffSystem, kickToQueue } from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import Dialog from "@/components/ui/Dialog";
import { custodyLine, type CustodyEntry } from "@/lib/custodyLine";

/** How the standing line above the record opens this panel's move dialog. */
export const QUEUE_EVENT = "ridgeline:queue-move";

export type CustodyRow = {
  id: number; kind: string; fromName: string; toName: string; note: string;
  when: string; at: string; actor: string;
};

export type QueueLegRow = {
  id: number; fromName: string; toName: string; reason: string; actor: string;
  when: string; at: string;
};

const KIND_WORD: Record<string, string> = {
  intake: "First owner on record",
  transfer: "Handed on",
  claim: "Claimed and granted",
  release: "Returned to house stewardship",
};

/**
 * Who has this machine - both senses of the word, in one card.
 *
 * POSSESSION is whose move it is: parking a system with the client is how
 * finished-but-not-shipped work leaves the shop's board without being archived
 * or faked, and how a blockage on their side stops counting against turnaround.
 * OWNERSHIP is whose machine it is, which for anything that will be resold is
 * the asset itself - a serial number that can show who has held it and when is
 * worth more than one that can't.
 *
 * They were two cards. Same question from opposite ends, two headings, two
 * chronologies, and the shop's own read on it: "they more or less handle the
 * same thing anyway". They do. See lib/custodyLine for the interleave.
 */
export default function CustodyPanel({
  instrumentId, externalId,
  holderName, isMine, since, days, reason, seenBy = "", seenAt = "",
  legs, queueOptions, ourName, canKick,
  ownerName, providers, orgOptions, canHandOff, events, showOwnership = true,
}: {
  instrumentId: number;
  externalId: string;

  // ── Possession ───────────────────────────────────────────────────────────
  /** Who holds the queue right now, already resolved to a name. */
  holderName: string;
  /** True when the viewer is the one expected to act. */
  isMine: boolean;
  /** The day it landed there, already formatted. */
  since: string;
  days: number;
  /** What they are waiting on, in the words whoever parked it used. */
  reason: string;
  /**
   * Who dismissed the handback line on their side, and when.
   *
   * The receipt on the notification, and the answer to a question the board
   * could never answer: a system parked with a client and a note attached
   * looked exactly the same whether they read it that afternoon or never
   * opened the record. Blank means nobody has.
   */
  seenBy?: string;
  seenAt?: string;
  legs: QueueLegRow[];
  /** Organizations with access to this system - the only valid destinations. */
  queueOptions: { id: number; name: string; kind: string }[];
  /** What to call our own queue. */
  ourName: string;
  canKick: boolean;

  // ── Ownership ────────────────────────────────────────────────────────────
  ownerName: string;
  /** Everyone else with access right now - they survive a handoff by design. */
  providers: { name: string; kind: string; access: string }[];
  orgOptions: { id: number; name: string; kind: string }[];
  canHandOff: boolean;
  events: CustodyRow[];
  /**
   * Whether this reader gets the ownership half at all.
   *
   * A client sees their own machine's queue, which is theirs to know and
   * always was. Who else has owned it, and the roster of companies it could be
   * handed to, is the operator's book - see lib/clientView for the same
   * reasoning applied panel by panel.
   */
  showOwnership?: boolean;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [toOrgId, setToOrgId] = useState<string>("");
  const [why, setWhy] = useState("");
  const [moveErr, setMoveErr] = useState("");

  const [handOpen, setHandOpen] = useState(false);
  const [handTo, setHandTo] = useState(0);
  const [note, setNote] = useState("");
  const [keep, setKeep] = useState(false);
  const [handErr, setHandErr] = useState("");

  const [pending, startTransition] = useTransition();

  // The standing line above the record carries the same one decision and no
  // room for the form, so it opens this one rather than growing a second copy
  // of it. Same channel the hero kebab uses to reach the layout.
  useEffect(() => {
    const on = () => { if (canKick) { setMoveOpen(true); setMoveErr(""); } };
    window.addEventListener(QUEUE_EVENT, on);
    return () => window.removeEventListener(QUEUE_EVENT, on);
  }, [canKick]);

  const parked = !isMine;
  const owns = showOwnership;
  const handTarget = orgOptions.find((o) => o.id === handTo);
  const moveTarget = toOrgId === "" ? null : toOrgId === "us" ? null : parseInt(toOrgId);
  const moveTargetName = toOrgId === "us" ? ourName : queueOptions.find((o) => String(o.id) === toOrgId)?.name ?? "";

  const rows: CustodyEntry[] = custodyLine(
    legs.map((l) => ({ ...l, at: new Date(l.at) })),
    owns ? events.map((e) => ({ ...e, at: new Date(e.at) })) : [],
  );

  const send = () => {
    if (!toOrgId) { setMoveErr("Pick whose queue it goes into"); return; }
    if (why.trim().length < 3) { setMoveErr("Say what they're waiting on - it's the whole message"); return; }
    setMoveErr("");
    startTransition(async () => {
      const res = await kickToQueue(instrumentId, moveTarget, why);
      if (res?.error) setMoveErr(res.error);
      else {
        setMoveOpen(false); setToOrgId(""); setWhy("");
        toast({ message: `Moved ${externalId} to ${moveTargetName || "their"} queue` });
      }
    });
  };

  return (
    <div className="card" style={parked ? { borderLeft: "3px solid #8A5410" } : undefined}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <div className="card-title">Custody</div>
        {/* Only worth a chip when someone else is holding it - "ours" is the
            default state of every system on the board and says nothing. */}
        {!isMine && <span className={`pill ${parked ? "warn" : "info"}`}>With {holderName}</span>}
        <span className="mut t-small">
          {days === 0 ? "since today" : `${days} day${days === 1 ? "" : "s"}`} · {since}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {canKick && (
            <button className="btn sm primary" onClick={() => { setMoveOpen(!moveOpen); setMoveErr(""); }}>
              {moveOpen ? "Cancel" : "Move it"}
            </button>
          )}
          {owns && canHandOff && (
            <button className="btn sm" onClick={() => { setHandOpen(!handOpen); setHandErr(""); }}>
              {handOpen ? "Cancel" : "Hand off"}
            </button>
          )}
        </span>
      </div>

      {/* The two standing facts, one line each. Possession is the one that
          changes weekly; ownership is the one that almost never does, which is
          why it reads as a footnote rather than as a second heading. */}
      {reason && (
        <div className="t-body" style={{ borderLeft: "3px solid var(--line)", padding: "4px 10px", margin: "6px 0" }}>
          {reason}
          {/* Only about somebody else's queue: "their side" means nothing when
              the queue is our own. Read or not read, said plainly - an unread
              handback is not a failure on anybody's part, it is a phone call
              that has not been made yet, and knowing which beats guessing. */}
          {!isMine && (
            <div className="mut t-small" style={{ marginTop: 4 }}>
              {/* Local part only, the same way the rows below name their actor
                  - a whole mailbox in a receipt line is noise. */}
              {seenAt
                ? `Seen by ${seenBy.split("@")[0] || "them"} · ${seenAt}`
                : "Not opened on their side yet"}
            </div>
          )}
        </div>
      )}
      {!reason && (
        <div className="mut t-small" style={{ marginBottom: 6 }}>
          {isMine
            ? "Nobody is waiting on anyone else. Move it to a client's queue when the next step is theirs."
            : `${holderName} has the next move on this system.`}
        </div>
      )}

      {owns && (
        <div className="mut t-small" style={{ marginBottom: 6 }}>
          Owned by <b style={{ color: "var(--ink)" }}>{ownerName}</b>.
        </div>
      )}

      {moveOpen && (
        <Dialog open onClose={() => setMoveOpen(false)} title={`Move ${externalId} to another queue`}
          footer={
            <>
              <span className={`dialog-status${moveErr ? " err" : ""}`}>{moveErr}</span>
              <button className="btn" onClick={() => setMoveOpen(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={send} disabled={pending}>
                {pending ? "Moving..." : `Move to ${moveTargetName || "their"} queue`}
              </button>
            </>
          }>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Into whose queue</label>
              <select value={toOrgId} onChange={(e) => setToOrgId(e.target.value)}>
                <option value="">Pick a queue…</option>
                {!isMine && <option value="us">{ourName} (take it back)</option>}
                {queueOptions.map((o) => <option key={o.id} value={String(o.id)}>{o.name} ({o.kind})</option>)}
              </select>
            </div>
            <div>
              <label>What are they waiting on? *</label>
              <input value={why} onChange={(e) => setWhy(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") send(); }}
                placeholder="Running application tests / your N2 generator tech" />
            </div>
          </div>
          <div className="mut t-meta" style={{ marginBottom: 10 }}>
            {moveTargetName || "They"} get a notification with that reason, and {externalId} drops off
            our board until it comes back. Access, ownership and history are untouched, and the
            days it spends there don&apos;t count against our turnaround.
          </div>
        </Dialog>
      )}
      {!moveOpen && moveErr && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{moveErr}</div>}

      {owns && handOpen && (
        <Dialog open onClose={() => setHandOpen(false)} title={`Hand off ${externalId}`}
          context={`Currently owned by ${ownerName}.`}
          footer={
            <>
              <span className={`dialog-status${handErr ? " err" : ""}`}>
                {handErr || (!handTo ? "Pick the new owner to continue." : "")}
              </span>
              <button className="btn" onClick={() => setHandOpen(false)} disabled={pending}>Cancel</button>
              <button className="btn primary" disabled={pending || !handTo}
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: `Hand ${externalId} to ${handTarget?.name}?`,
                    body: (
                      <>
                        <b>What happens:</b>
                        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                          <li>{handTarget?.name ?? "The new owner"} gets ownership and full edit access.</li>
                          <li>{ownerName} keeps a frozen record of their period of ownership
                            {keep ? " and read-only access." : " and loses live access."}</li>
                          <li>
                            {providers.length
                              ? <>Access is unchanged for {providers.map((p) => p.name).join(", ")} - they keep working the system.</>
                              : <>Nobody else currently has access.</>}
                          </li>
                          <li>Part costs and PO numbers recorded by {ownerName} stay hidden from the new owner.</li>
                        </ul>
                        <div className="mut" style={{ marginTop: 8 }}>Permanent, and recorded.</div>
                      </>
                    ),
                    action: `Hand off to ${handTarget?.name}`,
                  });
                  if (!ok) return;
                  setHandErr("");
                  startTransition(async () => {
                    try {
                      const res = await handOffSystem(instrumentId, handTo, { note, keepPreviousAsViewer: keep });
                      if (res?.error) { setHandErr(res.error); return; }
                      toast({ message: `Handed ${externalId} to ${handTarget?.name}` });
                      setHandOpen(false); setHandTo(0); setNote(""); setKeep(false);
                    } catch (e) {
                      // A server action that throws used to reject into nothing,
                      // which is indistinguishable from a dead button.
                      setHandErr(`The handoff didn't go through: ${(e as Error).message || "server error"}`);
                    }
                  });
                }}>
                {pending ? "Handing off..." : handTo ? `Hand off to ${handTarget?.name}` : "Hand off"}
              </button>
            </>
          }>
          <div style={{ marginBottom: 8 }}>
            <label>Hand {externalId} to</label>
            <select value={handTo} onChange={(e) => setHandTo(parseInt(e.target.value))}>
              <option value={0}>Pick the new owner…</option>
              {orgOptions.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.kind})</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label>Note for the record</label>
            <input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Shipped to end customer, PO 4471" />
          </div>
          <label className="t-small" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} style={{ width: 15, height: 15 }} />
            Keep {ownerName} on as a viewer - usual when they resold it and still want visibility.
          </label>

          {/* The confirm carries the consequence list; see the rationale on
              confirmDialog for why it must not be a native confirm(). */}
        </Dialog>
      )}

      {rows.length > 0 && (
        <>
          <div className="eyebrow" style={{ margin: "12px 0 4px" }}>
            {owns ? "Where it has been" : "Handovers"}
          </div>
          {rows.map((r) => (
            <div key={r.key} className="t-small" style={{ borderTop: "1px solid var(--line)", padding: "5px 0" }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                <span style={{ fontWeight: 700 }}>
                  {r.fromName && r.toName ? `${r.fromName} → ${r.toName}` : r.toName || r.fromName || "unknown"}
                </span>
                {/* The axis, said rather than colour-coded: one list of moves
                    where half change who acts and half change who owns is
                    unreadable unless each row says which it is. */}
                <span className="mut t-meta">
                  {r.axis === "owner" ? KIND_WORD[r.kind] ?? r.kind : "Moved queues"}
                </span>
                <span className="mut t-meta" style={{ marginLeft: "auto" }}>
                  {r.actor ? `${r.actor.split("@")[0]} · ` : ""}{r.when}
                </span>
              </div>
              {r.note && <div className="mut">{r.note}</div>}
            </div>
          ))}
        </>
      )}
      {rows.length === 0 && owns && (
        <div className="mut t-body" style={{ marginTop: 8 }}>
          It has not changed hands or queues since it was put on file.
        </div>
      )}
    </div>
  );
}
