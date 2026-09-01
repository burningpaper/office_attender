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
Status: Not Started

## Stage 2: Schema + migrations
Goal: Neon Postgres schema from DESIGN.md §4 in Drizzle, with the SA public holiday calendar
for 2026 seeded into `calendar_days`.
Success Criteria:
- Migrations run clean up and down.
- `calendar_days` correctly marks 2026-04-03 and 2026-05-01 as `PUBLIC_HOLIDAY`, and
  `is_required_day` is false for them.
- Constraint test: duplicate `(employee_id, date)` is rejected.
Status: Not Started

## Stage 3: Identity resolution + first import (no AI)
Goal: Parser output lands in the database. Names normalised deterministically.
Success Criteria:
- 88 raw name strings collapse to the correct employee count; `Zakiyya`/`Zakiya`,
  `Johanneson`/`Johannesen`, `zoe`/`Zoe` merge without a model call.
- `Brian` and `Intern` are surfaced as unresolved, not silently merged or dropped.
- `first_seen`/`last_seen` computed per employee.
- Re-importing the same file is a no-op (sha256 dedupe) and changes zero rows.
Status: Not Started

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
Status: Not Started

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
