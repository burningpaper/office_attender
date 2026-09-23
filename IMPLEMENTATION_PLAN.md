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
Status: **Built and fully tested — awaiting an API key for the one real call.**
13 new tests (139 total). The model is stubbed in tests; everything around it is verified.

Notes from the build:
- **Design gap found by the tests.** A string the model returns as `UNKNOWN` was being
  re-sent on every subsequent run, forever, to be told the same thing. `model IS NULL` is
  now the record of "never asked", so `UNKNOWN` becomes a settled outcome that stays
  visible to a person without being re-queried. This is what makes "second run costs
  nothing" actually true.
- **Answers are matched by returned `rawText`, never array position.** If the model drops
  or reorders an entry, the affected string degrades to `UNKNOWN` rather than silently
  inheriting a neighbour's category. Tested both ways.
- **Privacy verified live, not just asserted**: all 153 distinct name parts across the 82
  employees were checked against the generated prompt. None appears. Only the 35 reason
  strings are ever sent.
- Prompt caching is deliberately *not* the optimisation here. The database is the cache —
  one call per novel string in the lifetime of the system. Not calling beats caching.
- `npm run reasons:classify -- --show` prints the exact prompt without calling anything.

**To run it:** add `ANTHROPIC_API_KEY` to `.env.local`, then `npm run reasons:classify`.
One request, ~3,000 characters, well under a cent.

## Stage 6: Web interface
Goal: The table from the spec, plus month filter, sorting, and the expandable per-person
calendar row.
Success Criteria:
- All six columns sort correctly, including tri-state ordering (NO → YES → EXEMPT → N/A).
- Month filter defaults to current month and shows a sane, non-alarming default view.
- Exempt employees hidden by default, with a toggle and a header count.
- Excused-day counts visible on the row, so a clean-looking fraction isn't misleading.
- Verified in a browser at desktop and mobile widths; keyboard navigable.
Status: **Complete** — 12 new tests (151 total). Verified in a real browser at 1280px and
375px; no console errors, no horizontal page overflow, fully keyboard operable.

Notes from the build:
- **Sorting was extracted out of the component** into `lib/compliance/sort.ts` so the
  tri-state ordering could actually be tested. Logic trapped in a React component is
  logic nobody tests.
- **"Never attended" sorts as most-overdue, not as missing data.** An empty string sorts
  before every real date, so ascending puts those people at the top where they belong.
- **The current-month default is honest but was a dead end.** On the 1st every verdict
  reads "not yet", so the column is uninformative. Rather than change the specified
  default, the header now offers a link to the last month that can answer the question.
- Row expansion shows the month's required days with reason chips — the answer to
  "which days, and did they say why?" is one click away, not another screen.
- Dropped TanStack Table from the design: 82 rows and five columns did not justify a
  dependency, and hand-rolling gave better control over the tri-state comparator.
- Accessibility verified in-browser: `aria-sort` on every sortable header, `th scope=row`
  for names, accessible names on all expand controls, every input labelled, a table
  caption, and a visible focus ring. `prefers-reduced-motion` disables the animations.

**Not yet done:** the page has no authentication. That is stage 8, and it must not be
deployed before then.

## Stage 7: Upload UI with preview/approve
Goal: Drag-drop upload, seven-stage progress, diff preview, explicit approval before commit.
Success Criteria:
- Diff shows added/changed/removed records and roster deltas before anything is written.
- Anomalies (proposed closures, unresolved names, low-confidence reasons) must be
  resolved before Approve enables.
- Rejecting an upload leaves the database untouched.
Status: **Complete** — 13 new tests (164 total). Verified end to end in a browser with the
real workbook.

Notes from the build:
- **The sheet already answered half the July mystery.** `"Office closed"` is written on the
  *totals rows* — which the parser correctly discards as attendance — against 2026-07-01,
  one of the two ambiguous zero-attendance required days. The parser now keeps prose found
  on discarded rows and the preview shows it as evidence beside the question.
- **September was about to be flagged as eleven office closures.** Every September required
  day has zero attendance because the month has not happened. Anomaly detection now ignores
  dates later than `asOf`, leaving exactly the two genuine July questions.
- **A proposal that is offered must be honoured.** Accepting "Read the column as 2026-06-01"
  originally did nothing — the parser still withheld it. The workbook is now re-read with
  confirmed columns applied, and that column imports 70 records.
- **Batched the writes.** Row-at-a-time meant ~200 network round trips to Neon and a 19s
  commit. Batching employees, aliases, reasons and exemptions, and raising the chunk size
  to 2,000, brought it to 11s. Preview is 2.9s.
- Pre-existing stage 3 and 4 tests had to answer the new gate. They decline every proposal
  via a shared `importDeclining` helper, which changes no data and keeps their assertions
  about the file exactly as they were.
- The file is re-sent for the commit rather than held server-side between preview and
  approval — it is small, and it means no half-finished import sits anywhere.

