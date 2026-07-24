"use client";

import { useRouter } from "next/navigation";

export default function EodDateNav({ date, today, dates }: { date: string; today: string; dates: string[] }) {
  const router = useRouter();
  const all = dates.includes(today) ? dates : [today, ...dates];
  const shift = (days: number) => {
    const d = new Date(date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const go = (d: string) => router.push(d === today ? "/eod" : `/eod?date=${d}`);
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
      <button className="btn sm" onClick={() => go(shift(-1))} title="Previous day">‹</button>
      <select
        value={all.includes(date) ? date : ""}
        onChange={(e) => { if (e.target.value) go(e.target.value); }}
        style={{ width: "auto", fontSize: 12 }}
      >
        {!all.includes(date) && <option value="">{date}</option>}
        {all.map((d) => <option key={d} value={d}>{d}{d === today ? " · today" : ""}</option>)}
      </select>
      <button className="btn sm" onClick={() => go(shift(1))} disabled={date >= today} title="Next day">›</button>
      {date !== today && <button className="btn sm" onClick={() => go(today)}>Back to today</button>}
    </div>
  );
}
