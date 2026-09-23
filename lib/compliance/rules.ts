/**
 * The compliance rules. Pure functions over plain data.
 *
 * `asOf` is always passed in and never read from the clock, so every verdict is
 * reproducible and the tests can stand on a specific day and look around.
 *
 * Three ideas run through all of it, each of them a correction to the original
 * spec (DESIGN.md §2 and §10):
 *
 *  - Only *elapsed* required days count. Otherwise the current month reads as
 *    company-wide failure from the 1st until the last Friday.
 *  - Only *working* required days count. Good Friday and Workers' Day both fall
 *    on Fridays in 2026, and nobody can attend on a day the office is shut.
 *  - An explained absence is neutral. It leaves the denominator entirely rather
 *    than counting against anyone.
 */

import type {
  CalendarDay,
  ComplianceResult,
  EmployeeInput,
  EmployeeRow,
  Exemption,
  LongTermResult,
  RecentForm,
} from "./types";

const WEDNESDAY = 3;
const FRIDAY = 5;

export function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function lastDayOfMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Exemptions
// ---------------------------------------------------------------------------

/** Is this exemption in force on the given date? */
export function exemptionAppliesOn(exemption: Exemption, date: string): boolean {
  if (!exemption.active) return false;
  if (exemption.effectiveFrom && date < exemption.effectiveFrom) return false;
  if (exemption.effectiveTo && date > exemption.effectiveTo) return false;
  return true;
}

export function activeExemption(
  employee: EmployeeInput,
  asOf: string,
): Exemption | null {
  return employee.exemptions.find((e) => exemptionAppliesOn(e, asOf)) ?? null;
}

// ---------------------------------------------------------------------------
// The required-day denominator
// ---------------------------------------------------------------------------

/**
 * The days this person was actually expected in the office, within a window.
 *
 * A date has to clear four hurdles: the calendar says it is a required working
 * day, it has finished, and it falls inside their employment window.
 *
 * "Finished" means strictly before `asOf`, not up to and including it. Today is
 * still being lived: the register is filled in through the day, people arrive
 * at different times, and somebody who has not been ticked at half past nine
 * has not missed anything - nobody has looked for them yet. Judging a day in
 * progress turns an unfinished register into a roomful of absentees.
 *
 * The cost is a day of lag: attend on Wednesday and it counts from Thursday.
 * That is the right way round, because the alternative is chasing somebody on
 * the strength of a form that has not been filled in.
 */
export function requiredDaysFor(
  employee: EmployeeInput,
  calendar: CalendarDay[],
  window: { start: string; end: string },
  asOf: string,
): string[] {
  return calendar
    .filter((day) => {
      if (!day.isRequiredDay) return false;
      if (day.date < window.start || day.date > window.end) return false;
      if (day.date >= asOf) return false; // not yet finished
      if (employee.firstSeenDate && day.date < employee.firstSeenDate) return false;
      if (employee.lastSeenDate && day.date > employee.lastSeenDate) return false;
      return true;
    })
    .map((day) => day.date);
}

/**
 * Score a set of required days.
 *
 * Excused days are removed from the denominator before anything is judged, so a
 * person who was sick on the only required day of the window is neither
 * compliant nor non-compliant - there is nothing left to measure.
 */
function score(employee: EmployeeInput, requiredDates: string[]): ComplianceResult {
  const attendedDates: string[] = [];
  const excusedDates: string[] = [];
  const missed: string[] = [];
  const unrecorded: string[] = [];

  for (const date of requiredDates) {
    const state = employee.attendance.get(date);

    /**
     * A missing row means one of two things, and they are opposites.
     *
     * If the register was kept that day for anybody else in the office, this
     * person was left unticked, which is how a keeper says "not in". If it was
     * not kept at all, nothing is known and nothing should be concluded - the
     * alternative is reporting a whole office absent for a week nobody has got
     * round to.
     */
    if (state === undefined) {
      if (employee.recordedDates?.has(date)) missed.push(date);
      else unrecorded.push(date);
      continue;
    }

    if (state === "NOT_EMPLOYED") {
      unrecorded.push(date);
      continue;
    }

    if (state === "PRESENT") attendedDates.push(date);
    else if (state === "ABSENT_EXPLAINED") excusedDates.push(date);
    else missed.push(date);
  }

  const attended = attendedDates.length;
  const excused = excusedDates.length;
  const required = requiredDates.length - excused - unrecorded.length;

  if (required === 0) {
    return {
      verdict: "NA",
      attended: 0,
      required: 0,
      excused,
      attendedDates,
      excusedDates,
      missed: [],
      unrecorded,
      note:
        unrecorded.length > 0 && excused === 0
          ? `Nothing recorded yet for ${unrecorded.length} required day${unrecorded.length === 1 ? "" : "s"}.`
          : excused > 0
            ? `Every required day was excused (${excused}).`
            : "No required days have elapsed yet.",
    };
  }

  return {
    verdict: attended === required ? "YES" : "NO",
    attended,
    required,
    excused,
    attendedDates,
    excusedDates,
    missed,
    unrecorded,
  };
}

