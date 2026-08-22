# VERIFY - full-route audit of the rebuilt UI

Run against `npm run dev:local` (PGlite fixture), captured with Playwright at
375 / 768 / 1280. Screenshots for every route live in
`docs/design/screens/verify/<slug>-<width>.jpg`.

How each column is measured:

- **Header never wraps** - the `.app-header` row height, measured live at all
  three widths on six representative pages (one bar row plus the spectrum
  strip; the mobile header is its own single-row layout). Routes share one
  layout, so the measurement generalizes.
- **No horizontal scroll** - `scrollWidth > innerWidth` measured on every
  route at every width.
- **No inline fontSize / colour** - `grep -a` counts on the route's own
  `page.tsx` (component-level residue is listed under Open issues).
- **Destructive actions via confirmDialog** - `window.confirm` count is 0
  repo-wide; every reason-collecting destructive action goes through
  `confirmReason`/`confirmReasonText` (the 42 remaining `window.prompt`
  sites were converted in this pass). Per-route value is "yes" unless noted.
- **Mutations toast** - converted pages toast their `startTransition` sites;
  the components still silent are listed under Open issues.
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
| `/` | L+ | yes | yes | 4 fontSize / 0 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/admin/access` | redirect | yes | yes | yes | yes | yes | yes | yes | - |
| `/agreements` | redirect | yes | yes | yes | yes | yes | yes | yes | - |
| `/archive` | L | yes | yes | 3 fontSize / 2 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/assets` | L | yes | yes | yes | yes | partial: NewAssetForm | yes | yes | silent panels (issue 2) |
| `/assets/3` | R | yes | yes | 16 fontSize / 2 hex | yes | partial: AttachmentsPanel, GasPanel, MaintenancePanel, PartsPanel, PhotosPanel, SharePanel | yes | yes | inline residue (issue 1); silent panels (issue 2) |
| `/assets/3/label` | P | yes | yes | yes | yes | yes | yes | yes | - |
| `/assets/3/signoff` | P | yes | yes | 13 fontSize / 2 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/catalog/19` | R | yes | yes | 16 fontSize / 0 hex | yes | partial: ModelSpecsCard, PublishModelCard | yes | yes | inline residue (issue 1); silent panels (issue 2) |
| `/checkout` | redirect | yes | yes | yes | yes | yes | yes | yes | - |
| `/dev/ui` | D | yes | yes | yes | yes | yes | yes | yes | - |
| `/discussions` | U | yes | yes | 9 fontSize / 0 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/documents` | U | yes | yes | 7 fontSize / 3 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/drop/devdroptoken12345678` | X | yes | yes | yes | yes | yes | yes | yes | - |
| `/eod` | F | yes | yes | yes | yes | yes | yes | yes | - |
| `/equipment` | X | yes | yes | 4 fontSize / 0 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/equipment/no-such-slug` | X (404) | yes | yes | 16 fontSize / 1 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/gallery` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/import` | U | yes | yes | yes | yes | yes | yes | yes | - |
| `/inbox` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/instruments/1` | R | yes | yes | 1 fontSize / 2 hex | yes | partial: AssetsPanel, AttachmentsPanel, ClientRequest, MaintenancePanel, PartsPanel, PhotosPanel, QueuePanel, ValidationPanel | yes | yes | inline residue (issue 1); silent panels (issue 2) |
| `/instruments/1/binder` | P | yes | yes | 19 fontSize / 0 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/instruments/1/label` | P | yes | yes | yes | yes | yes | yes | yes | - |
| `/instruments/1/signoff` | P | yes | yes | 14 fontSize / 2 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/listing/nosuchtoken12345` | X (404) | yes | yes | 9 fontSize / 0 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/login` | X | yes | yes | 3 fontSize / 0 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/lookup?sn=US2405111` | redirect | yes | yes | yes | yes | yes | yes | yes | - |
| `/maintenance` | L | yes | yes | 3 fontSize / 0 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/messages` | L | yes | yes | 3 fontSize / 0 hex | yes | partial: NewMessageButton | yes | yes | inline residue (issue 1); silent panels (issue 2) |
| `/messages/1` | R | yes | yes | yes | yes | yes | yes | yes | - |
| `/metrics` | U | yes | yes | 17 fontSize / 3 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/parity` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/pdf` | U | yes | yes | yes | yes | yes | yes | yes | - |
| `/purchasing` | L | yes | yes | 2 fontSize / 0 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/purchasing/1` | R | yes | yes | yes | yes | yes | yes | yes | - |
| `/records/1` | R | yes | yes | 25 fontSize / 1 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/remote` | L | yes | yes | 4 fontSize / 2 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/remote/1` | R (404) | yes | yes | 5 fontSize / 1 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/remote/enroll/1` | X* | yes | yes | 12 fontSize / 2 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/search?q=LZ` | L | yes | yes | 6 fontSize / 2 hex | yes | partial: LookupPanels | yes | yes | inline residue (issue 1); silent panels (issue 2) |
| `/settings` | F | yes | yes | yes | yes | yes | yes | yes | - |
| `/settings/activity` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/settings/admin` | F | yes | yes | 6 fontSize / 0 hex | yes | partial: SharePanel | yes | yes | inline residue (issue 1); silent panels (issue 2) |
| `/settings/agreements` | L | yes | yes | 1 fontSize / 0 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/settings/catalog` | A | yes | yes | yes | yes | partial: CatalogGasCard, CatalogPackageCard | yes | yes | silent panels (issue 2) |
| `/settings/organizations` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/settings/organizations/1` | R | yes | yes | 1 fontSize / 0 hex | yes | partial: SitesCard | yes | yes | inline residue (issue 1); silent panels (issue 2) |
| `/settings/parts` | A | yes | yes | yes | yes | yes | yes | yes | - |
| `/settings/procedures` | A | yes | yes | yes | yes | yes | yes | yes | - |
| `/settings/tenants` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/share/nosuchtoken12345` | X | yes | yes | 3 fontSize / 0 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/stock` | L | yes | yes | 2 fontSize / 0 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/stock/1` | R | yes | yes | 11 fontSize / 4 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/welcome` | F | yes | yes | yes | yes | yes | yes | yes | - |
| `/whats-new` | U | yes | yes | 5 fontSize / 0 hex | yes | yes | yes | yes | inline residue (issue 1) |
| `/work` | L | yes | yes | yes | yes | yes | yes | yes | - |
| `/work/2` | R | yes | yes | 9 fontSize / 3 hex | yes | partial: AttachmentsPanel, PartsPanel, PhotosPanel | yes | yes | inline residue (issue 1); silent panels (issue 2) |