## Stage 7b: Emailer
Goal: Bulk-mail non-compliant people via n8n and MS Graph, with each person's own
attended/missed dates appended.
Success Criteria:
- Category picker builds a recipient list; exempt people are never included.
- Email addresses can be pasted in and matched to the roster.
- Dry run exercises the whole chain, including Microsoft auth, and sends nothing.
- Every send is recorded with the dates it quoted.
Status: **Complete** — 42 new tests (206 total). n8n workflow `ihvZfOZeDcc7yvV9` built via
MCP and verified live: valid dry run 200, malformed address 400, missing secret 403.

Notes from the build:
- **The workflow used to answer 200 with an empty body on a validation failure.** A thrown
  error in a Code node skips the respond node, so n8n falls back to a bare 200 — which the
  app would have recorded as a successful send. Validation failures are now *returned*, and
  routed to a real 400. The client also refuses to treat anything but an explicit `ok:true`
  as a send.
- Three exclusions are enforced in the library, not the interface: exempt people, people
  with no address, and anybody whose verdict is not NO. **`NA` is not a failure** — mailing
  the September "not yet" cohort would be the original bug with a stamp on it.
- Excused days are listed separately and labelled as not counted. Telling somebody they
  failed to attend on a day they were signed off sick is how a system gets switched off.
- A real send needs `confirm: "SEND"` **checked on the server**, so clicking about in the
  network tab cannot shortcut it.
- Fixed a leaked timer in the send client (one dangling `setTimeout` per recipient) and a
  race in the recipient loader where flicking between categories could land an older
  response on top of a newer one.

### Open questions for you

1. **Sender address.** The spec says "my email address". The only Microsoft Graph
   credential on the n8n instance sends as `notifications.za@vml.com`, so that is the
   default (`OFFICE_ATTENDANCE_SENDER` in `.env.local`). Sending as you personally needs a
   credential with `Send as` rights on your mailbox.
2. **"This week"** is not a metric the system has. The three categories offered are the
   three columns that exist: this month, two-week, and long-term.
3. **"Sent" means accepted by Microsoft for delivery**, not delivered. Graph answers 202 on
   accept; a later bounce is not visible to this system.

## Stage 7c: People who have left
Goal: Mark anybody no longer on the newest sheet as having left, keep them out of the
current month, and never email them.
Success Criteria:
- Leavers detected from the roster, not from attendance.
- Hidden from the report for months they were not on, with a toggle and a count.
- Never appear in an email list.
- Somebody who reappears is un-marked automatically.
Status: **Complete** — 8 new tests (214 total). 15 of 82 marked as having left.

Notes from the build:
- **The signal is the roster, not attendance.** Somebody on the newest sheet with a month
  of zeroes has not left — they are precisely who the report exists to surface. Francesca
  Tiganis has not attended once in seven months and stays ACTIVE. It is disappearing from
  the sheet that means gone.
- **Rejoining is handled by the same rule in reverse.** A name left off one month by
  mistake corrects itself on the next upload rather than needing anyone to remember.
- Two independent guards keep a leaver out of an email: the durable `status`, and whether
  they were on that month's sheet at all. Either alone is sufficient.
- Their history is untouched — Chadley Potgieter left after August and still appears in
  the August report, because he was on the August sheet.
- **Kelly-Ann Tabone is both exempt and departed.** The departure check runs first, so she
  is excluded as LEFT. The exempt count dropped from 7 to 6 for that reason.

## Stage 8: Auth, deploy, docs
Goal: Behind authentication, on Vercel, documented.
Success Criteria:
- No unauthenticated route exposes employee data; uploaded files in private storage.
- Full test suite green; deployed and verified against production.
- `.claude/DEVELOPER_LOGS.md` written.
Status: **Auth and docs complete** (16 new tests, 230 total). Deploy awaiting your go-ahead.

Notes from the build:
- **Next 16 renamed `middleware.ts` to `proxy.ts`.** Checked rather than assumed — the old
  name still builds but logs a deprecation.
- **Closed by default.** The proxy lists the handful of open paths explicitly and closes
  everything else, so a route added next year is private the moment it exists rather than
  whenever somebody remembers. There is a test asserting exactly that.
- **A missing `AUTH_SECRET` returns 500, not open access.** The safe reading of "I cannot
  check whether you are allowed in" is no.
- Verified over HTTP with no cookie: pages 307 to the login screen, API routes 401, and no
  employee name or address appears in any response body. A forged cookie is rejected.
- Sessions are HMAC-signed, expire after 12 hours, and the cookie is httpOnly, sameSite
  lax, and secure in production. Password comparison is constant-time.
- The login `next` parameter only ever redirects within the app — an open redirect there
  would make a link that looks like ours land somewhere that is not.

## Stage 9: A second office
Goal: Track more than one office, each with its own staff list and workbook, without
either one's data touching the other.
Decisions taken (2026-09-09): one home office per person — visiting another office stays
an explained absence, exactly as "In JHB" works today. The report and emailer show one
office at a time, chosen with a picker.