/** An EXEMPT result, which never carries numbers. */
function exemptResult(exemption: Exemption): ComplianceResult {
  return {
    verdict: "EXEMPT",
    attended: 0,
    required: 0,
    excused: 0,
    attendedDates: [],
    excusedDates: [],
    missed: [],
    unrecorded: [],
    note: exemption.rawText ?? exemption.type,
  };
}

// ---------------------------------------------------------------------------
// The four columns
// ---------------------------------------------------------------------------

/**
 * Compliant this month: present on every required day that has happened.
 *
 * The elapsed-days rule lives here. On 1 September nothing has elapsed, so the
 * answer is "not yet" rather than "no" - which is the difference between a
 * useful default view and one that accuses everybody on the first of the month.
 */
export function monthlyCompliance(
  employee: EmployeeInput,
  calendar: CalendarDay[],
  month: string, // "YYYY-MM"
  asOf: string,
): ComplianceResult {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  const window = {
    start: `${month}-01`,
    end: lastDayOfMonth(year, monthIndex),
  };

  /**
   * An exemption is judged as at the month being looked at, not as at today.
   *
   * Somebody taken off tracking this week should stop counting from this week
   * onward - not have August quietly rewritten as though the policy never
   * applied to them. "Going forward" has to mean forward.
   */
  const exemption = activeExemption(employee, window.end < asOf ? window.end : asOf);
  if (exemption) return exemptResult(exemption);

  return score(employee, requiredDaysFor(employee, calendar, window, asOf));
}

/**
 * Two-week compliance: at least one Wednesday and at least one Friday.
 *
 * Both halves must be answerable. If the fortnight contains no required
 * Wednesday - a public holiday, or the person joined on Thursday - then the
 * question has no answer, and NA is the honest one.
 */
export function twoWeekCompliance(
  employee: EmployeeInput,
  calendar: CalendarDay[],
  asOf: string,
): ComplianceResult {
  const exemption = activeExemption(employee, asOf);
  if (exemption) return exemptResult(exemption);

  const window = { start: addDays(asOf, -13), end: asOf };
  const required = requiredDaysFor(employee, calendar, window, asOf);

  /** Judgeable days: something is known and it is not an excused absence. */
  const judgeable = (date: string) => {
    const state = employee.attendance.get(date);
    if (state === undefined) return employee.recordedDates?.has(date) ?? false;
    return state !== "ABSENT_EXPLAINED" && state !== "NOT_EMPLOYED";
  };
  const weds = required.filter((d) => weekdayOf(d) === WEDNESDAY).filter(judgeable);
  const fris = required.filter((d) => weekdayOf(d) === FRIDAY).filter(judgeable);

  const excused = required.filter(
    (d) => employee.attendance.get(d) === "ABSENT_EXPLAINED",
  ).length;
  const unrecorded = required.filter(
    (d) => employee.attendance.get(d) === undefined && !employee.recordedDates?.has(d),
  );

  if (weds.length === 0 || fris.length === 0) {
    return {
      verdict: "NA",
      attended: 0,
      required: 0,
      excused,
      attendedDates: [],
      excusedDates: required.filter(
        (d) => employee.attendance.get(d) === "ABSENT_EXPLAINED",
      ),
      missed: [],
      unrecorded,
      note:
        unrecorded.length > 0
          ? `Nothing recorded yet for ${unrecorded.length} of the last fortnight's required days.`
          :
        weds.length === 0 && fris.length === 0
          ? "No required days in the last two weeks."
          : weds.length === 0
            ? "No required Wednesday in the last two weeks."
            : "No required Friday in the last two weeks.",
    };
  }

  const present = (date: string) => employee.attendance.get(date) === "PRESENT";
  const anyWed = weds.some(present);
  const anyFri = fris.some(present);

  return {
    verdict: anyWed && anyFri ? "YES" : "NO",
    attended: weds.filter(present).length + fris.filter(present).length,
    required: weds.length + fris.length,
    excused,
    attendedDates: [...weds, ...fris].filter(present).sort(),
    excusedDates: required
      .filter((d) => employee.attendance.get(d) === "ABSENT_EXPLAINED")
      .sort(),
    missed: [...weds, ...fris].filter((d) => !present(d)).sort(),
    unrecorded,
  };
}

