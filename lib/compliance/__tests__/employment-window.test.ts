/**
 * The employment window, and the day `last_seen_date` stopped meaning anything.
 *
 * `last_seen_date` was invented when a month arrived as a spreadsheet. It meant
 * "the last monthly sheet this person's name appeared on", and in that world it
 * doubled as the end of their employment: a name that stopped being printed
 * belonged to somebody who had gone.
 *
 * Then the register replaced the spreadsheet. Nothing advances the column any
 * more, so for anybody still employed it now records the date of the last
 * import and nothing else. The last Cape Town workbook covered September, so
 * every one of its 61 people carried `last_seen_date = 2026-09-30` into
 * October and November - and the rule read that as "left on 30 September" and
 * returned zero required days for the month. Sixty-odd people were ticked in
 * on the register and the report showed them as 0/0, NA, nothing to judge.
 *
 * Durban and Johannesburg were untouched, which is the detail that gives the
 * cause away: both were created by paths that never set the column at all.
 *
 * So the bound now applies only to somebody who has actually left. Departure
 * is what `status` records, and it reaches the rules as `hasLeft`.
 *
 * Note the fixture: the shared `employee()` helper in rules.test.ts defaults
 * `lastSeenDate` to "2026-09-30", and every test using it judges a month at or
 * before September. That is why a suite of 359 tests never once asked what
 * happens to an active employee in the month after their last import.
 */
import { describe, expect, it } from "vitest";
import { buildCalendar } from "../../calendar/build-calendar";
import { completeMonthsFor, monthlyCompliance, requiredDaysFor } from "../rules";
import type { AttendanceState, EmployeeInput } from "../types";

const CALENDAR = buildCalendar(2026, 2027).map((d) => ({
  date: d.date,
  isRequiredDay: d.isRequiredDay,
  label: d.label,
}));

const NOVEMBER = { start: "2026-11-01", end: "2026-11-30" };

/** Somebody whose last import was September, as all 61 Cape Town people are. */
function stillHere(overrides: Partial<EmployeeInput> = {}): EmployeeInput {
  return {
    id: 1,
    displayName: "Still Here",
    firstSeenDate: "2026-03-02",
    lastSeenDate: "2026-09-30",
    hasLeft: false,
    exemptions: [],
    attendance: new Map<string, AttendanceState>(),
    ...overrides,
  };
}

describe("an active employee, in the month after their last import", () => {
  it("still has required days", () => {
    const required = requiredDaysFor(stillHere(), CALENDAR, NOVEMBER, "2026-11-13");

    // Wed 4, Thu 5, Fri 6, Wed 11, Thu 12 - the 13th is today and unfinished.
    expect(required).toEqual([
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-11",
      "2026-11-12",
    ]);
  });

  it("is credited for the days the register says they were in", () => {
    const person = stillHere({
      attendance: new Map<string, AttendanceState>([
        ["2026-11-04", "PRESENT"],
        ["2026-11-05", "PRESENT"],
        ["2026-11-06", "PRESENT"],
        ["2026-11-11", "PRESENT"],
        ["2026-11-12", "PRESENT"],
      ]),
    });

    const result = monthlyCompliance(person, CALENDAR, "2026-11", "2026-11-13");

    expect(result.attended).toBe(5);
    expect(result.required).toBe(5);
    expect(result.verdict).toBe("YES");
  });

  it("is not reported as NA with nothing to judge", () => {
    // The exact symptom: ticked in on the register, 0/0 on the report.
    const person = stillHere({
      attendance: new Map<string, AttendanceState>([["2026-11-04", "PRESENT"]]),
    });

    const result = monthlyCompliance(person, CALENDAR, "2026-11", "2026-11-13");

    expect(result.verdict).not.toBe("NA");
    expect(result.required).toBeGreaterThan(0);
  });

  it("counts the month towards the long-term average", () => {
    const months = completeMonthsFor(stillHere(), CALENDAR, "2026-11-30");
    expect(months).toContain("2026-10");
  });
});

