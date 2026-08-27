// What a document is called, and who decides.
//
// Two shapes of numbering exist in this trade and they are not variations of
// each other. One counts per document type - PO-1042, INV-1043 - and each
// counter runs on independently. The other allocates a number to the JOB and
// hangs every document for that job off it: quote Q030120_A, its invoices
// 030120_INV1 and 030120_INV2, its purchase orders 030120_PO1. In the second,
// the number is the thread that ties a folder of paper together, and a shop
// that works that way can read a filing cabinet by it.
//
// One template language covers both, and the difference is a single token.
// A template with {job} in it is job-scoped: its sequence counts WITHIN that
// job, so every job starts again at 1. A template without it is workspace
// scoped: one running counter for that document type. Nothing else changes,
// and no caller has to know which shape a workspace uses.
//
// Pure. Numbers are the one thing in a billing system that a client quotes
// back at you a year later, so the rule that makes them has to be arguable
// against a filing cabinet without a database in the room.

export const DOC_KINDS = ["work_order", "quote", "invoice", "purchase_order"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const DOC_LABEL: Record<DocKind, string> = {
  work_order: "Work orders",
  quote: "Quotes",
  invoice: "Invoices",
  purchase_order: "Purchase orders",
};

/**
 * The tokens a template may use.
 *
 *   {job}   the job number, shared by every document on one engagement.
 *           Its presence is what makes a template job-scoped.
 *   {seq}   the running number. Within the job when {job} is present,
 *           across the workspace when it is not.
 *   {alpha} the running number as a letter - A, B, ... Z, AA. For a shop
 *           whose quotes are Q030120_A and Q030120_B rather than _1 and _2.
 *
 * Padding rides on the token: {job:6} is zero-padded to six digits, which is
 * how 30120 is written 030120. Everything outside a token is a literal.
 *
 * A template that is ONLY {job} is legal and means one document of that kind
 * per job - which is exactly what a work order is in a job-numbered shop: the
 * job IS the work order, and a second one means a second job. The job counter
 * is the uniqueness there, so the caller allocates a new job rather than
 * reusing one. Every other kind needs {seq} or {alpha}, or every document of
 * that kind would be called the same thing.
 */
export type Scheme = {
  templates: Record<DocKind, string>;
  /** Where a brand new workspace's job counter starts. */
  jobStart: number;
};

/** What the app ships with: one counter per type, no job thread. */
export const DEFAULT_SCHEME: Scheme = {
  templates: {
    work_order: "WO-{seq}",
    quote: "Q-{seq}",
    invoice: "INV-{seq}",
    purchase_order: "PO-{seq}",
  },
  jobStart: 1001,
};

const TOKEN = /\{(job|seq|alpha)(?::(\d+))?\}/g;

/** Does this template hang off a job number? */
export const jobScoped = (template: string): boolean => /\{job(?::\d+)?\}/.test(template);

/** A-Z, AA-AZ, ... 1 is A. Zero and below have no letter. */
export function alphaOf(n: number): string {
  if (!Number.isFinite(n) || n < 1) return "";
  let out = "", i = Math.floor(n);
  while (i > 0) {
    const r = (i - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    i = Math.floor((i - 1) / 26);
  }
  return out;
}

/** The inverse. "" and anything not A-Z read as 0. */
export function alphaValue(s: string): number {
  const t = s.trim().toUpperCase();
  if (!t || !/^[A-Z]+$/.test(t)) return 0;
  let n = 0;
  for (const ch of t) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

const pad = (n: number, width: number) => String(n).padStart(Math.max(0, width), "0");

/** Fill a template in. Unknown tokens are left alone rather than blanked. */
export function render(template: string, v: { job?: number; seq?: number }): string {
  return template.replace(TOKEN, (whole, token: string, width?: string) => {
    const w = width ? parseInt(width, 10) : 0;
    if (token === "job") return v.job === undefined ? whole : pad(v.job, w);
    if (token === "seq") return v.seq === undefined ? whole : pad(v.seq, w);
    if (token === "alpha") return v.seq === undefined ? whole : alphaOf(v.seq);
    return whole;
  });
}

const escapeLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A regex that reads a rendered number back apart.
 *
 * Built from the template rather than guessed, so a shop whose invoices are
 * 030120_INV1 does not have its numbers parsed by a rule written for INV-1043.
 * The old code took "the trailing digits" off any number it found, which on
 * 030120_INV1 is the 1 - so the next invoice for a different job came out
 * 030120_INV2 and the counter was shared by every job in the workspace.
 */
export function matcher(template: string): RegExp {
  let out = "";
  let last = 0;
  for (const m of template.matchAll(TOKEN)) {
    out += escapeLiteral(template.slice(last, m.index));
    const token = m[1];
    out += token === "job" ? "(?<job>\\d+)"
      : token === "seq" ? "(?<seq>\\d+)"
        : "(?<alpha>[A-Za-z]+)";
    last = m.index + m[0].length;
  }
  out += escapeLiteral(template.slice(last));
  return new RegExp(`^${out}$`);
}

export type Parsed = { job: number | null; seq: number | null };

/** Read a number apart with its own template. Null when it does not match. */
export function parse(template: string, number: string): Parsed | null {
  const m = matcher(template).exec(number.trim());
  if (!m) return null;
  const g = m.groups ?? {};
  const seq = g.seq !== undefined ? parseInt(g.seq, 10)
    : g.alpha !== undefined ? alphaValue(g.alpha)
      : null;
  return { job: g.job !== undefined ? parseInt(g.job, 10) : null, seq };
}

/**
 * The next number for one document kind.
 *
 * `existing` is every number already used for that kind in the workspace. The
 * sequence is the highest one that PARSES, plus one - numbers that do not
 * match the template are ignored rather than guessed at, so a workspace that
 * changes its scheme does not have its new numbering skewed by its old, and a
 * hand-typed number from a migration cannot drag the counter somewhere odd.
 *
 * On a job-scoped template only the numbers belonging to THIS job count, which
 * is what makes each job start again at 1.
 */
export function nextNumber(
  template: string,
  existing: string[],
  opts: { job?: number | null } = {},
): string {
  const scoped = jobScoped(template);
  const job = opts.job ?? null;
  // A job-scoped template with no job to hang on cannot be rendered. The
  // caller allocates one first; returning a half-rendered string with a live
  // {job} in it would put a literal brace on an invoice.
  if (scoped && job === null) return "";
  let top = 0;
  for (const n of existing) {
    const p = parse(template, n);
    if (!p || p.seq === null) continue;
    if (scoped && p.job !== job) continue;
    top = Math.max(top, p.seq);
  }
  return render(template, { job: job ?? undefined, seq: top + 1 });
}

/**
 * The next job number in the workspace.
 *
 * Read off the documents themselves rather than from a stored counter. A
 * counter is one more thing to be wrong after a restore, a manual insert or a
 * hand-typed number, and the documents are the record - if 030212 exists then
 * 030212 is taken, whatever any counter believes.
 */
export function nextJob(
  scheme: Scheme,
  existing: Partial<Record<DocKind, string[]>>,
): number {
  let top = 0;
  for (const kind of DOC_KINDS) {
    const template = scheme.templates[kind];
    if (!jobScoped(template)) continue;
    for (const n of existing[kind] ?? []) {
      const p = parse(template, n);
      if (p?.job != null) top = Math.max(top, p.job);
    }
  }
  return top > 0 ? top + 1 : Math.max(1, Math.round(scheme.jobStart));
}

/**
 * The job a document belongs to, read off its own number.
 *
 * How an invoice raised against a job inherits the job's thread without
 * anything storing it twice: the work order is 030212, so its invoices are
 * 030212_INV1 and 030212_INV2. Null when the scheme is not job-scoped or the
 * number was typed by hand into some other shape.
 */
export function jobOf(scheme: Scheme, kind: DocKind, number: string): number | null {
  const template = scheme.templates[kind];
  if (!jobScoped(template)) return null;
  return parse(template, number)?.job ?? null;
}

/**
 * The next revision of a document: 030120_A becomes 030120_Ar1, then r2.
 *
 * A revision is not a new document - it is the same offer, argued again - so
 * it keeps its number and wears a suffix. Anything already carrying one is
 * bumped rather than stacked, so r1 never becomes r1r1.
 */
export function nextRevision(number: string, existing: string[] = []): string {
  const base = number.trim().replace(/r\d+$/i, "");
  let top = 0;
  for (const n of [number, ...existing]) {
    const t = n.trim();
    if (!t.toLowerCase().startsWith(base.toLowerCase())) continue;
    const m = /r(\d+)$/i.exec(t);
    if (m) top = Math.max(top, parseInt(m[1], 10));
  }
  return `${base}r${top + 1}`;
}

/** Everything wrong with a template, said plainly. Empty means it is usable. */
export function templateProblems(template: string): string[] {
  const out: string[] = [];
  const t = template.trim();
  if (!t) return ["Give it a shape, like PO-{seq}"];
  if (t.length > 40) out.push("Keep it under 40 characters");
  const tokens = [...t.matchAll(TOKEN)].map((m) => m[1]);
  if (!tokens.includes("seq") && !tokens.includes("alpha") && !tokens.includes("job")) {
    // Without a counter every document of that kind is called the same thing.
    out.push("Needs {seq} or {alpha} so each one is different");
  }
  if (tokens.includes("seq") && tokens.includes("alpha")) {
    out.push("Use {seq} or {alpha}, not both - they are the same counter");
  }
  if (tokens.filter((x) => x === "job").length > 1) out.push("Only one {job}");
  const stray = t.replace(TOKEN, "");
  if (/[{}]/.test(stray)) out.push("Unknown token - only {job}, {seq} and {alpha}");
  if (/\s/.test(stray)) out.push("No spaces - a number gets pasted into emails and file names");
  return out;
}

/** A worked example of a scheme, for the editor's preview. */
export function preview(scheme: Scheme, kind: DocKind): string[] {
  const template = scheme.templates[kind];
  if (templateProblems(template).length) return [];
  const job = Math.max(1, Math.round(scheme.jobStart));
  return jobScoped(template)
    ? [render(template, { job, seq: 1 }), render(template, { job, seq: 2 }), render(template, { job: job + 1, seq: 1 })]
    : [render(template, { seq: 1001 }), render(template, { seq: 1002 }), render(template, { seq: 1003 })];
}

/** Parse a stored scheme. Blank, broken or partial falls back field by field. */
export function parseScheme(stored: string): Scheme {
  if (!stored.trim()) return DEFAULT_SCHEME;
  try {
    const raw = JSON.parse(stored) as Partial<Scheme>;
    const templates = { ...DEFAULT_SCHEME.templates };
    for (const kind of DOC_KINDS) {
      const t = (raw.templates as Record<string, string> | undefined)?.[kind];
      // A template that would not work is not applied. A workspace whose
      // stored scheme went bad keeps numbering documents rather than failing
      // to name one - and the editor shows them the problem.
      if (typeof t === "string" && templateProblems(t).length === 0) templates[kind] = t.trim();
    }
    const start = Number(raw.jobStart);
    return {
      templates,
      jobStart: Number.isFinite(start) && start > 0 ? Math.round(start) : DEFAULT_SCHEME.jobStart,
    };
  } catch {
    return DEFAULT_SCHEME;
  }
}

/** For the column. Blank when it is the stock shape, so a default can move later. */
export function serializeScheme(scheme: Scheme): string {
  const same = DOC_KINDS.every((k) => scheme.templates[k] === DEFAULT_SCHEME.templates[k])
    && scheme.jobStart === DEFAULT_SCHEME.jobStart;
  return same ? "" : JSON.stringify({ templates: scheme.templates, jobStart: scheme.jobStart });
}
