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

## 2026-09-01 — Stage 5: the model finally gets a job

Thirty-five strings. That is the entire surface area a language model touches in this
system, and it took four stages of work to get it that small.

The attendance grid never needed one — it is 10,221 literal booleans, and running those
through a model would have been slower, dearer and, fatally, non-deterministic. Identity
resolution did not need one either: eighty-four name spellings collapsed to eighty-two
people on casefolding, punctuation stripping and one conservative edit-distance rule. What
is left is genuinely linguistic and genuinely irreducible — `On leave`, `On Leave`,
`on leave`, `booked off`, `B/day Leave`, `Fam Res leave`, `son at ER`. No amount of string
manipulation folds those into one another.

### Two things the tests caught

The first was a design gap rather than a bug. A note like `Sent Msg on Teams` says only
that somebody sent a message; it gives no reason for the absence, so `UNKNOWN` is the
correct and final answer. But the sync only ever selected rows still marked `UNKNOWN`,
which meant that string would be re-sent on every run for the rest of the system's life to
be told the same thing again. Now `model IS NULL` carries the meaning "never asked", and a
returned `UNKNOWN` is written back with the model stamped on it: still visible to a person,
never re-queried. That is what makes "the second run costs nothing" true rather than
aspirational.

The second was about trust. The first implementation matched the model's answers to the
strings by array position, which is fine right up until a response comes back one entry
short — at which point every subsequent note silently inherits its neighbour's category and
nothing looks wrong. Matching on the returned `rawText` instead means a dropped or reordered
entry degrades to `UNKNOWN`, loudly and locally. There is a test that removes an entry from
the middle of a response and checks that exactly one string is affected.

### Privacy, verified rather than asserted

The prompt contains the reason strings and nothing else — no names, no dates, no employee
identifiers. Rather than take that on trust, the check pulls all 153 distinct name parts
across the 82 employees out of the database and greps the generated prompt for each. None
appears. It happens to be the cheapest option too, but the reason is POPIA.

### On caching

The obvious optimisation here is prompt caching, and it is the wrong one. The system prompt
is about 3,000 characters, which is likely below the minimum cacheable prefix anyway, and
more to the point the database already guarantees each string is classified exactly once in
the lifetime of the system. In steady state a monthly upload sends nothing at all. Not
calling comfortably beats caching the call.

**Still to do:** the single real request. It needs an `ANTHROPIC_API_KEY` in `.env.local`;
until then `npm run reasons:classify -- --show` prints exactly what would be sent.

**Next:** Stage 6, the web interface.

## 2026-09-01 — Stage 6: the interface

The report finally has a face, and the first thing it had to prove is that the September
problem is really fixed. It is: open the page on the 1st and you get seventy-five dashes,
a quiet note saying the month has not started, and nobody accused of anything.

Which immediately exposed a second, smaller problem. A column of dashes is honest but
useless — you cannot sort it, cannot learn anything from it, and the default view is
therefore a dead end on the first of every month. Changing the specified default felt
wrong; the spec says current month and that is a reasonable thing to want. So the header
now says what is going on and offers a way forward: *"No required day has come round yet
this month, so every verdict below reads 'not yet'. Look at August instead."* The default
stays as specified, and nobody lands on an empty screen with no idea what to do next.

### Logic that lives in a component is logic nobody tests

The sorting started life inside the table component, where it worked and could not be
tested. Verdicts are not booleans — NO, YES, NA and EXEMPT have to order sensibly, and
"sensibly" means worst-first, because that is what somebody opening a compliance report
wants to see. That rule deserves a test, so it moved to `lib/compliance/sort.ts` and got
twelve.

One of those tests earns its place on its own: somebody who has never attended sorts as
the most overdue rather than as missing data. An empty string sorts before every real
date, so ascending puts them at the top. Francesca Tiganis and Jenny Luxton have not been
in the office once in seven months, and they should be the first two rows when you sort by
last attended, not the last two.

### What the expanded row is for

The question after "why is Carlos Feyder red?" is always "which days, and did he say
why?". Clicking his row answers it in place: eight required days in August, four in the
office, three explained — two on leave, one Family Responsibility — and one plain absence
on Wednesday the 26th. That is the `4/5 +3ex` in his row, spelled out.

The reason chips currently show the raw spreadsheet text because stage 5's classification
has not run yet. They will show the tidied version the moment it does, with no other change.

### Judgement calls

The design named TanStack Table. Eighty-two rows and five columns did not justify a
dependency, and hand-rolling the comparator gave better control over the tri-state
ordering, so it was dropped.

Colour is spent almost entirely on the verdicts. This is a document somebody scans for
exceptions, and if the furniture competes with the signal, the signal loses.

**Not yet done, and important:** there is no authentication on this page. It is a named
list of employees with illness and maternity records attached. Stage 8, and it must not be
deployed before then.

**Next:** Stage 7, the upload screen with its preview-and-approve gate.

## 2026-09-01 — Stage 7: the gate, and what the sheet already knew

Two dates have been nagging since stage 2. July 1st and 3rd are required days on which not
one person in the company was marked present, and neither is a South African public
holiday. Either the office was shut or nobody filled the sheet in — opposite verdicts, one
excusing seventy-five people and the other condemning them, with nothing in the data to
separate them.