describe("somebody who has actually left", () => {
  it("has no required days after the day they left", () => {
    const gone = stillHere({ displayName: "Gone", hasLeft: true });

    expect(requiredDaysFor(gone, CALENDAR, NOVEMBER, "2026-11-13")).toEqual([]);
  });

  it("is not judged on a month that began after they left", () => {
    const gone = stillHere({ displayName: "Gone", hasLeft: true });

    const result = monthlyCompliance(gone, CALENDAR, "2026-11", "2026-11-13");
    expect(result.verdict).toBe("NA");
    expect(result.required).toBe(0);
  });

  it("stops counting towards the long-term average when they go", () => {
    const gone = stillHere({ displayName: "Gone", hasLeft: true });

    expect(completeMonthsFor(gone, CALENDAR, "2026-11-30")).not.toContain("2026-10");
  });

  /**
   * A leaver is still judged on the months they were there for. Departing in
   * September must not erase September.
   */
  it("is still judged on the months they worked", () => {
    const gone = stillHere({
      displayName: "Gone",
      hasLeft: true,
      attendance: new Map<string, AttendanceState>([["2026-09-02", "PRESENT"]]),
    });

    const required = requiredDaysFor(
      gone,
      CALENDAR,
      { start: "2026-09-01", end: "2026-09-30" },
      "2026-10-01",
    );
    expect(required.length).toBeGreaterThan(0);
    expect(required.every((date) => date <= "2026-09-30")).toBe(true);
  });
});

/**
 * Matthew Rudd, who left in November with a September roster date.
 *
 * Marked departed on 11 November, in the office on the 5th and 6th, register
 * entries for both days reading "last day - needs to be removed". His
 * `last_seen_date` said 30 September, so the two days he actually worked fell
 * outside his window and the report never counted them.
 */
describe("a leaver whose roster date is older than their last day in", () => {
  it("is credited for the days they were in after it", () => {
    const rudd = stillHere({
      displayName: "Matthew Rudd",
      hasLeft: true,
      lastSeenDate: "2026-09-30",
      attendance: new Map<string, AttendanceState>([
        ["2026-11-05", "PRESENT"],
        ["2026-11-06", "PRESENT"],
      ]),
    });

    const required = requiredDaysFor(rudd, CALENDAR, NOVEMBER, "2026-11-13");
    expect(required).toContain("2026-11-05");
    expect(required).toContain("2026-11-06");

    const result = monthlyCompliance(rudd, CALENDAR, "2026-11", "2026-11-13");
    expect(result.attended).toBe(2);
  });

  it("is not judged on the days after their last one", () => {
    const rudd = stillHere({
      displayName: "Matthew Rudd",
      hasLeft: true,
      lastSeenDate: "2026-09-30",
      attendance: new Map<string, AttendanceState>([
        ["2026-11-05", "PRESENT"],
        ["2026-11-06", "PRESENT"],
      ]),
    });

    const required = requiredDaysFor(rudd, CALENDAR, NOVEMBER, "2026-11-13");
    expect(required).not.toContain("2026-11-11");
    expect(required).not.toContain("2026-11-12");
  });

  /**
   * The guard that makes the above safe. An absence dated after somebody left
   * must not reopen their window, or marking a leaver absent by mistake would
   * make them non-compliant for a job they no longer hold.
   */
  it("is not reopened by an absence dated after they left", () => {
    const gone = stillHere({
      displayName: "Gone",
      hasLeft: true,
      lastSeenDate: "2026-09-30",
      attendance: new Map<string, AttendanceState>([
        ["2026-11-11", "ABSENT"],
        ["2026-11-12", "ABSENT_EXPLAINED"],
      ]),
    });

    expect(requiredDaysFor(gone, CALENDAR, NOVEMBER, "2026-11-13")).toEqual([]);
  });

  it("falls back to attendance when there is no roster date at all", () => {
    const gone = stillHere({
      displayName: "No Roster Date",
      hasLeft: true,
      firstSeenDate: null,
      lastSeenDate: null,
      attendance: new Map<string, AttendanceState>([["2026-11-05", "PRESENT"]]),
    });

    const required = requiredDaysFor(gone, CALENDAR, NOVEMBER, "2026-11-13");
    expect(required).toEqual(["2026-11-04", "2026-11-05"]);
  });
});

describe("the lower bound is untouched", () => {
  it("does not judge somebody before they joined", () => {
    const joiner = stillHere({ firstSeenDate: "2026-11-11", lastSeenDate: null });

    expect(requiredDaysFor(joiner, CALENDAR, NOVEMBER, "2026-11-13")).toEqual([
      "2026-11-11",
      "2026-11-12",
    ]);
  });
});
