# Competitive Parity Audit — Sierra Spectra

*Audit date: August 2026. Feature claims about this app were verified against the code on
this branch; competitor claims come from vendor sites and third-party comparisons (sources
at the end). Pricing is list pricing as published in mid-2026 and changes often.*

---

## 1. What this product actually is

Sierra Spectra started as "replace the client's Google Sheet" and has grown into a
**multi-tenant service-operations portal for lab-instrument refurbishers**. In market
terms it straddles five categories at once, which is why no single competitor lines up
cleanly against it:

| Category | Representative competitors | What we take from that category |
|---|---|---|
| CMMS / maintenance management | MaintainX, Limble, UpKeep | Work orders (tasks + checklists), PM schedules, parts, labour hours, audit trail |
| Asset tracking | EZOfficeInventory, Asset Panda | Asset registry, custody/ownership chain, QR labels, checkouts, CSV import/export |
| Repair-shop / service management | RepairShopr, ServiceTrade | Client portal, per-client communication, status visibility, intake procedures |
| Regulated calibration/asset platforms | Qualer, CERDAAC (SIMCO), Blue Mountain RAM | Sign-off gates with evidence snapshots, append-only audit log, procedure catalog with tests/tolerances |
| Remote support | TeamViewer, AnyDesk, ScreenConnect | Audited, per-person, custody-aware remote access to lab PCs (MeshCentral relay) |

The distinctive spine of the product is **inter-organization workflow**: ownership vs.
queue ("whose move is it") as separate axes, per-record sharing across workspaces,
frozen engagement records on handoff, cross-workspace serial lookup with access
requests and ownership claims, and a public tokenized for-sale listing page. None of
the mainstream CMMS/asset tools model a multi-company refurbishment pipeline this way.

## 2. Parity matrix

Legend: ✅ at or above parity · 🟡 partial · ❌ missing · ➕ we have it, most competitors don't.

### Core maintenance (vs. MaintainX / Limble / UpKeep)

| Capability | Us | Notes |
|---|---|---|
| Work orders (tasks, checklists, assignment, due dates, threaded notes) | ✅ | Full parity for our niche; no dispatch board |
| Preventive maintenance scheduling | 🟡 | Interval (days) cadence with floating next-due and one-open-task rule. **No meter/usage-based PM, no calendar grid, no technician scheduling** — MaintainX Premium and Limble both do meter-based |
| Asset registry & hierarchy | ✅➕ | Systems composed of attachable assets, as-found condition, lifecycle events, merged service history — deeper than MaintainX's flat asset list |
| Parts inventory | ✅ | Stockrooms (shop/cage/van), min-qty reorder points, signed ledger, recount-with-reason. Parity with UpKeep Starter/MaintainX Premium |
| Purchase orders | ✅ | Draft→sent→partial→received derived status, price book. Parity with MaintainX Premium PO management |
| Automated reordering | ❌ | Reorder *list* + one-click draft PO only; humans send/receive. Limble automates PO generation from thresholds |
| Reporting & dashboards | 🟡 | Real KPIs (PM compliance %, gross/net turnaround, time-in-stage, hours, spend) but **numbers-only: no charts, no trends, no custom ranges, no metric export**. All three competitors ship visual dashboards |
| Mobile app / offline | ❌ | Responsive web only; no PWA, no offline, no push. **This is the single biggest parity gap** — MaintainX is mobile-first and it's the top-cited reason teams adopt it |
| Barcode/QR scanning | 🟡 | We *generate* printable QR labels; scanning relies on the phone camera opening a URL. No in-app scan-to-find, no barcode fields |
| Meters / IoT / condition monitoring | ❌ | Limble and MaintainX integrate sensors; out of scope for our size, listed for completeness |
| SSO / SAML | ❌ | Email code + optional SMS + password fallback. Competitors gate SSO behind enterprise tiers, so absence mainly blocks larger buyers |
| Public API & webhooks | ❌ | No API keys, no webhooks. All three competitors have APIs at upper tiers |
| Real-time updates | 🟡 | 45s polling, deliberate serverless tradeoff; competitors push instantly on mobile |

### Asset tracking (vs. EZOfficeInventory / Asset Panda)

| Capability | Us | Notes |
|---|---|---|
| Check-in/check-out & custody | ✅➕ | Custody events, ownership handoff, frozen dossiers — stronger provenance than either |
| Labels | 🟡 | QR generation yes; no label-printer integrations (Zebra/Dymo), no barcode symbologies |
| CSV import with dry-run | ✅ | Parity or better (mapping guesses + check pass) |
| Depreciation / fixed-asset accounting | ❌ | Asset Panda's bread and butter; we track no book value |
| Reservations / scheduling of equipment | ❌ | EZO has booking; not obviously needed for refurb workflow |