Except there was. Somebody had typed `"Office closed"` into the sheet, against 1 July, on
the totals row. The parser had been discarding that row since stage 1 — correctly, because
a row of column sums is not attendance — and throwing the annotation away with it. It now
keeps any prose found on a discarded row, and the import preview puts it in front of you as
evidence beside the question: *"The sheet has 'Office closed' written against this date on
July row 59."*

The 3rd has no such note. It is still asked about, still unanswered, and the report still
counts it. That asymmetry is the right outcome: the system knows what the file says and
does not extrapolate from it.

### Nearly eleven questions instead of two

The first run of anomaly detection raised eleven office-closure questions rather than two.
Nine of them were September, where every required day has zero attendance for the dullest
possible reason: the month has not happened yet. The sheet is laid out a month in advance,
so on the 1st it is a full grid of zeroes.

Two genuine questions buried in nine spurious ones is worse than no questions at all — it
teaches you to click through the list without reading. Detection now ignores anything later
than today.

### A proposal you cannot act on is worse than no proposal

The preview offered "Read the column as 2026-06-01 and import its attendance" for June's
`O1 June` column, and clicking it did precisely nothing. The parser still withheld the
column, because withholding is what it was told to do at parse time and the decision
arrived afterwards.

That is the worst kind of bug: the interface says something happened and nothing did. The
workbook is now read a second time with the confirmed columns applied, but only when there
is something to apply. Accepting that one column imports seventy records.

### Speed

The first end-to-end commit took nineteen seconds, almost all of it network latency —
inserting employees, aliases, reasons and exemptions one row at a time meant around two
hundred round trips to Neon. Batching them, and raising the attendance chunk from 500 to
2,000 rows, took it to eleven. Preview is under three seconds.

### The gate itself

Nothing is written while a question raised by the importer is unanswered. The commit
endpoint returns 409 rather than an error, because a refusal is a normal outcome — it means
somebody still has to decide something, not that anything went wrong.

The file is sent again for the commit rather than parked on the server between preview and
approval. It is eighty kilobytes, and it means there is never a half-finished import
sitting somewhere waiting to be forgotten.

**Next:** Stage 8 — authentication, deploy, docs. Nothing goes online before the first of
those.

## 2026-09-01 — The emailer

This is the first part of the system that reaches outside the building, so most of the
work went into what it refuses to do.

Three exclusions are absolute, and they live in the library rather than the interface,
where a later change could quietly skip them. Exempt people are never mailed — telling
somebody on maternity leave, or somebody who lives four hundred kilometres away, that they
have not been in the office would be worse than sending nothing. Nobody without an address
is mailed. And nobody whose verdict is `NA` is mailed, because `NA` means the question
could not be answered, not that they failed. That last one matters more than it sounds:
mailing the September "not yet" cohort would be the original bug from the spec, with a
stamp on it.

Excused days get their own line, labelled as not counted. Under the agreed policy a
recorded reason removes the day from the denominator, so listing it under "you did not
attend" would be telling somebody they failed on a day they were signed off sick.

### The 200 that meant nothing

The n8n workflow validated its input by throwing. That reads fine until you notice what
n8n does with it: a thrown error skips the respond node entirely, and the webhook falls
back to answering 200 with an empty body. From the app's side that is indistinguishable
from a successful send. Every malformed address would have been recorded as delivered.

Two changes. The workflow now *returns* validation failures and routes them to a real 400
with a reason. And the client asserts success rather than assuming it: anything that is not
an explicit `ok: true` — a 500, an empty body, HTML from a proxy — is a failure. Both are
tested, including the empty-200 case specifically.

The workflow was built through the MCP server and verified against the live instance: a
valid dry run answers 200, a malformed address 400 with the reason, a request with no
secret 403.

### Dry run as a first-class path

The workflow has a dry-run branch that exercises everything — the webhook auth, the
payload validation, the whole chain — and stops short of Graph. It means the plumbing can
be proved on a Tuesday afternoon without a single employee receiving anything, which is the
difference between testing this feature and hoping about it.

A real send additionally needs the word SEND typed, and that is checked on the server, not
just in the browser.

### Two smaller things the linter caught

The send client created an abort timer per recipient and never cleared it, so fifty
recipients left fifty dangling timers holding the process open. And the recipient loader
set state directly in an effect, which turned out to hide a real race: flicking between
categories could land an older response on top of a newer one and show the wrong people as
about to be emailed. Both fixed, the second with an abortable request rather than a
suppression.

**Still not done, and still the blocker:** there is no authentication. The app now holds
attendance records, illness reasons, and email addresses, and can send mail. Stage 8.

## 2026-09-01 — People who have left

The emailer made this urgent. Chasing a former employee about their office attendance is
the most obviously wrong message the system could send, and until now nothing distinguished
somebody who had left from somebody who simply had not come in.

