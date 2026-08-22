# Ridgeline — full UI audit and rebuild plan

Repo: `SierraSpectraLLC/service` · 55 routes · 113 components · `globals.css` 509 lines · no CSS framework.

> **Corrected 2026-08-22** against the codebase. Counts below are measured, not estimated.
> Facts that constrain the plan:
> - **Stage colors are data, not code.** `stage_defs` stores `bg`/`fg` hex per tenant
>   (`src/db/schema.ts`), read by `src/lib/stageDefs.ts`; tenants can create custom stages
>   with arbitrary colors. `STAGE_COLOR` in `src/lib/stages.ts` is only the seed/fallback.
>   Converting stages to tones is a schema migration + lossy mapping — out of scope for the
>   tone pass.
> - **Some color records feed email HTML.** `src/lib/digest.ts` and `src/lib/eodEmail.ts`
>   render emails, where literal inline hex is required. They keep their hex; do not sweep them.
> - **`src/components/CatalogForm.tsx` contains a literal NUL byte** (the `"\x00any"` sentinel
>   key). grep classifies the file as binary and silently skips it — every grep in this
>   project must use `-a`, and the file is converted by hand. The sentinel must be preserved
>   byte-for-byte.
> - The companion doc `ridgeline-ui-audit-and-prompts.md` (Prompts 0–2, B2) is not in this
>   repo; this document is the source of truth.

