"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { requestAcceptance, transferRestorationToBuyer } from "@/app/actions";
import { Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";
import RestorationChecklistCard from "@/components/RestorationChecklistCard";
import { VerdictCard } from "@/components/RestorationVerify";
import { fmtWhen } from "@/lib/when";
import type { CommissionStageData } from "@/lib/restorationData";

/**
 * The Commission stage: the on-site checklist, the on-site verdict, buyer
 * acceptance (signed in the BUYER's portal session - staff only request),
 * and the transfer that moves the record with the serial.
 */
export default function RestorationCommission({ projectId, data, canEdit, externalId }: {
  projectId: number;
  data: CommissionStageData;
  canEdit: boolean;
  externalId: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(data.acceptance?.requestedOf ?? "");
  const [pending, startTransition] = useTransition();

  const act = (fn: () => Promise<{ error?: string } | void>, done?: string) =>
    startTransition(async () => {
      const res = await fn();
      if (res && "error" in res && res.error) { toast({ message: res.error, tone: "bad" }); return; }
      if (done) toast({ message: done });
      router.refresh();
    });

  const acc = data.acceptance;

  return (
    <>
      <RestorationChecklistCard projectId={projectId} stage="commission_onsite"
        title="On-site checklist" eyebrow="receive → install → prove"
        data={data.onsite} canEdit={canEdit} />

      <VerdictCard projectId={projectId} phase="commission" verdict={data.verdict} canEdit={canEdit}
        title="On-site checkout" eyebrow="proved on the buyer's bench" />

      <section className="card">
        <h2 className="card-title">Acceptance <span className="eyebrow">buyer signs in their own portal</span></h2>
        {acc?.signedAt ? (
          <div className="gate-item">
            <span className="gate-mark ok">✓</span>
            Signed by {acc.signedBy} · {fmtWhen(acc.signedAt)}
            <span className="gate-src">portal</span>
          </div>
        ) : acc?.requestedAt ? (
          <div className="gate-item">
            <span className="gate-mark wait">…</span>
            Portal request sent to {acc.requestedOf} · {fmtWhen(acc.requestedAt)}
            <span className="gate-src">portal</span>
          </div>
        ) : (
          <div className="mut t-body" style={{ marginBottom: 8 }}>
            Not requested yet. The buyer signs on this project&apos;s page in their
            own signed-in portal session - never a share link.
          </div>
        )}
        {canEdit && !acc?.signedAt && (
          <div className="row al-center sp-2" style={{ marginTop: 8 }}>
            <input type="text" value={email} placeholder="buyer contact's email"
              onChange={(e) => setEmail(e.target.value)} style={{ maxWidth: 280 }} />
            <button className="btn sm primary" disabled={pending || !email.includes("@")}
              onClick={() => act(() => requestAcceptance(projectId, email), "Acceptance requested")}>
              {acc?.requestedAt ? "Re-send request" : "Request acceptance"}
            </button>
          </div>
        )}
        <div className="cred-note" style={{ marginTop: 8 }}>
          Acceptance is the release condition — when escrow is in play, funds
          move on this signature, not on a phone call.
        </div>
      </section>

      <section className="card">
        <div className="transfer">
          <h3>Transfer the record</h3>
          <p>
            On acceptance, {externalId}&apos;s full history — findings, parts, outside
            work, checkout verdicts, wipe certificate, handoff kit — moves to{" "}
            {data.buyerName || "the buyer"}. This workspace keeps a frozen
            provider copy. The serial keeps its story.
          </p>
          {canEdit ? (
            <button className="btn accent" disabled={pending || !acc?.signedAt}
              onClick={() => act(() => transferRestorationToBuyer(projectId), "Transferred - the restoration is complete")}>
              {acc?.signedAt ? "Transfer to buyer" : "Awaiting buyer acceptance"}
            </button>
          ) : (
            <Pill tone={acc?.signedAt ? "good" : "faint"}>{acc?.signedAt ? "Accepted" : "Awaiting acceptance"}</Pill>
          )}
        </div>
      </section>
    </>
  );
}
