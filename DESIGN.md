# Office Attendance — System Design

> Status: draft for review. Written after a full forensic read of `data_example.xls.xlsx`
> (8 sheets, Mar–Sep 2026, ~70–80 people, ~1,500 cells per month).

---

## 1. What the spreadsheet actually is

The spec describes a file with "names and a column for each date with a check where the
person has been in the office", where "the data isn't 100% clean" and therefore needs an
AI layer to read it.

Having pulled the file apart cell by cell, the reality is more specific — and better news
than the spec assumes:

**The workbook is one sheet per month, not one file per week.** Sheets are named `March`
… `September`, plus a stray `Pdf` sheet holding a single week (24–28 Aug 2026) in a
slightly different shape. Every upload therefore carries *the whole year to date*, not a
week's increment.

**The grid is already clean.** Attendance cells are literal `0` and `1`. Not ticks, not
crosses, not "Y". Out of roughly 10,000 attendance cells across seven months, exactly
**zero** contain an ambiguous truthiness marker.

**The mess is confined to three places:**

| Where | What it looks like | Volume |
|---|---|---|
| Free-text absence reasons written *in place of* the 0/1 | `On leave`, `on leave `, `On Leave`, `Sick`, `BOOKED OFF SICK`, `son at ER`, `Plumbing situation`, `Affected by storm`, `"Office closed"` | ~290 cells, **~65 distinct strings** |
| Employee names | `Zakiya Karim` vs `Zakiyya Karim`; `Weslee Johannesen` vs `Weslee Johanneson`; `zoe Flanegan` vs `Zoe Flanegan`; `Brian` and `Intern` with no surname at all | 88 distinct name strings for ~75 real people |
| Sheet furniture | blank spacer columns between week blocks (`I`, `O`, `U`, `AA` — and they *move* every month); a totals row (`6, 5, 3, 1, 7, 7`); trailing legend rows (`Richard Shelton`, `Weslee Johannesen`) sitting below a blank gap; stray header labels like `O1 June` and `10 Aug` where a date serial should be | every sheet |

**Dates are Excel serials, not text.** `46083` → `2026-03-02`. Deterministic to decode.

### Consequence: the AI layer should move

The spec puts AI at the front of the pipeline, parsing the spreadsheet. That is the wrong
place for it. Sending 1,500 cells per sheet through a model to read digits that are
already digits is slow, expensive, and — worst — *non-deterministic*: re-uploading the
same file could produce different attendance records, which is fatal for a compliance
report someone might act on.

**Deterministic parser first; AI only where the data is genuinely linguistic.** Two narrow,
cacheable jobs:

1. **Reason normalisation** — map ~65 distinct free-text strings onto a controlled
   vocabulary (`SICK`, `ANNUAL_LEAVE`, `FAMILY_RESPONSIBILITY`, `TRAVEL_OTHER_OFFICE`,
   `WFH_APPROVED`, `PUBLIC_HOLIDAY_OR_CLOSURE`, `PERSONAL_EMERGENCY`, `UNKNOWN`), each with
   a `counts_as` verdict.
2. **Identity resolution** — only for names the exact/normalised matcher fails on, and
   always as a *suggestion a human confirms*, never a silent merge.

Both are keyed by the raw string and cached in the database, so the model is called once
per novel string, ever. In steady state a monthly upload makes **zero to three** model
calls. See §6.

---

## 2. Four things the spec gets wrong (these matter more than the architecture)

### 2.1 The default view is broken on the 1st of every month

> "Compliant? — if an employee has attended the office every Wednesday and Friday for the
> current month this will be YES, otherwise NO"
>
> "…the ability to filter the page by month (it will default to the current month)"

Today is **1 September 2026**. The September sheet has all its date columns laid out but
**not a single `1` in any of them** — the month hasn't happened yet. Under the rule as
written, the default view on the day you open the app shows **every employee as
NON-COMPLIANT**, and stays that way until the last Friday of the month.

The same thing happens every month, on day one, forever.

**Fix:** compliance is measured against *required days that have already elapsed*. On
9 September the denominator is the Wednesdays and Fridays up to and including today — not
all of them. Show the fraction, not just the verdict: `YES 3/3`, `NO 2/3`. A bare
YES/NO hides whether "NO" means *missed one* or *missed everything*, and that distinction
is the whole point of the report.

