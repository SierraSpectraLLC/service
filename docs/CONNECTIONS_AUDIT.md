# Connections Audit — Ridgeline

*Audit date: August 2026, against `claude/app-connections-audit-1mfyv8`. Every finding
below was reproduced against a running instance, not inferred from reading. Method is at
the end.*

---

## Summary

The app is in good health. Typecheck is clean, 2,029 tests across 156 files pass, the
production build succeeds, and the schema mirror check reports all 1,035 columns
mirrored. Crawling 1,201 URLs across 78 distinct route shapes — as the owner and as six
client personas — produced **one** unintended 404. Every literal `href`, `redirect()`,
and stored notification target in the codebase resolves to a real route. Every API route
does its own authorization, and each of the seven cron routes named in `vercel.json`
exists and is guarded consistently.

What follows is the short list of things that are genuinely broken, dead, or
undiscoverable.

| # | Finding | Severity | Fix size |
|---|---|---|---|
| 1 | `robots.txt` frozen at build time; disallows the public catalog | High | 1 line |
| 2 | Daily-digest panel on the operator's own org page is a dead end | High | ~3 lines |
| 3 | `npm run dev:local` fails on a fresh clone | High (onboarding) | ~2 lines |
| 4 | Cron routes accept `Bearer undefined` when `CRON_SECRET` is unset | Medium-high (security) | ~4 lines × 7 |
| 5 | `lib/serviceReport.ts` — 507 lines, tested, wired to nothing | Medium (unfinished) | Feature |
| 6 | `lib/xlsxTemplate.ts` — 211 lines, tested, superseded | Low (dead code) | Delete |
| 7 | Twilio SMS sign-in documented nowhere | Medium | Docs |
| 8 | `.env.example` missing 9 vars the code reads | Medium | Docs |
| 9 | `revalidatePath("/clients/…")` — route does not exist | Low | 1 line |
| 10 | `revalidatePath("/records")` — route does not exist | Low | 1 line |
| 11 | README understates the cron schedule | Low | Docs |
| 12 | Both parity docs materially stale | Low | Docs |
| 13 | Inbox links do not degrade when access is withdrawn | Low | ~10 lines |

---

## 1. `robots.txt` is baked at build time, and it disallows the public catalog

**High. One line.**

`/robots.txt` is the **only** statically prerendered route in the entire application. The
build's own route table says so — every one of the other 78 routes is `ƒ (Dynamic)`:

```
├ ○ /robots.txt        233 B    103 kB      ← Static
├ ƒ /sitemap.xml       233 B    103 kB      ← Dynamic
```

`src/app/robots.ts` calls `getModules()`, a database read, to decide whether to emit
`Allow: /equipment`. `src/app/sitemap.ts` makes the same call and carries
`export const dynamic = "force-dynamic"`. `robots.ts` does not, so Next renders it once
during `next build` and serves that frozen copy forever.

Two consequences, both real:

- **The Settings toggle does nothing.** Switching the public catalog on under
  Settings → Platform cannot change `robots.txt` until somebody redeploys. Everywhere
  else in this codebase a module flag takes effect immediately and deliberately — that
  is the whole reason the digest schedule lives in the database rather than in
  `vercel.json`. This is the one place the promise breaks.
- **A failed build-time read bakes in `Disallow`.** `getModules()` swallows its error
  and returns all-false. Any build where the database is unreachable at prerender time
  produces a `robots.txt` that disallows `/equipment` permanently.

The two files then contradict each other: `sitemap.xml` is dynamic, so it happily
advertises `/equipment` and every published model, while `robots.txt` says `Disallow: /`
and never names the exception. The library exists to be found, and no crawler is allowed
to find it.

**Reproduced.** The local fixture sets `public_catalog_enabled = true`. The served
`robots.txt` has no `Allow: /equipment` line, and `.next/server/app/robots.txt.body` on
disk shows why — it was written at build time.

**Fix.** Add the line `sitemap.ts` already has:

```ts
// src/app/robots.ts
export const dynamic = "force-dynamic";
```

---

## 2. The daily-digest panel on the operator's own organization page is a dead end

**High. About three lines.**

`/settings/organizations/<operator-org>` renders the full "Daily digest" panel —
recipient checkboxes, send hour, days of the week, **Preview**, **Send now**. That panel
is for a *partner* edition, and an operator has no partner edition of itself. Every
control in it either fails or writes somewhere the user does not expect.

