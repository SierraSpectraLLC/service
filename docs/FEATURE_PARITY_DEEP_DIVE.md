# Feature Parity Deep Dive — Sierra Spectra

*Companion to `COMPETITIVE_PARITY_AUDIT.md`. This document is the exhaustive,
domain-by-domain inventory: every capability a product in our five overlapping markets
would be expected to have, whether **we have it, partly have it, or lack it**, what we
actually ship today, and what full parity would require. Feature claims about our app
were verified against the code on this branch (55 tables in `src/db/schema.ts`,
~170 server actions, ~35k lines). Competitor claims come from the sources in the
companion doc.*

**Status legend:** ✅ Have · 🟡 Partial · ❌ Missing · ➕ Ahead of the field · ⛔ De-scoped (deliberately not building)

---

## Scorecard at a glance

| Domain | ✅ | 🟡 | ❌ | Verdict |
|---|---|---|---|---|
| 1. Work orders & tasks | 9 | 3 | 3 | Strong core, no dispatch/custom fields |
| 2. Preventive maintenance | 6 | 1 | 2 | Solid; missing meter-based + calendar |
| 3. Assets & equipment | 12 | 3 | 3 | **Best-in-class for our niche** |
| 4. Parts & inventory | 8 | 1 | 3 | Strong; no auto-reorder/BOM |
| 5. Purchasing | 4 | 1 | 4 | Functional; no approvals/vendor mgmt |
| 6. Financials & billing | 1 | 0 | 9 | **Weakest domain — biggest opportunity** |
| 7. Client portal | 8 | 0 | 3 | ➕ Ahead of competitors |
| 8. Reporting & analytics | 5 | 2 | 4 | Real KPIs, no visualization |
| 9. Documents & media | 6 | 3 | 2 | Strong; service-report unwired |
| 10. Compliance & quality | 5 | 1 | 6 | Good bones; no cert/CAPA |
| 11. Remote support | 5 | 1 | 1 | ➕ Genuinely differentiated |
| 12. Communication | 5 | 2 | 2 | Solid; no real-time/chat |
| 13. Auth, security, tenancy | 6 | 2 | 3 | Strong tenancy; no SSO |
| 14. Integrations & extensibility | 6 | 0 | 5 | No API/webhooks/accounting/shipping |
| 15. Mobile & platform | 1 | 0 | 3 | Responsive web only |
| 16. Sales & marketplace | 5 | 0 | 0 | ➕ Unique, nobody else has it |
| 17. Data import/export | 3 | 1 | 1 | Good CSV; no API-driven sync |

**Headline:** we are at or above parity on the *operational spine* (assets, work,
parts, portal, remote, compliance bones, marketplace) and behind on the *business
layer* (billing/financials, visualization, integrations, mobile packaging). The gaps
cluster where they're cheapest to close relative to their value.

---

## 1. Work orders & task management

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| Create / assign / due dates | ✅ | Tasks with assignee, due date, state | — |
| Checklists | ✅ | `checklist_items` with per-item notes | — |
| Threaded notes & @mentions | ✅ | `task_notes`, `item_notes`, mention notifications | — |
| Recurring work (from PM) | ✅ | `pm-generate` cron turns due schedules into tasks | — |
| Priorities | ✅ | Per-system priority; overdue surfacing | — |
| Work request intake | ✅ | Report-an-issue & request-PM, even for read-only clients | — |
| Time tracking per job | ✅ | `time_entries` in minutes | — |
| Origin/type tagging | 🟡 | `origin`: ''/checkout/pm/issue/pm_request | User-defined work types/categories |
| Status workflow | 🟡 | System *stages* model progress, not per-task status | Configurable per-task status lanes |
| SOP / task templates | 🟡 | `task_templates`/`template_*` tables exist but **UI retired** | Re-expose SOP bundles (schema is already there) |
| Approval workflows | ❌ | Only sign-off gating; no "manager approves before start" | Approval step entity + routing |
| Custom fields | ❌ | No `custom_field` anywhere | Per-tenant custom field definitions |
| Dispatch board / kanban | ❌ | List views only | Drag-to-assign board, technician swimlanes |

**Competitor note:** MaintainX/UpKeep are built *around* the work order with mobile
execution and kanban. Our tasks live inside the asset/system record, which is right for
refurb (work is about the instrument, not a ticket queue) but means no standalone
dispatch view.

