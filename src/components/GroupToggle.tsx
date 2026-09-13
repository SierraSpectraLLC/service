/**
 * How a registry is sectioned: by what the rows ARE, or by whose they are.
 *
 * Links rather than buttons, because the grouping is URL state like every
 * other reading of the page - a filtered, owner-grouped list is a link
 * somebody can send. The page builds the two hrefs so the search and facets
 * already in the URL stay put.
 */
export default function GroupToggle({ value, choices }: {
  value: string;
  choices: { key: string; label: string; href: string }[];
}) {
  return (
    <div className="seg" role="group" aria-label="Group by">
      {choices.map((c) => (
        <a key={c.key} href={c.href} aria-current={c.key === value ? "true" : undefined}>{c.label}</a>
      ))}
    </div>
  );
}
