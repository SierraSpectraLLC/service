import Link from "next/link";
import StatusLine from "@/components/ui/StatusLine";
import { formatDollars } from "@/lib/money";
import { positionTone, withPeriod, type Period } from "@/lib/finance";

/**
 * What is actually true about cash, in one sentence, before any table asks to
 * be read.
 *
 * The overview used to open with five tiles that did not sum. Every figure an
 * owner needed was on the page and the answer was on none of it, because the
 * answer is a subtraction and nothing performed it. This performs it.
 *
 * The fact that spoils it goes last and drives the tone, because that is the
 * part somebody has to do something about: being owed money is the ordinary
 * state of a service business, and being owed money that is past terms is not.
 */
export default function PositionLine({
  owedCents, owesCents, pastDueCents, pastDueCount, period,
}: {
  /** Invoiced and not yet paid: inside terms plus past them. */
  owedCents: number;
  /** Committed and not yet paid out: open purchase orders plus claims. */
  owesCents: number;
  pastDueCents: number;
  pastDueCount: number;
  period: Period;
}) {
  const net = owedCents - owesCents;
  const tone = positionTone(owedCents, pastDueCents);
  const share = owedCents > 0 ? Math.round((pastDueCents / owedCents) * 100) : 0;

  return (
    <StatusLine tone={tone} actions={<>
      {pastDueCents > 0 && (
        <Link className="btn sm accent" href={withPeriod("/money/collections", period)}>
          Work collections
        </Link>
      )}
      <Link className="btn sm" href={withPeriod("/money/invoices", period)}>See invoices</Link>
    </>}>
      You are owed <span className="fig">{formatDollars(owedCents)}</span> and owe{" "}
      <span className="fig">{formatDollars(owesCents)}</span>. Net{" "}
      <span className="fig">{formatDollars(net)}</span>
      {pastDueCents > 0 ? (
        <>
          {" "}— but <span className="fig">{formatDollars(pastDueCents)}</span> of what you are
          owed is past terms (<b>{share}%</b>, across {pastDueCount}{" "}
          invoice{pastDueCount === 1 ? "" : "s"}).
        </>
      ) : (
        <>. Nothing is past terms.</>
      )}
    </StatusLine>
  );
}
