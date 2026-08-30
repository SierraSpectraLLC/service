"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { signAcceptance } from "@/app/actions";
import { toast } from "@/components/ui/Toast";

/**
 * The buyer's half of acceptance: a typed name in their own signed-in portal
 * session. Typing the name IS the signature - the same doctrine as the house
 * signoffs - and the server checks the session belongs to the buying
 * organization before anything is written.
 */
export default function BuyerAcceptanceCard({ projectId }: { projectId: number }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();

  const sign = () => startTransition(async () => {
    const res = await signAcceptance(projectId, name);
    if (res?.error) { toast({ message: res.error, tone: "bad" }); return; }
    toast({ message: "Accepted - thank you. The record transfers to your organization." });
    router.refresh();
  });

  return (
    <div>
      <div className="mut t-body" style={{ marginBottom: 8 }}>
        Signing accepts delivery and commissioning of this system. Your typed
        name is the signature; it is recorded with your login and the moment.
      </div>
      <div className="row al-center sp-2">
        <input value={name} placeholder="Type your full name" aria-label="Your full name"
          onChange={(e) => setName(e.target.value)} style={{ maxWidth: 280 }} />
        <button className="btn accent" disabled={pending || !name.trim()} onClick={sign}>
          {pending ? "Signing…" : "Accept & sign"}
        </button>
      </div>
    </div>
  );
}
