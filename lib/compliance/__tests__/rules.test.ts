import { describe, expect, it } from "vitest";
import { buildCalendar } from "../../calendar/build-calendar";
import {
  completeMonthsFor,
  evaluateEmployee,
  lastAttended,
  longTermCompliance,
  monthlyCompliance,
  requiredDaysFor,
  twoWeekCompliance,
} from "../rules";
import type { AttendanceState, EmployeeInput, Exemption } from "../types";

const CALENDAR = buildCalendar(2026, 2026).map((d) => ({
  date: d.date,
  isRequiredDay: d.isRequiredDay,
  label: d.label,
}));

function employee(overrides: Partial<EmployeeInput> = {}): EmployeeInput {
  return {
    id: 1,
    displayName: "Test Person",
    firstSeenDate: "2026-03-02",
    lastSeenDate: "2026-09-30",
    exemptions: [],
    attendance: new Map<string, AttendanceState>(),
    ...overrides,
  };
}

/** Mark a set of dates with a state. */
function withAttendance(dates: Record<string, AttendanceState>): Map<string, AttendanceState> {
  return new Map(Object.entries(dates));
}

/** Every required day in a month, from the calendar. */
const requiredIn = (month: string) =>
  CALENDAR.filter((d) => d.isRequiredDay && d.date.startsWith(month)).map((d) => d.date);

// ---------------------------------------------------------------------------

describe("the current-month bug (DESIGN.md §2.1)", () => {
  it("returns NA on the 1st of the month, not NO", () => {
    // This is the whole reason the rule changed. September 2026 has 1,474 cells
    // in the real data and not one attendance - because it has not happened.
    const result = monthlyCompliance(employee(), CALENDAR, "2026-09", "2026-09-01");
    expect(result.verdict).toBe("NA");
    expect(result.required).toBe(0);
    expect(result.note).toMatch(/no required days have elapsed/i);
  });

  it("counts only the required days that have already happened", () => {
    // On Wednesday 9 September, two required days have elapsed: the 2nd and 4th.
    const person = employee({
      attendance: withAttendance({
        "2026-09-02": "PRESENT",
        "2026-09-04": "PRESENT",
        "2026-09-09": "PRESENT",
      }),
    });
    const result = monthlyCompliance(person, CALENDAR, "2026-09", "2026-09-09");
    expect(result.required).toBe(3); // 2nd, 4th, 9th
    expect(result.attended).toBe(3);
    expect(result.verdict).toBe("YES");
  });

  it("does not hold the rest of the month against anyone", () => {
    const person = employee({ attendance: withAttendance({ "2026-09-02": "PRESENT" }) });
    const result = monthlyCompliance(person, CALENDAR, "2026-09", "2026-09-02");
    expect(result.verdict).toBe("YES");
    expect(result.required).toBe(1);
    // September has nine required days in total; eight are still in the future.
    expect(requiredIn("2026-09")).toHaveLength(9);
  });
});

describe("the public-holiday bug (DESIGN.md §2.2)", () => {
  it("does not mark a whole company non-compliant for April", () => {
    // Good Friday is 3 April and nobody attended. Under the naive rule that is
    // every employee failing. It must not count at all.
    const aprilRequired = requiredIn("2026-04");
    expect(aprilRequired).not.toContain("2026-04-03");

    const person = employee({
      attendance: withAttendance(
        Object.fromEntries(aprilRequired.map((d) => [d, "PRESENT" as AttendanceState])),
      ),
    });
    const result = monthlyCompliance(person, CALENDAR, "2026-04", "2026-04-30");
    expect(result.verdict).toBe("YES");
    expect(result.attended).toBe(result.required);
  });

  it("excludes Workers' Day from May", () => {
    expect(requiredIn("2026-05")).not.toContain("2026-05-01");
  });

  it("still counts the ambiguous July days", () => {
    // Zero attendance company-wide, but not public holidays. Only a human can
    // rule on those, so the engine must not quietly excuse them.
    const july = requiredIn("2026-07");
    expect(july).toContain("2026-07-01");
    expect(july).toContain("2026-07-03");
  });
});

