# Ridgeline — Prompt B3: the add/edit procedure dialog

Run after Prompt 0 and Part 1 of B2 (scoped procedures). This replaces the current "New · Autosampler" dialog.

```
Redesign the add/edit procedure dialog. It currently renders 11 sections in one scrolling column with a Task/Test toggle at the top, a 17-chip "Models" multi-select, a separate "System types it belongs to" multi-select, and a "Never runs" error that is visible before the user has touched anything. Keep every piece of data it collects; reorganize it.

STRUCTURE:
- Header: title "New procedure" or "Edit · {name}", a muted context line "{scope label} · launched from {node}", and the Task / Test segmented toggle on the right. Keep the toggle: it is a real fork. Only the fields that differ between task and test swap in place; nothing else moves when you toggle.
- Desktop (>= 900px): a dialog with a left step nav (170px) and a scrolling form. Steps: What it is · Where it lives · When it runs · Steps & checklist · Compliance & provenance. Clicking a step scrolls to that section; the nav marks each step done (green check) or needs-attention (amber "!") based on live validation.
- Mobile (< 640px): full-screen, one step per screen, a thin progress bar under the header, "‹ Back" and "Next: {next step name}" in a fixed footer; the last step's primary button is Save.
- Footer (sticky on both): left side is a live status line. While invalid: "Can't save yet — {first problem}" in red, Save disabled. When valid: "Covers N models" muted, Save enabled. Save button label names the scope: "Save to Autosamplers on LC-MS" / "Save to G7167B only".
- Validation runs on blur / after a step is visited, never on first paint. No red banner at the bottom of the form.

SECTION 1 — WHAT IT IS:
- Name (required). Placeholder from the existing examples.
- Task variant: a "When done, record" segmented control: Inspected / replaced · Note · Nothing (replaces the "Inspect / Replace outcome" checkbox + "Require a note" checkbox; keep the explanatory sentence as a tooltip or one-line hint). Checkboxes: "Required for sign-off" and "Consumes a part", side by side on desktop, each with its one-line hint.
- Test variant: "Result" segmented control: Pass / fail · Measured value · Reading · Note. "Required for sign-off" checkbox with the test-specific hint.

SECTION 2 — WHERE IT LIVES (replaces Models + System types):
- A radio list with one row per rung of the tree from the launching node upward, most general first. Because module types (e.g. Autosampler) are shared across instrument types, the rungs are: "Every {module type}" (all instrument types) → "{Module type}s on {instrument type}" → "Only {model}". If launched from a module-type node, omit the model rung; if launched from an instrument-type node, show only the top rung(s). Each row: bold label, one-line description with the model count, and the tree path in the mono face on the right.
- Default to the launching node.
- Under the list, a live "Covers N models: …" box listing the actual model names (mono), truncated after 8 with "+N more". Include the sentence: "Need to leave one out? Save, then turn it off on that model's page." Do not reintroduce a multi-select.
- When editing an existing procedure and the scope changes, show a warning in the covers box: "Starts applying to N models: …" / "Stops applying to N models: …".
- "Parts it takes" moves into this section, directly under the covers box, because part applicability depends on scope. Each part row: PartNumber (mono), name, "Fits {models}" in violet or "Fits all N", and a kebab (Edit fit, Remove). "+ Part" opens the existing part picker with a model-fit multi-select limited to the models in scope. Keep the guidance sentence: "Same work, different part per model? Tag the part with the models it fits and keep one procedure."

SECTION 3 — WHEN IT RUNS:
- Two checkboxes with their hints: "At intake — created once when a unit of a covered model is added" and "On a cadence — scheduled on every covered unit, existing and new".
- When "On a cadence" is checked, reveal an inline cadence row: "Every [number] [days | months | injections | hours]". If the current data model has no cadence field, add it; if it exists under a different shape, map to it.
- This section is required (at least one). The step nav and footer reflect it; no standalone error banner.

SECTION 4 — STEPS & CHECKLIST:
- Two fields side by side on desktop, stacked on mobile: Notes (optional) and Checklist (one line per step; keep the "end a line with a colon to make it a heading" hint as the field's sub-label, not a separate paragraph).

SECTION 5 — COMPLIANCE & PROVENANCE (collapsed by default):
- Collapsed row shows the current values as neutral chips: "Qualification: none", "Source: not saying". Expanding reveals the existing Qualification (None / IQ / OQ / PQ) and Where it came from (Not saying / Our IP / Restated facts / OEM material) segmented controls with their existing hints. Expand automatically when editing a procedure where either is set to a non-default value.

REMOVE: the "Models" chip field, the "System types it belongs to" chip field, the "Empty covers every system type…" sentence, and the "Never runs" banner.

Reuse the shared components (segmented control, checkbox with hint, PartNumber, chips). Verify at 375px, 768px, and 1280px; verify the Task/Test toggle does not shift any section except the swapped fields; verify Save is disabled with a named reason until Name and When-it-runs are satisfied.
```

