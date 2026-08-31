"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addOrg } from "@/app/actions";
import { rosterSummary, type ClientRow } from "@/lib/clientRoster";
import { DataTable, FacetStrip, Pill, Toolbar, type DataRow } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

/**
 * The client roster: who the shop works for, and what of theirs it looks after.
 *
 * Adding one is a STAFF verb and always was - addOrg has been requireStaff
 * since it was written, on the reasoning that a service company's clients are
 * theirs to create rather than something they file a request for. The form was
 * simply only ever rendered on an owner-only Settings page, so in practice an
 * engineer who picked up a new client had to go and find somebody. That is the
 * gap this room closes; the action is unchanged.
 *
 * A row opens the client's record only for a reader who may actually open it -
 * that page is the owner's, and a row leading to a redirect is worse than a row
 * that does not lead anywhere. The counts are on the row for exactly that
 * reason: they are what an engineer came to find out, so the list answers the
 * question without needing the click that most readers do not get.
 */
export default function ClientRosterPanel({ rows, filter, canOpen, canAdd }: {
  rows: ClientRow[];
  /** The facet and search, off the URL - the same shape the Settings list uses. */
  filter: { q: string; kind: string };
  /** Whether this reader may open an organization's record. */
  canOpen: boolean;
  /** Whether this reader may create one. Mirrors lib/tenants.mayCreateOrgs. */
  canAdd: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState({ name: "", kind: "client" });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const href = (kind: string) => {
    const p = new URLSearchParams();
    if (filter.q) p.set("q", filter.q);
    if (kind) p.set("kind", kind);
    return `/clients${p.size ? `?${p}` : ""}`;
  };

  const submit = () => {
    if (!draft.name.trim()) return;
    setError("");
    startTransition(async () => {
      const res = await addOrg(draft.name, draft.kind);
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Added ${draft.name.trim()}` });
      setDraft({ name: "", kind: draft.kind });
      router.refresh();
    });
  };

  return (
    <>
      <Toolbar
        search={
          <form action="/clients">
            {filter.kind && <input type="hidden" name="kind" value={filter.kind} />}
            <input name="q" defaultValue={filter.q} placeholder="Company name"
              aria-label="Search clients" />
          </form>
        }
        facets={
          /* Prospects sit beside the two kinds because to a reader it is one
             question - which of these companies is this list about - and
             because a Clients facet that included the people we are still
             selling to would be the roster telling the same lie the fleet
             was. */
          <FacetStrip facets={(["client", "prospect", "provider"] as const).map((k) => ({
            key: k,
            label: k === "client" ? "Clients" : k === "prospect" ? "Prospects" : "Providers",
            count: rows.filter((o) => (k === "prospect" ? o.prospect : o.kind === k && !o.prospect))
              .length || undefined,
            on: filter.kind === k, href: href(filter.kind === k ? "" : k),
          }))} />
        }
      />

      <DataTable
        cols={[
          { key: "name", label: "Company", width: "minmax(160px, 1.6fr)" },
          { key: "kind", label: "Kind", width: "90px", hideMobile: true },
          { key: "has", label: "What we look after", width: "minmax(160px, 1.2fr)", align: "right" },
        ]}
        rows={rows.map((o): DataRow => ({
          key: o.id,
          href: canOpen ? `/settings/organizations/${o.id}` : undefined,
          cells: {
            name: (
              <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                {/* Their header colour, so this list looks like their workspace does. */}
                <span aria-hidden style={{ width: 10, height: 10, borderRadius: 3, flexShrink: 0, background: o.themeColor || "var(--line)" }} />
                <span className="t-lead" style={{ fontWeight: 700 }}>{o.name}</span>
              </span>
            ),
            kind: o.prospect
              ? <Pill tone="warn">prospect</Pill>
              : <Pill tone={o.kind === "provider" ? "warn" : "info"}>{o.kind}</Pill>,
            /* A prospect's systems are on file and not in the fleet, and the
               roster is where somebody notices the difference. */
            has: (
              <span className="mut t-meta">
                {rosterSummary(o)}{o.prospect && o.systems > 0 ? " · not in the fleet" : ""}
              </span>
            ),
          },
        }))}
        empty={filter.q || filter.kind
          ? "Nobody here matches that."
          : "No companies yet - add the first one below."}
      />

      {canAdd && (
        <>
          <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="New company name" aria-label="New company name"
              className="t-body" style={{ flex: "1 1 160px" }} />
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
              aria-label="What kind" className="t-small" style={{ width: "auto" }}>
              <option value="client">client - owns systems</option>
              <option value="provider">provider - services them</option>
            </select>
            <button className="btn sm accent" onClick={submit} disabled={pending || !draft.name.trim()}>
              {pending ? "Adding..." : "Add"}
            </button>
          </div>
          {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
        </>
      )}

      {/* The other half of the same subject, for the one reader who has it.
          Sharing a system, letting somebody sign in and setting where their
          reports go are configuration; this room is the roster. */}
      {canOpen && (
        <div className="mut t-small" style={{ marginTop: 12 }}>
          Sign-ins, sharing and report recipients live in{" "}
          <Link href="/settings/organizations">Settings › Clients &amp; orgs</Link>.
        </div>
      )}
    </>
  );
}
