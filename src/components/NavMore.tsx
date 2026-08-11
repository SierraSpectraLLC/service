"use client";

import Link from "next/link";
import Dropdown from "@/components/Dropdown";

/** Collapses the long tail of staff nav links into one dropdown so the top bar fits on a phone. */
export default function NavMore({ items }: { items: { href: string; label: string }[] }) {
  return (
    <Dropdown label="More">
      {items.map((i) => (
        <Link key={i.href} href={i.href}>{i.label}</Link>
      ))}
    </Dropdown>
  );
}
