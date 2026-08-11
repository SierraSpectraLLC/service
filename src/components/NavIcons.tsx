import Link from "next/link";

/**
 * The header's utility cluster: search, messages, alerts, account. Icons rather
 * than another row of white pills, because these four are always present and
 * always the same - they are the furniture, not the navigation. What changes
 * between pages belongs on the left; what is always there belongs here, small.
 *
 * Inline SVG at 18px on `currentColor`, so an organization's themed header (which
 * can be light or dark) gets legible icons without a second palette. No icon
 * dependency: four line drawings are not worth a package.
 */

const S = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const SearchIcon = () => (
  <svg {...S} aria-hidden><circle cx="11" cy="11" r="7" /><path d="M20 20l-4.3-4.3" /></svg>
);

export const MessagesIcon = () => (
  <svg {...S} aria-hidden><path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-5.5A8 8 0 0 1 13 4a8 8 0 0 1 8 8z" /></svg>
);

export const BellIcon = () => (
  <svg {...S} aria-hidden>
    <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" /><path d="M10.5 20a1.9 1.9 0 0 0 3 0" />
  </svg>
);

/**
 * One icon in the cluster, with an optional unread count. The badge is a number
 * rather than a dot: "3 waiting" is actionable and "something happened" is not.
 * Capped at 99+ so a neglected inbox can't push the layout around.
 */
export function NavIcon({ href, label, count = 0, children }: {
  href: string;
  /** Read out by assistive tech, and the hover tooltip - the icon alone is a guess. */
  label: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <Link className="nav-ico" href={href} title={label}
      aria-label={count > 0 ? `${label}, ${count} unread` : label}>
      {children}
      {count > 0 && <span className="nav-badge" aria-hidden>{count > 99 ? "99+" : count}</span>}
    </Link>
  );
}
