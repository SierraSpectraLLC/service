import { describe, expect, it } from "vitest";
import { maskPhone, normalizePhone } from "@/lib/sms";

describe("phone numbers", () => {
  it("takes what people actually type", () => {
    // The shop types ten digits; carriers want E.164. Refusing the former would
    // be pedantry, so this bridges it rather than arguing.
    expect(normalizePhone("555 123 4567")).toBe("+15551234567");
    expect(normalizePhone("(555) 123-4567")).toBe("+15551234567");
    expect(normalizePhone("1-555-123-4567")).toBe("+15551234567");
    expect(normalizePhone("+1 555 123 4567")).toBe("+15551234567");
  });

  it("leaves a number that carries its own country code alone", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("refuses what cannot be a phone number", () => {
    for (const junk of ["", "   ", "abc", "12345", "+1", "9".repeat(20)]) {
      expect(normalizePhone(junk)).toBe("");
    }
  });

  it("shows only the last four back to somebody", () => {
    // Printed on a page that might be on a screen share.
    expect(maskPhone("+15551234567")).toBe("••••••••4567");
    expect(maskPhone("")).toBe("");
  });
});
