import { describe, expect, it } from "vitest";
import { agentMessageCommands, consoleSafe } from "@/lib/remote";
import { noticesFor, permitted } from "@/lib/fleetNotice";

/**
 * The wire format, which is the half of this feature that can only fail on
 * somebody else's PC.
 *
 * meshcore parses a console command with splitArgs - /[^\s"]+|"([^"]*)"/gi -
 * so a quoted argument runs to the next double quote and there is NO escape
 * for one. Everything here is about that one fact.
 */
describe("what survives the engine's argument splitter", () => {
  it("takes the quotes out, because a quote ends the argument early", () => {
    // Left alone, this would end its argument at "Property and hand the rest
    // to agentmsg as further arguments.
    const out = consoleSafe('Say "Property of Sierra Spectra" to the caller');
    expect(out).not.toContain('"');
    expect(out).toBe("Say 'Property of Sierra Spectra' to the caller");
  });

  it("takes curly quotes too - a pasted notice is full of them", () => {
    expect(consoleSafe("“Account past due”")).toBe("'Account past due'");
  });

  it("flattens a multi-line notice onto the one line a console command is", () => {
    expect(consoleSafe("Line one.\n\nLine two.\r\n  Line three.")).toBe("Line one. Line two. Line three.");
  });

  it("truncates rather than letting a pasted essay run the command line", () => {
    const out = consoleSafe("x".repeat(5000));
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("the commands that leave a machine saying the right thing", () => {
  const safety = { reason: "Source heater overshooting setpoint.", decidedBy: "bill@x.com", contact: "555-0100", effect: "hold" as const };
  const repo = { noticeText: "Property of Sierra Spectra.", approvedBy: "joe@x.com", rung: "notice" as const };

  it("always clears first, because agentmsg appends and cannot replace", () => {
    const cmds = agentMessageCommands(permitted(noticesFor(repo, safety), "unattended"));
    expect(cmds[0]).toBe("clearagentmsg");
  });

  it("says nothing by saying only 'clear' - which is how a cleared notice is retracted", () => {
    expect(agentMessageCommands([])).toEqual(["clearagentmsg"]);
  });

  it("keeps the fault above the bill on the wire, not just in the array", () => {
    const cmds = agentMessageCommands(permitted(noticesFor(repo, safety), "unattended"));
    expect(cmds).toHaveLength(3);
    expect(cmds[1]).toContain("Source heater");
    expect(cmds[2]).toContain("Property of Sierra Spectra");
  });

  it("carries the contact into the one string an agent message is", () => {
    const cmds = agentMessageCommands(permitted(noticesFor(null, safety), "unattended"));
    expect(cmds[1]).toContain("(555-0100)");
  });

  it("emits a command that splitArgs reads back as exactly three arguments", () => {
    // The parse meshcore actually performs, run against what we send.
    const splitArgs = (str: string) => {
      const out: string[] = [];
      const re = /[^\s"]+|"([^"]*)"/gi;
      for (let m = re.exec(str); m != null; m = re.exec(str)) out.push(m[1] ? m[1] : m[0]);
      return out;
    };
    const nasty = { ...repo, noticeText: 'Ring "the office" now\nor else' };
    const cmds = agentMessageCommands(permitted(noticesFor(nasty, null), "unattended"));
    const args = splitArgs(cmds[1]);
    expect(args[0]).toBe("agentmsg");
    expect(args[1]).toBe("add");
    // The whole notice arrives as ONE argument - the point of the sanitising.
    expect(args[2]).toBe("Ring 'the office' now or else");
    expect(args).toHaveLength(4);
  });
});
