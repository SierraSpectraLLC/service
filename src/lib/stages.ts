export const STAGES = [
  "Intake",
  "Refurbishment",
  "System setup",
  "Checkout",
  "Applications",
  "Sign-off",
  "Waiting / blocked",
  "Waiting to ship",
  "Shipped",
] as const;
export type Stage = (typeof STAGES)[number];

export const TASK_STATES = ["Open", "In progress", "Blocked", "Done"] as const;
export const PART_STATES = ["Needed", "Ordered", "In transit", "Received", "Backordered"] as const;
export const CARRIERS = ["", "UPS", "FedEx", "USPS", "DHL", "Freight", "Other"] as const;
export const ATTACH_KINDS = ["Tune report", "Test data", "Report", "Photo", "Manual", "Other"] as const;

export const STAGE_COLOR: Record<string, { bg: string; fg: string }> = {
  Intake: { bg: "#EEF1F5", fg: "#475569" },
  Refurbishment: { bg: "#FBEAE3", fg: "#A33A1A" },
  "System setup": { bg: "#E7F2FA", fg: "#1D6396" },
  Checkout: { bg: "#FAF0DC", fg: "#8A5410" },
  Applications: { bg: "#E2F5EC", fg: "#0F6E56" },
  "Sign-off": { bg: "#E5F3E5", fg: "#2E6B2E" },
  "Waiting / blocked": { bg: "#FBE9E9", fg: "#A32D2D" },
  "Waiting to ship": { bg: "#EDEBFA", fg: "#4F45A3" },
  Shipped: { bg: "#DDF0EA", fg: "#085041" },
};
export const TASK_COLOR: Record<string, { bg: string; fg: string }> = {
  Open: { bg: "#EEF1F5", fg: "#475569" },
  "In progress": { bg: "#E7F2FA", fg: "#1D6396" },
  Blocked: { bg: "#FBE9E9", fg: "#A32D2D" },
  Done: { bg: "#E5F3E5", fg: "#2E6B2E" },
};
export const PART_COLOR: Record<string, { bg: string; fg: string }> = {
  Needed: { bg: "#EEF1F5", fg: "#475569" },
  Ordered: { bg: "#EDEBFA", fg: "#4F45A3" },
  "In transit": { bg: "#E7F2FA", fg: "#1D6396" },
  Received: { bg: "#E5F3E5", fg: "#2E6B2E" },
  Backordered: { bg: "#FBE9E9", fg: "#A32D2D" },
};
export const ATTACH_META: Record<string, { glyph: string; bg: string; fg: string }> = {
  "Tune report": { glyph: "⚙", bg: "#EDEBFA", fg: "#4F45A3" },
  "Test data": { glyph: "▤", bg: "#E7F2FA", fg: "#1D6396" },
  Report: { glyph: "▦", bg: "#E5F3E5", fg: "#2E6B2E" },
  Photo: { glyph: "▣", bg: "#FAF0DC", fg: "#8A5410" },
  Manual: { glyph: "▥", bg: "#FBEAE3", fg: "#A33A1A" },
  Other: { glyph: "▢", bg: "#EEF1F5", fg: "#475569" },
};

export function trackUrl(carrier: string, n: string): string | null {
  if (!n) return null;
  const t = n.replace(/\s+/g, "");
  switch (carrier) {
    case "UPS": return "https://www.ups.com/track?tracknum=" + t;
    case "FedEx": return "https://www.fedex.com/fedextrack/?trknbr=" + t;
    case "USPS": return "https://tools.usps.com/go/TrackConfirmAction?tLabels=" + t;
    case "DHL": return "https://www.dhl.com/en/express/tracking.html?AWB=" + t;
    default: return null;
  }
}
