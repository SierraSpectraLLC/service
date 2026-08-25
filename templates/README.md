# Document layouts

These three workbooks ARE the layout of the paperwork the app exports:

| File | Exported from | Route |
|---|---|---|
| `InvoiceTemplate.xlsx` | an invoice's page → **Excel** | `/api/export/invoice/{id}` |
| `QuoteTemplate.xlsx` | a quote's page → **Excel** | `/api/export/quote/{id}` |
| `POTemplate.xlsx` | a purchase order's page → **Excel** | `/api/export/po/{id}` |

## Changing the layout

Open the file in Excel, change it, commit, deploy. Fonts, colors, merges,
the wire-transfer block, the FedEx note, your address - all of it is yours
and the app never touches it. That is the point of keeping these as real
.xlsx files instead of code.

The one thing to keep steady: **the cells the app writes into.** They are
listed per document at the top of `src/lib/xlsxDocs.ts` (invoice number in
C4, customer block at I9-I11, line table at rows 25-40, and so on). Moving
one of those cells is fine - update its entry there, one line. Everything
else can move freely.

Two conventions the app relies on:

- **Line rows compute their own totals.** The app writes description,
  quantity and unit price; the row's own formula makes the total, so a
  person can tweak a quantity in the exported file and watch it recalculate.
- **The table holds 16 rows.** A longer document gets rows inserted inside
  the table automatically (styled like the row above) and the summary
  formulas widened to match.

Renaming a sheet tab breaks the export with a clear error naming the sheet
it expected - so don't rename the tabs.
