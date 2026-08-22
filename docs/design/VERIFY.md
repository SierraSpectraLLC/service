# VERIFY - full-route audit of the rebuilt UI

Run against `npm run dev:local` (PGlite fixture), captured with Playwright at
375 / 768 / 1280. The h-scroll and header measurements were captured before the second
pass; the second pass swaps size-identical classes for inline styles and
adds dialogs/toasts, so the layout measurements carry over. Screenshots
for every route live in
`docs/design/screens/verify/<slug>-<width>.jpg`.

How each column is measured:

- **Header never wraps** - the `.app-header` row height, measured live at all
  three widths on six representative pages (one bar row plus the spectrum
  strip; the mobile header is its own single-row layout). Routes share one
  layout, so the measurement generalizes.
- **No horizontal scroll** - `scrollWidth > innerWidth` measured on every
  route at every width.
- **No inline fontSize / colour** - `grep -a` counts on the route's own
  `page.tsx`, after the second pass converted every on-scale inline
  fontSize (11/12/13/14/16/22) to `.t-*` classes repo-wide. What remains
  is deliberate: off-scale values, printed-sheet typography, iOS
  zoom-guard inputs, runtime-computed sizes, and values that conflict
  with a carrying class's own size (see the runtime-stays list).
- **Destructive actions via confirmDialog** - `window.confirm`,
  `window.prompt` and `window.alert` counts are 0 repo-wide; every
  reason-collecting destructive action goes through `confirmReason` with
  per-site { title, body, action } copy, and plain input questions go
  through `inputDialog`. Per-route value is "yes" unless noted.
- **Mutations toast** - every component the first pass flagged as silent
  now toasts its success path (past-tense verb + object). The only
  mutations left without a toast are ones whose feedback is already a
  navigation, an inline success note, or an optimistic control that
  visibly flips.
- **Tab reaches every RowAction** - RowActions renders inline `<button>`s
  plus a `<details><summary>` kebab, both natively focusable; verified live
  by tabbing to the kebabs on /settings/catalog (see keyboard spot-checks).
- **Escape closes every Dialog** - all dialogs render through the one
  `Dialog` component, whose Escape/focus-trap behavior is unit-tested
  (`tests/dialog.test.tsx`) and spot-checked live.

## Found and fixed during this pass (commit "VERIFY fixes")

- **Tablet header wrapped at 768-979px.** The desktop nav overflowed to a
  second row between the mobile drawer and the full desktop layout. Fixed
  with a compressed one-row band (tighter nav-link padding, brand text
  hidden); the burger/drawer now covers 640-767 and the tab bar stays
  phone-only. Verified single-row at 640/700/768/900/979/1024/1280.
- **/dev/ui horizontally scrolled at 375.** The nav-fixture frames and the
  gallery facet strips now scroll inside their own containers instead of
  stretching the page.
- **`.page-actions` could push past the viewport** on narrow record pages;
  now clamped with `min-width: 0; max-width: 100%`.


## Route table

