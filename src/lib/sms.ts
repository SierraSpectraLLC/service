// Codes by text, for when email is the thing that's broken.
//
// The boundary is one file, like lib/remote: everything that knows Twilio's wire
// format is here, so swapping carriers is this file and nothing else. Nothing
// above it should know a carrier exists - it asks for a code to be delivered to a
// person, and finds out whether that worked.
//
// Configuration is three environment variables and no code change; without them
// smsConfigured() is false and every path that could text falls back to email,
// which is what an instance that never wants texts should do silently.
const SEND_TIMEOUT_MS = 8000;

export type SmsConfig = { accountSid: string; authToken: string; from: string };

export function smsConfig(): SmsConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  const from = process.env.TWILIO_FROM ?? "";
  if (!accountSid || !authToken || !from) return null;
  return { accountSid, authToken, from };
}

export const smsConfigured = () => smsConfig() !== null;

/**
 * A number in the shape carriers want: E.164, digits with a leading +.
 *
 * A bare ten-digit number is assumed to be North American, because that is what
 * everybody in this shop types and refusing it would be pedantry. Anything with
 * its own country code is left alone. Returns "" for something that cannot be a
 * phone number, which is how the caller refuses it.
 */
export function normalizePhone(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return "";
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : "";
  if (digits.length === 10) return `+1${digits}`;             // 555 123 4567
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : "";
}

/** How a number is shown back to somebody: never in full, so a screen share is safe. */
export function maskPhone(e164: string): string {
  if (!e164) return "";
  return `${"•".repeat(Math.max(0, e164.length - 4))}${e164.slice(-4)}`;
}

/**
 * Send one message. Returns false rather than throwing: every caller has email
 * to fall back to, and a carrier outage should cost somebody one extra tap, not
 * their way in.
 */
export async function sendSms(to: string, body: string): Promise<boolean> {
  const cfg = smsConfig();
  const number = normalizePhone(to);
  if (!cfg || !number) return false;
  const started = Date.now();
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: number, From: cfg.from, Body: body }).toString(),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      console.error(`[sms] carrier rejected after ${ms}ms:`, res.status, await res.text().catch(() => ""));
      return false;
    }
    console.log(`[sms] code sent in ${ms}ms`);
    return true;
  } catch (e) {
    console.error(`[sms] send failed after ${Date.now() - started}ms:`, (e as Error).name, (e as Error).message);
    return false;
  }
}
