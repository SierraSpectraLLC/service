import Link from "next/link";
import { formatCents } from "@/lib/money";
import type { AccountKey, RefType } from "@/lib/ledger/accounts";
import type { Tone } from "@/lib/tones";

/**
 * A money figure that is a door into the ledger.
 *
 * Every dollar on every money screen is a sum over journal rows, and this is
 * how a reader proves it: click the figure, get the rows, with their sum
 * beside it. Nothing on any screen is stored, and the way to say so is to
 * make every figure open the rows it came from. Underline only on hover, so
 * a page reads as figures and not as a wall of links.
 *
 * The href is the ledger page's own filter vocabulary - account, window,
 * document kind and id, client, side - so a figure and the page it opens
 * cannot disagree about which rows are meant.
 */
export type FigureFilter = {
  acct?: AccountKey;
  /** Only this side of the account: "out" of the bank is its credits. */
  side?: "dr" | "cr";
  from?: string;
  to?: string;
  type?: RefType;
  id?: string | number;
  org?: number;
  /** Leave out reversed entries and their mirrors. */
  live?: boolean;
};

export function ledgerHref(f: FigureFilter): string {
  const p = new URLSearchParams();
  if (f.acct) p.set("acct", f.acct);
  if (f.side) p.set("side", f.side);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.type) p.set("type", f.type);
  if (f.id !== undefined && f.id !== "") p.set("id", String(f.id));
  if (f.org !== undefined) p.set("org", String(f.org));
  if (f.live) p.set("live", "1");
  const q = p.toString();
  return `/money/ledger${q ? `?${q}` : ""}`;
}

export default function Figure({ cents, filter, tone, label, big, title }: {
  cents: number;
  filter: FigureFilter;
  tone?: Tone;
  /** Words instead of the formatted figure - "$1,200 in the bank". */
  label?: React.ReactNode;
  big?: boolean;
  title?: string;
}) {
  return (
    <Link
      href={ledgerHref(filter)}
      className={`fig money${tone ? ` ${tone}` : ""}${big ? " big" : ""}`}
      title={title ?? "Show the ledger rows behind this figure"}
    >
      {label ?? formatCents(cents)}
    </Link>
  );
}