describe("excused absences are neutral (DESIGN.md §10)", () => {
  it("removes an explained absence from the denominator entirely", () => {
    const person = employee({
      attendance: withAttendance({
        "2026-03-04": "PRESENT",
        "2026-03-06": "ABSENT_EXPLAINED", // sick
      }),
    });
    const result = monthlyCompliance(person, CALENDAR, "2026-03", "2026-03-06");
    expect(result.verdict).toBe("YES");
    expect(result.attended).toBe(1);
    expect(result.required).toBe(1); // the sick day left the denominator
    expect(result.excused).toBe(1);
  });

  it("reports NA when every required day was excused", () => {
    // Someone off sick all month is neither compliant nor not.
    const person = employee({
      attendance: withAttendance(
        Object.fromEntries(
          requiredIn("2026-03").map((d) => [d, "ABSENT_EXPLAINED" as AttendanceState]),
        ),
      ),
    });
    const result = monthlyCompliance(person, CALENDAR, "2026-03", "2026-03-31");
    expect(result.verdict).toBe("NA");
    expect(result.excused).toBe(8);
    expect(result.note).toMatch(/every required day was excused/i);
  });

  it("surfaces the excused count so a clean fraction is not misleading", () => {
    // 1/1 looks perfect until you see the three sick days behind it.
    const person = employee({
      attendance: withAttendance({
        "2026-03-04": "ABSENT_EXPLAINED",
        "2026-03-06": "ABSENT_EXPLAINED",
        "2026-03-11": "ABSENT_EXPLAINED",
        "2026-03-13": "PRESENT",
      }),
    });
    const result = monthlyCompliance(person, CALENDAR, "2026-03", "2026-03-13");
    expect(result).toMatchObject({ verdict: "YES", attended: 1, required: 1, excused: 3 });
  });

  it("counts an unexplained absence against them", () => {
    const person = employee({
      attendance: withAttendance({ "2026-03-04": "PRESENT", "2026-03-06": "ABSENT" }),
    });
    const result = monthlyCompliance(person, CALENDAR, "2026-03", "2026-03-06");
    expect(result.verdict).toBe("NO");
    expect(result.missed).toEqual(["2026-03-06"]);
  });
});

describe("exemptions", () => {
  const remote: Exemption = {
    type: "REMOTE_LOCATION",
    rawText: "Stays in George",
    effectiveFrom: null,
    effectiveTo: null,
    active: true,
  };

  it("resolves Kevin Irwin's seven months of zeroes to EXEMPT, not NO", () => {
    // He lives ~430km away. Reporting him red every month is noise that trains
    // you to ignore the red.
    const kevin = employee({
      displayName: "Kevin Irwin",
      exemptions: [remote],
      attendance: withAttendance(
        Object.fromEntries(requiredIn("2026-03").map((d) => [d, "ABSENT" as AttendanceState])),
      ),
    });

    const row = evaluateEmployee(kevin, CALENDAR, "2026-03", "2026-03-31");
    expect(row.isExempt).toBe(true);
    expect(row.exemptionNote).toBe("Stays in George");
    expect(row.monthly.verdict).toBe("EXEMPT");
    expect(row.twoWeek.verdict).toBe("EXEMPT");
    expect(row.longTerm.verdict).toBe("EXEMPT");
  });

  it("respects an exemption's effective dates", () => {
    const maternity: Exemption = {
      type: "PARENTAL_LEAVE",
      rawText: "On Maternity Leave",
      effectiveFrom: "2026-06-01",
      effectiveTo: "2026-12-31",
      active: true,
    };
    const person = employee({ exemptions: [maternity] });

    expect(monthlyCompliance(person, CALENDAR, "2026-05", "2026-05-29").verdict).not.toBe("EXEMPT");
    expect(monthlyCompliance(person, CALENDAR, "2026-06", "2026-06-30").verdict).toBe("EXEMPT");
  });

  it("ignores an inactive exemption", () => {
    const person = employee({
      exemptions: [{ ...remote, active: false }],
      attendance: withAttendance({ "2026-03-04": "ABSENT" }),
    });
    expect(monthlyCompliance(person, CALENDAR, "2026-03", "2026-03-04").verdict).toBe("NO");
  });
});

describe("two-week compliance", () => {
  it("needs one Wednesday AND one Friday", () => {
    const asOf = "2026-03-13"; // a Friday
    const both = employee({
      attendance: withAttendance({ "2026-03-11": "PRESENT", "2026-03-13": "PRESENT" }),
    });
    expect(twoWeekCompliance(both, CALENDAR, asOf).verdict).toBe("YES");

    const wedOnly = employee({ attendance: withAttendance({ "2026-03-11": "PRESENT" }) });
    expect(twoWeekCompliance(wedOnly, CALENDAR, asOf).verdict).toBe("NO");

    const friOnly = employee({ attendance: withAttendance({ "2026-03-13": "PRESENT" }) });
    expect(twoWeekCompliance(friOnly, CALENDAR, asOf).verdict).toBe("NO");
  });

  it("reports NA when the fortnight has no required Friday to judge", () => {
    // Standing on Wednesday 6 May, the fortnight back to 23 April contains
    // Fridays 24 April and 1 May - and 1 May is Workers' Day.
    const person = employee({ firstSeenDate: "2026-04-24", lastSeenDate: "2026-09-30" });
    const result = twoWeekCompliance(person, CALENDAR, "2026-04-24");
    expect(result.verdict).toBe("NA");
    expect(result.note).toMatch(/no required wednesday/i);
  });

  it("does not look outside the employment window", () => {
    const joiner = employee({ firstSeenDate: "2026-03-11", lastSeenDate: "2026-09-30" });
    const required = requiredDaysFor(
      joiner,
      CALENDAR,
      { start: "2026-03-01", end: "2026-03-31" },
      "2026-03-13",
    );
    expect(required).toEqual(["2026-03-11", "2026-03-13"]);
  });
});