## 2. Preventive maintenance

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| Calendar-interval PM | ✅ | `pm_schedules.every_days`, floating next-due | — |
| Auto-generate work from PM | ✅ | Cron; **one open task per schedule** rule | — |
| PM on systems *and* assets | ✅ | Schedules attach to either | — |
| Parts tied to PM | ✅ | Named parts on a schedule | — |
| PM compliance reporting | ✅ | On-time/late/overdue %, in `/metrics` | — |
| Pause/resume | ✅ | Paused section in `/maintenance` | — |
| Meter / usage-based PM | ❌ | No run-hours/cycles/usage counters | Meter entity + reading capture + threshold trigger |
| Calendar grid / scheduling | ❌ | Chronological list grouped by month | Visual calendar, per-day capacity, tech assignment |
| Fixed (non-floating) cadence | 🟡 | Only floats from completion date | Option for fixed-date schedules |

**Competitor note:** meter-based PM is a headline feature of MaintainX Premium and
Limble. For lab instruments, run-hours or injection-count triggers are a natural fit and
would move us toward the calibration-platform buyer.

## 3. Assets & equipment management

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| Asset registry | ✅ | `assets` with kind/status/owner/condition | — |
| Composite hierarchy | ➕ | Systems built from attachable assets (pumps, detectors…) | — |
| Lifecycle events | ✅ | `asset_events`: installed/removed/moved/status | — |
| Custody & ownership chain | ➕ | `custody_events`, ownership handoff, frozen dossiers | — |
| Merged service history | ➕ | `lib/assetHistory` merges events + tasks + parts + time | — |
| As-found condition | ✅ | Captured at intake | — |
| Equipment catalog | ✅ | Categories, types, models, manufacturers, stock photos | — |
| QR labels | ✅ | Server-rendered SVG on label pages | — |
| Check-in / checkout | ✅ | Run-checkout applies intake procedures | — |
| Photos with cover/framing | ✅ | Non-destructive framing string | — |
| Documentation per asset | ✅ | Files panel | — |
| Categorization/models | ✅ | Full vocab catalog with in-use counts | — |
| Location / site management | 🟡 | Free-text location, no site hierarchy | Structured sites/buildings/rooms |
| Criticality ranking | 🟡 | Priority exists; no formal criticality tier | Criticality scale driving PM/alerts |
| Downtime tracking | 🟡 | Stage/queue time is measured, not framed as downtime | Explicit uptime/downtime metric |
| Depreciation / book value | ❌ | No financial value on assets | Purchase cost, depreciation schedule, book value |
| Warranty tracking | ❌ | No warranty entity (verified) | Warranty start/end, claim workflow |
| Reservations / booking | ❌ | No scheduling of equipment | Calendar booking (low relevance for refurb) |

**Competitor note:** this is our strongest domain. Asset Panda's edge is depreciation and
fixed-asset accounting; EZOfficeInventory's is reservations. Neither models a
multi-company custody chain like we do.

## 4. Parts & inventory

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| Parts registry | ✅ | `parts` with full lifecycle states | — |
| Multi-location stockrooms | ➕ | Shop shelf / client cage / van kit, shareable | — |
| Reorder points | ✅ | `stock_items.min_qty`, "needs ordering" badge | — |
| Signed stock ledger | ✅ | `stock_moves`: receive/issue/adjust/transfer/return | — |
| Issue / receive / transfer | ✅ | Issue creates a costed `parts` row + ledger entry | — |
| Recount with reason | ✅ | Correcting entry, never silent overwrite | — |
| Price book | ✅ | `part_prices` per PN × vendor, OEM flag | — |
| Cost tracking w/ redaction | ➕ | Parsed `cost_cents`, org-stamped redaction | — |
| Barcode on parts | ⛔ | De-scoped — QR-label + camera-URL is enough at our scale | — |
| Vendor management | 🟡 | Vendor is a free-text field, no vendor entity (verified) | Vendor records, contacts, terms, performance |
| Auto-reorder | ❌ | Reorder *list* + draft PO; human sends | Threshold-triggered PO generation |
| Kitting / BOM | ❌ | No bill-of-materials | Kit definitions, assemblies |
| Usage forecasting | ❌ | No consumption trend/lead-time model | Demand forecasting from move history |