Success Criteria:
- Uploading one office's workbook cannot alter another office's attendance.
- Two people with the same name in different offices stay two people.
- An office closure applies only to that office; public holidays stay national.
- Report and emailer pick an office; the emailer cannot mail two offices at once.
- Existing data ends up on Cape Town with nothing lost.
Status: **Complete** — 5 new tests (246 total). Cape Town and Durban both exist; Durban is
empty and waiting for its workbook.

Notes from the build:
- **The re-sync would have deleted the other office's data.** Fenced to the importing
  office, with a test that imports the same workbook as two offices and checks the first
  survives byte for byte.
- Identity is unique per office now, not per company. The same workbook imported as two
  offices produces two Zoe Flanegans, which is correct.
- Closures live in their own table and are folded into the calendar per office; public
  holidays stay national and shared.
- `resolveOffice` falls back to the *first* office rather than to "all", because both
  views that use it are safer scoped — an emailer defaulting to every office would be one
  careless click from mailing two cities at once.
- Found a display bug on the way: the header took its required-day count from the first
  non-exempt row, which broke as soon as somebody off the month's roster sorted to the
  top. It now takes the largest denominator anyone has.

**To add Durban's data:** `npm run office -- list` to check it exists, then upload its
workbook at /upload and pick Durban from the office selector.

Note that "In JHB" is one of the most common absence reasons in the Cape Town data (31
cells), and Johannesburg is *not* an office in this system. Travel to another office stays
an explained absence for the office the person belongs to, which is the right behaviour
whether or not that other office is tracked here.

The dangerous part was the re-sync added in stage 8b. It deletes attendance for anyone not
listed on a month's sheet, scoped only by date — so a Johannesburg upload would delete
every Cape Town record for those months. That is fixed first, before a second office can
exist to trigger it.

Also globally scoped and needing office boundaries: `employees.normalised_key` and
`employee_aliases.raw_name` are unique across the whole table, so same-named people in
different offices would merge; and `OFFICE_CLOSED` sits on the shared calendar, so closing
one office would excuse the other. Public holidays are national and stay shared.

## Stage 10: Keeping the register in the app
Goal: Stop the spreadsheet being the way attendance arrives. Upload a staff list per
office, then tick a weekly register directly.
Status: **Complete** — 32 new tests (278 total).

What it replaces: 2,641 lines of parsing, identity resolution, anomaly detection and reason
classification existed only because the input was a workbook somebody edited by hand. New
data no longer goes through any of it. The importer stays for the history it brought in,
and as a fallback.

Notes from the build:
- **Only Wednesdays and Fridays appear.** The old sheets recorded all five weekdays and the
  system discarded three of them, which is a lot of ticking for nothing. A week is two
  columns.
- **Public holidays and closures cannot be ticked** — they show the reason instead. The
  calendar work already decided nobody is absent on a day the office was shut; the register
  should not invite somebody to record it by hand.
- **Saved as you go, one cell per request.** No save button, because a register is filled
  in while somebody looks around the office and a button is a thing to forget. One request
  per cell keeps a failure local to one person's day.
- **A comment marks the week, not the day.** The reasons people give are almost always
  about the week — "on leave", "in Durban" — and asking for the same sentence twice is how
  a register stops being filled in.
- **An import never overwrites a hand-entered day.** The register is filled in by somebody
  looking at the office; a spreadsheet uploaded later is a copy of what somebody once
  thought. `attendance.source` records which, and the importer reports how many it left
  alone.
- Comments offer the reasons already in use as suggestions. "On leave", "On Leave" and
  "on leave" became three separate things last time; this is the cheapest way to stop it.

**Still to decide:** individual logins. There is one shared password, so "who recorded
this" cannot be answered yet. That matters more now that several people in two cities will
be entering data.

## Stage 11: Recent form — not chasing people who have mended their ways
Goal: A monthly fraction is cumulative, so an early miss follows somebody all month however
well they behave afterwards. Add a recency signal so the chase list reflects current
behaviour rather than the worst thing somebody did on the 2nd.
Decisions taken (2026-09-22): the window is the required days **since the last reminder was
sent**, falling back to the **last four required days** for anybody never emailed. People
who are improving stay on the email list, flagged, rather than being removed.

Success Criteria:
- Somebody who missed early and has attended every required day since shows as Improving.
- The window is measured from their last reminder where one exists.
- All-excused or not-yet-recorded recent days mean "cannot tell", never "improving".
- The monthly verdict is unchanged — it is still true, just no longer the only thing shown.
- Real examples pass: Mark Haefele (A A P P P P) and Matthew van Niekerk (A P P P P P)
  are flagged; somebody still missing is not.
Status: **Complete** — 15 new tests (315 total).

Scored with the same `score()` the monthly verdict uses, so the two can never disagree
about what an excused or unrecorded day means. An exempt person is never "improving", and
neither is somebody already compliant.

Deliberately not a weighted or decaying score. It would rank people well, but the email
quotes somebody's own days back to them, and "your recency-adjusted compliance is 0.71" is
not a sentence anybody can check. "You have been in every required day since the 9th" is.
