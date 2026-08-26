// The waiting room, against a real table.
//
// Two guarantees live in SQL and nowhere else, and a mocked database would
// prove neither: that a new item PUSHES the whole burst out again (one UPDATE
// across every unsent row), and that two flushes racing cannot both send the
// same batch (claim-then-send, in that order). The second is the one that
// would show up as a duplicate email nobody could reproduce.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

/** Every email the mailer was handed, in order. */
const sent: { to: string[]; subject: string; html: string }[] = [];

vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/lib/email", () => ({
  sendEmail: async (to: string[], subject: string, html: string) => {
    sent.push({ to, subject, html });
  },
}));
vi.mock("@/lib/notifyShell", () => ({
  wrapNotification: async (body: string) => `<shell>${body}</shell>`,
}));
vi.mock("@/lib/appUrl", () => ({ appUrl: () => "https://app.test" }));
vi.mock("@/lib/brand", () => ({ getBrand: async () => ({ name: "Ridgeline" }) }));
vi.mock("@/lib/house", () => ({ houseEmails: async () => ["bill@sierra.test", "joe@sierra.test"] }));
vi.mock("@/lib/directory", () => ({ namedLogins: async () => [] }));

const { queueEmail, flushOutbox, pruneOutbox } = await import("@/lib/outboxData");

const at = (s: string) => new Date(`2026-08-26T${s}Z`);

const task = (item: string, over: Record<string, string> = {}) => {
  // Built the way lib/notify builds it, so the subject and the context can
  // never disagree the way a hand-written fixture's would.
  const context = over.context ?? "LZ-001";
  return {
    email: "bill@sierra.test", kind: "task_assigned",
    title: `Joe assigned you "${item}" on ${context}`,
    href: "/instruments/1", subject: `${context}: assigned "${item}"`,
    body: `<p>${item}</p>`, actor: "Joe", item, ...over, context,
  };
};

const rows = async () => (await client.query<{
  id: number; item: string; send_after: Date; send_by: Date; sent_at: Date | null;
}>(`SELECT id, item, send_after, send_by, sent_at FROM email_outbox ORDER BY id`)).rows;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
});

beforeEach(async () => {
  sent.length = 0;
  await client.exec(`DELETE FROM email_outbox`);
});

