// What is configured, what the client is asked for, and whether a webhook is
// really from Stripe. No network - every function here is arithmetic or crypto.
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { modeNotice, payAmount, platformFee, stripeMode } from "@/lib/stripe";
import { verifyWebhook } from "@/lib/stripeApi";

describe("stripeMode", () => {
  it("reads the key rather than a flag", () => {
    expect(stripeMode("")).toBe("absent");
    expect(stripeMode(undefined)).toBe("absent");
    expect(stripeMode("sk_test_abc")).toBe("test");
    expect(stripeMode("rk_test_abc")).toBe("test");
    expect(stripeMode("sk_live_abc")).toBe("live");
    expect(stripeMode("rk_live_abc")).toBe("live");
  });

  it("treats an unrecognised key as test, never as live", () => {
    // Wrong in the safe direction: a mislabelled key that reads as test shows
    // a banner nobody needed, where one that reads as live invites somebody to
    // trust a payment page they should not.
    expect(stripeMode("whatever")).toBe("test");
  });

  it("says so out loud in test mode and stays quiet in live", () => {
    expect(modeNotice("test")).toContain("TEST MODE");
    expect(modeNotice("live")).toBe("");
    expect(modeNotice("absent")).toBe("");
  });
});

describe("payAmount", () => {
  const base = { balanceCents: 84000, cardSurchargeBps: 290, cardSurchargeFlatCents: 30 };

  it("asks for the balance on a bank transfer, with no surcharge", () => {
    const p = payAmount({ ...base, method: "ach" });
    expect(p.amountCents).toBe(84000);
    expect(p.surchargeCents).toBe(0);
    expect(p.line).toBe("");
  });

  it("adds the disclosed card fee, and says what it is", () => {
    const p = payAmount({ ...base, method: "card" });
    expect(p.surchargeCents).toBe(2466);
    expect(p.amountCents).toBe(86466);
    expect(p.line).toContain("2.90% processing fee plus $0.30");
    expect(p.line).toContain("Paying by bank transfer avoids it");
  });

  it("charges nothing extra when the operator absorbs it", () => {
    const p = payAmount({ ...base, method: "card", cardSurchargeBps: 0, cardSurchargeFlatCents: 0 });
    expect(p.amountCents).toBe(84000);
    expect(p.line).toBe("");
  });
});

describe("platformFee", () => {
  it("is nothing until somebody sets it", () => {
    expect(platformFee(84000, 0)).toBe(0);
    expect(platformFee(84000, -5)).toBe(0);
  });
  it("is basis points of the amount", () => {
    expect(platformFee(84000, 25)).toBe(210);
  });
});

describe("verifyWebhook", () => {
  const secret = "whsec_testsecret";
  const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const sign = (t: number) => createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");

  it("accepts a real signature inside the tolerance", () => {
    const t = 1_700_000_000;
    expect(verifyWebhook(payload, `t=${t},v1=${sign(t)}`, secret, 300, t + 10)).toBe(true);
  });

  it("rejects a forged signature", () => {
    const t = 1_700_000_000;
    expect(verifyWebhook(payload, `t=${t},v1=${"0".repeat(64)}`, secret, 300, t)).toBe(false);
  });

  it("rejects a replay from an hour ago", () => {
    const t = 1_700_000_000;
    expect(verifyWebhook(payload, `t=${t},v1=${sign(t)}`, secret, 300, t + 3600)).toBe(false);
  });

  it("rejects a tampered payload under a real signature", () => {
    const t = 1_700_000_000;
    const header = `t=${t},v1=${sign(t)}`;
    const tampered = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", extra: 1 });
    expect(verifyWebhook(tampered, header, secret, 300, t)).toBe(false);
  });

  it("rejects anything missing - no secret, no header, no payload", () => {
    const t = 1_700_000_000;
    expect(verifyWebhook(payload, `t=${t},v1=${sign(t)}`, "", 300, t)).toBe(false);
    expect(verifyWebhook(payload, "", secret, 300, t)).toBe(false);
    expect(verifyWebhook("", `t=${t},v1=x`, secret, 300, t)).toBe(false);
    expect(verifyWebhook(payload, "nonsense", secret, 300, t)).toBe(false);
  });
});
