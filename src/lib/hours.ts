// Labour is stored in whole minutes; the UI speaks hours ("1.5", "0:45", "45m").
export function parseHours(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const hm = /^(\d+):([0-5]?\d)$/.exec(s);            // 1:30
  if (hm) return parseInt(hm[1]) * 60 + parseInt(hm[2]);
  const mins = /^(\d+(?:\.\d+)?)\s*m(?:in)?$/.exec(s); // 45m
  if (mins) return Math.round(parseFloat(mins[1]));
  const hrs = /^(\d+(?:\.\d+)?)\s*h?$/.exec(s);        // 1.5 or 1.5h
  if (hrs) return Math.round(parseFloat(hrs[1]) * 60);
  return null;
}

export function formatHours(minutes: number): string {
  if (!minutes) return "0 h";
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}