describe("holding a burst", () => {
  it("sends nothing at the moment a task is assigned", async () => {
    await queueEmail([task("Install new collision cell")], at("09:00:00"));
    expect(await flushOutbox(at("09:00:10"))).toBe(0);
    expect(sent).toEqual([]);
  });

  it("EVERY NEW TASK PUSHES THE WHOLE BURST OUT AGAIN", async () => {
    // The mechanism. The wait measures the silence since the LAST assignment,
    // not the age of the first, which is what makes five tasks one email
    // however long somebody takes to type them.
    await queueEmail([task("Collision cell")], at("09:00:00"));
    await queueEmail([task("Autosampler")], at("09:00:20"));
    await queueEmail([task("Chiller")], at("09:00:45"));
    const all = await rows();
    expect(all).toHaveLength(3);
    // All three now due at 09:01:15 - thirty seconds after the last one.
    for (const r of all) expect(new Date(r.send_after).toISOString()).toBe(at("09:01:15").toISOString());
  });

  it("still holds while the person is typing, and goes when they stop", async () => {
    await queueEmail([task("Collision cell")], at("09:00:00"));
    await queueEmail([task("Autosampler")], at("09:00:20"));
    expect(await flushOutbox(at("09:00:40"))).toBe(0);   // pushed to 09:00:50
    expect(await flushOutbox(at("09:00:50"))).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("does not let the deadline slide with it", async () => {
    // send_by is fixed when the row is written, so a burst that never goes
    // quiet still lands. Only send_after moves.
    await queueEmail([task("A")], at("09:00:00"));
    await queueEmail([task("B")], at("09:04:00"));
    const [first] = await rows();
    expect(new Date(first.send_by).toISOString()).toBe(at("09:05:00").toISOString());
    expect(await flushOutbox(at("09:05:00"))).toBe(1);
  });
});

describe("what comes out", () => {
  it("turns five assignments into one email that lists them", async () => {
    const items = [
      "Install new collision cell", "Install/set up autosampler",
      "Connect exhaust/ventilation", "Set up chiller", "Set up/connect roughing pump",
    ];
    for (const i of items) await queueEmail([task(i)], at("09:00:00"));
    expect(await flushOutbox(at("09:01:00"))).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["bill@sierra.test"]);
    expect(sent[0].subject).toBe("LZ-001: 5 tasks assigned");
    for (const i of items) expect(sent[0].html).toContain(i);
  });

  it("leaves a lone assignment as the email it always was", async () => {
    await queueEmail([task("Install new collision cell")], at("09:00:00"));
    await flushOutbox(at("09:01:00"));
    expect(sent[0].subject).toBe('LZ-001: assigned "Install new collision cell"');
  });

  it("splits two systems into two coherent emails, not one vague one", async () => {
    await queueEmail([task("Collision cell")], at("09:00:00"));
    await queueEmail([task("Rebuild the pump", { context: "LZ-002", href: "/instruments/2" })], at("09:00:05"));
    expect(await flushOutbox(at("09:01:00"))).toBe(2);
    expect(sent.map((s) => s.subject).sort())
      .toEqual(['LZ-001: assigned "Collision cell"', 'LZ-002: assigned "Rebuild the pump"']);
  });

  it("sends both people their own", async () => {
    await queueEmail([task("A"), task("B", { email: "sam@sierra.test" })], at("09:00:00"));
    await flushOutbox(at("09:01:00"));
    expect(sent.flatMap((s) => s.to).sort()).toEqual(["bill@sierra.test", "sam@sierra.test"]);
  });
});

describe("sending it once", () => {
  it("claims before it sends, so a second flush finds nothing", async () => {
    await queueEmail([task("A")], at("09:00:00"));
    expect(await flushOutbox(at("09:01:00"))).toBe(1);
    expect(await flushOutbox(at("09:01:01"))).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("stamps the row rather than deleting it, so lateness has an answer", async () => {
    await queueEmail([task("A")], at("09:00:00"));
    await flushOutbox(at("09:01:00"));
    const [r] = await rows();
    expect(r.sent_at).not.toBeNull();
  });

  it("does not re-send a sent row when a later burst pushes its siblings", async () => {
    await queueEmail([task("A")], at("09:00:00"));
    await flushOutbox(at("09:01:00"));
    await queueEmail([task("B")], at("09:02:00"));
    expect(await flushOutbox(at("09:03:00"))).toBe(1);
    expect(sent.map((s) => s.subject)).toEqual([
      'LZ-001: assigned "A"', 'LZ-001: assigned "B"',
    ]);
  });
});

describe("tidying up", () => {
  it("keeps recent sends and sweeps old ones", async () => {
    await queueEmail([task("A")], at("09:00:00"));
    await flushOutbox(at("09:01:00"));
    await pruneOutbox(at("09:01:00"));
    expect(await rows()).toHaveLength(1);
    // Two weeks on, nobody is asking why it was late.
    await pruneOutbox(new Date(at("09:01:00").getTime() + 15 * 86400000));
    expect(await rows()).toHaveLength(0);
  });

  it("never sweeps something still waiting to go", async () => {
    await queueEmail([task("A")], at("09:00:00"));
    await pruneOutbox(new Date(at("09:00:00").getTime() + 400 * 86400000));
    expect(await rows()).toHaveLength(1);
  });
});

describe("the door notifications leave through", () => {
  // The branch in lib/notify that decides between the mailer and the waiting
  // room. Small enough to look obviously right and important enough that
  // "obviously right" is not the standard: get it backwards and every
  // assignment email stops arriving, silently.
  const assign = async (taskTitle: string) => {
    const { notifyTaskAssigned } = await import("@/lib/notify");
    await notifyTaskAssigned({
      actorEmail: "joe@sierra.test", actorName: "Joe", assignee: "bill",
      taskTitle, instrumentId: 1, externalId: "LZ-001",
    });
  };

  beforeEach(async () => {
    await client.exec(`DELETE FROM notifications; DELETE FROM notification_prefs;`);
  });

  it("holds the email and writes the inbox row at once", async () => {
    await assign("Install new collision cell");
    // Nothing sent...
    expect(sent).toEqual([]);
    // ...but the record exists this instant, and the bell will show it.
    const inbox = await client.query<{ title: string }>(`SELECT title FROM notifications`);
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0].title).toContain("Install new collision cell");
    expect(await rows()).toHaveLength(1);
  });

  it("turns a burst into one email once it goes quiet", async () => {
    for (const t of ["Collision cell", "Autosampler", "Chiller"]) await assign(t);
    expect(sent).toEqual([]);
    expect((await client.query(`SELECT 1 FROM notifications`)).rows).toHaveLength(3);
    await flushOutbox(new Date(Date.now() + 60_000));
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("LZ-001: 3 tasks assigned");
  });

  it("queues nothing for somebody who turned the email off", async () => {
    // The preference still gates the email; holding it would just be a slower
    // way of ignoring what they asked for. The inbox row is written either way.
    await client.exec(
      `INSERT INTO notification_prefs (email, kind, email_on) VALUES ('bill@sierra.test','task_assigned',false)`);
    await assign("Collision cell");
    expect(await rows()).toEqual([]);
    expect((await client.query(`SELECT 1 FROM notifications`)).rows).toHaveLength(1);
  });
});