/**
 * Long-term compliance: an average of three Wednesdays and three Fridays a
 * month, over the complete months this person has actually been employed.
 *
 * Dividing by months employed rather than months elapsed is what stops someone
 * who joined in August looking like a persistent offender. Fewer than two
 * complete months is not enough to average anything, so it reports NA.
 *
 * Worth knowing: in a month where a public holiday takes out a Wednesday, three
 * is a demanding target. December 2026 has only seven required days at all.
 */
export function longTermCompliance(
  employee: EmployeeInput,
  calendar: CalendarDay[],
  asOf: string,
  options: { minimumMonths?: number; target?: number } = {},
): LongTermResult {
  const minimumMonths = options.minimumMonths ?? 2;
  const target = options.target ?? 3;

  const exemption = activeExemption(employee, asOf);
  if (exemption) {
    return { ...exemptResult(exemption), wednesdayAverage: 0, fridayAverage: 0, monthsCounted: 0 };
  }

  const months = completeMonthsFor(employee, calendar, asOf);
  if (months.length < minimumMonths) {
    return {
      verdict: "NA",
      attended: 0,
      required: 0,
      excused: 0,
      missed: [],
      attendedDates: [],
      excusedDates: [],
      unrecorded: [],
      note: `Only ${months.length} complete month${months.length === 1 ? "" : "s"} of history.`,
      wednesdayAverage: 0,
      fridayAverage: 0,
      monthsCounted: months.length,
    };
  }

  let wednesdays = 0;
  let fridays = 0;
  let attended = 0;

  for (const month of months) {
    const window = {
      start: `${month}-01`,
      end: lastDayOfMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1),
    };
    for (const date of requiredDaysFor(employee, calendar, window, asOf)) {
      if (employee.attendance.get(date) !== "PRESENT") continue;
      attended++;
      if (weekdayOf(date) === WEDNESDAY) wednesdays++;
      else if (weekdayOf(date) === FRIDAY) fridays++;
    }
  }

  const wednesdayAverage = wednesdays / months.length;
  const fridayAverage = fridays / months.length;

  return {
    verdict: wednesdayAverage >= target && fridayAverage >= target ? "YES" : "NO",
    attended,
    required: months.length * target * 2,
    excused: 0,
    attendedDates: [],
    excusedDates: [],
    missed: [],
    unrecorded: [],
    wednesdayAverage,
    fridayAverage,
    monthsCounted: months.length,
  };
}

/**
 * Months the employee worked start to finish, and which have themselves ended.
 *
 * Completeness is measured against the month's *required days*, not its
 * calendar edges. 1 March 2026 is a Sunday and 30-31 May fall on a weekend, so
 * comparing against the 1st and the 31st would treat somebody who worked every
 * single required day of March as a mid-month joiner. What matters is whether
 * they were present for the first day that counted and still there for the last.
 */
