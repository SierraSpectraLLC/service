import Link from "next/link";
import {
  CLIENT_STATE, bySeverity, density, needsAttention, standingPill,
  type ClientState, type ClientTodo, type Density,
} from "@/lib/clientView";
import { COVERAGE, coverageBadge, coverageLine, type Coverage } from "@/lib/coverage";
import { EmptyState, FacetStrip, Pill, Toolbar } from "@/components/ui";

/**
 * One system, as the organization that owns it reads it.
 *
 * `why` is a sentence rather than a field list because the three things a
 * client wants are only useful together: what is wrong, what is being done,
 * and when. "Autotune fails above m/z 900. A rebuild is quoted and waiting on
 * your approval." is the whole answer; "Waiting / blocked · 6d · parts" is a
 * thing they have to decode.
 */
export type ClientSystem = {
  id: number;
  externalId: string;
  /** What it is built from - the model, not the stored description. */
  label: string;
  /** Room or bench on their own floor. Blank for accounts that never set one. */
  location: string;
  state: ClientState;
  why: string;
  /** True when the queue sits with THEM. */
  yourMove: boolean;
  lastVisit: string;
  /**
   * Who services this one, and until when.
   *
   * A separate axis from `state` and deliberately so: "In service" says the
   * machine is fine, and says nothing at all about whether anybody is under
   * contract to keep it that way. The page used to conflate them by counting
   * shared systems as serviced ones.
   */
  coverage: Coverage;
};

/**
 * The client's landing: what is waiting on them, what needs attention, and
 * everything else behind one line.
 *
 * A server component on purpose. The search and the location filter ride the
 * URL like every other list in this app, and the healthy strip is a real
 * <details> - so the whole page works with no JavaScript and the filter
 * survives a link somebody pastes to a colleague.
 */