The distinction turns out to be sharp, and it is not about attendance at all. Everybody on
a month's sheet gets a row, whether they attended or not — Kevin Irwin has seven months of
zeroes and Francesca Tiganis has not been in once. Neither has left. What marks a departure
is the name no longer being printed on the sheet. So detection reads the roster, not the
attendance, and the fifteen people it found were last printed in March, April, June, July
and August respectively.

Getting that backwards would have been quietly catastrophic: marking people as departed for
not attending would remove exactly the people the report exists to surface, and the report
would look reassuringly empty.

Rejoining runs the same rule in reverse. If somebody is left off a month by mistake they
are marked as gone, and reappear as active the moment the next upload includes them again —
no one has to remember, and no one has to go and unmark anything by hand.

A leaver keeps their history. Chadley Potgieter went after August and still appears in the
August report, because he was on the August sheet. It is only the months he was absent from
that stop listing him.

Two independent things now keep a leaver out of an email: the durable status, and whether
they were on that month's sheet at all. Either alone would do; having both means a stale
status cannot leak a message to somebody who has gone.

One wrinkle worth recording. Kelly-Ann Tabone is both exempt — she lives in Langebaan — and
departed, having last appeared in April. The departure check runs first, so she is now
excluded as LEFT rather than EXEMPT, and the report's exempt count dropped from seven to
six. Both reasons keep her out; only the label changed. A test asserts exactly that, because
the first version of it asserted the label and broke.

**Next:** Stage 8 — authentication, deploy, docs. Still the blocker.

## 2026-09-01 — Who the mail comes from

A challenge from the user: the `OFFICE_ATTENDANCE_SENDER` setting makes no sense, because
the n8n credential is delegated and the mail will therefore come from them.

That is a good objection, and I agreed with it before checking, which was the wrong order.
Microsoft settled it in one request:

> `/me request is only valid with delegated authentication flow.`

The credential is app-only — client credentials, not delegated. An app-only token has no
"me" to send as, so the mailbox has to be named in the URL, and the app registration has to
be permitted to send from it. `OFFICE_ATTENDANCE_SENDER` is load-bearing rather than
decorative, and mail comes from `notifications.za@vml.com`, not from any individual.

A second request pinned down the shape of the credential further: `GET /users/{id}` returns
`403 Authorization_RequestDenied`. The registration holds `Mail.Send` and nothing else,
which is exactly what its name — "Microsoft Graph - Notifications.za Email Only" — has been
saying all along.

### A near-miss worth recording

While chasing this I called `updateNode` with a `parameters` object containing only the
`url`. That does not merge; it **replaces**. The send node silently lost its authentication
type, its `sendBody` flag and its entire JSON payload, and the workflow stayed active and
looked fine in the structure view.

The only reason it surfaced was that the next request returned "Access token is empty"
rather than a Graph error, which was the wrong shape of failure for what I had changed.
Restoring the full parameter object fixed it, and a real send to an undeliverable address
confirmed the body was back — an empty body would not have been accepted.

Two lessons. `updateNode` replaces wholesale: pass the complete parameters, or use
`patchNodeField`. And an active workflow can be broken in a way that neither the API nor
the canvas complains about, so the check has to be an actual request.

### What the dry run says now

The identity node had to go. It could never work, because looking a mailbox up needs
directory permission this credential deliberately does not have, and a node that always
returns 403 is worse than no node. The dry run instead reports the configured sender and
says plainly that it cannot be verified from here, and that a wrong one fails at send with
`ErrorAccessDenied`. The emailer page shows the sender too, so it is visible before anyone
types SEND rather than discoverable afterwards.

## 2026-09-01 — The wrong mailbox

A delegated credential existed after all, and switching to it exposed something worth
writing down.

n8n's public API refuses to list credentials on this instance — 403 — so there was no way
to look up an ID. I referenced the credential by name instead, on the strength of an
existing workflow that does the same thing, and tested it with a real send to an
undeliverable address.

The send succeeded. It also went from the wrong person. n8n had not matched the name at
all; it silently bound a different credential of the same type and stored it as
`Microsoft Graph - Matthew Arnold (Personal)`. No warning, no error, and the canvas looked
correct. One message left Matthew Arnold's mailbox.

Two things follow. A credential reference must be by ID, because a name that matches
nothing does not fail — it substitutes. And an unverifiable configuration is a reason to
stop and ask, not a reason to test with a live send. The whole point of building a dry-run
path was to avoid exactly this, and I went around it.

With the correct ID bound, the dry run reads the identity from Graph and reports
`jarred.cinman@vml.com`. That check is now the only source of truth for the sender: the
`OFFICE_ATTENDANCE_SENDER` setting is gone, along with the sender field in the payload,
because with delegated auth there is no choice to express. Microsoft is asked, every dry
run, and the answer is shown in the interface before anybody types SEND.

The earlier reasoning about app-only credentials was correct for the credential I had at
the time — `/me` returned "only valid with delegated authentication flow" and
`GET /users/{id}` returned 403, which is exactly the shape of a Mail.Send-only app
registration. It was simply the wrong credential for the job.

**Unrelated, noticed in passing:** `VML - Bloodstream - Create Meeting Request` has an Azure
client secret hardcoded in plaintext in its token node, readable by anyone with n8n API
access. Flagged to the user; not ours to change.