### 2.2 Public holidays make everyone non-compliant

Wednesdays and Fridays with **zero attendance across the entire company**:

```
2026-04-03  Fri   Good Friday
2026-05-01  Fri   Workers' Day
2026-07-01  Wed   ┐ whole-company absence, not an SA public holiday
2026-07-03  Fri   ┘ (office closure? sheet never filled in?)
```

Under the naive rule, every employee is non-compliant for April and May. Someone somewhere
in the file already noticed this and typed `"Office closed"` into a cell as a workaround.

**Fix:** a first-class `calendar_days` table marking each date `WORKING`,
`PUBLIC_HOLIDAY`, or `OFFICE_CLOSED`. Non-working days are removed from the denominator
entirely — they can neither help nor hurt. Seed it with the South African public holiday
calendar; let the importer *propose* closures when a required day has zero attendance
across an otherwise-populated sheet, and let you confirm them in the UI.

That last bit is important: July 1st and 3rd are ambiguous from the data alone. Zero
attendance either means the office was shut, or means nobody filled the sheet in. Those
are opposite verdicts and only a human knows which. The system should ask, not guess.

### 2.3 Some people are excused, and the spec has nowhere to put that

Column C is a standing per-employee note. It is not date-specific and it is not an
absence reason — it is a *permanent exemption*:

```
Kevin Irwin           Stays in George
Jana Kleinloog        Stays in Hermanus      (~400 km from Cape Town)
Hannerie Lotz         Stays in Paarl
Sandra McDiarmid      Stays in George
Rialene Nel           From Paarl
Kelly-Ann Tabone      Stays in Lagebaan
Mary Rodrigues-Jack   On Maternity Leave
Lorna Downs           Approved to work from home every Thursday
```

Kevin Irwin lives ~430 km away and has a `0` in every single cell for seven straight
months. Reporting him as NON-COMPLIANT every month is not information; it is noise that
trains you to ignore the red.

**Fix:** compliance is **tri-state, not binary** — `YES` / `NO` / `EXEMPT`, plus `N/A`
for people without enough history to judge. Exempt employees are excluded from the
denominator and can be filtered out of the default view. The exemption is a structured
record (type, reason, effective from/to), not a free-text note, because "on maternity
leave" ends and "lives in George" doesn't.

Note also that the wording drifted between months — `Stays in Hermanus` in March became
`From Hermanus` by August. Same fact, different string. Exemptions belong on the employee
record, sourced from the sheet but not re-derived from its phrasing every time.

### 2.4 "It will append" is the wrong sync model

> "It will append to existing data i.e. it will add whichever dates are not yet in the
> system."

Every upload contains all seven months, and **past months get edited** — someone
retrospectively types `On leave` into a cell for a date three weeks ago. Append-only means
those corrections are silently discarded and the app's numbers permanently diverge from the
spreadsheet everyone else is looking at.

**Fix:** every upload is a **full re-sync (upsert)** over the date range the file covers,
with an append-only `attendance_history` audit trail so "when did Mary's 12 June change
from absent to on-leave, and which upload did it?" is answerable. The import shows you a
diff — *"47 new records, 3 changed, 1 employee added, 2 employees no longer present"* —
and you approve before anything is committed.

---

## 3. Three smaller traps found in the data

**Employee churn is real and unmarked.** 26 of 88 name strings appear in only some months.
`Chantal Brunette` appears in March alone; `Intern` shows up in August. Long-term
compliance ("average 3 Wednesdays and 3 Fridays per month") computed against a fixed
7-month window punishes anyone who joined in July. Every employee needs a derived
`first_seen` / `last_seen` window, and averages must divide by *months employed*, not
months elapsed. Someone with under two complete months of history gets `N/A`, not `NO`.

**Rows below the blank gap are a legend, not data — usually.** May has `Ben Clay`,
`Zoe Flanegan` and `Jason Tucker` appearing twice; the second copy sits below the blank
gap with entirely empty cells. Safe to drop. But June's `Weslee Johannesen`, in the same
position, has a genuine `1` in it. So the rule is *"drop rows with no attendance data at
all"*, not *"drop everything after the first blank row"* — and duplicates that survive
that filter get merged with `1` winning, with a warning surfaced in the import report.