## 5. Purchasing

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| Purchase orders | ✅ | `purchase_orders` + `po_lines` | — |
| Receiving (per line) | ✅ | Line receipt puts stock on shelf | — |
| Derived status | ✅ | draft→sent→partial→received / cancelled | — |
| Draft PO from reorder list | ✅ | Priced from price book | — |
| Vendor catalog | 🟡 | Vendor name only, no catalog/terms | Vendor entity (see §4) |
| PO approval workflow | ❌ | No spend-authorization gate | Approval routing by amount |
| EDI / vendor API ordering | ❌ | Manual send | Punchout/API to distributors |
| Blanket POs / contracts | ❌ | One-off orders only | Recurring/blanket agreements |
| RFQ / quote comparison | ❌ | None | Multi-vendor quote requests |

## 6. Financials & billing — *biggest opportunity*

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| Cost recording | ✅ | Parts costs, PO totals, price book, labour minutes | — |
| Quotes / estimates | ❌ | None (verified) | Estimate from parts+labour; PDF; client approval |
| Estimate approval by client | ❌ | Client editors exist but no approve action | Approve/decline in portal |
| Invoicing | ❌ | Costs recorded, **nothing billed** (verified) | Invoice entity from engagement parts+hours |
| Payment collection | ❌ | None | Stripe/pay-link on invoice |
| Accounting integration | ❌ | None | QuickBooks/Xero export or API |
| Job costing / margin | ❌ | Ingredients exist, not assembled | Spend-vs-billed per engagement |
| Expense tracking | ❌ | Non-part costs (shipping, travel) uncaptured | Expense entity tied to system/engagement |
| Labour billing rates | ❌ | Minutes logged, no rate (verified) | Rate cards, billable vs non-billable |
| Contracts / SLA / entitlements | ❌ | No entitlement entity (verified) | Service contracts, SLA timers, coverage |

**This domain is where the app leaks money today:** it records everything needed to bill
and then bills nothing. See the value model in the companion doc — invoicing + expense/job
costing is the highest value-to-effort work because the data already exists.

## 7. Client / customer portal — *ahead of the field*

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| Role-graded client logins | ➕ | client_viewer / client_editor | — |
| Per-org theming | ✅ | Header colour + logo | — |
| Storage quotas per client | ✅ | 1/5/25/100 GB or unlimited | — |
| Status visibility | ✅ | Dashboard + instrument pages, scoped | — |
| Report-an-issue | ✅ | Available to read-only viewers | — |
| Request PM | ✅ | Available to read-only viewers | — |
| Private discussion rooms | ➕ | Per-org rooms, audience-scoped | — |
| Per-client EOD reports | ➕ | One report + recipient list per org | — |
| Free client seats | ➕ | Clients don't consume paid seats | — (Asset Panda charges for view-only) |
| Estimate approval | ❌ | See §6 | Approve/decline estimates |
| Invoice viewing / payment | ❌ | See §6 | Client sees & pays invoices |
| Self-service scheduling | ❌ | Request-PM only, no calendar booking | Book a service slot |

## 8. Reporting & analytics

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| PM compliance | ✅ | On-time %, late, overdue-open | — |
| Turnaround (net of parked) | ➕ | Gross + net days excluding queue time | — |
| Time-in-stage | ✅ | Per active system + avg per transition | — |
| Hours & spend | ✅ | By client and by person | — |
| Scheduled delivery | 🟡 | Daily digest + EOD emails | Configurable scheduled reports |
| Custom date ranges | 🟡 | 30/90-day only | Arbitrary ranges |
| Charts / graphs / trends | ❌ | Numbers-and-pills only; no chart lib | Visual dashboards, trend lines |
| Metric export | ❌ | Can't export the metrics | CSV/PDF of reports |
| Custom / ad-hoc reports | ❌ | Fixed report set | Report builder |
| Configurable dashboards | ❌ | Fixed layout | Drag-to-build KPI dashboards |

**Note:** the queries already compute the hard part. Visualization is presentation work,
and the charts double as sales-deck slides.

## 9. Documents & media

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| File attachments | ✅ | Vercel Blob, relay fallback, quotas | — |
| Dedup billing | ➕ | One stored file billed once across records | — |
| File kinds / categories | ✅ | Tune/Test/Report/Photo/Manual/Other | — |
| Photo gallery | ✅ | Grid with framing, cover markers | — |
| PDF studio | ➕ | In-browser assemble/reorder + server merge | — |
| Cloud integration | ✅ | OneDrive/SharePoint per-person OAuth | — |
| Service-report PDF | 🟡 | **Built & tested in `src/lib`, wired to nothing** | Wire `serviceReport.ts` to a route/action |
| Excel template filler | 🟡 | **Built & tested, wired to nothing** | Wire `xlsxTemplate.ts` to a route/action |
| E-signature on docs | 🟡 | Sign-off exists, not Part 11 | Re-auth at signing (see §10) |
| Document versioning | ❌ | New upload = new row | Version chains |
| Document templates | ❌ | Beyond the unwired xlsx filler | Template library |

