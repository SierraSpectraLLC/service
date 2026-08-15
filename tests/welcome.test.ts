import { describe, expect, it } from "vitest";
import { landingFor, welcomeRedirect } from "@/lib/welcome";

const DONE = new Date("2026-08-01T10:00:00Z");

describe("who meets the welcome step", () => {
  it("somebody signing in for the first time", () => {
    expect(welcomeRedirect(true, null, "/")).toBe("/welcome");
    expect(welcomeRedirect(true, null, "/instruments/42")).toBe("/welcome");
    expect(welcomeRedirect(true, null, "/settings/catalog")).toBe("/welcome");
  });

  it("and nobody who has already been through it", () => {
    // Existing people have been using the instance for months. A form in front
    // of their work would be the change they remember, and not fondly.
    expect(welcomeRedirect(true, DONE, "/")).toBe("");
    expect(welcomeRedirect(true, DONE, "/instruments/42")).toBe("");
  });

  it("and nobody who is not signed in - that is the login page's job", () => {
    expect(welcomeRedirect(false, null, "/")).toBe("");
  });
});

describe("what still works mid-setup", () => {
  it("the welcome page itself, or it would redirect to itself forever", () => {
    expect(welcomeRedirect(true, null, "/welcome")).toBe("");
  });

  it("signing out, because a form nobody can leave is a trap", () => {
    expect(welcomeRedirect(true, null, "/login")).toBe("");
  });

  it("every API route", () => {
    // The form posts through one, and a redirected image is a broken image
    // rather than a redirect anybody sees.
    expect(welcomeRedirect(true, null, "/api/files/12")).toBe("");
    expect(welcomeRedirect(true, null, "/api/auth/session")).toBe("");
  });

  it("does not treat a lookalike path as exempt", () => {
    // "/welcomers" is not "/welcome", and a prefix test that thinks it is would
    // be a hole in the only gate this has.
    expect(welcomeRedirect(true, null, "/welcomers")).toBe("/welcome");
    expect(welcomeRedirect(true, null, "/logins")).toBe("/welcome");
  });
});

describe("where signing in lands somebody", () => {
  it("on the form the first time and the dashboard after", () => {
    expect(landingFor(null)).toBe("/welcome");
    expect(landingFor(DONE)).toBe("/");
  });
});