**A totals row is hiding in the grid.** August row 72 holds `6, 5, 3, 1, 7, 7` — column
sums, no name. Any cell value that is numeric but not 0 or 1 marks its row as
non-employee furniture. Every stray number in the whole workbook (`5`, `3`, `36`, `22`…)
comes from exactly this.

---

## 4. Data model

```
employees
  id, first_name, last_name, display_name, normalised_key
  first_seen_date, last_seen_date, status (ACTIVE | DEPARTED)
  created_at, updated_at

employee_aliases                 -- every raw name string ever seen, incl. typos
  id, employee_id, raw_name, source_upload_id, confirmed_by_human, created_at

exemptions                       -- from column C; structured, not free text
  id, employee_id, type (REMOTE_LOCATION | PARENTAL_LEAVE | APPROVED_WFH | OTHER)
  raw_text, effective_from, effective_to (nullable), active

attendance                       -- one row per employee per date. Current truth.
  employee_id, date  [PK]
  state (PRESENT | ABSENT | ABSENT_EXPLAINED | NOT_EMPLOYED)
  raw_value                      -- exactly what the cell held, always kept
  reason_id (nullable), source_upload_id, updated_at

attendance_history               -- append-only; every change, forever
  id, employee_id, date, old_state, new_state, upload_id, changed_at

reasons                          -- the AI cache. One row per distinct raw string.
  id, raw_text [UNIQUE], category, normalised_text
  counts_as (EXCUSED | UNEXCUSED | NOT_A_REASON)
  confidence, model, reviewed_by_human, created_at

calendar_days                    -- what the compliance denominator is built from
  date [PK], day_type (WORKING | PUBLIC_HOLIDAY | OFFICE_CLOSED | WEEKEND)
  is_required_day (bool)         -- Wed/Fri AND working
  label, confirmed_by_human

uploads
  id, filename, sha256 [UNIQUE], uploaded_at, uploaded_by
  status (PENDING | PREVIEWED | COMMITTED | REJECTED)
  date_range_start, date_range_end, stats_json, warnings_json
```

`sha256` on `uploads` makes re-uploading the same file a no-op rather than a duplicate run.

Compliance is **computed, never stored** — the rules will change once you see real output,
and stored verdicts go stale silently. Cache per `(employee, month)` with the calendar
version as part of the key if the page gets slow; it won't at 80 employees.

### Why `state` is four values

`ABSENT` and `ABSENT_EXPLAINED` are different facts and you will want them separated in the
UI ("Nadine missed both required days — one sick, one unexplained"). `NOT_EMPLOYED` keeps
joiners and leavers out of denominators without special-casing every query. And `raw_value`
is retained on every row so that if the reason vocabulary changes, everything can be
reclassified from source without a re-upload.

---

## 5. Import pipeline

Seven stages, deterministic until stage 4, and **nothing is written until you approve a diff**.

```
  ┌─ 1 ─────────────┐   file → sha256 → dedupe check → store blob
  │  Ingest         │
  ├─ 2 ─────────────┤   per sheet: locate header row, decode Excel date serials,
  │  Structural     │   drop spacer columns, drop the totals row, drop legend rows
  │  parse          │   with no attendance data, stop at the real end of the roster
  ├─ 3 ─────────────┤   0 → ABSENT · 1 → PRESENT · blank → ABSENT
  │  Cell classify  │   text → ABSENT_EXPLAINED + reason lookup
  │  (rules only)   │   numeric >1 → furniture, flag the row
  ├─ 4 ─────────────┤   ONLY distinct raw strings not already in `reasons`
  │  AI: reasons    │   → category + normalised text + counts_as + confidence
  ├─ 5 ─────────────┤   ONLY names the deterministic matcher missed
  │  AI: identity   │   → ranked candidate matches, surfaced for human confirmation
  ├─ 6 ─────────────┤   required days with company-wide zero attendance
  │  Anomaly detect │   roster additions/removals · duplicate names · date gaps
  │  (rules only)   │   unfilled trailing columns (future dates)
  ├─ 7 ─────────────┤   diff vs current DB → YOU APPROVE → transactional upsert
  │  Preview→commit │   + history rows + calendar confirmations
  └─────────────────┘
```

