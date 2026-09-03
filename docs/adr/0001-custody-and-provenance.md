# ADR 0001 — Custody and provenance

Status: accepted (Phase 0). Date: 2026-09-02. Supersedes nothing.

## The problem

`instruments` and `assets` carry `tenantOrgId`, stamped at creation like every
other row. That is right for a work order and wrong for a machine: a machine is
not the property of the workspace that typed it in. Two consequences follow, and
they are the reason this document exists.

**History forks.** `lib/clientShare` hands a client from one shop to another by
COPYING instrument rows — "their EP-001 is our NW-114" is two rows for one
physical machine, and from the copy forward each shop writes a history the other
cannot see. Nothing reconciles them. The serial number is the only thing that
knows they are the same machine, and `lib/serialLookup` has to guess.

**There is no stream.** History is reconstructed at read time from tasks, work
orders, `pm_schedules`, `service_visits`, `stage_events`, `asset_events`,
`custody_events` and `audit_log`. `lib/serviceHistory.ts` says so in its own
header. Nothing can be hashed, graded, scored or projected to an outside viewer,
because there is no single row per thing-that-happened to project.

The market this is for makes both expensive: on a resale, the history IS the
product. A serial number that can prove who held a system, what was done to it
and by whom is worth more than one that cannot.

## The model

**System identity.** One row per physical machine, platform-scoped, with
relationships hanging off it. `tenantOrgId` on instruments and assets becomes
vestigial (the column stays; no read path uses it).

**Custody epochs.** Custody is a span, not a pointer. `custody_epochs` numbers
spans 1..n per instrument: who held it, which event opened it, which closed it,
and how it closed (`open | sealed | steward_sealed | dormant | claimed`). Exactly
one open epoch per instrument. `instruments.ownerOrgId` becomes derived from it.

**Grants.** Access is a grant on an epoch, not a row on a system: grantee, kind
(`service | broker | assessor | view`), scope, `startsAt`/`endsAt`, and an end
reason (`revoked | released | epoch_closed | expired`). A grant that has ended
still happened — see the visibility rules.

**One event stream.** `system_events`, append-only, hash-chained per instrument.
Every event carries `occurredAt` and `recordedAt` separately, stable procedure
keys, and TWO payloads split at write time: `provenance` (travels with the
machine forever) and `private` (stays with the org that wrote it). The hash
covers provenance-side fields only, so redacting or withholding never breaks the
chain.

Splitting at write is the load-bearing decision. `lib/redact` is a read filter
keyed to the record's tenant; a read filter cannot answer "may a stranger who
buys this machine in 2031 see this sentence", because the person who knew the
answer was the person typing it, and they are gone. `lib/provenance` already
makes this exact bet for catalog text — classify at the keystroke, never audit a
thousand notes afterwards. This is the same bet for service history.

## Grades

Three axes, all recorded, none inferred at read time.