## 1. Findings that apply to the whole app

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| 1 | **Styling is per-element, not per-system.** | 3,121 inline `style={{}}`; 70 unique hex colors in TSX vs 17 `:root` variables; `fontSize:` set inline 1,617 times (12/11/13 by feel) | Nothing can be changed globally. Every page drifts. This is the root cause of "it looks messy." |
| 2 | **Pills have no vocabulary.** | 197 `className="pill"`, each with inline bg/fg; ~45 distinct color pairs that are really ~7 meanings | Same status looks different on different pages; near-duplicate hexes (#E5F3E5 / #E8F3EC) |
| 3 | **Destructive actions use the browser's `window.confirm()`.** | 28 call sites across 20 components. CustodyPanel is the deliberate exception: an armed two-click button with a consequence list, because a browser's "suppress additional dialogs" checkbox makes native `confirm()` silently return false (see the comment in the file). A non-native `ConfirmDialog` satisfies that same rationale. | Unstyled OS dialog, can't show what's about to happen, can't be undone, looks broken on mobile |
| 4 | **Inline "dashed forms" are the only create/edit pattern.** | 31 `.dash-form` blocks across 21 components, open in place inside cards | Cards grow and push content; forms have no title, no validation area, no consistent footer; on mobile they open below the fold |
| 5 | **Twelve separate sheet/modal implementations.** | `.sheet` used 12× (ProceduresPanel alone has 4); each manages its own scrim, header, close, and footer | No shared Dialog — every sheet differs in header, padding, buttons |
| 6 | **Ten table implementations.** | `.reg`, `.grid-row`, `<table>` in CatalogGrid, AssetGrid, TenantConsole, PriceBookCard, ImportPanel, SpecTable, StockGrid; UsagePanel is a `.grid-row` div grid, not a `<table>` | Different header styles, striping, hover, and mobile behavior per table |
| 7 | **No feedback layer.** | No toast/snackbar; only `NotificationCenter`; most actions give no confirmation | User can't tell if Save worked |
| 8 | **Navigation has three levels and two systems.** | Top nav (3 fixed links + Inventory when the module is on + 2 staff-only dropdowns) · Settings 2-row tabs · catalog sub-tabs; no mobile nav (`.header-nav` wraps) | On a phone the header is 3 rows of wrapped pills |
| 9 | **Record pages are 15–20 stacked cards.** | `instruments/[id]` 748 lines, 20 panels; `assets/[id]` 16 panels; plus drag-to-reorder "arrange mode" | Good bones (`.section-bar`, `.band-label`, `.panel-flow`) but each panel invents its own title row, list, and actions |
| 10 | **Identifiers aren't typographically distinct.** | `--mono` exists; `.mono` used sparingly | Serials, part numbers, WO numbers, model names read as prose |

What's **good** and should be kept: the CSS comments (keep that voice), `.page-head`, `.empty`, `.reg` column variables, `.tabs`/`.subtabs`, `.seg`, `.menu` (native `<details>`), `.sheet` responsive rule (bottom sheet on phone, centered dialog on desktop), `.section-bar` + `.band-label` + `.panel-flow`, the `.file-row .row-act` hover-reveal, `prefers-reduced-motion` handling, print styles.

## 2. Archetypes

Every screen in the app is one of seven shapes. Fix the shape once; every screen inherits.

| Code | Archetype | Opening structure | Body | Mobile |
|---|---|---|---|---|
| **L** | List | breadcrumb? · page-head (title · sub · actions) · sticky toolbar (search · facets) | one `DataTable` (or `CardGrid` when image-led) | table → 2-col row cards; facets scroll |
| **R** | Record | breadcrumb · `RecordHero` (image · eyebrow · id+title · meta · stats · actions) · sticky jump bar | bands → `Panel`s in 2 balanced columns | 1 column; hero actions → kebab |
| **F** | Form / settings | Settings sidebar · page-head | `Panel`s of `Field`s; one sticky save footer per page | sidebar → drilldown |
| **D** | Dialog | `Dialog` (title · context · close) | sections; side step-nav if >3 | full-screen sheet, one step per screen |
| **C** | Confirm | `ConfirmDialog` (what will happen · consequence · cancel / do it) | — | same |
| **P** | Print / packet | print header with operator brand | `@media print` stack | — |
| **X** | Public / tokenized | minimal header with operator brand, no nav | one card, one job | same |
| **U** | Utility tool | page-head | bespoke (PDF studio, import, remote) but uses the same panels/buttons | stacked |

## 3. Route inventory

Lines = current page file length (component sizes not included). Issues are the page-specific ones beyond §1.

### Staff app

| Route | Type | Components | Lines | Issues / what changes |
|---|---|---|---|---|
| `/` (dashboard) | L+ | Dashboard, WhatsNew | 289 | Metrics tiles + `.grid-row` table + dash-form inline note. → metric tiles (number/label/1 pill), `DataTable`, follow-ups + PM due as two `Panel`s. |
| `/work` | L | — | 165 | Inline list markup. → `DataTable` with facets Open/Mine/Blocked/Sign-off/Closed. |
| `/work/[id]` | R | 8 panels + WorkOrderControls (2 dash-forms) | 376 | Controls open inline. → `RecordHero` with stage bar; stage change, block/unblock → `Dialog`. |
| `/assets` | L | RegistryFilter, NewAssetForm (dash-form), GridToggle, RegistryList | 105 | `.reg` is good; grouped by org. Keep; add row actions; new-asset → `Dialog`. |
| `/assets/[id]` | R | 16 panels, PanelLayout | 534 | Every panel its own title style. → `Panel` everywhere; AssetControls' 3 confirms → `ConfirmDialog`. |
| `/assets/[id]/label` | P | LabelCard | 38 | Fine; use `PrintHeader`. |
| `/assets/[id]/signoff` | P | SignoffPanel, SignatureBlock | 201 | Fine; `PrintHeader`, signature block styling shared. |
| `/instruments/[id]` | R | 20 panels, PanelLayout | 748 | Biggest page. Same as assets; CustodyPanel's armed two-click handoff (no native confirm — see §1.3) → `ConfirmDialog`, QueuePanel dash-form, ClientRequest sheet → shared Dialog. |
| `/instruments/[id]/binder` | P | — | 246 | Validation binder; `PrintHeader`, `DataTable` for the procedure index. |
| `/instruments/[id]/label`, `/signoff` | P | as assets | | same |
| `/catalog/[id]` (model page) | R | ModelHeaderCard, ModelSpecsCard, PublishModelCard, ProceduresPanel, ReferencePanel | 276 | 7 stacked cards → hero + tabs (see model-page mockup). |
| `/maintenance` | L | — | 141 | Inline list. → `DataTable` with due-dots, facets Overdue/≤14d/≤30d/All, grouped by system. |
| `/purchasing` | L | NeededPartsCard | 150 | → `DataTable` of POs + "Needed parts" `Panel` above; PoPanel's 3 dash-forms + confirm → `Dialog`/`ConfirmDialog`. |
| `/purchasing/[id]` | R | PoPanel, PoJobCard | 106 | → `RecordHero` (PO number mono, vendor, status, total) + lines table + receive `Dialog`. |
| `/stock` | L | NewStockroomForm (sheet) | 107 | → `CardGrid` of stockrooms (name, location, item count, low-stock pill). |
| `/stock/[id]` | R | StockShelf (dash-form), StockGrid, StockroomAdmin (2 dash-forms), StockAddCard, ReorderCard | 240 | → hero + `DataTable` (part mono, qty, min, location, RowActions) + adjust/move `Dialog`. |
| `/eod` | F/L | EodPanel (confirm), EodDateNav | 114 | Date nav as segmented control in toolbar; sections as `Panel`s; send → `ConfirmDialog` with preview. |
| `/metrics` | L+ | — | 268 | → metric tiles + 2-col `Panel`s with simple bars; consistent number typography. |
| `/parity` | U | ParityList | 29 | → `DataTable` of diffs with accept/dismiss RowActions. |
| `/archive` | L | — | 61 | → `DataTable`, same as assets with "Archived" facet on. |
| `/messages`, `/messages/[id]` | L/R | NewMessageButton (sheet), ThreadPanel (confirm) | 121/64 | → split pane on desktop (threads · thread); composer fixed at bottom; new message `Dialog`. |
| `/inbox` | L | InboxPanel, SignInSettings | 51 | → `DataTable` of notifications grouped by day; settings → `Panel`. |
| `/discussions` | L | DiscussionPanel | 148 | → thread list + composer, same component as messages. |
| `/search` | L | SearchBox, LookupPanels (dash-form) | 260 | → one search field, results grouped by type with `SectionHead`s; identifiers mono. |
| `/documents` | U | StoreFileList (sheet), StorePicker, FileLinksCard (confirm), LibraryUpload, StorageMeter, CloudLibraryCard | 258 | File browser. → `DataTable` with resizable columns kept; store picker as facets; upload `Dialog`; delete → `ConfirmDialog` with file count. |
| `/gallery` | L | GalleryGrid | 98 | → `CardGrid` of photos with system/date eyebrow; lightbox `Dialog`. |
| `/pdf` | U | PdfStudio, PdfCombiner (dash-form) | 121 | Keep `.pdf-studio` grid; page cards use `Panel` chrome; actions via `RowActions`. |
| `/import` | U | ImportPanel (`<table>`) | 21 | → stepper (Upload · Map columns · Preview · Import) using `Dialog` step-nav inline; preview as `DataTable`. |
| `/remote`, `/remote/[id]`, `/remote/enroll/[orgId]` | U | RemoteDevicesPanel, RemoteInviteLink | 159/106/171 | Device list → `DataTable` (name, org, last seen dot, RowActions); session page keeps `.fill-window`; enroll → `X`-style single card. |
| `/equipment`, `/equipment/[slug]` | X | SpecTable | 87/248 | Public catalog. → public header, `CardGrid`, model page with spec `DataTable`. |
| `/lookup` | X | — | 11 | Serial lookup; single card, mono input. |
| `/records/[id]` | R | ActivityFeed | 200 | Frozen engagement record (dossier snapshot). → `RecordHero` + `Panel`s, read-only. |
| `/share/[token]` | X | — | 69 | Tokenized share page. → `PublicShell`. |
| `/drop/[token]` | X | — | 62 | Tokenized file drop. → `PublicShell`. |
| `/listing/[token]` | X | — | 134 | Public sale listing. → `PublicShell` (see archetypes prototype). |
| `/checkout` | U | — | 7 | Redirect/stub. |
| `/welcome`, `/whats-new` | F/X | WelcomeForm | 44/44 | Single `Panel`. |
| `/login` | X | LoginForm | 116 | Single card, operator brand, magic-link field; `.container.form` kept. |

### Settings (all **F**; get the sidebar)

| Route | Components | Lines | Issues |
|---|---|---|---|
| `/settings` | ConfigurationForm (2 confirms) | 61 | 431-line form, 63 inline styles. → `Panel`s of `Field`s; appearance preview; sticky save. |
| `/settings/catalog` | CatalogForm (3 confirms), MakersCard (confirm), PendingModelsCard, CatalogPhotosCard (confirm), ReferencePanel, CatalogGasCard, CatalogPackageCard | 135 | → Option C card grid + 4 summary tiles; makers/types/gases/packages edit in `Dialog`. |
| `/settings/procedures` | ProceduresPanel (4 sheets, confirm) | 69 | → tree + accordions; dialog rebuilt (B3). |
| `/settings/parts` | PartCatalogPanel (sheet), PriceBookCard (dash-form, confirm) | 162 | → Option A ledger. |
| `/settings/organizations`, `/[id]` | PersonnelForm (confirm), OrgSettingsForm (3 confirms), SitesCard (sheet), AgreementsPanel (sheet) | 50/169 | → org list `DataTable`; org record = `RecordHero` + tabs (Profile · Sites · People · Agreements · Access). |
| `/settings/admin` | SharePanel, AccessRequestsPanel (confirm), HouseMembersPanel (dash-form) | 144 | → `Panel`s; requests as `DataTable` with approve/deny RowActions. |
| `/settings/activity` | UsagePanel (`.grid-row` div grid) | 108 | → `DataTable`. |
| `/settings/tenants` | TenantConsole (`<table>`) | 77 | → `DataTable`. |
| `/agreements` | AgreementsPanel (sheet, 671 lines) | 93 | → `DataTable` of agreements (client, type, term, status dot) + `Dialog` for new/renew. |
| `/admin/access` | — | 6 | redirect |

### Dialog inventory (12 sheets + 31 inline forms + 28 confirms → 3 components)

| Today | Count | Becomes |
|---|---|---|
| `.sheet` modals (Photos, Sites, NewMessage, StoreFileList, PartCatalog, Procedures ×4, Agreements, NewStockroom, ClientRequest) | 12 | `Dialog` |
| `.dash-form` inline create/edit (Tasks ×3, Assets ×3, PO ×3, WorkOrders ×2, StockroomAdmin ×2, Attachments ×2, WorkOrderControls ×2, + 14 singles) | 31 | `Dialog` for create; `InlineEdit` (single field, Enter/Esc) for one-line edits |
| `window.confirm()` (plus CustodyPanel's armed two-click handoff) | 28 | `ConfirmDialog` |

## 4. The component kit (what every archetype is built from)

All in `src/components/ui/`, no inline styles, every class in `globals.css` with a why-comment.

| Component | Props (essential) | Notes |
|---|---|---|
| `Pill` | `tone` neutral/faint/info/good/warn/accent/bad, `mono?` | Replaces 197 inline pills |
| `Dot` | `tone` | status-as-dot; pair with `Legend` |
| `Legend` | `items: {tone,label}[]` | one per list page |
| `Id` | `children`, `dim?` | monospace identifier |
| `PageHead` | `title, sub?, crumb?, actions?` | wraps existing `.page-head` |
| `Toolbar` | `search?, facets?, actions?` | sticky under header |
| `FacetStrip` | `facets[], onToggle` | counted pills; scrolls on mobile |
| `SectionHead` | `label, count?, action?, sticky?` | |
| `DataTable` | `cols[], rows[], groupBy?, rowActions?, mobile: 'cards'` | one table; replaces 10 |
| `CardGrid` + `EntityCard` | `image, eyebrow, title, meta, pills[], actions` | equipment, stockrooms, gallery |
| `RowActions` | `items[{label,onClick,tone?}]` | hover-reveal + kebab; sheet on mobile |
| `Panel` | `title, count?, actions?, empty?` | the one card chrome for record pages |
| `RecordHero` | `image?, eyebrow, id, title, meta, stats[], actions[]` | |
| `JumpBar` | `sections[]` | sticky; existing `.section-bar` |
| `Tabs` | `items[{label,count?,warn?}]` | underline tabs (existing `.tabs`) |
| `Field` | `label, hint?, required?, error?` | wraps label+control+hint |
| `Seg` | options | existing `.seg` |
| `Dialog` | `title, context?, steps?, footer, size` | bottom sheet <700px, centered ≥700px; full-screen with step-per-screen when `steps` given |
| `ConfirmDialog` | `title, body, action, tone` | `confirm()` replacement; returns a promise so call sites change one line |
| `InlineEdit` | `value, onSave` | one-line edits |
| `Toast` | `message, tone, undo?` | mounted once in `layout.tsx` |
| `EmptyState` | `title, body, action?` | existing `.empty` |
| `PrintHeader` | operator brand | packets/labels/binder |
| `PublicShell` | operator brand, no nav | share/listing/equipment/lookup/login |
| `MobileNav` | bottom tab bar + drawer | Today · Work · Assets · Inbox · Library |
| `SettingsNav` | sidebar (+ catalog tree) | drilldown on mobile |

## 5. Instruction set for Claude Code

Run in order. Each block is one session; commit per block. Prompts 0–2 from `ridgeline-ui-audit-and-prompts.md` are the foundation; they are restated here in condensed form so this document is self-contained.

### Phase 1 — Foundation (no visible change yet)

```
FOUNDATION. Read src/app/globals.css fully and keep its commented style. No Tailwind, no CSS modules, no UI library.

1. Add tone variables (neutral, faint, info, good, warn, accent, bad — bg/fg pairs from the existing inline pill colors), .pill.{tone}, .dot.{tone}, a type scale (.t-meta 11 / .t-small 12 / .t-body 13 / .t-lead 14 / .t-title 16 / .t-page 22, .t-mono-id), spacing vars --sp-1..5 and .stack-N / .row-N utilities.
2. Create src/components/ui/ with: Pill, Dot, Legend, Id, PageHead, Toolbar, FacetStrip, SectionHead, RowActions, Panel, EmptyState, Field, Seg, Tabs. Each wraps an existing globals.css class where one exists (.page-head, .empty, .seg, .tabs, .subtabs). None may contain inline styles.
3. Convert the STATIC {bg,fg} color records exported from src/lib to a Tone name: WO_COLOR (workOrders), PROVENANCE_STYLE, STANDING_COLOR (agreements AND gxp), DOC_STATE_COLOR (gxp), ROLE_COLOR (procedureRole), and po.ts. Do NOT touch stage colors (DB-backed per tenant), digest.ts, or eodEmail.ts (email HTML keeps literal hex).
4. Typecheck + tests. Show me the tone mapping table for all ~45 existing pill color pairs before applying.
```

```
SWEEP. (Re-sequenced: runs AFTER the Phase 2–4 conversions, on files that survive them mostly intact, with a residue pass as the second-to-last block. Every grep uses -a; CatalogForm.tsx is swept by hand, preserving its "\x00any" sentinel byte-for-byte. Per-file before/after screenshots at 375 and 1280.) Remove the ~3,100 inline style objects, biggest files first (ProceduresPanel, TasksPanel, StoreFileList, MaintenancePanel, PartCatalogPanel, AgreementsPanel, OrgSettingsForm, PartsPanel, ConfigurationForm, AttachmentsPanel, Dashboard, PdfStudio, then everything else). Layout-only objects → .row-N/.stack-N; fontSize → .t-*; pill colors → <Pill tone>; hex → nearest variable (ask me if none fits). Runtime-dependent styles (data-driven widths, org brand colors) may stay. JSX structure and behavior unchanged in this pass. One commit per file with the removed count. Report before/after totals.
```

### Phase 2 — The three things every page shares

```
DIALOG, CONFIRM, TOAST.
1. Dialog (src/components/ui/Dialog.tsx): props title, context (muted line under title), size sm|md|lg, steps? [{key,label}], footer (left status slot + buttons). Uses the existing .sheet/.scrim rules: bottom sheet under 700px, centered dialog above. When `steps` is given: desktop renders a 170px left step nav with done/warn markers and a scrolling body; mobile renders one step per screen with a thin progress bar and Back / Next:{name} in a fixed footer. Escape closes, focus is trapped, scroll-lock on body, returns focus on close. Portal to body.
2. ConfirmDialog: `await confirm({title, body, action: "Decommission", tone: "bad"})` → boolean. Mount one provider in layout.tsx. Body may include a list of consequences. Replace all 36 window.confirm( call sites; keep the existing message text as the body, and write a one-verb action label for each ("Remove", "Decommission", "Delete 3 files").
3. Toast: `toast({message, tone, undo?: () => void})`. Mount once in layout.tsx, bottom-center on mobile, bottom-right on desktop, 5 s, stacking. Add a success toast to every server action call site that currently gives no feedback (grep startTransition(async in components) — message is the verb past-tense + object ("Saved procedure", "Part added to PO-118").
4. Convert all 12 .sheet usages to <Dialog>. Convert the 37 .dash-form blocks: create/multi-field forms → <Dialog>; single-field edits (task title, note text, quantity) → <InlineEdit value onSave> which shows the value with a pencil on hover and swaps to an input on click, Enter saves, Esc cancels.
Screenshot each converted dialog at 375 and 1280.
```

```
DATATABLE + CARDGRID. Build src/components/ui/DataTable.tsx on the existing .reg pattern: cols [{key,label,width,align,hideMobile}], rows, groupBy? (renders .reg-group heads with counts), striping assigned in the component, sticky head, hover, rowActions → RowActions, mobile: each row becomes a 2-column card (primary cell + secondary cells as a muted line, kebab right). Replace every table: Dashboard .grid-row, AssetRegistryList, AssetGrid, CatalogGrid, TenantConsole, PriceBookCard, ImportPanel preview, UsagePanel, SpecTable, StockGrid, and the inline lists on /work, /maintenance, /purchasing, /archive, /inbox, /parity, /remote, /agreements. Build CardGrid + EntityCard (image 52px with placeholder, eyebrow, title (mono option), meta, ≤1 pill row, kebab) for /settings/catalog, /stock, /gallery, /equipment.
```

### Phase 3 — Navigation

```
NAVIGATION. Keep the navy header and spectrum bar.
1. Desktop: identity left; Dashboard · Work orders · Assets · Inventory · Operations ▾ · Library ▾ as now; utility cluster right. Active = filled pill (existing rule).
2. Mobile (<640): header shows hamburger · brand · utility. Add MobileNav: a bottom tab bar (Today / Work / Assets / Inbox / Library) with the active tab in navy, and a slide-in drawer from the hamburger listing every nav group with its items. The header must never wrap to two rows.
3. Settings: replace the two-row tab stack with SettingsNav, a 240px left sidebar: Workspace / Catalog (Equipment · Procedures & maintenance · Parts book · Price book) / Organizations / Access, role-filtered as SettingsTabs is now; under Procedures, the instrument › module › model tree. Mobile: the sidebar becomes the first screen (a grouped list), each entry a route. .container.settings becomes the two-pane grid.
4. Every non-root page gets a Breadcrumb above the page head; record pages show "Section › Group › Id".
```

### Phase 4 — Archetype by archetype

```
LIST PAGES (L). Apply PageHead → Toolbar(search, FacetStrip) → DataTable|CardGrid → Legend to: /, /work, /assets, /archive, /maintenance, /purchasing, /stock, /inbox, /messages (thread list), /discussions, /search, /gallery, /agreements, /parity, /remote, /settings/organizations, /settings/parts, /settings/procedures (accordion variant), /settings/catalog (grid), /settings/activity, /settings/tenants, /settings/admin (requests). Rules: one status dot + ≤1 pill per row; identifiers via <Id>; model applicability as muted text; row actions via RowActions; page counts in the sub line; facet counts real. Specific layouts for the three catalog pages are in ridgeline-settings-redesign-options.html (A/B/C) and ridgeline-site-prototype.html.
```

```
RECORD PAGES (R). Apply Breadcrumb → RecordHero → JumpBar → bands → Panel (in the existing .panel-flow balanced columns) to: /instruments/[id], /assets/[id], /work/[id], /purchasing/[id], /stock/[id], /catalog/[id], /settings/organizations/[id], /records/[id], /messages/[id]. Every panel uses <Panel title count actions empty>; every list inside a panel is the same row shape (dot + primary, muted meta, RowActions). Hero stats line carries the counts that matter (open WOs, PM due, required-open, blocked days) with warn tone where attention is needed. Keep arrange mode but move its toggle into the hero kebab. For /catalog/[id] and /settings/organizations/[id] use Tabs under the hero instead of bands (few sections, each self-contained).
```

```
FORMS AND SETTINGS (F). ConfigurationForm, OrgSettingsForm, PersonnelForm, WelcomeForm, CatalogForm, EodPanel: group into <Panel>s of <Field>s (label · control · hint · error), two columns for short fields, one for long; a single sticky footer per page with status text left ("Unsaved changes" / "Saved 2 s ago") and Save right; validation on blur; no per-panel Save buttons. Appearance settings show a live preview of the header.
```

```
DIALOGS (D). Rebuild the following as <Dialog> with sections (side step-nav when >3): New work order, New asset, New PO / receive lines, Stock adjust/move, New agreement / renew, New message, Upload files, New model (CatalogForm), Procedure (Task + Test — spec in ridgeline-prompt-B3-procedure-dialog.md), Client request, Site, Photo edit, Stage change / Block (WorkOrderControls). Every dialog: title + context line, sections with .card-title-weight headings, footer with live status ("Can't save yet — {reason}") and a Save that names the object ("Create WO", "Add to PO-118").
```

```
PRINT / PUBLIC (P, X). PrintHeader (operator logo · name · document title · date · id) used by /assets/[id]/label, /assets/[id]/signoff, /instruments/[id]/label, /instruments/[id]/signoff, /instruments/[id]/binder; SignatureBlock shared. PublicShell (operator brand top-left, no nav, footer "Powered by Ridgeline") used by /login, /share/[token], /drop/[token], /listing/[token], /equipment, /equipment/[slug], /lookup, /remote/enroll/[orgId]. Dead-link states use EmptyState with one sentence and one action.
```

```
UTILITIES (U). /documents: keep the resizable-column file browser but render it through DataTable's chrome; store picker → FacetStrip; StorageMeter → a metric tile; upload → Dialog. /pdf: keep .pdf-studio; source list and page cards use Panel/EntityCard chrome; per-card controls → RowActions. /import: a 4-step stepper (Upload · Map columns · Preview · Import) using Dialog's step-nav inline on the page; preview via DataTable; errors as a warn Panel listing row numbers. /remote: device DataTable; session page unchanged except PageHead. /metrics: metric tiles + Panels; bars are simple divs with tone backgrounds, numbers in .t-page.
```

### Phase 5 — Verification

```
VERIFY. For every route in the inventory: render at 375, 768, 1280; confirm (a) header never wraps, (b) nothing scrolls horizontally except FacetStrip on mobile, (c) no inline fontSize/colors remain (grep), (d) every destructive action goes through ConfirmDialog, (e) every mutating action toasts, (f) keyboard: Tab reaches every RowAction, Escape closes every Dialog, focus returns. Produce a table: route · archetype · screenshot links · open issues.
```

## 6. Decisions I made in the mockups (override if you disagree)

- **Settings gets a sidebar**, not a third tab row.
- **Mobile gets a bottom tab bar** (Today · Work · Assets · Inbox · Library) plus a drawer for everything else.
- **Identifiers are always monospace** (IBM Plex Mono if you add fonts via `next/font`; the system mono otherwise).
- **Status = one dot + at most one pill.** Two pills saying the same thing is the most common visual noise in the current app.
- **Create = Dialog; edit-one-field = InlineEdit; destructive = ConfirmDialog.** No more inline dashed forms.
- **Model page and org record use tabs; everything else uses bands + jump bar.**
