"use client";

import { useMemo } from "react";
import { matchesQuery } from "@/lib/search";
import { STATUS_LABEL, sinceWords, type Status } from "@/lib/loginLog";
import { DataTable, Dot, FacetStrip, Legend, PageHead, Pill, Toolbar } from "@/components/ui";
import type { Tone } from "@/lib/tones";

/** Dates cross the server boundary as strings and are revived here. */
type Row = {
  email: string; name: string; role: string; orgName: string;
  lastSeenAt: string | null; lastLoginAt: string | null;
  logins7: number; logins30: number; methods: string[];
  hasPassword: boolean; invitedNeverIn: boolean; status: Status;
};

type Recent = {
  id: number; email: string; method: string; orgName: string;
  role: string; device: string; ip: string; at: string;
};

const STATUS_TONE: Record<Status, Tone> = {
  active: "good",
  quiet: "warn",
  dormant: "bad",
  never: "neutral",
};

const FILTERS: { key: "all" | Status; label: string }[] = [
  { key: "all", label: "Everyone" },
  { key: "active", label: "Active" },
  { key: "quiet", label: "Quiet" },
  { key: "dormant", label: "Dormant" },
  { key: "never", label: "Never signed in" },
];

/**
 * Who is using the platform. Two tables, because they answer different
 * questions: the roster is "is this account alive", the feed underneath is
 * "who came in this morning, and from what". Filter state lives in the URL.
 */
export default function UsagePanel({ rows, recent, windowDays, filter: urlFilter }: {
  rows: Row[]; recent: Recent[]; windowDays: number;
  filter: { q: string; f: string; feed: string };
}) {
  const q = urlFilter.q.trim();
  const filter = (FILTERS.some((x) => x.key === urlFilter.f) ? urlFilter.f : "all") as "all" | Status;
  const feed = urlFilter.feed === "1";
  // One clock for the whole render, so two rows an hour apart don't disagree
  // about what "now" was.
  const now = useMemo(() => new Date(), []);
  const date = (s: string | null) => (s ? new Date(s) : null);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  const shown = rows
    .filter((r) => filter === "all" || r.status === filter)
    .filter((r) => matchesQuery(q, [r.email, r.name, r.orgName, r.role, STATUS_LABEL[r.status]]));

  const href = (next: { f?: string; feed?: string }) => {
    const merged = { f: filter === "all" ? "" : filter, feed: feed ? "1" : "", ...next };
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (merged.f) p.set("f", merged.f);
    if (merged.feed === "1") p.set("feed", "1");
    return `/settings/activity${p.size ? `?${p}` : ""}`;
  };

  return (
    <>
      <PageHead title="Who's using the portal"
        sub={`A session lasts 30 days, so somebody who works here every morning signs in about once a month. Last seen is the column that means usage; sign-ins counts doors opened. Reading the last ${windowDays} days.`}
        actions={
          <a className="btn sm" href={href({ feed: feed ? "" : "1" })}>
            {feed ? "Hide sign-in log" : "Sign-in log"}
          </a>
        } />
      <Toolbar
        search={
          <form action="/settings/activity">
            {filter !== "all" && <input type="hidden" name="f" value={filter} />}
            {feed && <input type="hidden" name="feed" value="1" />}
            <input name="q" defaultValue={q} placeholder="Name, email, company or role" aria-label="Search people" />
          </form>
        }
        facets={
          <FacetStrip facets={FILTERS.map((f) => ({
            key: f.key, label: f.label,
            count: counts[f.key] || undefined,
            on: filter === f.key && f.key !== "all" || (f.key === "all" && filter === "all"),
            href: href({ f: f.key === "all" ? "" : f.key }),
          }))} />
        }
      />
      <DataTable
        cols={[
          { key: "dot", label: "", width: "12px" },
          { key: "who", label: "Person", width: "minmax(180px, 2fr)" },
          { key: "seen", label: "Last seen", width: "minmax(90px, 1fr)" },
          { key: "logins", label: "Sign-ins (30d)", width: "minmax(110px, 1fr)", hideMobile: true },
          { key: "status", label: "Status", width: "120px" },
        ]}
        rows={shown.map((r) => ({
          key: r.email,
          cells: {
            dot: <Dot tone={STATUS_TONE[r.status]} />,
            who: (
              <span style={{ minWidth: 0, display: "block" }}>
                <span className="t-body" style={{ display: "block", fontWeight: 700 }}>{r.name || r.email.split("@")[0]}</span>
                <span className="mut t-meta" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.email}{r.orgName ? ` · ${r.orgName}` : ""}{r.role ? ` · ${r.role.replace("_", " ")}` : ""}
                  {/* Which door, because a password sign-in used to leave no trace. */}
                  {r.hasPassword ? " · has a password" : ""}
                </span>
              </span>
            ),
            seen: <span className="t-small">{sinceWords(date(r.lastSeenAt) ?? date(r.lastLoginAt), now)}</span>,
            logins: (
              <span className="t-small">
                {r.logins30 || <span className="mut">-</span>}
                {r.methods.length > 0 && <span className="mut t-meta"> · {r.methods.join(", ")}</span>}
              </span>
            ),
            status: <Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill>,
          },
        }))}
        empty="Nobody matches"
      />
      <Legend items={[
        { tone: "good", label: "active" },
        { tone: "warn", label: "quiet" },
        { tone: "bad", label: "dormant" },
        { tone: "neutral", label: "never signed in" },
      ]} />

      {feed && (
        <>
          <div className="sec-head" style={{ marginTop: 8 }}><span>Sign-in log</span></div>
          <p className="mut t-small" style={{ marginTop: 0 }}>
            Every door opened, newest first. A run of these from one address in one minute is worth a
            look; one a month from somebody who is here daily is normal.
          </p>
          <DataTable
            cols={[
              { key: "who", label: "Person", width: "minmax(160px, 1.4fr)" },
              { key: "method", label: "Door", width: "100px" },
              { key: "meta", label: "From", width: "minmax(160px, 1.6fr)", hideMobile: true },
              { key: "when", label: "When", width: "110px", align: "right" },
            ]}
            rows={recent.map((e) => ({
              key: e.id,
              cells: {
                who: <span className="t-body">{e.email}</span>,
                method: <Pill tone={e.method === "password" ? "info" : "neutral"}>{e.method}</Pill>,
                meta: (
                  <span className="mut t-meta">
                    {[e.orgName, e.role.replace("_", " "), e.device, e.ip].filter(Boolean).join(" · ")}
                  </span>
                ),
                when: <span className="mut t-meta">{sinceWords(new Date(e.at), now)}</span>,
              },
            }))}
            empty="No sign-ins recorded yet"
          />
        </>
      )}
    </>
  );
}