### Service business (vs. RepairShopr / ServiceTrade)

| Capability | Us | Notes |
|---|---|---|
| Customer portal | ✅➕ | Role-graded client logins (viewer/editor), per-org theming, storage quotas, EOD reports per client, private discussion rooms, report-an-issue and request-PM even for read-only viewers. Far beyond RepairShopr's status-check portal |
| Estimates / quotes / invoicing / payments | ❌ | **We record costs but bill nothing.** RepairShopr's core is ticket→estimate→invoice→POS. Closing this turns recorded parts + labour into revenue documents |
| Contracts / warranties / SLAs | ❌ | No entitlement entity anywhere |
| Shipping integration | 🟡 | Carrier + tracking are free text; no carrier API, no label purchase |
| Service reports (branded PDF) | 🟡 | A full PDF service-report generator and an Excel template filler **exist in `src/lib` with tests but are wired to nothing** — cheapest possible wins |

### Regulated lab work (vs. Qualer / CERDAAC / Blue Mountain RAM)

| Capability | Us | Notes |
|---|---|---|
| Append-only audit log with typed reasons | ✅ | Genuine parity in spirit with regulated platforms |
| Sign-off gates with evidence snapshots & stale detection | ✅➕ | Unusual at our price class |
| 21 CFR Part 11 e-signatures | ❌ | Explicitly disclaimed in code (no re-auth at signing). Needed only if customers are FDA-regulated |
| Calibration certificate management | ❌ | No cert entity, expiry alerts, or standards traceability; certs are generic attachments. This is *the* wedge feature of Qualer/CERDAAC and adjacent to what our users already do |
| Procedure/test catalog with targets & tolerances | ✅ | Real differentiator vs. generic CMMS |

### Where we are ahead of everyone (➕)

- **Multi-company pipeline**: ownership vs. queue axes, net turnaround excluding parked
  days, frozen engagement records, cross-workspace serial claims.
- **Custody-aware remote support**: per-person, audited, revocable lab-PC access where
  attended/unattended is *derived from custody* — replaces a standing TeamViewer install.
- **Cost redaction by org** end to end (UI, search, CSV exports all agree).
- **Tokenized public for-sale listings** with per-file opt-in — a lightweight
  used-equipment sales channel none of the comparison set has.
- **True multi-tenancy** (operator workspaces on one instance) with per-tenant isolation
  tests — this is a *platform* capability, i.e. the option to sell the product itself.

## 3. Gap analysis, prioritized

**P0 — blocks parity claims buyers check first**
1. **Mobile**: a PWA (manifest + service worker + offline read cache + camera scan of our
   own QR labels) covers ~80% of "do you have an app?" without app stores.
2. **Visual reporting**: charts + trends + CSV export on the existing `/metrics` data.
   The queries already exist; this is presentation work.
3. **Wire up the orphaned service-report PDF and Excel template filler** — finished,
   tested code delivering a customer-facing deliverable competitors charge for.

**P1 — expands the sellable market**
4. **Calibration/certificate tracking**: cert entity with expiry, due-soon alerts,
   printable cert from test results. Rides on the existing procedures/tests machinery and
   moves us toward the Qualer/CERDAAC buyer.
5. **Quotes & invoices** from recorded parts + labour (even export-to-QuickBooks CSV
   first). Turns the system from cost-recorder into revenue tool.
6. **Meter-based PM** (hours/cycles on instruments) alongside day-interval PM.

**P2 — enterprise unlockers, build when a deal demands**
7. SSO (OIDC first), public API + webhooks, carrier tracking API, label-printer support,
   automated PO generation, Part 11-grade signing (re-auth at signature).

## 4. What could this be worth to end users?

Two ways to look at it: what users would otherwise pay (price anchoring), and what it
saves/earns them (value in use).

### 4a. Replacement-cost anchor

A small instrument-service operator (say 5 staff + 3 client orgs, ~50–150 assets) buying
today's feature set piecemeal:

| Replaced tool | Anchor price (2026 list) | Annual |
|---|---|---|
| CMMS, mid tier (MaintainX Premium $49/user/mo × 5, or UpKeep Starter $45) | ~$245/mo | ~$2,900 |
| Asset tracking (EZOfficeInventory Advanced, unlimited users) | ~$55/mo | ~$660 |
| Customer portal / service mgmt (RepairShopr Repair Shop tier) | ~$120/mo | ~$1,440 |
| Remote access (TeamViewer/ScreenConnect, 2 licenses) | ~$100/mo | ~$1,200 |
| File sharing w/ client quotas (Box/Dropbox business seats) | ~$60/mo | ~$720 |
| **Stack total** | **~$580/mo** | **~$6,900/yr** |

