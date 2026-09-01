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

## 2026-09-01 — Stage 3: identity resolution and the first real import

Eighty-four name strings went in. Eighty-two people came out. The two that collapsed were
`Zakiya`/`Zakiyya Karim` and `Zoe`/`zoe Flanegan`, and neither needed a model to work out —
one is a case difference, the other a single transposed letter.

The rule that does it is deliberately timid. Two names match only if they have the same
number of parts, share at least one part exactly, sit within an edit distance of two, and
are long enough that two edits are a typo rather than a difference. Every clause is there
because of something real in this roster: `Anthea O'Neill'` and `Ashley O'Neill'` are two
people who share a surname and a stray apostrophe; `Jason Tucker` and `Jason Khubeka` share
a first name; `Matthew Rudd` must not absorb `Matthew van Niekerk`. A looser rule silently
combines two employees' attendance into one record, and nobody would ever notice.

Names with no surname never match anything. `Brian` and `Intern` are created as people and
flagged for a human, because there is nothing there to be confident about.

### The bug the integration test caught

The unit tests all passed. The integration test — the real workbook, through the whole
pipeline, into a real Postgres — did not, and the reason was worth the whole exercise.

Similarity matching compared each new name against known employees *and* against people
created earlier in the same run. The trouble is that a person created earlier in the same
run has no database id yet, so the match succeeded, returned `employeeId: undefined`, and
the importer cheerfully created a second employee. `Zakiyya Karim` matched `Zakiya Karim`,
was reported as matched, and became a separate row anyway. Eighty-three employees instead
of eighty-two.

The fix is a canonical key: every resolution now carries the normalised key of the person
it belongs to, whether or not that person exists in the database yet, and the importer
creates one employee per distinct key. Grouping before writing rather than after.

### Corrections to earlier claims

The design said roughly 65 distinct reason strings. It is 35. The earlier figure came from
scanning non-binary cell values before the parser knew how to spot a totals row, so the
numbers `5`, `22`, `36` and friends were being counted as absence reasons. The cost
argument in §6 only gets stronger.

Also: `Jason Khubeka` never becomes an employee at all. Both his appearances are legend
rows below the blank gap with no attendance data, so the parser drops him — correct
behaviour, but surprising if you go looking for him.

### What the data now says

Seven months, 10,453 attendance rows, 1,443 of them present. And September: 1,474 cells,
zero present. That is the current-month problem from the design sitting in the database in
plain sight — the month is laid out and hasn't happened. Stage 4's first job is to not read
that as seventy-five people failing.

The other thing visible now is why stage 5 exists. `On leave`, `On Leave` and `on leave` are
three separate rows covering 96 cells between them. One concept, three spellings, and no
amount of string normalisation will also fold in `booked off` and `Off Sick`.

**Next:** Stage 4, the compliance engine.

## 2026-09-01 — Stage 4: the compliance engine

The engine is pure functions over plain data, with `asOf` always passed in and never read
from the clock. That one decision makes every verdict reproducible and lets the tests stand
on a chosen day and look around — which is how the September case became provable rather
than a thing we believed.

And it is provable now. On 1 September, with 1,474 September cells in the database and not
one attendance among them, the report shows seventy-five dashes and zero accusations. The
original rule would have shown seventy-five reds, every month, on the first.

### The bug hiding in "complete month"

Long-term compliance averages over the complete months a person has worked, so something
has to decide what "complete" means. The obvious answer — they were here from the 1st to
the 31st — is wrong, and the real data proves it: 1 March 2026 is a Sunday, so the earliest
anyone can appear is Monday the 2nd. Everybody looked like a mid-month joiner, and March
silently vanished from all seventy-five long-term averages.

The fix is to measure completeness against the month's first and last *required* days
rather than its calendar edges. Someone present from before the first day that counts,
until after the last, worked a complete month. May has the same shape at the other end: its
final required day is the 29th, because the 30th and 31st are a weekend.

### Two things the engine now says out loud

An explained absence leaves the denominator, so `4/5 (+3ex)` is a real row in the August
report — Carlos Feyder was required on eight days, excused on three, and judged on five.
Showing the excused count matters: without it, a clean-looking `1/1` hides three sick days,
and a suspiciously light month looks like a good one.

`Approved to work from home every Thursday` does not exempt anybody. Thursday is not a
required day, so the note says nothing whatsoever about Wednesday and Friday attendance.
It is recorded, and surfaced for confirmation, but it does not remove Lorna Downs from the
report. The other seven standing notes — four remote locations and a maternity leave — do.

### A finding worth arguing about

Two people out of seventy-five meet the long-term rule. The arithmetic is correct; the
target is simply far above what this office actually does. Roughly 2.5 office days per
person per month against a target of six. A column that reads NO for 88% of the company is
not information, it is wallpaper, and people learn to scroll past it. Flagged in the plan
for a decision rather than quietly adjusted — the rule came from the spec, and changing it
is not ours to do.

**Next:** Stage 5, reason normalisation, where `On leave` / `On Leave` / `on leave` finally
become one thing.