export function completeMonthsFor(
  employee: EmployeeInput,
  calendar: CalendarDay[],
  asOf: string,
): string[] {
  if (!employee.firstSeenDate) return [];

  const requiredByMonth = new Map<string, string[]>();
  for (const day of calendar) {
    if (!day.isRequiredDay) continue;
    const month = day.date.slice(0, 7);
    const list = requiredByMonth.get(month) ?? [];
    list.push(day.date);
    requiredByMonth.set(month, list);
  }

  const months: string[] = [];
  const start = new Date(`${employee.firstSeenDate}T00:00:00Z`);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));

  while (true) {
    const year = cursor.getUTCFullYear();
    const monthIndex = cursor.getUTCMonth();
    const month = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
    const endOfMonth = lastDayOfMonth(year, monthIndex);

    if (endOfMonth > asOf) break; // the month has not finished

    const required = (requiredByMonth.get(month) ?? []).sort();
    if (required.length === 0) {
      cursor.setUTCMonth(monthIndex + 1);
      continue; // nothing to judge - a month entirely of holidays
    }

    const firstRequired = required[0];
    const lastRequired = required[required.length - 1];

    if (employee.firstSeenDate > firstRequired) {
      cursor.setUTCMonth(monthIndex + 1);
      continue; // joined after the month's first required day
    }
    if (employee.lastSeenDate && employee.lastSeenDate < lastRequired) break;

    months.push(month);
    cursor.setUTCMonth(monthIndex + 1);
  }

  return months;
}

/**
 * How many required days to look back over when nobody has been reminded.
 *
 * Four is two ordinary weeks of Wednesdays and Fridays. Counting days rather
 * than a fortnight of calendar keeps the window meaningful through a public
 * holiday, which would otherwise leave only two or three days to judge on.
 */
const RECENT_REQUIRED_DAYS = 4;

/** Never reach further back than this, however sparse the calendar. */
const RECENT_MAX_LOOKBACK_DAYS = 42;

/**
 * How somebody has behaved lately.
 *
 * The window is the required days since their last reminder, because that is
 * the question actually being asked: you wrote to them, did they come in? With
 * nobody to have reminded them, it falls back to the last few required days.
 *
 * Scored with the same function as every other verdict, so the two can never
 * drift apart - a day excused here is excused there, and a day nothing is known
 * about is unknown in both.
 */
export function recentForm(
  employee: EmployeeInput,
  calendar: CalendarDay[],
  asOf: string,
): RecentForm {
  const floor = addDays(asOf, -RECENT_MAX_LOOKBACK_DAYS);
  const reminder = employee.lastReminderDate ?? null;

  const elapsed = requiredDaysFor(
    employee,
    calendar,
    { start: floor, end: asOf },
    asOf,
  );

  if (reminder && reminder >= floor) {
    // Strictly after: a reminder cannot have changed that same day's behaviour.
    const since = elapsed.filter((date) => date > reminder);
    return { basis: "SINCE_REMINDER", since: reminder, result: score(employee, since) };
  }

  const last = elapsed.slice(-RECENT_REQUIRED_DAYS);
  return {
    basis: "LAST_FEW_DAYS",
    since: last.length > 0 ? addDays(last[0], -1) : null,
    result: score(employee, last),
  };
}

/** The most recent day they were physically in the office. */
export function lastAttended(employee: EmployeeInput): string | null {
  let latest: string | null = null;
  for (const [date, state] of employee.attendance) {
    if (state === "PRESENT" && (latest === null || date > latest)) latest = date;
  }
  return latest;
}

/** Everything the table needs for one person. */
export function evaluateEmployee(
  employee: EmployeeInput,
  calendar: CalendarDay[],
  month: string,
  asOf: string,
): EmployeeRow {
  const exemption = activeExemption(employee, asOf);
  const monthly = monthlyCompliance(employee, calendar, month, asOf);
  const recent = recentForm(employee, calendar, asOf);

  return {
    employeeId: employee.id,
    displayName: employee.displayName,
    isExempt: exemption !== null,
    exemptionNote: exemption?.rawText ?? exemption?.type ?? null,
    hasLeft: employee.hasLeft ?? false,
    onRosterThisMonth: true, // set by the loader, which knows the month's roster

    monthly,
    twoWeek: twoWeekCompliance(employee, calendar, asOf),
    longTerm: longTermCompliance(employee, calendar, asOf),
    lastAttended: lastAttended(employee),
    recent,
    /**
     * Both halves are needed. Somebody already compliant is not improving, and
     * neither is somebody whose recent days were all excused or never recorded
     * - that is an absence of evidence, not evidence of change.
     */
    improving: monthly.verdict === "NO" && recent.result.verdict === "YES",
  };
}

/**
 * Sort order for the table: the people who need attention first.
 *
 * NO before YES before NA, and exempt last - they are hidden by default anyway.
 */
export const VERDICT_ORDER: Record<string, number> = {
  NO: 0,
  YES: 1,
  NA: 2,
  EXEMPT: 3,
};
