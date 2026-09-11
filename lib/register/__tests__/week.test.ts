import { describe, expect, it } from "vitest";
import { addDays, dayStatusFor, formatWeek, requiredDaysOfWeek, weekStart } from "../week";

describe("weeks", () => {
  it("finds the Monday of any day's week", () => {
    // 2026-09-09 is a Wednesday.
    expect(weekStart("2026-09-09")).toBe("2026-09-07");
    expect(weekStart("2026-09-07")).toBe("2026-09-07"); // the Monday itself
    expect(weekStart("2026-09-11")).toBe("2026-09-07"); // the Friday
  });

  it("treats Sunday as the end of the week that just finished", () => {
    // Otherwise opening the register on a Sunday evening shows next week,
    // which is not the week anybody has been keeping.
    expect(weekStart("2026-09-13")).toBe("2026-09-07");
  });

  it("picks out the two days that count", () => {
    expect(requiredDaysOfWeek("2026-09-07")).toEqual({
      wednesday: "2026-09-09",
      friday: "2026-09-11",
    });
  });

  it("labels a week readably, including across a month boundary", () => {
    // en-GB abbreviates September to "Sept", which is correct British usage.
    expect(formatWeek("2026-09-07")).toBe("7–11 Sept 2026");
    expect(formatWeek("2026-08-31")).toBe("31 Aug – 4 Sept 2026");
    expect(formatWeek("2026-08-03")).toBe("3–7 Aug 2026");
  });

  it("steps between weeks", () => {
    expect(addDays("2026-09-07", 7)).toBe("2026-09-14");
    expect(addDays("2026-09-07", -7)).toBe("2026-08-31");
  });
});

describe("what a day is", () => {
  const calendar = new Map([
    ["2026-09-09", { isRequiredDay: true, label: null }],
    ["2026-05-01", { isRequiredDay: false, label: "Workers' Day" }],
    ["2026-09-10", { isRequiredDay: false, label: null }],
  ]);

  it("opens an ordinary required day", () => {
    expect(dayStatusFor("2026-09-09", calendar, new Map())).toEqual({
      kind: "OPEN",
      date: "2026-09-09",
    });
  });

  it("closes a public holiday and says which one", () => {
    expect(dayStatusFor("2026-05-01", calendar, new Map())).toEqual({
      kind: "CLOSED",
      date: "2026-05-01",
      label: "Workers' Day",
    });
  });

  it("closes a day this office shut, even though the calendar allows it", () => {
    const closures = new Map([["2026-09-09", "Office closed"]]);
    expect(dayStatusFor("2026-09-09", calendar, closures)).toEqual({
      kind: "CLOSED",
      date: "2026-09-09",
      label: "Office closed",
    });
  });

  it("refuses a date the calendar has never heard of", () => {
    expect(dayStatusFor("2030-01-01", calendar, new Map()).kind).toBe("CLOSED");
  });
});
