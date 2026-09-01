# Developer Logs

## 2026-09-01 — Design, and Stage 1: the parser

The spec asked for an AI layer to read a messy spreadsheet. Before writing any of it we
pulled the sample workbook apart cell by cell — eight sheets, seven months, about ten
thousand attendance cells — and found the premise was off in a useful way.

The grid isn't messy. Every attendance cell is a literal boolean: TRUE or FALSE, 1,443
of the former and 8,778 of the latter, with not a single ambiguous tick or cross among
them. What *is* messy is the language around the edges — roughly 65 distinct free-text
absence reasons (`On leave`, `on leave `, `BOOKED OFF SICK`, `son at ER`, `Plumbing
situation`) and the employee names, where `Zakiya`/`Zakiyya` and `Johannesen`/`Johanneson`
are the same people spelled two ways.

So the AI moved off the critical path. Running ten thousand already-clean cells through a
model would be slow, expensive, and — the part that actually matters — non-deterministic:
the same file could import differently twice, and a compliance report that quietly changes
its mind is worse than no report. The parser is now pure rules; the model gets the ~65
strings, cached forever by exact text, and nothing else.

Reading the data also broke four rules in the spec. The loudest: "compliant = attended
every Wednesday and Friday this month" combined with "default to the current month" marks
*every employee non-compliant on the 1st of every month*, because the month hasn't happened
yet. September in the sample is exactly that — every column laid out, not one filled.
Public holidays do the same thing at company scale: Good Friday and Workers' Day both fall
on required days and both show zero attendance across the entire company. Someone had
already noticed and typed `"Office closed"` into a cell as a workaround. All four are
written up in DESIGN.md with the decisions taken.

### The parser

Rule-based, deterministic, and it withholds rather than guesses. Two findings shaped it.

The first was the booleans. SheetJS hands back `{t:"b", v:false}` where the sheet appears
to show a zero, so the naive `String(cell.v)` produced the string `"false"` in the records.
Caught by a golden test comparing against a hand-verified cell.

The second was more interesting. We started by assuming the columns before the first
recognised date were name and comment columns. That's wrong for June, whose 1st-of-the-month
column is headed `O1 June` — a capital O typed for a zero — and therefore doesn't parse as
a date, and therefore got treated as a note column and had its 70 attendance values
concatenated into everyone's standing-note field. The fix is to stop asking the header what
a column is and ask the contents instead: attendance columns are dense with 0/1, note
columns never contain any. That single change fixed the note pollution, found the broken
header, and generalised to the note column that loses its `Comment` heading from July
onward.

Malformed headers are flagged with a *proposed* reading — `O1 June` → 2026-06-01 — but only
when the guess is corroborated by the dates in the surrounding columns, and the column's
data stays withheld until a human confirms. August's `10 Aug` gets a different message
because that column is empty below the header: no data to withhold, but a day the sheet
meant to record and never did.

### What the tests are really for

The counts are asserted exactly, so any change has to be a decision rather than a surprise.
Five of the first test run's failures were the parser being right and our assumptions being
wrong — nine totals rows rather than one, a `YONDER` division divider on every sheet, and
`Weslee Johannesen` genuinely having no surname because the full name sits in the first-name
column. Those became documented expectations.

The trap worth remembering: June's Weslee row sits below the blank gap exactly where the
legend rows live, but it carries a real `1`. So the drop rule is "no attendance data",
never "below the gap". There's a test named after it.

### Housekeeping

`xlsx` on npm is abandoned at 0.18.5 with two high-severity CVEs and `npm audit` reporting
"no fix available" — SheetJS moved distribution to their own CDN. Installed 0.20.3 from
`cdn.sheetjs.com` instead; audit is clean.

**Next:** Stage 2, the Neon Postgres schema, with the SA public holiday calendar seeded so
April and May stop reading as company-wide failure.

## 2026-09-01 — Stage 2: the schema, and a solved mystery

Stage 1 left a loose end. The August sheet had a column headed `10 Aug` with absolutely
nothing under it, and the parser flagged it as "a day the sheet meant to capture and never
did" — accurate, but not an explanation.

The calendar explains it. National Women's Day is 9 August, and in 2026 that falls on a
Sunday. The Public Holidays Act moves such a holiday to the following Monday, so 10 August
2026 is a public holiday. The column exists because whoever laid the month out worked from
a template; it is empty because the office was closed. Nobody typed anything because there
was nothing to type.

That is the whole argument for this table in one example. Without a calendar the system
reads an empty column as mass absence, and the same thing happens at much larger scale in
April and May, where Good Friday and Workers' Day both land on Fridays and show zero
attendance across all ~75 employees. Naively that is the entire company failing twice a
year.

Holidays are computed rather than listed — Easter via the anonymous Gregorian computus,
the ten fixed dates from the Act, then the Sunday rule applied over the top. It means the
2027 calendar needs no one to remember anything. It also surfaced a wrinkle worth knowing:
December 2026 has only seven required days, because 16 December is a Wednesday and
Christmas Day a Friday. That is precisely the month where "an average of three Wednesdays
and three Fridays" becomes arithmetically awkward, which is the caveat already flagged in
the design.

### Constraints that actually bite

`attendance.date` carries a foreign key to `calendar_days`. That sounds fussy until you
consider the alternative: attendance rows sitting on dates the compliance engine has never
heard of, quietly excluded from every denominator, discovered months later when a month
reads oddly. The FK turns calendar coverage into a hard precondition of import.

The tests run against PGlite — real Postgres compiled to WASM — so a unique violation is a
genuine unique violation rather than a mock agreeing with itself. That mattered
immediately: the first run showed six constraint tests "failing" while the constraints
were in fact working perfectly. Drizzle wraps driver errors in a `Failed query: ...`
Error, so matching on the message tested the wrapper, not the database. Asserting on the
SQLSTATE code instead (`23505`, `23503`, `22P02`) is both correct and more precise about
what is being claimed.

One deliberate piece of restraint: re-seeding never overwrites a day someone has confirmed.
The importer can only ever *propose* that a zero-attendance day was an office closure — the
data genuinely cannot distinguish "the office was shut" from "nobody filled the sheet in" —
so when a human rules on it, that ruling has to outlive the next seed.

**Next:** Stage 3, identity resolution and the first real import.