---

## Addendum — Test variant, Section 1 in detail

```
Expand the Test variant of Section 1 ("What it is") of the procedure dialog. Everything outside Section 1 is identical to the Task variant.

FIELDS:
- Name (required).
- Result: segmented control — Pass / fail · Measured value · Reading · Note. Below it an "Acceptance" block whose contents depend on the selection. Switching result types swaps only this block; nothing else on the form moves.
- Two checkboxes, side by side on desktop: "Required for sign-off" (hint: nobody can sign off until this test is done and a report is filed) and "Needs a report attached" (hint: a file — tune report, printout, photo — must be on the result). If the data model has no attachment-required flag, add one.
- A dashed "On the work order:" preview box under the acceptance block that renders the result row as the tech will see it: test name, the entry control(s) for this result type, and the pass/fail treatment. Update it live.

ACCEPTANCE BLOCK BY RESULT TYPE:

Pass / fail:
- "What counts as a pass" textarea (optional) — shown to the tech as guidance.
- Checkbox "Attach a reading too": tech records a number and unit alongside the verdict; the number is stored but not graded. When checked, reveal a Unit field.
- Preview: name + Pass / Fail buttons.

Measured value (graded automatically — show a green "graded automatically" chip on the block header):
- "Measured with" (optional free text: standard, tool, or method, e.g. "Caffeine standard, 6 replicate injections").
- "Passes when": one criterion row = operator segmented control (≥ · ≤ · < · > · ±) + number input (mono) + unit text input. For ± the row gets a second number input for the center value ("± 0.05 of 1.00 mL/min").
- "+ Alternate criterion" adds another row joined by an "OR" label; each extra row has a remove ✕. Criteria with different units mean the tech may enter either; the result passes if any criterion is met. Store criteria as structured data (operator, value, unit, optional center), not as a string.
- Checkbox "Also record the raw replicates" (optional; reveals nothing here — it tells the work-order form to present N inputs plus the computed value).
- Unit inputs autocomplete from units already used in the library.
- Preview: name, an entry box per distinct unit, the limit sentence, and a sample Pass chip.
- Validation: at least one criterion with operator, number and unit before Save; the footer says "Can't save yet — add a pass limit."

Reading (recorded, not judged — gray "recorded, not judged" chip):
- Unit (required).
- "Typical range" (optional): two number inputs, low and high, shown to the tech as a muted hint only. Never produces a fail.
- Preview: name, entry box with unit, and the typical-range chip.

Note:
- "Prompt for the tech" (optional single line, e.g. "Describe spray stability at 0.2 mL/min").
- Preview: name and a text field showing the prompt as placeholder.

WORK-ORDER SIDE (the consumer of this data — do not redesign the work-order page now, just make sure the result row component can render these four shapes):
- Pass / fail: verdict buttons, optional reading input.
- Measured value: one input per unit, auto-grade on blur, show Pass / Fail chip and the limit it was judged against; block sign-off on Fail only if "Required for sign-off" is set.
- Reading: input with unit; out-of-typical-range shows an amber hint, not a fail.
- Note: textarea with the prompt.

MIGRATION: existing tests whose acceptance criteria live in the name or notes (e.g. "Target <0.15 % RSD or SD <10 nL, whatever is greater") should be left as-is but flagged in the "Needs review" filter so the limits can be moved into structured fields by hand. Do not attempt to parse them automatically.

Verify: switching between the four result types does not shift the Name field or the checkboxes; the preview updates live; Measured value refuses to save without a complete criterion; Task ↔ Test toggle preserves Name, scope, timing, checklist and compliance values.
```
