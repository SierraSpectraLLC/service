"use client";

import { useMemo, useState } from "react";
import { matchesQuery } from "@/lib/search";
import { STATUS_LABEL, sinceWords, type Status } from "@/lib/loginLog";

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

const STATUS_COLOR: Record<Status, { bg: string; fg: string }> = {
  active: { bg: "#E5F3E5", fg: "#2E6B2E" },
  quiet: { bg: "#FAF0DC", fg: "#8A5410" },
  dormant: { bg: "#FBE9E9", fg: "#A32D2D" },
  never: { bg: "#EEF1F5", fg: "#475569" },
};

const FILTERS: { key: "all" | Status; label: string }[] = [
  { key: "all", label: "Everyone" },
  { key: "active", label: "Active" },
  { key: "quiet", label: "Quiet" },
  { key: "dormant", label: "Dormant" },
  { key: "never", label: "Never signed in" },
];

/**
 * Who is using the platform. Two panels, because they answer different
 * questions: the roster is "is this account alive", the feed underneath is
 * "who came in this morning, and from what".
 */
export default function UsagePanel({ rows, recent, windowDays }: {
  rows: Row[]; recent: Recent[]; windowDays: number;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | Status>("all");
  const [feed, setFeed] = useState(false);
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

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <div className="card-title">Who&apos;s using the portal</div>
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setFeed((v) => !v)}>
            {feed ? "Hide sign-in log" : "Sign-in log"}
          </button>
        </div>
        <p className="mut" style={{ fontSize: 12, marginTop: 0 }}>
          A session lasts 30 days, so somebody who works here every morning signs in about once a
          month. <b>Last seen</b> is the column that means usage; <b>sign-ins</b> counts doors opened.
          Reading the last {windowDays} days.
        </p>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {FILTERS.map((f) => (
            <button key={f.key} className={filter === f.key ? "btn sm primary" : "btn sm"}
              aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label} {counts[f.key] ?? 0}
            </button>
          ))}
        </div>

        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, email, company, role..." style={{ marginBottom: 10 }} />

        <div className="grid-row eyebrow" style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 8, padding: "8px 4px", borderBottom: "1px solid var(--line)" }}>
          <div>Person</div><div>Last seen</div><div>Sign-ins (30d)</div><div>Status</div>
        </div>
        {shown.map((r) => {
          const c = STATUS_COLOR[r.status];
          return (
            <div key={r.email} className="row-hover"
              style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 8, alignItems: "center", padding: "8px 4px", borderTop: "1px solid var(--line)" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{r.name || r.email.split("@")[0]}</div>
                <div className="mut" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.email}{r.orgName ? ` · ${r.orgName}` : ""}{r.role ? ` · ${r.role.replace("_", " ")}` : ""}
                </div>
              </div>
              <div style={{ fontSize: 12 }}>{sinceWords(date(r.lastSeenAt) ?? date(r.lastLoginAt), now)}</div>
              <div style={{ fontSize: 12 }}>
                {r.logins30 || <span className="mut">-</span>}
                {/* Which door, because a password sign-in is the one that used
                    to leave no trace at all. */}
                {r.methods.length > 0 && (
                  <span className="mut" style={{ fontSize: 11 }}> · {r.methods.join(", ")}</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                <span className="pill" style={{ background: c.bg, color: c.fg }}>{STATUS_LABEL[r.status]}</span>
                {r.hasPassword && (
                  <span className="pill" title="Signs in without waiting for mail"
                    style={{ background: "#E7F2FA", color: "#1D6396" }}>password</span>
                )}
              </div>
            </div>
          );
        })}
        {shown.length === 0 && <div className="mut" style={{ fontSize: 13, padding: "10px 4px" }}>Nobody matches.</div>}
      </div>

      {feed && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>Sign-in log</div>
          <p className="mut" style={{ fontSize: 12, marginTop: 0 }}>
            Every door opened, newest first. A run of these from one address in one minute is worth a
            look; one a month from somebody who is here daily is normal.
          </p>
          {recent.map((e) => (
            <div key={e.id} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", padding: "7px 4px", borderTop: "1px solid var(--line)" }}>
              <span style={{ fontSize: 13 }}>{e.email}</span>
              <span className="pill" style={{ background: e.method === "password" ? "#E7F2FA" : "#EEF1F5", color: e.method === "password" ? "#1D6396" : "#475569" }}>
                {e.method}
              </span>
              <span className="mut" style={{ fontSize: 11 }}>
                {[e.orgName, e.role.replace("_", " "), e.device, e.ip].filter(Boolean).join(" · ")}
              </span>
              <span className="mut" style={{ fontSize: 11, marginLeft: "auto" }}>{sinceWords(new Date(e.at), now)}</span>
            </div>
          ))}
          {recent.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No sign-ins recorded yet.</div>}
        </div>
      )}
    </>
  );
}
