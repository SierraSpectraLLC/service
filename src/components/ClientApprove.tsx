"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveQuoteAsClient, declineQuoteAsClient } from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";

/**
 * Answering a quote from inside your own session.
 *
 * The old affordance was a link to the PUBLIC share page: a signed-in client
 * was sent out of the portal to approve their own money through a token URL,
 * and if nobody had ever minted that link - or somebody had revoked it - the
 * button simply was not there and they had no way to answer at all.
 *
 * The signature is still asked for, and it is still typed, because a name
 * against a decision is what the paperwork needs. The difference is that it is
 * no longer the AUTHORIZATION: the server checks the session, the role and the
 * organization, and records the account alongside whatever was typed.
 */
export default function ClientApprove({ quoteId, number, total, canApprove, suggestedName }: {
  quoteId: number;
  number: string;
  /** Already formatted; shown back so nobody signs a figure they did not read. */
  total: string;
  /**
   * False for a read-only account. They still see the quote and its state -
   * approving work is financial authority, and a lab tech who can report a
   * down instrument should not be able to accept four thousand dollars.
   */
  canApprove: boolean;
  suggestedName: string;
}) {
  const [open, setOpen] = useState<"" | "yes" | "no">("");
  const [name, setName] = useState(suggestedName);
  const [why, setWhy] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  if (!canApprove) {
    return (
      <span className="mut t-small">
        Waiting on somebody at your organization who can approve work.
      </span>
    );
  }

  const close = () => { setOpen(""); setError(""); };

  const answer = (kind: "yes" | "no") => start(async () => {
    setError("");
    const res = kind === "yes"
      ? await approveQuoteAsClient(quoteId, name)
      : await declineQuoteAsClient(quoteId, name, why);
    if (res?.error) { setError(res.error); return; }
    close();
    toast({
      message: kind === "yes"
        ? `${number} approved. We will get started.`
        : `${number} declined. We have passed on your reason.`,
    });
    router.refresh();
  });

  return (
    <>
      <button className="btn sm primary" onClick={() => setOpen("yes")}>Approve</button>
      <button className="btn sm" onClick={() => setOpen("no")}>Decline</button>

      <Dialog open={open === "yes"} onClose={close} title={`Approve ${number}`}
        footer={
          <>
            <button className="btn" onClick={close} disabled={pending}>Cancel</button>
            <button className="btn primary" onClick={() => answer("yes")} disabled={pending || !name.trim()}>
              {pending ? "Approving…" : `Approve ${total}`}
            </button>
          </>
        }>
        <p className="t-body">
          Approving tells us to start the work in {number}, at <b>{total}</b>. Anything outside
          it is quoted to you before it happens.
        </p>
        <label className="t-small" style={{ display: "block", marginTop: 10 }}>
          Your name, as the signature on this
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Type your name to sign" aria-label="Your name" />
        </label>
        {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
      </Dialog>

      <Dialog open={open === "no"} onClose={close} title={`Decline ${number}`}
        footer={
          <>
            <button className="btn" onClick={close} disabled={pending}>Cancel</button>
            <button className="btn" onClick={() => answer("no")} disabled={pending || !name.trim()}>
              {pending ? "Sending…" : "Decline"}
            </button>
          </>
        }>
        <p className="t-body">
          Nothing is charged. Tell us why if you can - it goes to the engineer on the job, and
          it is usually the fastest route to a quote you would say yes to.
        </p>
        <label className="t-small" style={{ display: "block", marginTop: 10 }}>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Your name" />
        </label>
        <label className="t-small" style={{ display: "block", marginTop: 10 }}>
          Why, or what would change your mind
          <textarea value={why} onChange={(e) => setWhy(e.target.value)} rows={3}
            aria-label="Reason" />
        </label>
        {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
      </Dialog>
    </>
  );
}
