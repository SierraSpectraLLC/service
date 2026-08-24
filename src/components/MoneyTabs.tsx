import { Tabs } from "@/components/ui";

/**
 * The rooms of /money, in the order money moves through them: what has been
 * quoted, what has been billed, what is stuck, and the standing arrangements
 * underneath all of it. Overview is the loop itself.
 */
export default function MoneyTabs({ active, counts = {} }: {
  active: "overview" | "quotes" | "invoices" | "collections" | "contracts" | "costing" | "overhead";
  counts?: Partial<Record<"quotes" | "invoices" | "collections" | "contracts", number>>;
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
        { key: "contracts", label: "Contracts", href: "/money/contracts", count: counts.contracts },
        { key: "costing", label: "Costing", href: "/money/costing" },
        { key: "overhead", label: "Overhead", href: "/money/expenses" },
      ]}
    />
  );
}