- **Who** — `attested` (asserted by the custodian about work they did not
  witness), `self_reported` (the custodian's own staff did it), `third_party`
  (an outside org under a grant did it). A backfilled countersign can upgrade
  `attested` to `third_party`; grades are not in the hash, so it does not
  disturb the chain.
- **How** — `procedure_run` (a procedure set was worked, step by step, with
  results), `typed` (somebody wrote it down afterwards), `document_only` (a
  document exists and nothing structured does). `lib/signoff.signoffGate`
  already encodes the principle: a checkbox is not evidence.
- **Handoff** — how an epoch ended: `sealed`, `steward_sealed` (the platform
  operator sealed for a memberless client org), `dormant_gap` (nobody sealed;
  the gap is recorded as a gap), `closed_by_claim`.

## Visibility

One pure function, `viewOf(viewer, system)`, and every custody read goes through
it. Four rules:

1. **Party.** A viewer is a party to an epoch if it is the custodian, a grantee
   (ever — an ended grant still happened), the broker on the transfer that
   closed it, or the author, commissioner or custodian-at-time of any event in
   it. Parties see the epoch in `full`: both payloads, real names.
2. **Anchor.** A viewer's anchor is the highest-numbered epoch it is a party to.
   Every epoch BELOW the anchor reads at `prov`: structured provenance and
   findings, no `private`, custodians anonymized. This is what a buyer is
   buying. Every epoch above the anchor that the viewer is not party to is
   `none` — custody moving on does not hand the previous holder a window.
3. **No relationship, no system.** A viewer who is party to no epoch gets an
   EMPTY view, not a list of `none`s. The system does not exist for them.
4. **Names.** A custodian's name shows at `full` and reads
   `"<kind>, anonymized"` below it. An author's name shows to parties on that
   event always, and downstream only if that org set `showNameDownstream`;
   otherwise `"<kind> (name withheld by provider)"`. Custodian-authored events
   read `"custodian at the time"` below `full`, so anonymizing the custodian is
   not undone by the byline.

`private` is narrower than the epoch: it is visible to parties ON THAT EVENT
(author, commissioner, custodian-at-time) and to the epoch's custodian — not to
every party to the epoch. A broker who commissioned one exam sees that exam's
private payload and not the PM's.

Free text can additionally be `withheld` at seal. A party to the event still
reads the original; everyone else reads a withheld marker in its place. The
marker is always shown: a redaction that hides that it happened is a lie about
the record.

## Transfer, claim, seal

**Transfer** is `initiate → review → seal → accept`. Review shows the outgoing
custodian the provenance projection exactly as the recipient will see it, with
per-event withhold toggles on free text only — structured provenance does not
withhold. Seal, in one transaction, appends the transfer event, composes a
frozen bundle (`engagement_records` + `lib/dossier.composeSystemDossier`, which
already scopes to the org the record is frozen for) with its sha256, closes the
epoch, and ends every grant with `endReason = epoch_closed`. Accept opens epoch
n+1. Seal to nobody is legal and closes the epoch `dormant`.

**Claim** is the path for history whose holder will not or cannot seal:
`serialLookup.findOutsideMatches` → claim with evidence → notice to the
custodian (or its steward) and to every author in the epoch → a notice window →
silent resolution closes the epoch `claimed` and opens the claimant's. Structured
provenance crosses immediately; free text crosses at the end of the window
unless its AUTHOR withheld it. A claim on an already-dormant system resolves at
once — the gap is already in the record.

**Steward seal** exists because a client org with no members cannot act. The
operator that created it seals on its behalf, marked as such, and the transfer
event's `private` records who acted.

## Consequences

- Custody moves ONLY by seal-and-accept or by a resolved claim. Both leave the
  previous holder a frozen, exportable bundle. There is no path that deletes a
  holder's copy of their own work.
- The provenance score is a pure function of the chain, so a listing can show it
  without showing anyone's name.
- Every phase is additive. No column is dropped and no type is altered; retired
  columns stay and stop being read.

## Naming collisions (do not rename)

`lib/provenance.ts` is catalog publishability. `lib/custodyLine.ts` is queue
custody (whose move it is). `lib/handoff.ts` is the client-share invite
lifecycle. `procedures.provenance` and `catalog_refs.provenance` are
publishability strings. System custody lives in `src/lib/custody/` and nowhere
else.

## Policy — decided 2026-09-03

All five proposals accepted as written. Encoded as named constants in
`src/lib/custody/policy.ts`, which is the one place a surface may read them.

1. `showNameDownstream` defaults to **off**. A provider's name travelling with
   its work is free advertising for a national and a re-identification for a
   shop that services four instruments in one county; the provider owns the
   switch.
2. Dates travel **exact**. A PM done on a Tuesday is provenance about the
   machine, not about the shop, and rounding it would corrupt the plan
   recomputation for no privacy gain.
3. Region does **not** travel. "Service provider, California" re-identifies a
   regional shop in one guess.
4. The claim notice window is **14 days**.
5. `orgs.verifiedAt` requires business registration, an email domain the org
   controls, and at least one grant from an unrelated verified org. It gates
   the `third_party` grade: an org grading its own subsidiary as third-party is
   the obvious way to buy a score.
