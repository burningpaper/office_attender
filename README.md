# Office Attendance

Tracks who has been in the office on the required days — Wednesdays and Fridays — from a
spreadsheet that is re-uploaded each week, and can email the people who have not been.

The whole system exists because of one uncomfortable fact about the source data: the
spreadsheet is clean, and the rules everybody assumed were obvious are not.

## What it does

- **Imports** the attendance workbook, deterministically, with a preview you approve before
  anything is written.
- **Reports** compliance per person per month — this month, the last fortnight, and a
  long-term average — with the working shown rather than a bare yes or no.
- **Emails** the people who are genuinely not compliant, each with their own dates, through
  n8n and Microsoft Graph.

## Getting started

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run db:migrate
npm run db:seed                # public holidays and working days, 2025–2027
npm run dev
```

You will also need the attendance workbook itself. It is **not** in this repository and
must not be: it holds named employees, reasons for absence including illness and maternity
leave, and everybody's work email address. Put it in the project root as
`data_example.xls.xlsx` — the tests read it from there.

```bash
npm run db:import -- data_example.xlsx        # commits, once you answer its questions
npm run db:import -- data_example.xlsx --dry-run
npm run reasons:classify                       # normalise absence reasons (one model call)
npm run report -- 2026-08                      # the report, on the command line
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run check` | Typecheck, lint and the full test suite |
| `npm test` | Tests only |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Seed the working-day calendar |
| `npm run db:status` | What is actually in the database |
| `npm run db:import` | Import a workbook |
| `npm run report` | Print the compliance report |
| `npm run reasons:classify` | Classify any unrecognised absence reasons |

## How it fits together

```
  workbook ──▶ parse ──▶ resolve identities ──▶ preview ──▶ YOU APPROVE ──▶ database
              (rules)      (rules)              (diff)                          │
                                                                                ▼
                                        calendar ──────────▶ compliance ──▶ report
                                     (holidays, closures)      (rules)         │
                                                                               ▼
                                                            reasons ──▶ emailer ──▶ n8n ──▶ Graph
                                                          (one model call)
```

Everything in that diagram is deterministic except one box. A language model is used for
exactly one job — turning 35 free-text absence notes such as `On leave`, `booked off`,
`B/day Leave` and `son at ER` into a controlled vocabulary — and its answers are cached
against the exact string, so it is called once per novel note in the lifetime of the system.
The attendance grid itself is 10,000 clean booleans and is read by rules, because a
compliance report that changed its mind between imports would be worse than no report.

## Documents

- **[DESIGN.md](DESIGN.md)** — what the data actually contains, and the four rules in the
  original spec that break against it.
- **[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)** — the stages, with what each one
  turned up.
- **[.claude/DEVELOPER_LOGS.md](.claude/DEVELOPER_LOGS.md)** — a running account of the
  build, including the mistakes.

## A note on the data

This application holds personal information: named employees, their office attendance,
reasons for absence including illness and family emergencies, and work email addresses.
It is protected by a single shared password and should stay that way at minimum. The
workbook and `.env.local` are both excluded from version control, and the reason
classifier is deliberately sent absence strings with no names attached.