export default function ClientLanding({
  systems, todos, operatorName, orgName, today, q, where, coverage, thisYear, override,
}: {
  systems: ClientSystem[];
  todos: ClientTodo[];
  operatorName: string;
  orgName: string;
  /** The shop's today, for reading a coverage end date as past or future. */
  today: string;
  /** Search text, from the URL. */
  q: string;
  /** The chosen location, from the URL; blank means all of them. */
  where: string;
  /** The agreement card, already rendered by the page that could read it. */
  coverage?: React.ReactNode;
  /** Only figures that are real. See the note on the band below. */
  thisYear?: { value: string; label: string }[];
  override?: Density | null;
}) {
  const locations = [...new Set(systems.map((s) => s.location.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const shape = density({ systems: systems.length, sites: locations.length, override });

  const needle = q.trim().toLowerCase();
  const hit = (s: ClientSystem) =>
    (!needle || `${s.externalId} ${s.label} ${s.location}`.toLowerCase().includes(needle))
    && (!where || s.location.trim() === where);

  const shown = systems.filter(hit);
  const attention = shown.filter((s) => needsAttention(s.state))
    .sort((a, b) => bySeverity(a.state, b.state) || a.externalId.localeCompare(b.externalId));
  const healthy = shown.filter((s) => !needsAttention(s.state));

  const href = (next: { q?: string; where?: string }) => {
    const p = new URLSearchParams();
    const nq = next.q ?? q;
    const nw = next.where ?? where;
    if (nq) p.set("q", nq);
    if (nw) p.set("where", nw);
    return p.size ? `/?${p}` : "/";
  };

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

      {/* At more than a screenful, or across more than one room, searching is
          the only way in. Below that it is furniture. */}
      {shape === "grouped" && (
        <Toolbar
          search={
            <form action="/">
              {where && <input type="hidden" name="where" value={where} />}
              <input name="q" defaultValue={q} placeholder="Find an instrument, model or room"
                aria-label="Search your instruments" />
            </form>
          }
          facets={
            <FacetStrip facets={[
              { key: "", label: "Everywhere", count: systems.length, on: where === "", href: href({ where: "" }) },
              ...locations.map((l) => ({
                key: l, label: l, on: where === l, href: href({ where: l }),
                count: systems.filter((s) => s.location.trim() === l).length,
              })),
            ]} />
          }
        />
      )}

      <h3 className="band-label">
        {attention.length > 0 ? "Needs attention" : "Your instruments"}
        <span className="sp" />
        <span className="mut t-meta">
          {attention.length} of {shown.length}
          {shape === "grouped" && locations.length > 1 && !where ? " · by room" : ""}
        </span>
      </h3>

      {shown.length === 0 ? (
        <EmptyState title="Nothing matches that."
          body="Try a different search, or clear the filter to see everything." />
      ) : shape === "cards" ? (
        /* Small account: everything is a card, because at this size the
           exceptions and the inventory are the same list and the healthy ones
           are still worth seeing. */
        <div className="wall">
          {[...attention, ...healthy].map((s) => (
            <SystemCard key={s.id} s={s} operatorName={operatorName} today={today} />
          ))}
        </div>
      ) : (
        <>
          {attention.length === 0 ? (
            <EmptyState title="Nothing needs your attention."
              body={`Every instrument ${orgName} has under service is running normally.`} />
          ) : locations.length > 1 && !where ? (
            locations
              .map((l) => ({ l, list: attention.filter((s) => s.location.trim() === l) }))
              .filter((g) => g.list.length > 0)
              .map((g) => (
                <div key={g.l} className="site">
                  <h4>
                    {g.l}
                    <span className="c">
                      {g.list.length} of {systems.filter((s) => s.location.trim() === g.l).length} need something
                    </span>
                  </h4>
                  <div className="wall">
                    {g.list.map((s) => <SystemCard key={s.id} s={s} operatorName={operatorName} today={today} />)}
                  </div>
                </div>
              ))
          ) : (
            <div className="wall">
              {attention.map((s) => <SystemCard key={s.id} s={s} operatorName={operatorName} today={today} />)}
            </div>
          )}

          {/* The inventory that needs nothing. One line, opened only by
              somebody who actually wants the list. */}
          {healthy.length > 0 && (
            <details className="healthy">
              <summary>
                <span className="dot" aria-hidden />
                <b className="mono">{healthy.length}</b>
                {healthy.length === 1 ? " instrument is" : " instruments are"} running normally
                <span className="rt">Show all</span>
              </summary>
              <div className="list">
                {healthy.map((s) => (
                  <div key={s.id} className="ledger">
                    <span className="grow">
                      <Link href={`/instruments/${s.id}`} className="plain" style={{ fontWeight: 600 }}>
                        {s.externalId}
                      </Link>
                      <span className="sub">{s.label}{s.location ? ` · ${s.location}` : ""}</span>
                    </span>
                    {/* Only where it is not ours: the band label above already
                        says how many are, and a badge on every row would be
                        noise on the list nobody opens. */}
                    {s.coverage.state !== "ours" && (
                      <Pill tone={COVERAGE[s.coverage.state].tone}>{coverageBadge(s.coverage)}</Pill>
                    )}
                    <span className="mut t-meta">{s.lastVisit ? `last visit ${s.lastVisit}` : ""}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}

      {coverage}

      {/* Figures that are actually recorded, and no others. Uptime and a
          median response time are the two an account manager asks for first,
          and neither is computable: there is no service-state history and no
          first-response capture in this app. A number a client cannot check
          and we cannot derive is worse than no number, so the band carries
          visit counts and nothing that would have to be invented. */}
      {thisYear && thisYear.length > 0 && (
        <>
          <h3 className="band-label">This year with {operatorName}</h3>
          <div className="pair">
            {thisYear.map((m) => (
              <div key={m.label} className="card">
                <div className="bignum">{m.value}</div>
                <div className="biglab">{m.label}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function SystemCard({ s, operatorName, today }: {
  s: ClientSystem; operatorName: string; today: string;
}) {
  const tone = CLIENT_STATE[s.state].tone;
  const pill = standingPill(s.state, s.yourMove, operatorName);
  return (
    <Link href={`/instruments/${s.id}`} className={`inst ${tone}`}>
      <div className="top">
        <div className="state"><i aria-hidden />{CLIENT_STATE[s.state].label}</div>
        <h4>{s.externalId}</h4>
        <div className="make">{s.label}{s.location ? ` · ${s.location}` : ""}</div>
      </div>
      <div className="why">{s.why}</div>
      {/* Always rendered, always specific. An absent line would be read as
          "covered" by anybody used to seeing one, which is the assumption this
          whole thing exists to stop. */}
      <div className={`why cov${s.coverage.state === "lapsed" ? " warn" : ""}`}>
        {coverageLine(s.coverage, today)}
      </div>
      <div className="foot">
        {/* Three answers, not two. "With them and fine" is the ordinary state
            of a system that just came back from service, and the condition
            this replaced could not say it - see standingPill. */}
        <Pill tone={pill.tone}>{pill.label}</Pill>
        <span className="rt">{s.lastVisit ? `last visit ${s.lastVisit}` : ""}</span>
      </div>
    </Link>
  );
}