Note client logins are free in our model, while Asset Panda charges even for *view-only*
seats ($120/collaborator/yr) — a real advantage for a business whose value is client
visibility.

So **today's app is already worth roughly $500–700/month (~$6–8k/yr) per operator
workspace** in avoided spend — before counting the inter-org workflow nobody else sells.

**With P0+P1 gaps closed** (mobile, dashboards, service reports, calibration certs,
invoicing), the comparison set shifts upward: UpKeep Professional is $75/user/mo
(~$4.5k/yr for 5), Asset Panda runs $600–900/user/yr, and the regulated calibration
platforms (Qualer, CERDAAC, Blue Mountain) are quote-only deals that commonly land in
five figures annually. A defensible bundle price becomes **$800–1,500/month
(~$10–18k/yr) per operator workspace**, i.e. closing the gaps roughly **doubles the
credible willingness to pay** and — because the multi-tenant plumbing already exists —
makes "sell workspaces to other refurbishers" a real product, not a consulting artifact.

### 4b. Value-in-use (why users would actually pay it)

Industry benchmarks for moving maintenance work off spreadsheets into a CMMS: ~27%
average downtime reduction (Aberdeen), 10–40% maintenance cost savings, planned work
costing 30–50% less than emergency work, and typical documented ROI of 300–500% within
18–24 months. For a shop whose product *is* instrument uptime and turnaround:

- **Turnaround**: the app already measures net turnaround excluding parked days. If
  visibility + queue accountability shave even 3–5 days off a refurb cycle, that is one
  or two extra billable engagements per bench per year — thousands of dollars each.
- **Labour capture**: mobile + one-tap hour logging typically recovers 5–10% of billable
  time that after-the-fact entry loses. On 5 techs at ~$100/hr billed, 5% ≈ **$50k/yr**.
- **Invoicing gap is leaking money today**: parts and labour are recorded but never
  turned into revenue documents; anything not manually re-keyed into billing is at risk
  of write-off. Even a 2% billing-leak reduction on a modest $1M service revenue is
  **$20k/yr** — by itself larger than the entire software stack cost.
- **Sales channel**: the listing pages turn refurbished inventory into a marketable
  storefront; one incremental instrument sale per year likely exceeds the annual cost of
  the whole system.

**Bottom line:** to an end-user operator, the closed-gap product plausibly carries
$10–18k/yr in price-anchored value and **$50–100k+/yr in operational value** for a
5-person shop, dominated by billed-hour capture, billing-leak reduction, and faster
turnaround. The features that unlock the largest share of that value are not the hardest
ones: wiring up the already-written service-report generator, invoicing/QuickBooks
export, and a scanning-capable PWA are the top three by value-to-effort.

---

## Sources

- [Tractian: MaintainX vs Limble](https://tractian.com/en/blog/maintainx-vs-limble) · [Tractian: MaintainX vs UpKeep](https://tractian.com/en/blog/maintainx-vs-upkeep)
- [Facilio: MaintainX vs Limble 2026](https://facilio.com/blog/maintainx-vs-limble/) · [Limble: MaintainX vs UpKeep](https://limble.com/learn/maintainx-vs-upkeep)
- [FieldServiceSoftware.io: MaintainX pricing](https://fieldservicesoftware.io/software/maintainx/)
- [SelectHub: Asset Panda vs EZOfficeInventory](https://www.selecthub.com/eam-software/asset-panda-vs-ezofficeinventory/) · [Bulbthings comparison](https://bulbthings.com/blog/asset-panda-vs-ezofficeinventory) · [Vendr: Asset Panda pricing](https://www.vendr.com/marketplace/asset-panda)
- [Capterra: RepairShopr](https://www.capterra.com/p/133945/RepairShopr/) · [SoftwareSuggest: RepairShopr](https://www.softwaresuggest.com/repairshopr)
- [Qualer / CERDAAC / Blue Mountain RAM](https://cerdaac.com/solutions/calibration-management/) · [Blue Mountain calibration](https://www.bluemountain.io/blue-mountain-ram-products/calibration-management-software/)
- [eWorkOrders: quantified CMMS benefits](https://eworkorders.com/cmms-software/cmms-benefits/) · [ManWinWin: CMMS ROI modeling](https://www.manwinwin.com/maintenance-software-roi-calculator-how-to-model-the-real-payback-of-a-cmms/)