## Keyboard spot-checks

Recorded live with Playwright at 1280 (see also `tests/dialog.test.tsx`, which
unit-tests the focus trap, Tab wrap, Escape close, body-scroll lock and
focus-return of the shared Dialog every dialog in the app renders through):

| Check | Result |
|---|---|
| Upload dialog on /documents opens; Escape closes it | pass (opened, Escape closed) |
| confirmReason dialog (hours remove) traps Tab; Escape closes | pass (Tab trapped, Escape closed) |
| RowActions kebabs on /settings/catalog (5) all reachable by Tab alone | pass |

## Open issues (couldn't fix in this pass, listed honestly)

1. **Inline `fontSize` residue inside components.** The sweep covered every
   file untouched since Phase 1, and the tone hexes were tokenized repo-wide,
   but panels rewritten during earlier phases (TasksPanel, ProceduresPanel,
   MaintenancePanel, AgreementsPanel, PartCatalogPanel, and ~100 more files)
   still size text with inline `fontSize` using the same px values the scale
   defines. Visually consistent, mechanically unconverted. A follow-up pass
   converting `fontSize: 11/12/13` to `.t-meta/.t-small/.t-body` per file is
   pure find-and-replace plus captures.
2. **Mutations that still do not toast.** ~30 components with
   `startTransition` mutations have no toast; several are deliberate (LoginForm
   and WelcomeForm navigate away, ViewAsBar becomes a banner, WhatsNew
   dismisses itself, DailyUpdatePanel/EodPanel autosave with inline status).
   The genuinely silent ones worth a pass: AssetsPanel, AttachmentsPanel,
   GasPanel, MaintenancePanel, PartsPanel, PhotosPanel (single ops),
   QueuePanel, SharePanel, SignoffPanel, SitesCard, StagePanel, StockShelf,
   ValidationPanel, LookupPanels, ModelSpecsCard, PublishModelCard,
   ClientRequest, NewAssetForm, NewMessageButton, CatalogGasCard,
   CatalogPackageCard.
3. **confirmReasonText titles are the old prompt sentences.** The 42 converted
   destructive confirms open the proper dialog with a reason field, but the
   button says the generic "Confirm" rather than naming the act, and the whole
   old message rides in the title. Renaming each to `{ title, body, action }`
   is per-site copywriting.
4. **`window.prompt` still used for non-destructive input** in five places
   (StoreFileList share label + folder rename, SystemPanel, MakersCard,
   ConfigurationForm, CatalogForm "Set maker for all shown") - inputs, not
   confirms, so they were out of scope for confirmDialog; a small InputDialog
   would retire them.
5. **PGlite (dev:local) occasionally aborts under load.** The wasm database
   can crash during long capture sessions, corrupting its data dir (delete
   `node_modules/.cache/ridgeline-pglite` to recover). Dev-harness-only;
   production uses Neon.
6. **Not capturable in dev:local**: CloudBrowser/CloudLibraryCard (need a
   Microsoft app), WhatsNew overlay (needs an undismissed changelog), toast
   popups from NotificationCenter (need a fresh notification mid-session).

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
