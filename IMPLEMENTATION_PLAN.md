# Implementation Plan — Office Attendance

Design: see [DESIGN.md](DESIGN.md). All four open questions decided — DESIGN.md §10.

## Stage 1: Deterministic parser + golden fixtures
Goal: A standalone TypeScript module that turns the real workbook into typed
`{name, date, rawValue}` records, with zero AI and zero database.
Success Criteria:
- Parses all 8 sheets; correctly decodes Excel date serials to calendar dates.
- Drops spacer columns, the August totals row, and legend rows with no attendance data —
  while KEEPING June's `Weslee Johannesen` row, which sits below the gap but has real data.
- Snapshot test asserts exact counts per sheet; re-running on the same file is byte-identical.
- Flags, without crashing: `O1 June`, `10 Aug`, numeric-not-0/1 cells, duplicate names.
Status: **Complete** — 19 tests passing, typecheck and lint clean.

Notes from the build (things the sample data taught us):
- Attendance is stored as **Excel booleans** (`t:"b"`), not the numbers the grid
  displays. Normalised to `"1"`/`"0"` at the parser boundary.
- There are **nine** totals rows, not one — every sheet has one and several have two.
  All are nameless, which is what makes them safe to drop.
- A column's *header* cannot identify an attendance column; its *contents* can.
  Classification is by 0/1 density, which also stopped June's broken `O1 June` column
  being swallowed into the standing-note field.
- `YONDER` is a division divider row present on all seven sheets; dropped as no-data.
- August's `10 Aug` column is **empty below the header** — a day the sheet meant to
  capture and never did. Flagged distinctly from June's, which does hold withheld data.
- `Weslee Johannesen` carries the full name in the first-name column with the surname
  column blank, so it joins `Brian` and `Intern` as unresolved identities for Stage 3.

## Stage 2: Schema + migrations
Goal: Neon Postgres schema from DESIGN.md §4 in Drizzle, with the SA public holiday calendar
for 2026 seeded into `calendar_days`.
Success Criteria:
- Migrations run clean up and down.
- `calendar_days` correctly marks 2026-04-03 and 2026-05-01 as `PUBLIC_HOLIDAY`, and
  `is_required_day` is false for them.
- Constraint test: duplicate `(employee_id, date)` is rejected.
Status: **Complete** — 26 new tests (45 total), migration applied to Neon, calendar seeded
2025–2027.

Notes from the build:
- **The `10 Aug` mystery from Stage 1 is solved.** National Women's Day falls on Sunday
  9 Aug 2026, so under the Public Holidays Act's Sunday rule the Monday is a public
  holiday. The column exists because someone laid the month out; it is empty because the
  office was shut.
- Holidays are **computed, not hardcoded** — Easter by the anonymous Gregorian computus,
  plus the Sunday rule — so next year's calendar needs no maintenance.
- December 2026 has only **7** required days: 16 Dec is a Wednesday and 25 Dec a Friday.
  This is the month where the long-term "3 Wednesdays and 3 Fridays" rule gets hard to
  reach — the caveat flagged in DESIGN.md §7.
- `attendance.date` has an **FK to `calendar_days`**, so attendance can never exist on a
  day compliance cannot evaluate. Calendar coverage becomes a hard requirement of import
  rather than something discovered later when a month reads oddly.
- Tests run against **PGlite** (real Postgres in WASM), so constraints, enums and foreign
  keys are genuine — no network, no credentials, no mocks.
- Re-seeding never overwrites a day a human has ruled on, which is what makes the
  eventual OFFICE_CLOSED confirmations durable.

## Stage 3: Identity resolution + first import (no AI)
Goal: Parser output lands in the database. Names normalised deterministically.
Success Criteria:
- 88 raw name strings collapse to the correct employee count; `Zakiyya`/`Zakiya`,
  `Johanneson`/`Johannesen`, `zoe`/`Zoe` merge without a model call.
- `Brian` and `Intern` are surfaced as unresolved, not silently merged or dropped.
- `first_seen`/`last_seen` computed per employee.
- Re-importing the same file is a no-op (sha256 dedupe) and changes zero rows.
Status: **Complete** — 38 new tests (83 total). Seven months imported into Neon:
82 employees, 84 aliases, 10,453 attendance rows, 35 distinct reasons.

Notes from the build:
- **Real bug caught by the integration test.** A similarity match landing on someone
  created earlier in the *same run* found a candidate with no database id yet, so
  `Zakiyya Karim` silently became a second employee. Fixed with a `canonicalKey` that
  groups spellings before any row is written.
- **35 distinct reason strings, not ~65.** The earlier estimate counted the totals rows'
  numbers as reasons. DESIGN.md corrected. The cost argument is unchanged and stronger.