`OrgSettingsForm.tsx:599` gates the panel on `isOwner && showDigest`. It never consults
`org.isOperator`, which the component already receives (`page.tsx:165`) and already uses
elsewhere.

What actually happens on that page:

| Control | Behaviour |
|---|---|
| **Preview** | `GET /api/digest/preview?org=<operator>` → **404** *"No such organization in your workspace."* The route requires `org.parentOrgId === tenant`; the operator's own row has `parentOrgId = null`. |
| **Send now** | `sendDigestNow(<operator>)` → `{ error: "Not found" }` — the same guard, in `actions.ts:6986`. |
| **Send hour / days** | Writes succeed, but to `orgs.digestHour`/`digestDays` **on the operator row — the row that holds the *internal* edition's schedule**, which is also edited at Settings → Configuration. Two screens, one set of columns, no indication they are the same setting. |
| **Recipients** | Writes `orgs.digestRecipients` on the operator row. The internal edition reads `houseEmails(tenant)` (`digest.ts:sendDigestEdition`), never that column. The list is stored and never used. |

The 404 was found by crawling, not by reading — it is the only unintended non-200 in
1,201 requests.

The cron itself is correct: `runDailyDigest` excludes the operator from partner editions
with `o.id !== tenantOrgId`. Only the settings panel is wrong, so the fix belongs there.

**Fix.** Hide the panel for the operator's own organization, so the internal edition is
configured in exactly one place:

```tsx
{isOwner && showDigest && !org.isOperator && (
  <Panel title="Daily digest" …>
```

Worth adding a one-line pointer where the panel used to be — *"This workspace's own
edition is configured under Settings → Configuration"* — so the absence reads as a
decision rather than a missing feature.

---

## 3. `npm run dev:local` fails on a fresh clone

**High for onboarding. About two lines.**

The README's zero-setup path — the one that needs no Neon, no Resend, no env file, and
that the design screenshots are taken from — does not survive `git clone && npm ci`:

```
[dev:local] database: /home/user/service/node_modules/.cache/ridgeline-pglite
Error: ENOENT: no such file or directory,
       mkdir '/home/user/service/node_modules/.cache/ridgeline-pglite'
    at new m (@electric-sql/pglite/src/fs/nodefs.ts:15:10)
    at seed (scripts/dev-local.ts:609:3)
```

npm does not create `node_modules/.cache`, and PGlite's `mkdirSync` is not recursive, so
it cannot create the leaf either. `mkdir -p node_modules/.cache` fixes it — but a new
contributor has no way to know that, and the failure names PGlite rather than the
missing parent directory.

**Fix.** Create the directory in `scripts/dev-local.ts` before handing the path to
PGlite:

```ts
import { mkdirSync, readFileSync } from "node:fs";
// PGlite's own mkdir is not recursive, so the parent must already exist.
mkdirSync(DATA_DIR, { recursive: true });
```

---

## 4. Cron endpoints accept `Bearer undefined` when `CRON_SECRET` is unset

**Medium-high. Security. Four lines, seven times — or one shared helper.**

All seven cron routes guard identically:

