// Who a reminder and a quote go to. Written after a first-rung reminder went
// to a client's whole daily-digest list: the rule is one destination, in a
// strict order, and nobody rather than a guess.
import { describe, expect, it } from "vitest";
import { quoteRecipients, reminderRecipients } from "@/lib/moneyRecipients";

describe("reminderRecipients", () => {
  it("goes to nobody, not the digest list, when no AP desk and no contact are set", () => {
    // The incident: first rung, blank AP email, a full digest list. The digest
    // list is not even an input here - a reminder cannot reach it.
    expect(reminderRecipients({ contactEmail: undefined, apEmail: "" })).toEqual([]);
    expect(reminderRecipients({ contactEmail: null, apEmail: "   " })).toEqual([]);
  });

  it("goes to the AP desk on every rung, the first one included", () => {
    expect(reminderRecipients({ apEmail: " ap@labzen.example " })).toEqual(["ap@labzen.example"]);
  });

  it("goes to the rung's escalation contact alone when the rung names one", () => {
    expect(reminderRecipients({ contactEmail: "cfo@labzen.example", apEmail: "ap@labzen.example" }))
      .toEqual(["cfo@labzen.example"]);
  });
});

describe("quoteRecipients", () => {
  const digest = ["adam@labzen.example", "michael@labzen.example", "adam@labzen.example"];
  it("goes to the AP desk alone when one is set", () => {
    expect(quoteRecipients({ apEmail: "ap@labzen.example", digestList: digest })).toEqual(["ap@labzen.example"]);
  });
  it("falls back to the digest list - the people who asked for the work - once, deduplicated", () => {
    expect(quoteRecipients({ apEmail: "", digestList: digest })).toEqual(["adam@labzen.example", "michael@labzen.example"]);
    expect(quoteRecipients({ apEmail: null, digestList: [] })).toEqual([]);
  });
});