**Two finished-but-dark features:** the service-report generator and Excel template
filler are complete with tests and connected to no UI. Cheapest customer-facing wins
available.

## 10. Compliance & quality

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| Append-only audit log | ➕ | Actor/entity/action/old-new, no delete path | — |
| Sign-off gates | ➕ | Blocks on open mandatory tasks / missing test reports | — |
| Frozen evidence snapshots | ➕ | JSON snapshot + stale-signature detection | — |
| Procedure / test catalog | ➕ | Per type/model, intake+interval, required flag | — |
| Test targets & tolerances | ✅ | Result type/target/tolerance on tests | — |
| Typed reasons on destructive ops | ✅ | `lib/reason` on deletes/revokes/cancels | — |
| 21 CFR Part 11 e-sign | ❌ | Explicitly disclaimed (no re-auth at signing) | Re-authentication + binding at signature |
| Calibration certificates | ❌ | No cert entity; certs are generic files | Cert entity, expiry, due-soon alerts, printable cert |
| Standards traceability | ❌ | None | Standard→instrument→cert chain |
| Nonconformance / CAPA | ❌ | None | NCR/CAPA workflow |
| Training records | ❌ | None | Per-person competency records |
| Change control | ❌ | Audit log ≠ change control | Formal change requests |

**The calibration-certificate gap is the market wedge** into Qualer/CERDAAC/Blue
Mountain territory, and it rides on the existing procedures/tests machinery.

## 11. Remote support — *genuinely differentiated*

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| Remote access to lab PCs | ➕ | MeshCentral relay, framed in portal | — |
| Per-person, audited, revocable | ➕ | Audit row names a human; 120s tokens | — |
| Custody-aware attended/unattended | ➕ | Derived from stage/ownership, not a toggle | — |
| Branded installers | ✅ | Rebranded agent/console/installer | — |
| Client self-service tier | ✅ | Per-org `remoteAccessEnabled` | — |
| 24-hour IT invite links | ✅ | Enroll without a portal account | — |
| Session recording / file transfer | 🟡 | Engine can; not surfaced in our portal | Wire recording/transfer into the framed session |

**This is the stickiest module:** agents on lab PCs + firewall allowlists approved by the
client's IT are infrastructure-grade switching costs. Replaces a standing
TeamViewer/UltraViewer install with something auditable.

## 12. Communication & collaboration

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| Notifications (10 kinds) | ✅ | In-app row written before email | — |
| Per-kind email opt-out | ✅ | `notification_prefs` | — |
| Discussion boards | ➕ | Per-org rooms + system discussions | — |
| @mentions | ✅ | Task-note and discussion mentions | — |
| Browser push (opt-in) | 🟡 | OS notifications when tab hidden | — |
| SMS | 🟡 | Twilio for sign-in codes only | SMS for alerts/notifications |
| Real-time updates | ❌ | ~45s polling (serverless tradeoff) | Websockets/SSE live updates |
| Live chat | ❌ | Discussions are threaded, not chat | Real-time chat |

## 13. Auth, security & tenancy

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| Passwordless (code + link) | ✅ | Resend email; rate-limited | — |
| SMS code | ✅ | Twilio optional | — |
| Password fallback | ✅ | Set from inside app, never self-signup | — |
| RBAC | ✅ | owner/staff/client_viewer/client_editor | — |
| Multi-tenancy | ➕ | Operator workspaces, per-tenant isolation tests | — |
| View-as (impersonation) | ➕ | Owner walks portal as any org, still audited | — |
| Rate limiting / lockouts | ✅ | `login_attempts`, 15-min lockouts | — |
| MFA | 🟡 | Email/SMS code is a factor; no TOTP/authenticator | TOTP, enforced MFA policy |
| Session management | 🟡 | Auth.js sessions | Admin session revocation, device list |
| SSO / SAML / OIDC | ❌ | None (Microsoft OAuth is file-access only) | OIDC/SAML sign-in |
| IP restrictions / allowlists | ❌ | None | Network policy controls |