```ts
const authHeader = req.headers.get("authorization");
if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

With `CRON_SECRET` unset the template literal interpolates to the string
`"Bearer undefined"`, and that is a value any caller can send. The guard does not fail
closed; it fails to a publicly guessable password.

`/api/cron/*` is excluded from the middleware login gate (`middleware.ts:54`) — correctly,
since Vercel's scheduler holds no session — so nothing downstream stops the request
either. What an anonymous caller reaches on such an instance:

- `/api/cron/daily-digest` — sends client-facing digest email on demand
- `/api/cron/dunning` — sends dunning notices to clients
- `/api/cron/recurring` — generates recurring invoices
- `/api/cron/renewals`, `/api/cron/usage`, `/api/cron/pm-generate`, `/api/cron/sheet-sync`

`.env.example` ships `CRON_SECRET=""` — the empty string, which produces the same
problem via `"Bearer "`.

**Fix.** One shared guard, refusing when the secret is absent, comparing in constant
time. `lib/secretBox.ts` already exports `sameSecret` for exactly this shape of
comparison:

```ts
// src/lib/cronAuth.ts
import { sameSecret } from "@/lib/secretBox";

/** "" when the request may proceed; otherwise why it may not. */
export function cronDenied(req: Request): string {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  // No secret configured is a refusal, not a free pass: an unset variable must
  // never resolve to a password anyone can type.
  if (!secret) return "CRON_SECRET is not set on this instance";
  const header = req.headers.get("authorization") ?? "";
  return sameSecret(header, `Bearer ${secret}`) ? "" : "Unauthorized";
}
```

Then each route becomes two lines. Add a test asserting that an unset and an empty
`CRON_SECRET` both refuse `Bearer undefined` and `Bearer `.

---

## 5. The service-report PDF is complete, tested, and wired to nothing

**Medium. This is the one genuinely unfinished system.**

`src/lib/serviceReport.ts` — 507 lines, a full branded PDF generator reproducing the
document the shop has always sent — is imported by **zero** files in `src/`. It has its
own test file, `tests/serviceReport.test.ts`, which passes. Nothing else in the repository
references it.

It is unfinished for a stated reason, and the file says so itself:

> **NOTE:** this is ONE service company's logo. Everything else on this page is data, so
> a report can be issued by whichever operator did the work; this is not. Before this
> generator is wired to a page on a multi-operator instance, it has to come from that
> operator's uploaded logo (`orgs.logo_url`, already on `brandForTenant`) — printing one
> company's mark on another's service report is a false statement about who did the work.

That is the same principle the README opens with, and it is the right call. The blocker
is small and named: the hardcoded `MARK` constant.

`docs/FEATURE_PARITY_DEEP_DIVE.md:342` lists wiring this as recommendation #1.

**Fix, in order.**

1. Replace the drawn `MARK` with the operator's logo from `brandForTenant`, falling back
   to the operator's name set as type when no logo is uploaded. Never a hardcoded mark.
2. Add a route beside the ones that already exist for this shape of document —
   `/api/export/service-report/[workOrderId]` — mirroring
   `/api/export/invoice/[id]`, including its `requireStaff()` + `readTenant()` guard.
3. Add the download button to the work-order page, next to the existing export controls.
4. Add `outputFileTracingIncludes` only if the generator ends up reading anything off
   disk; as written it draws everything, so it should need no entry.

---

## 6. `lib/xlsxTemplate.ts` is dead by supersession

**Low. Delete it.**

`src/lib/xlsxTemplate.ts` (211 lines, plus tests) is a generic `{{token}}`-substitution
workbook filler. It has no importers. The job it was written for is now done by
`src/lib/xlsxDocs.ts`, which fills the three committed layouts by cell address and *is*
wired — to `/api/export/invoice/[id]`, `/api/export/quote/[id]`, and
`/api/export/po/[id]`.

Both parity docs still describe it as "built & tested, wired to nothing", implying it is
waiting to be finished. It is not; it lost. Two filler implementations in one repository
is a trap for whoever next needs to change a document layout.

**Fix.** Delete `src/lib/xlsxTemplate.ts` and `tests/xlsxTemplate.test.ts`, and correct
both parity docs. If the token-substitution approach is still wanted for
operator-supplied templates later, it is in the git history.

---

## 7. Twilio SMS sign-in codes are undiscoverable

**Medium. Documentation only.**

`src/lib/sms.ts` is complete and fully wired: `auth.ts:82` sends a code by text when the
person asks for one, `LoginForm` offers the option when `smsConfigured()` is true, and
`SignInSettings` lets somebody register a number. `smsConfigured()` reads three
environment variables.

Those three variables — `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` — appear
in **no** documentation: not `.env.example`, not `docs/PROVISIONING.md`, not the README.
Grep across `docs/` and `README.md` returns nothing.

The feature is therefore permanently off on every instance, and no operator has a way to
discover that it exists. This is the largest gap between what the code does and what
anybody can use.

**Fix.** Add a Twilio block to `.env.example` and a section to `docs/PROVISIONING.md`,
matching the existing treatment of Stripe and Microsoft: what it costs, what it does when
unset (falls back to email silently, which is correct), and the three values.

---

## 8. `.env.example` is missing nine variables the code reads

**Medium. Documentation only.**

The README says `cp .env.example .env`. Nine variables the code reads are not in that
file. Most are documented in `docs/PROVISIONING.md`, which is good — but somebody
following the README's setup steps never opens it.

| Variable | Subsystem | In `PROVISIONING.md`? |
|---|---|---|
| `SHOP_TZ` | Shop day — drives EOD keys, digest scheduling, every date stamp | Yes |
| `DATABASE_URL_UNPOOLED` | Build-time schema sync | Yes |
| `MS_CLIENT_ID` | OneDrive / SharePoint library | Yes |
| `MS_CLIENT_SECRET` | " | Yes |
| `MS_TENANT` | " | Yes |
| `CLOUD_TOKEN_KEY` | Seals stored Microsoft refresh tokens | Yes |
| `REMOTE_URL` | Remote support relay | Yes |
| `REMOTE_LOGIN_KEY` | " | Yes |
| `REMOTE_ADMIN_USER` | " | Yes |

The practical effect: two entire subsystems — the cloud document library and remote
support — are silently absent for anyone who sets the app up from the README alone.
`SHOP_TZ` is the quietest of the nine: unset, it defaults to `America/Los_Angeles`, so an
East Coast shop's digest sends at the wrong hour and its "today" rolls over at the wrong
time, with nothing anywhere saying why.

**Fix.** Add all nine to `.env.example`, each with the one-line explanation and the
"unset means…" sentence the file already uses so well for Stripe and Maps. Cross-link
`docs/PROVISIONING.md` from the README's setup section.

---

## 9 & 10. Two `revalidatePath` calls point at routes that do not exist

**Low. One line each.**

- `actions.ts:13970`, in `saveRecurringTerms`: `revalidatePath(\`/clients/${ag.orgId}\`)`.
  There is no `/clients` route anywhere in the app — this is a leftover from a rename.
  The pages that actually show recurring billing terms are `/money/contracts`,
  `/settings/agreements`, and `/settings/organizations/[id]`, and none of them is
  revalidated; only `/money` is.
- `actions.ts:8427`, in `handOffSystem`: `revalidatePath("/records")`. Only
  `/records/[id]` exists. Engagement records are listed on `/` and `/settings/admin`;
  `rev()` already covers `/`, so this call does nothing.

Practical impact is small — 74 of 79 pages are `force-dynamic`, so they re-render per
request anyway — but both calls are misleading to read and cost nothing to correct.

**Fix.** Replace the first with `/settings/organizations/${ag.orgId}`,
`/money/contracts`, and `/settings/agreements`; replace the second with
`/settings/admin`, or delete it since `rev()` already covers `/`.

---

## 11 & 12. Documentation drift

**Low.**

- **README §5** says *"`vercel.json` schedules `GET /api/cron/sheet-sync` and
  `GET /api/cron/daily-digest` hourly."* It schedules **seven** crons: those two plus
  `pm-generate`, `renewals`, `usage`, `dunning`, and `recurring`, on five different
  schedules. Somebody provisioning an instance from this list will not know what is
  running.
- **Both parity docs** are materially stale. `COMPETITIVE_PARITY_AUDIT.md:67` still says
  *"Estimates / quotes / invoicing / payments ❌ — **We record costs but bill nothing.**"*
  The app now has quotes, invoices, Stripe Connect, dunning, collections, statements,
  payroll, and a whole `/money` section. `FEATURE_PARITY_DEEP_DIVE.md` describes the
  codebase as "~35k lines, ~170 server actions, 55 tables"; it is now roughly 88k lines,
  348 server actions, and 92 tables. Two documents that confidently understate the
  product are worse than none, because they are used to decide what to build next.

**Fix.** Correct the README cron list. Re-run both parity docs against the current code —
the invoicing row in particular flips from ❌ to ✅, which changes the recommendations
that follow from it.

---

## 13. Inbox links do not degrade when access is withdrawn

**Low. Worth knowing about.**

Notification rows are keyed by email alone (`notifications.email`), with no check at
render time that the viewer can still open the target. A person whose share is withdrawn,
or whose org loses custody of a system, keeps old notifications pointing at
`/instruments/…` and `/work/…` rows they can no longer see. Those links 404 rather than
saying the record is no longer available.

I observed this as a 404 on `/work/2` from `/inbox` while crawling under a "view as
client" persona — and that particular instance is an artefact of the persona mechanism
(the persona swaps the org but keeps the owner's email, so the owner's own notifications
are shown against a client's access). The underlying gap is real but narrow: in
production a client only ever receives their own notifications, and it takes a
revocation to reach it.

**Fix, if it is worth it.** Either filter targets at render time in `/inbox`, or let the
row render and have the destination pages say "no longer available" instead of 404.
The second is cheaper and reads better.

---

## Also noted, not defects

- **`next dev` exhausts an 8 GB heap** walking the whole app; at the default heap it
  trips Next's own "approaching the used memory threshold, restarting" repeatedly. This
  is dev-mode compilation, not a production characteristic — `next start` serves the same
  1,201 URLs in a few minutes at ~480 MB RSS. It does make whole-app manual QA under
  `dev:local` painful, which is worth knowing before someone tries.
- **Auth.js needs `AUTH_URL` or `AUTH_TRUST_HOST`** to run under `next start` outside
  Vercel. Not a bug — Vercel sets what it needs — but it blocks local production-mode
  testing until you know it.
- **`/api/files/zip` 404s when a blob URL is unreachable.** Correct behaviour, and
  correctly commented; it surfaced only because the local fixture uses fake
  `https://blob.local/…` URLs.

---

## What the audit confirmed is sound

Worth stating, because it is most of the app:

- **Authorization.** Every route excluded from the middleware login gate
  (`api/files`, `api/upload`, `api/drop`, `api/share`, `api/catalog`, `api/stripe`,
  `api/cron`, and the token pages) re-checks its own credential. `mayReadAttachment` is
  shared by the download proxy, the zip route, and the PDF combiner, so they cannot
  drift. The Stripe webhook verifies its signature on the raw body before parsing.
- **Route integrity.** All 38 literal `href`s, all 70 template `href`s, every stored
  notification target, and every `redirect()` destination resolve to a real route. All
  seven crons in `vercel.json` exist.
- **Degradation.** Unconfigured integrations say so in plain English rather than
  failing: `/api/upload` names `BLOB_READ_WRITE_TOKEN`, `/api/cloud/file` explains that
  OneDrive is not set up, the Stripe pay buttons simply do not render, and `appUrl()`
  callers return early rather than emitting half a link.
- **Schema.** `check-schema-mirror` reports 1,035 columns all mirrored between
  `db/schema.ts` and `drizzle/schema-sync.sql`.

---

## Suggested order of work

**One sitting — four small, independent changes.**

1. `robots.ts` — add `force-dynamic` (#1). One line, unblocks the entire SEO surface.
2. `dev-local.ts` — `mkdirSync(DATA_DIR, { recursive: true })` (#3). Unblocks onboarding.
3. `OrgSettingsForm.tsx` — hide the digest panel for the operator's own org (#2).
4. `lib/cronAuth.ts` — shared guard that fails closed, plus its test (#4).

Each is independently shippable and independently testable. None touches the others.

**Next — documentation, one pass.**

5. `.env.example`: add the nine missing variables (#8) and the Twilio block (#7).
6. `docs/PROVISIONING.md`: add the Twilio section (#7).
7. README: correct the cron list (#11); link `PROVISIONING.md` from setup (#8).

**Then — cleanup.**

8. Fix the two dead `revalidatePath` targets (#9, #10).
9. Delete `lib/xlsxTemplate.ts` and its test (#6).
10. Re-run both parity docs against the current code (#12).

**Finally — the one real feature.**

11. Wire the service-report PDF (#5): operator logo from `brandForTenant`, then the
    export route, then the button. This is the only item here that is a feature rather
    than a repair, and the only one that wants its own review.

Item 13 is optional and can wait for somebody to actually hit it.

---

## Method

Everything above was reproduced, not inferred.

- **Static.** Extracted every literal and template `href`, every `redirect()`, every
  `revalidatePath()`, and every stored notification `href` in `src/`, then matched each
  against the 79 page routes and 31 route handlers with dynamic segments expanded to
  patterns. Cross-checked `process.env.*` reads against `.env.example`, `README.md`, and
  `docs/`. Checked every `src/lib` module and every component for importers.
- **Build.** `npm ci`, `npx tsc --noEmit` (clean), `npx vitest run` (2,029 passing),
  `npx tsx scripts/check-schema-mirror.ts` (1,035 columns), `npm run build` (succeeds) —
  the same four gates CI runs. Read the build's route table to find static/dynamic
  mismatches.
- **Dynamic.** Booted the app against the `dev:local` PGlite fixture, then rebuilt and
  served it with `next start` for speed. Breadth-first crawled the rendered link graph
  with the owner session — 1,201 URLs, 78 distinct route shapes — recording status,
  redirect target, timing, and referrer for each. Repeated the crawl under six client
  personas (three orgs × editor/viewer) via the `view_as` cookie. Probed the API surface
  directly for authorization and degradation behaviour.

The temporary change made to `src/db/index.ts` to let the production build reach the
throwaway PGlite database was reverted; the working tree is clean.
