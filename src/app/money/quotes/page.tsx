import { redirect } from "next/navigation";
import { RETIRED_ROUTES } from "@/lib/finance";

/**
 * A room that was folded into the seven. The old path keeps answering so a
 * bookmark, a digest link or a muscle memory still lands - see
 * RETIRED_ROUTES in lib/finance for where each one went.
 */
export default async function RetiredRoom({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const { period } = await searchParams;
  const to = RETIRED_ROUTES["/money/quotes"];
  redirect(period && period !== "month" ? `${to}${to.includes("?") ? "&" : "?"}period=${period}` : to);
}
