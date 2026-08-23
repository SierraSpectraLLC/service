import { Tabs } from "@/components/ui";

/**
 * The four rooms of /money, in the order money moves through them: what has
 * been quoted, what has been billed, and what is stuck. Overview is the loop
 * itself.
 */
export default function MoneyTabs({ active, counts = {} }: {
  active: "overview" | "quotes" | "invoices" | "collections";
  counts?: Partial<Record<"quotes" | "invoices" | "collections", number>>;
}) {
  return (
    <Tabs
      ariaLabel="Billing sections"
      active={active}
      items={[
        { key: "overview", label: "Overview", href: "/money" },
        { key: "quotes", label: "Quotes", href: "/money/quotes", count: counts.quotes },
        { key: "invoices", label: "Invoices", href: "/money/invoices", count: counts.invoices },
        {
          key: "collections", label: "Collections", href: "/money/collections",
          count: counts.collections, warn: (counts.collections ?? 0) > 0,
        },
      ]}
    />
  );
}