- `Jason Khubeka` never becomes an employee — both his rows are legend rows with no
  attendance data, so the parser drops him. Correct, but worth knowing.
- Kevin Irwin appears on **all seven** sheets with zeroes throughout; his window is
  2026-03-02 → 2026-09-30. An exemption question, not an attendance one.
- **September is 1,474 cells and zero present** — the current-month problem from
  DESIGN.md §2.1, now visible in real data. Stage 4 must not read this as mass failure.
- `On leave` / `On Leave` / `on leave` are three separate reason rows covering 96 cells.
  Exactly what stage 5 collapses.

## Stage 4: Compliance engine
Goal: Pure functions implementing DESIGN.md §7, fully unit tested. No UI.
Success Criteria:
- Elapsed-days-only rule verified: September 2026 as at 2026-09-01 yields `N/A`, not
  a company-wide `NO`.
- Holiday exclusion verified: April 2026 does not mark everyone non-compliant.
- Exempt, `N/A`, and short-tenure paths covered.
- Kevin Irwin (7 months of zeroes, lives in George) resolves to `EXEMPT`.
- Excused-neutral policy verified: a required day with any recorded reason leaves the
  denominator; someone present 1/1 with 3 sick days reads `YES 1/1 · 3 excused`, not `NO`.
Status: **Complete** — 43 new tests (126 total). All four success criteria verified against
the real 82-person dataset, not just fixtures.

Notes from the build:
- **Real bug: "complete month" was measured against the calendar month.** 1 March 2026 is a
  Sunday, so someone whose record starts Monday the 2nd looked like a mid-month joiner and
  lost the month from their long-term average. Now measured against the month's first and
  last *required* days. The real data has this shape at both ends (March starts the 2nd,
  May's last required day is the 29th).
- Exemption derivation was missing from stage 3 and is now wired in: 8 derived from
  standing notes, 7 of them active.
- **`Approved to work from home every Thursday` deliberately does NOT exempt.** Thursday is
  not a required day, so it says nothing about Wednesday and Friday. Recorded and surfaced
  for confirmation instead.
- `asOf` is always passed in, never read from the clock, so every verdict is reproducible.
- **The long-term rule is very hard to meet on this data** — see the note below.

### Finding for discussion: the long-term rule may be unusable as specified

Running the engine over August 2026 gives:

```
monthly:   YES 12 · NO 50 · NA 13 · EXEMPT 7
two week:  YES 34 · NO 27 · NA 14 · EXEMPT 7
long term: YES  2 · NO 66 · NA  7 · EXEMPT 7
```

Two people out of 75 meet "an average of 3 Wednesdays and 3 Fridays per month". That is not
a bug — the arithmetic is right — but a column that reads NO for 88% of the company carries
almost no information, and everyone learns to ignore it.

The cause is that the target is far above actual behaviour: 1,443 attendances across 82
people over 7 months is about 2.5 office days per person per month, against a target of 6.
Worth deciding whether the rule is aspirational (keep it, expect red) or diagnostic (lower
the target, or measure against the team median). Raised, not resolved.

## Stage 5: AI reason normalisation
Goal: The ~65 distinct reason strings classified into the controlled vocabulary, cached.
Success Criteria:
- One batched request classifies the full backlog; structured output validates.
- `On leave` / `on leave ` / `On Leave` all resolve to the same category.
- `"Office closed"` classifies as `PUBLIC_HOLIDAY_OR_CLOSURE`, not personal absence.
- Second run makes zero model calls (cache hit on every string).
- No employee names are included in any prompt.
Status: Not Started

## Stage 6: Web interface
Goal: The table from the spec, plus month filter, sorting, and the expandable per-person
calendar row.
Success Criteria:
- All six columns sort correctly, including tri-state ordering (NO → YES → EXEMPT → N/A).
- Month filter defaults to current month and shows a sane, non-alarming default view.
- Exempt employees hidden by default, with a toggle and a header count.
- Excused-day counts visible on the row, so a clean-looking fraction isn't misleading.
- Verified in a browser at desktop and mobile widths; keyboard navigable.
Status: Not Started

## Stage 7: Upload UI with preview/approve
Goal: Drag-drop upload, seven-stage progress, diff preview, explicit approval before commit.
Success Criteria:
- Diff shows added/changed/removed records and roster deltas before anything is written.
- Anomalies (proposed closures, unresolved names, low-confidence reasons) must be
  resolved before Approve enables.
- Rejecting an upload leaves the database untouched.
Status: Not Started

## Stage 8: Auth, deploy, docs
Goal: Behind authentication, on Vercel, documented.
Success Criteria:
- No unauthenticated route exposes employee data; uploaded files in private storage.
- Full test suite green; deployed and verified against production.
- `.claude/DEVELOPER_LOGS.md` written.
Status: Not Started
