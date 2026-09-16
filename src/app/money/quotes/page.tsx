import { ReceivablesRoom } from "@/app/money/receivables/page";

export const dynamic = "force-dynamic";

/**
 * Quotes: the receivables pipeline, held at its first stage. The shop
 * reaches for this more than for any other stage, so it has its own door in
 * the menu and its own address - see ReceivablesRoom for the one component
 * behind both.
 */
export default async function QuotesPage({ searchParams }: {
  searchParams: Promise<{ period?: string; org?: string }>;
}) {
  return ReceivablesRoom({ sp: await searchParams, room: "quotes" });
}
