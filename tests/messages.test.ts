import { describe, expect, it } from "vitest";
import {
  cleanBody, groupMessages, messageableFrom, threadTitle, unreadCount,
} from "@/lib/messages";

const m = (email: string, name = "", orgName = "") => ({ email, name, orgName });
const ME = "joe@sierraspectra.com";

describe("what a thread is called", () => {
  it("names itself after who is in it, never after you", () => {
    // A list of conversations is read by scanning for a person, so "Jane"
    // beats "You and Jane".
    expect(threadTitle("", [m(ME, "Joe"), m("jane@clienta.com", "Jane")], ME)).toBe("Jane");
    expect(threadTitle("", [m(ME, "Joe"), m("jane@clienta.com", "Jane"), m("rita@clienta.com", "Rita")], ME))
      .toBe("Jane, Rita");
  });

  it("keeps a name somebody gave it", () => {
    expect(threadTitle("Tuesday cover", [m(ME), m("jane@clienta.com", "Jane")], ME)).toBe("Tuesday cover");
  });

  it("counts the rest rather than wrapping onto a second line", () => {
    const many = [m(ME, "Joe"), m("a@x.com", "Ann"), m("b@x.com", "Ben"), m("c@x.com", "Cat"), m("d@x.com", "Dan")];
    expect(threadTitle("", many, ME)).toBe("Ann, Ben, Cat +1");
  });

  it("falls back to the email's local part, and to something for an empty room", () => {
    expect(threadTitle("", [m(ME), m("rita@clienta.com")], ME)).toBe("rita");
    expect(threadTitle("", [m(ME, "Joe")], ME)).toBe("Just you");
  });

  it("stops naming somebody who left", () => {
    expect(threadTitle("", [
      m(ME, "Joe"), m("jane@clienta.com", "Jane"),
      { ...m("gone@clienta.com", "Gone"), leftAt: "2026-08-01T00:00:00.000Z" },
    ], ME)).toBe("Jane");
  });
});

describe("what is unread", () => {
  const msgs = [
    { authorEmail: "jane@clienta.com", createdAt: "2026-08-16T10:00:00.000Z" },
    { authorEmail: ME, createdAt: "2026-08-16T11:00:00.000Z" },
    { authorEmail: "jane@clienta.com", createdAt: "2026-08-16T12:00:00.000Z" },
  ];

  it("counts what arrived after you last looked", () => {
    expect(unreadCount(msgs, "2026-08-16T10:30:00.000Z", ME)).toBe(1);
    expect(unreadCount(msgs, null, ME)).toBe(2);
    expect(unreadCount(msgs, "2026-08-16T23:00:00.000Z", ME)).toBe(0);
  });

  it("never counts your own words as something you haven't read", () => {
    expect(unreadCount([{ authorEmail: ME, createdAt: "2026-08-16T12:00:00.000Z" }], null, ME)).toBe(0);
  });
});

describe("who you may write to", () => {
  it("skips a domain-wildcard entry - there is nobody at the other end of it", () => {
    // "@clienta.com" is a rule about who may sign in, not a person; mail to it
    // would bounce and a thread would list a domain as a member.
    expect(messageableFrom([m("@clienta.com", "@clienta.com"), m("jane@clienta.com", "Jane")], ME)
      .map((x) => x.email)).toEqual(["jane@clienta.com"]);
  });

  it("is the directory, minus yourself and minus duplicates", () => {
    expect(messageableFrom(
      [m(ME, "Joe"), m("jane@clienta.com", "Jane"), m("JANE@clienta.com", "Jane again"), m("", "Nameless")],
      ME,
    ).map((x) => x.email)).toEqual(["jane@clienta.com"]);
  });
});

describe("a body worth sending", () => {
  it("wants something, and not a novel", () => {
    expect(cleanBody("   ")).toEqual({ error: "Write something first" });
    expect(cleanBody("  hello  ")).toEqual({ body: "hello" });
    expect("error" in cleanBody("x".repeat(4001))).toBe(true);
  });
});

describe("grouping a back-and-forth", () => {
  const msg = (id: number, author: string, mins: number) => ({
    id, authorEmail: author, authorName: author, body: `m${id}`,
    createdAt: new Date(Date.parse("2026-08-16T10:00:00.000Z") + mins * 60_000).toISOString(),
  });

  it("runs consecutive messages from one person together", () => {
    const groups = groupMessages([msg(1, "a", 0), msg(2, "a", 1), msg(3, "b", 2)]);
    expect(groups.map((g) => g.map((x) => x.id))).toEqual([[1, 2], [3]]);
  });

  it("breaks the run after a long gap - the next one is a new thought", () => {
    const groups = groupMessages([msg(1, "a", 0), msg(2, "a", 120)]);
    expect(groups.map((g) => g.map((x) => x.id))).toEqual([[1], [2]]);
  });
});
