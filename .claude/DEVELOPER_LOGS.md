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
