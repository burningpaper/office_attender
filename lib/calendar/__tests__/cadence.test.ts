/**
 * The cadence, and the boundary it turns on.
 */
import { describe, expect, it } from "vitest";
import { buildCalendar } from "../build-calendar";
import {
  THURSDAY,
  WEDNESDAY,
  FRIDAY,
  describeCadence,
  requiredDaysPerWeek,
  requiredWeekdays,
} from "../cadence";

describe("which weekdays are required", () => {
  it("is Wednesday and Friday before 5 November 2026", () => {
    expect(requiredWeekdays("2026-10-30")).toEqual([WEDNESDAY, FRIDAY]);
    expect(requiredWeekdays("2026-11-04")).toEqual([WEDNESDAY, FRIDAY]);
    expect(requiredDaysPerWeek("2026-10-01")).toBe(2);
  });

  it("includes Thursday from 5 November 2026", () => {
    expect(requiredWeekdays("2026-11-05")).toEqual([WEDNESDAY, THURSDAY, FRIDAY]);
    expect(requiredWeekdays("2027-03-01")).toEqual([WEDNESDAY, THURSDAY, FRIDAY]);
    expect(requiredDaysPerWeek("2026-11-05")).toBe(3);
  });

  it("reads as a sentence, so nothing has to hardcode the prose", () => {
    expect(describeCadence("2026-10-30")).toBe("Wednesdays and Fridays");
    expect(describeCadence("2026-11-05")).toBe("Wednesdays, Thursdays and Fridays");
    expect(describeCadence("2026-11-05", false)).toBe("Wednesday, Thursday and Friday");
  });
});

describe("the calendar either side of the boundary", () => {
  const byDate = new Map(buildCalendar(2026, 2026).map((d) => [d.date, d]));
  const required = (date: string) => byDate.get(date)!.isRequiredDay;

  it("does not hold October's Thursdays against anybody", () => {
    // The last Thursday before the change. Somebody who attended every
    // required day in October did not retrospectively miss four Thursdays.
    expect(required("2026-10-29")).toBe(false);
    expect(required("2026-10-28")).toBe(true); // Wednesday
    expect(required("2026-10-30")).toBe(true); // Friday
  });

  it("counts Thursdays from the 5th", () => {
    expect(required("2026-11-05")).toBe(true);
    expect(required("2026-11-12")).toBe(true);
  });

  it("still ignores a required weekday that is a public holiday", () => {
    // Christmas Day 2026 is a Friday; Boxing Day falls on the Saturday.
    expect(byDate.get("2026-12-25")!.dayType).toBe("PUBLIC_HOLIDAY");
    expect(required("2026-12-25")).toBe(false);
  });

  it("November has twelve required days, October nine", () => {
    // November 2026 opens on a Sunday, so the 4th is the month's first
    // Wednesday and the 5th - the day the rule changes - its first Thursday.
    // Four of each weekday follow, and no public holiday falls in November.
    const count = (month: string) =>
      [...byDate.values()].filter((d) => d.date.startsWith(month) && d.isRequiredDay).length;
    expect(count("2026-10")).toBe(9);
    expect(count("2026-11")).toBe(12);
  });
});
