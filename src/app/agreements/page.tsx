import { redirect } from "next/navigation";

/** Agreements live under Settings › Organizations now; the old URL follows. */
export default function AgreementsRedirect() {
  redirect("/settings/agreements");
}