## 14. Integrations & extensibility

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| Google Sheets | ✅ | Hourly parity sync, human-resolved diffs | — |
| Microsoft Graph / OneDrive | ✅ | Per-person OAuth, sealed tokens | — |
| Email (Resend) | ✅ | Codes, notifications, digests | — |
| SMS (Twilio) | ✅ | Sign-in codes | — |
| Storage (Vercel Blob) | ✅ | With relay fallback | — |
| Remote (MeshCentral) | ✅ | Self-hosted relay | — |
| Carrier / shipping API | ❌ | Carrier + tracking are free text | AfterShip/EasyPost auto-status (easy win) |
| Accounting (QuickBooks/Xero) | ❌ | None | Export or API sync |
| Public API | ❌ | No API keys, no endpoints | Documented REST/GraphQL + keys |
| Webhooks | ❌ | None | Outbound event webhooks |
| iPaaS (Zapier/Make) | ❌ | None | Zapier app / generic connectors |

## 15. Mobile & platform

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| Responsive web | ✅ | Media queries + touch styles | — |
| Installable PWA | ❌ | No manifest/service worker | Manifest + SW → home-screen install |
| Offline mode | ❌ | All `force-dynamic`, no cache | Offline read cache + write queue |
| Native app | ❌ | None | iOS/Android (likely unnecessary if PWA ships) |
| Push notifications | ❌ | Browser-only, tab must be open | Web Push / native push |

**Note:** with barcode scanning de-scoped, "mobile" shrinks to an installable, fast PWA —
much cheaper than a native app, and it closes the "do you have an app?" objection.

## 16. Sales & marketplace — *unique to us*

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| For-sale listings | ➕ | Per-system or per-unit toggle | — |
| Public tokenized pages | ➕ | Unguessable token, noindex, no session | — |
| Per-file listing opt-in | ➕ | Seller chooses which files show | — |
| Cross-workspace serial lookup | ➕ | Find a serial in any workspace | — |
| Ownership claims / access requests | ➕ | Claim or request access to found records | — |

No competitor in the comparison set has a refurbished-equipment sales channel built into
the maintenance system. This is a moat, not a gap.

## 17. Data import / export

| Capability | Status | What we have today | What full parity needs |
|---|---|---|---|
| CSV import with dry-run | ✅ | Column-mapping guesses + check pass | — |
| CSV export | ✅ | Assets & systems, cost-redacted | — |
| Bulk grid entry | ✅ | Inline grid on assets/stock | — |
| Migration tooling | 🟡 | Import covers onboarding; no re-sync | Ongoing two-way sync tools |
| API-driven data access | ❌ | See §14 | Public API |

---

## Consolidated priority roadmap

Ordered by value-to-effort, drawing on all 17 domains:

**Tier 0 — near-free wins (finished or nearly-finished code):**
1. Wire up the **service-report PDF** (`src/lib/serviceReport.ts`) — §9
2. Wire up the **Excel template filler** (`src/lib/xlsxTemplate.ts`) — §9
3. **Shipping-tracking API** on the existing carrier/tracking fields — §14
4. **Charts + export** on the existing `/metrics` numbers — §8

**Tier 1 — turns cost-recorder into a business tool:**
5. **Invoicing** from recorded parts + labour, with follow-up reminders — §6
6. **Expense tracking + job costing / margin** (ties to inventory + hours) — §6
7. **Quotes/estimates** with in-portal client approval — §6, §7
8. **QuickBooks/Xero export** — §14

**Tier 2 — expands the addressable market:**
9. **Calibration-certificate tracking** (expiry, alerts, printable cert) — §10
10. **Meter/usage-based PM** — §2
11. **Installable PWA** (no native app, no scanning) — §15
12. **Warranty tracking** (pairs with listings for repeat revenue) — §3, §6

**Tier 3 — enterprise unlockers, build on demand:**
13. SSO/OIDC, public API + webhooks — §13, §14
14. PO approval workflow, vendor management — §4, §5
15. 21 CFR Part 11 re-auth signing, CAPA/NCR — §10
16. Real-time (websockets), configurable dashboards — §8, §12

**De-scoped (deliberately not building):** barcode/QR scanning hardware workflows,
native mobile apps, IoT/sensor condition monitoring, equipment reservations,
depreciation accounting.