**Stage 3's matcher** normalises aggressively before it ever considers asking a model:
casefold, strip accents and punctuation, collapse whitespace, then exact match on
`normalised_key`, then match against `employee_aliases`. `zoe Flanegan` → `Zoe Flanegan`
and `Weslee Johanneson` → `Weslee Johannesen` (Levenshtein ≤ 2 on an otherwise-unique
surname) are handled here, without AI. Realistically only `Brian` and `Intern` — genuinely
incomplete records — reach stage 5, and the honest answer for those is to ask you.

**Stage 7 is the safety rail.** A compliance report that silently changed history is worse
than no report. The preview screen shows counts, the anomalies, the proposed calendar
closures, and any low-confidence classifications, with a single Approve.

---

## 6. The AI layer, concretely

**Model:** `claude-opus-5` — $5/MTok in, $25/MTok out.

**Structured output** via `output_config.format` with a JSON schema, so the response is
validated against the reason vocabulary rather than parsed out of prose. **Prompt caching**
on the system prompt + vocabulary definitions (stable prefix), with the batch of novel
strings after the last cache breakpoint.

**Cost, honestly:** the entire seven-month backlog is ~65 distinct strings — one request,
a few thousand tokens, well under a cent. Steady state is one or two new strings a month.
This is a rounding error, which is exactly why the cheaper-model question isn't worth
asking; correctness on the categorisation is worth more than the fractions of a cent.

Classifications are cached by exact raw text and marked `reviewed_by_human` once you
confirm them. A reason you have reviewed is never re-sent to the model.

**The policy split still holds.** The model assigns the category (`SICK`,
`ANNUAL_LEAVE`, …); a policy map you control decides what each category does to the numbers.
Per the decision in §10 that map ships with a single default rule — *any recorded reason
excuses the day* — which means the model's job is genuinely just normalisation, and a
misclassification changes a label in the UI rather than a compliance verdict. That is a good
place to be. The map stays editable in case you later want a category to stop excusing.

---

## 7. Compliance rules, restated precisely

Let `R(e, window)` = required days in `window`, where a required day is a date that is
Wed or Fri **and** `day_type = WORKING` **and** falls inside `e`'s employment window
**and** has already elapsed (`date <= today`).

Excused days (any `ABSENT_EXPLAINED`) are removed from `R` before evaluation, per §10.

| Column | Rule | Non-YES/NO outcomes |
|---|---|---|
| **Compliant?** | `PRESENT` on every day in `R(e, selected_month)` | `EXEMPT` if actively exempt; `N/A` if `R` is empty (start of month, all-holiday month) |
| **Two week** | ≥1 Wed **and** ≥1 Fri `PRESENT` in the last 14 days | `N/A` if the window contains no required Wed or no required Fri |
| **Long term** | Mean Wednesdays/month ≥ 3 **and** mean Fridays/month ≥ 3, averaged over **complete months since joining** | `N/A` if fewer than 2 complete months of tenure |
| **Last attended** | Max date where `state = PRESENT` | `Never` — and this is meaningful, not an error |

Display the working, not just the verdict: `NO 2/3`, `YES 4/4 · 1 excused`,
`N/A · joined 12 Aug`. Sorting must handle the non-boolean states — order
`NO → YES → N/A`, so the people who need attention sort to the top by default. Exempt rows
are hidden by default (§10) and sort last when revealed.

A caveat worth stating out loud: "average 3 Wednesdays and 3 Fridays per month" is
arithmetically unreachable in a month containing only 4 required Wednesdays where one is a
public holiday. The rule is a reasonable long-run target but it will produce odd results
on short months. Worth revisiting once you've seen a few months of real output.

---

## 8. Stack

