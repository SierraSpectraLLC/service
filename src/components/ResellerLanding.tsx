import Link from "next/link";
import { EmptyState, Panel, Pill } from "@/components/ui";
import type { ClientTodo } from "@/lib/clientView";
import type { PipelineStage, StalledUnit } from "@/lib/clientLandingData";

/**
 * A reseller's landing: where their units are in the process, and which ones
 * have stopped.
 *
 * The lab landing asks "can I use it". That question is meaningless here - a
 * unit in refurbishment is SUPPOSED to be in pieces, and stages.ts says so
 * where it calls "In service" a resting state rather than a step. What a
 * reseller wants is whether stock is moving, so this counts positions in a
 * process and says how long each one usually takes.
 *
 * There is no uptime figure here either, and for a second reason on top of the
 * first: uptime would be meaningless for a machine that is deliberately apart.
 */
export default function ResellerLanding({
  stages, stalled, todos, listings, operatorName, orgName, shippedThisYear,
}: {
  stages: PipelineStage[];
  stalled: StalledUnit[];
  todos: ClientTodo[];
  listings: { id: number; externalId: string; label: string; note: string; token: string }[];
  operatorName: string;
  orgName: string;
  shippedThisYear: number;
}) {
  const inPipeline = stages.reduce((n, s) => n + s.count, 0);

  return (
    <>
      {todos.length > 0 && (
        <section className="waiting" aria-labelledby="waiting-h">
          <h2 id="waiting-h">
            {operatorName} is waiting on you · {todos.length} thing{todos.length === 1 ? "" : "s"}
          </h2>
          <ol>
            {todos.map((t) => (
              <li key={t.key}>
                <span className="grow">
                  <Link href={t.href} className="plain" style={{ fontWeight: 600 }}>{t.title}</Link>
                  <span className="sub">{t.detail}</span>
                </span>
                {t.days !== undefined && t.days > 0 && (
                  <Pill tone={t.tone}>{t.days} day{t.days === 1 ? "" : "s"}</Pill>
                )}
                <Link className="btn sm" href={t.href}>{t.action}</Link>
              </li>
            ))}
          </ol>
        </section>
      )}

      <h3 className="band-label">
        Where your units are
        <span className="sp" />
        <span className="mut t-meta">{inPipeline} in the pipeline</span>
      </h3>

      {inPipeline === 0 ? (
        <EmptyState title="Nothing in the pipeline yet."
          body={`Units show up here as ${operatorName} takes them in.`} />
      ) : (
        <div className="pipe">
          {stages.filter((s) => s.count > 0).map((s) => (
            <div key={s.stage} className={`stage-col${s.hot ? " hot" : ""}`}>
              <span className="lab">{s.stage}</span>
              <span className="c">{s.count}</span>
              {/* No median rather than a zero: a stage nothing has finished
                  moving through has no typical duration, and "0 d" would read
                  as instant, which is the opposite of unknown. */}
              <span className="age">
                {s.medianDays === null ? "no history yet" : `${s.medianDays} d median`}
              </span>
            </div>
          ))}
        </div>
      )}

      {stalled.length > 0 && (
        <>
          <h3 className="band-label">
            Sitting too long
            <span className="sp" />
            <span className="mut t-meta">
              {stalled.length} unit{stalled.length === 1 ? "" : "s"} waiting on you
            </span>
          </h3>
          <div className="wall">
            {stalled.map((u) => (
              <Link key={u.id} href={`/instruments/${u.id}`}
                className={`inst ${u.days >= 60 ? "bad" : "warn"}`}>
                <div className="top">
                  <div className="state"><i aria-hidden />{u.stage}</div>
                  <h4>{u.externalId}</h4>
                  <div className="make">{u.label}</div>
                </div>
                <div className="why">{u.reason}</div>
                <div className="foot">
                  <Pill tone={u.days >= 60 ? "bad" : "warn"}>Your move</Pill>
                  <span className="rt"><b className="mono">{u.days} d</b> in stage</span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      <h3 className="band-label">Listed for sale</h3>
      <Panel title="Live listings" count={listings.length}
        actions={<Link className="btn sm" href="/listings">See all listings</Link>}
        hint="Each listing is a public page with its own link - the same sign-off packet and service history a buyer would ask for, already attached. Nothing about your other units is reachable from it."
        empty="Nothing is listed right now.">
        {listings.length > 0 && listings.map((l) => (
          <div key={l.id} className="ledger">
            <span className="grow">
              <Link href={`/instruments/${l.id}`} className="plain" style={{ fontWeight: 600 }}>
                {l.externalId}
              </Link>
              <span className="sub">{l.label}{l.note ? ` · ${l.note}` : ""}</span>
            </span>
            {l.token && (
              <Link className="btn sm" href={`/listing/${l.token}`}>Buyer&apos;s view</Link>
            )}
          </div>
        ))}
      </Panel>

      {/* Counted, not modelled: units that reached Shipped this calendar year.
          Nothing here is a rate, a percentage or a projection. */}
      <h3 className="band-label">This year with {operatorName}</h3>
      <div className="pair">
        <div className="card">
          <div className="bignum">{inPipeline}</div>
          <div className="biglab">units in the pipeline for {orgName}</div>
        </div>
        <div className="card">
          <div className="bignum">{shippedThisYear}</div>
          <div className="biglab">
            unit{shippedThisYear === 1 ? "" : "s"} shipped this year
          </div>
        </div>
      </div>
    </>
  );
}