describe("long-term compliance", () => {
  /** Attend the first `count` required days of a month. */
  const attendSome = (month: string, count: number) =>
    Object.fromEntries(
      requiredIn(month).slice(0, count).map((d) => [d, "PRESENT" as AttendanceState]),
    );

  it("reports NA below two complete months of history", () => {
    // Joined at the start of September, judged at the end of it: one month.
    const joiner = employee({ firstSeenDate: "2026-09-01", lastSeenDate: "2026-09-30" });
    const result = longTermCompliance(joiner, CALENDAR, "2026-09-30");
    expect(result.verdict).toBe("NA");
    expect(result.monthsCounted).toBe(1);
    expect(result.note).toMatch(/complete month/i);
  });

  it("starts judging once two complete months exist", () => {
    // The real "Intern" record begins 3 August. By the end of September that is
    // two complete months, so the average becomes answerable - and with no
    // attendance at all the answer is NO, not a shrug.
    const intern = employee({ firstSeenDate: "2026-08-03", lastSeenDate: "2026-09-30" });
    const result = longTermCompliance(intern, CALENDAR, "2026-09-30");
    expect(result.monthsCounted).toBe(2);
    expect(result.verdict).toBe("NO");
  });

  it("counts a month as complete when the person worked all its required days", () => {
    // 1 March 2026 is a Sunday, so the first required day is the 4th. Someone
    // whose record starts on Monday the 2nd worked the whole month.
    const person = employee({ firstSeenDate: "2026-03-02", lastSeenDate: "2026-05-31" });
    expect(completeMonthsFor(person, CALENDAR, "2026-05-31")).toEqual([
      "2026-03", "2026-04", "2026-05",
    ]);
  });

  it("divides by months employed, not months elapsed", () => {
    // Someone who joined in July must not be judged on March through June.
    const joiner = employee({ firstSeenDate: "2026-07-01", lastSeenDate: "2026-09-30" });
    expect(completeMonthsFor(joiner, CALENDAR, "2026-09-30")).toEqual(["2026-07", "2026-08", "2026-09"]);
  });

  it("excludes the month someone joined partway through", () => {
    const joiner = employee({ firstSeenDate: "2026-07-15", lastSeenDate: "2026-09-30" });
    expect(completeMonthsFor(joiner, CALENDAR, "2026-09-30")).toEqual(["2026-08", "2026-09"]);
  });

  it("passes when the averages reach three of each", () => {
    const person = employee({
      firstSeenDate: "2026-03-02",
      lastSeenDate: "2026-05-31",
      attendance: withAttendance({
        ...attendSome("2026-03", 8),
        ...attendSome("2026-04", 8),
        ...attendSome("2026-05", 8),
      }),
    });
    const result = longTermCompliance(person, CALENDAR, "2026-05-31");
    expect(result.monthsCounted).toBe(3);
    expect(result.wednesdayAverage).toBeGreaterThanOrEqual(3);
    expect(result.fridayAverage).toBeGreaterThanOrEqual(3);
    expect(result.verdict).toBe("YES");
  });

  it("fails when only one of the two averages is met", () => {
    // Every Wednesday, never a Friday.
    const wednesdaysOnly = Object.fromEntries(
      ["2026-03", "2026-04", "2026-05"]
        .flatMap((m) => requiredIn(m))
        .filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 3)
        .map((d) => [d, "PRESENT" as AttendanceState]),
    );
    const person = employee({
      firstSeenDate: "2026-03-02",
      lastSeenDate: "2026-05-31",
      attendance: withAttendance(wednesdaysOnly),
    });
    const result = longTermCompliance(person, CALENDAR, "2026-05-31");
    expect(result.wednesdayAverage).toBeGreaterThanOrEqual(3);
    expect(result.fridayAverage).toBe(0);
    expect(result.verdict).toBe("NO");
  });
});

describe("last attended", () => {
  it("finds the most recent day in the office", () => {
    const person = employee({
      attendance: withAttendance({
        "2026-03-04": "PRESENT",
        "2026-05-06": "PRESENT",
        "2026-05-08": "ABSENT_EXPLAINED",
      }),
    });
    expect(lastAttended(person)).toBe("2026-05-06");
  });

  it("returns null for someone who has never attended", () => {
    const person = employee({ attendance: withAttendance({ "2026-03-04": "ABSENT" }) });
    expect(lastAttended(person)).toBeNull();
  });
});