| Layer | Choice | Why |
|---|---|---|
| App | **Next.js 15, App Router, TypeScript** | Server Components render the table server-side; one deployable; matches your other projects |
| DB | **Postgres** (Neon, via Vercel) | Real dates, real constraints, real transactions. SQLite is fine locally |
| ORM | **Drizzle** | Typed schema, readable SQL, honest migrations |
| Parsing | **SheetJS (`xlsx`)** | Handles `.xls` and `.xlsx`; gives raw cell values and types, which is what stage 2 needs |
| AI | **`@anthropic-ai/sdk`**, `claude-opus-5` | §6 |
| Table | **TanStack Table** | Sorting, multi-column, custom comparators for tri-state columns |
| UI | **Tailwind + shadcn/ui** | |
| Auth | **One shared password, or Vercel access protection** | It's HR-adjacent data about named individuals. Do not ship this on a public URL |
| Host | **Vercel** | |

Upload runs in a Route Handler, not a Server Action — you want a real progress response and
a job you can retry.

### On authentication and data sensitivity

This is a named list of employees with reasons for absence including illness, family
emergencies and maternity leave. That is sensitive personal information under POPIA. Three
things follow: put it behind auth from commit one; keep the uploaded workbooks in private
storage, not `/public`; and don't send reason strings to the model with names attached —
stage 4 sends *distinct reason strings only*, with no employee identifiers, which happens
to be both cheaper and correct.

---

## 9. Interface

**Main table** — employees down, the four columns from the spec across, plus `Exempt` and
`Reasons this month`. Month picker defaults to current. Filters: hide exempt (default on),
show only non-compliant, search by name. Every column sortable. A row expands to a small
month calendar showing that person's Wed/Fri grid with reason chips — because the first
question after "Nadine is NON-COMPLIANT" is always "which days, and did she say why?".

**Import screen** — drag the workbook, watch the seven stages, land on the diff. Anomalies
and proposed holiday closures are resolved inline before Approve is enabled.

**Admin** — the reason vocabulary and its policy map; the calendar; employee merges and
exemptions.

Header stats worth having: required days elapsed this month, company-wide attendance rate
per required day (this is what exposes a mis-marked holiday immediately), and count of
people needing attention.

---

## 10. Decisions taken (1 Sep 2026)

All four open questions are now answered. Recorded here so the reasoning survives.

**1. Explained absences are EXCUSED — compliance-neutral.**
A required day where the employee was sick, on leave, at another office, or otherwise had a
recorded explanation is removed from the denominator entirely. It can neither help nor hurt.
Only `ABSENT` (a bare `0` with no explanation) counts against someone.

This makes the reason vocabulary load-bearing rather than decorative: a string the model
classifies as `UNKNOWN` still excuses the day, because *something was written in that cell*
and the honest reading is that an explanation existed. The policy map from §6 still ships —
it now has one default rule (`any recorded reason → EXCUSED`) rather than a per-category
table, and remains editable if you later want, say, `WFH` to stop excusing.

Consequence worth watching: someone with three sick Wednesdays reads as `YES 1/1`. The
verdict is right under this policy, but the row would look misleadingly clean, so the table
shows excused days alongside the fraction — `YES 1/1 · 3 excused` — and the expanded row
lists them. A high excused count is itself a thing you'd want to see.

**2. Exempt employees are HIDDEN by default.**
Filtered out of the main table, with a toggle to reveal them and a count in the header
(`68 shown · 7 exempt hidden`). Keeps the default view to people who need attention.
Exemptions are still first-class records with effective dates, so Mary's maternity leave
ends and she rejoins the main view automatically.

**3. Compliance measures ELAPSED required days only.**
Confirmed as §2.1 and §7. The denominator for the current month runs up to and including
today. Displayed as a fraction throughout.

**4. Stack: Next.js on Vercel, with Neon Postgres.**
As §8. Neon confirmed as the database.

---

## 11. Open items for later

Not blocking, but flagged so they don't get lost:

- **July 1st and 3rd** — company-wide zero attendance, not SA public holidays. The importer
  will propose them as closures; you'll need to tell it whether the office was shut or the
  sheet was never filled in. Opposite verdicts, and only a human knows.
- **`Brian` and `Intern`** — no surname. Will surface as unresolved on first import.
- **The "3 Wednesdays and 3 Fridays per month" long-term rule** is arithmetically
  unreachable in a month with 4 required Wednesdays where one is a public holiday. Fine as a
  long-run target; worth revisiting once you've seen real output.
- **The `Pdf` sheet** (single week, 24–28 Aug, different shape) — currently treated as a
  duplicate of data already in the August sheet and skipped. Confirm that's right.