| Route | Archetype | Header never wraps | No h-scroll | No inline fontSize/colour (page.tsx) | Destructive via confirmDialog | Mutations toast | Tab reaches RowActions | Escape closes Dialogs | Open issues |
|---|---|---|---|---|---|---|---|---|---|
| `/` | L+ | yes | yes | yes | yes | yes | yes | yes | - |
| `/admin/access` | redirect | yes | yes | yes | yes | yes | yes | yes | - |
| `/agreements` | redirect | yes | yes | yes | yes | yes | yes | yes | - |
| `/archive` | L | yes | yes | 0 fontSize / 2 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/assets` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/assets/3` | R | yes | yes | 2 fontSize / 2 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/assets/3/label` | P | yes | yes | yes | yes | yes | yes | yes | - |
| `/assets/3/signoff` | P | yes | yes | 11 fontSize / 2 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/catalog/19` | R | yes | yes | 2 fontSize / 0 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/checkout` | redirect | yes | yes | yes | yes | yes | yes | yes | - |
| `/dev/ui` | D | yes | yes | yes | yes | yes | yes | yes | - |
| `/discussions` | U | yes | yes | 4 fontSize / 0 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/documents` | U | yes | yes | 1 fontSize / 3 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/drop/devdroptoken12345678` | X | yes | yes | yes | yes | yes | yes | yes | - |
| `/eod` | F | yes | yes | yes | yes | yes | yes | yes | - |
| `/equipment` | X | yes | yes | 1 fontSize / 0 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/equipment/no-such-slug` | X (404) | yes | yes | 3 fontSize / 1 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/gallery` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/import` | U | yes | yes | yes | yes | yes | yes | yes | - |
| `/inbox` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/instruments/1` | R | yes | yes | 0 fontSize / 2 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/instruments/1/binder` | P | yes | yes | 18 fontSize / 0 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/instruments/1/label` | P | yes | yes | yes | yes | yes | yes | yes | - |
| `/instruments/1/signoff` | P | yes | yes | 12 fontSize / 2 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/listing/nosuchtoken12345` | X (404) | yes | yes | 1 fontSize / 0 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/login` | X | yes | yes | yes | yes | yes | yes | yes | - |
| `/lookup?sn=US2405111` | redirect | yes | yes | yes | yes | yes | yes | yes | - |
| `/maintenance` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/messages` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/messages/1` | R | yes | yes | yes | yes | yes | yes | yes | - |
| `/metrics` | U | yes | yes | 0 fontSize / 3 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/parity` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/pdf` | U | yes | yes | yes | yes | yes | yes | yes | - |
| `/purchasing` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/purchasing/1` | R | yes | yes | yes | yes | yes | yes | yes | - |
| `/records/1` | R | yes | yes | 1 fontSize / 1 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/remote` | L | yes | yes | 0 fontSize / 2 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/remote/1` | R (404) | yes | yes | 1 fontSize / 1 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/remote/enroll/1` | X* | yes | yes | 5 fontSize / 2 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/search?q=LZ` | L | yes | yes | 0 fontSize / 2 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/settings` | F | yes | yes | yes | yes | yes | yes | yes | - |
| `/settings/activity` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/settings/admin` | F | yes | yes | 1 fontSize / 0 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/settings/agreements` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/settings/catalog` | A | yes | yes | yes | yes | yes | yes | yes | - |
| `/settings/organizations` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/settings/organizations/1` | R | yes | yes | yes | yes | yes | yes | yes | - |
| `/settings/parts` | A | yes | yes | yes | yes | yes | yes | yes | - |
| `/settings/procedures` | A | yes | yes | yes | yes | yes | yes | yes | - |
| `/settings/tenants` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/share/nosuchtoken12345` | X | yes | yes | yes | yes | yes | yes | yes | - |
| `/stock` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/stock/1` | R | yes | yes | 0 fontSize / 4 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/welcome` | F | yes | yes | yes | yes | yes | yes | yes | - |
| `/whats-new` | U | yes | yes | 2 fontSize / 0 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |
| `/work` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/work/2` | R | yes | yes | 1 fontSize / 3 hex | yes | yes | yes | yes | off-scale or runtime-only residue (see notes) |

## Keyboard spot-checks

Recorded live with Playwright at 1280 (see also `tests/dialog.test.tsx`, which
unit-tests the focus trap, Tab wrap, Escape close, body-scroll lock and
focus-return of the shared Dialog every dialog in the app renders through):

| Check | Result |
|---|---|
| Upload dialog on /documents opens; Escape closes it | pass (opened, Escape closed) |
| confirmReason dialog (hours remove) traps Tab; Escape closes | pass (Tab trapped, Escape closed) |
| RowActions kebabs on /settings/catalog (5) all reachable by Tab alone | pass |

## Fixed since the first pass

1. **Inline `fontSize` residue**: converted repo-wide (~930 sites across
   112 files) to the `.t-*` scale; redundant values equal to a carrying
   class's own size were deleted. The counts left in the table are the
   deliberate stays described above.
2. **Silent mutations**: all 21 flagged components now toast; deliberate
   silences (navigation-as-feedback, inline success notes, optimistic
   selects) are the only exceptions.
3. **Generic confirm copy**: the 22 `confirmReasonText` sites each got
   their own { title, body, action } with a verb naming the act, and the
   generic helper was deleted.
4. **`window.prompt` / `window.alert`**: zero remain repo-wide. The five
   input prompts (plus a bare `prompt()` in the stock recount and the
   block-reason prompts in `lib/reason.ts`, now deleted) went through the
   new `inputDialog`, which shares the ConfirmDialog host, focus trap and
   Escape behavior.
5. **Em dashes and emoji in rendered text**: 55 em dashes became hyphens
   and the last emoji (link/photo/document/kit markers) became the same
   box-glyph vocabulary the attachment kinds use.

## Open issues (couldn't fix in this pass, listed honestly)

1. **PGlite (dev:local) occasionally aborts under load.** The wasm database
   can crash during long capture sessions, corrupting its data dir (delete
   `node_modules/.cache/ridgeline-pglite` to recover). Dev-harness-only;
   production uses Neon.
2. **Not capturable in dev:local**: CloudBrowser/CloudLibraryCard (need a
   Microsoft app), WhatsNew overlay (needs an undismissed changelog), toast
   popups from NotificationCenter (need a fresh notification mid-session).
3. **Class-size conflicts left in place**: a handful of `.btn.link` /
   `.btn.sm` / `.card-title` elements carry an inline fontSize that
   differs from the class's own size. A bare class swap would change
   rendering, so they stay inline until each is reviewed for whether the
   deviation is intentional.

## Runtime-dependent inline styles that stay (by design)

- Skeleton bar geometry in the two `loading.tsx` files.
- PhotoThumb/PhotoFramer framing transforms, widths, aspect ratios.
- Stage pills colored from per-tenant stage definitions (DB-driven).
- PdfStudio DOC_COLORS source chips and thumbnail geometry; drag outlines.
- StoreFileList's drag-resized column widths (fed to the grid as tracks).
- Org theme swatches (`themeColor` from the org record) and header brand
  colors from app settings.
- The three entry grids' compact cell geometry (spreadsheet density).
- Metric/heat bars sized from data (`width: pct%`).
- iOS-zoom-guard 16px inputs on login/welcome/profile forms.
- The signoff signature script line and print letterhead sizes.
