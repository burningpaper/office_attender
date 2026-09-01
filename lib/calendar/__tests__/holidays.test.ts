import { describe, expect, it } from "vitest";
import { buildCalendar } from "../build-calendar";
import { easterSunday, southAfricanHolidays } from "../holidays";

const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

describe("computus", () => {
  it("finds Easter Sunday for known years", () => {
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2025)).toBe("2025-04-20");
    expect(easterSunday(2024)).toBe("2024-03-31");
    expect(easterSunday(2027)).toBe("2027-03-28");
  });
});

describe("South African public holidays 2026", () => {
  const h = southAfricanHolidays(2026);

  it("derives Good Friday and Family Day from Easter", () => {
    expect(h.get("2026-04-03")).toBe("Good Friday");
    expect(h.get("2026-04-06")).toBe("Family Day");
  });

  it("applies the Sunday rule from the Public Holidays Act", () => {
    // National Women's Day falls on a Sunday in 2026, so the Monday is a
    // public holiday. This is why the August sheet has a "10 Aug" column with
    // nothing under it - the office was shut.
    expect(dow("2026-08-09")).toBe(0);
    expect(h.get("2026-08-09")).toBe("National Women's Day");
    expect(h.get("2026-08-10")).toBe("National Women's Day (observed)");
  });

  it("does not invent an observed day for holidays that miss Sunday", () => {
    expect(h.get("2026-04-04")).toBeUndefined(); // day after Good Friday
    expect(h.get("2026-01-02")).toBeUndefined(); // New Year's Day is a Thursday
  });

  it("covers all twelve statutory holidays", () => {
    const names = new Set([...h.values()].map((n) => n.replace(" (observed)", "")));
    expect(names).toEqual(
      new Set([
        "New Year's Day", "Human Rights Day", "Good Friday", "Family Day",
        "Freedom Day", "Workers' Day", "Youth Day", "National Women's Day",
        "Heritage Day", "Day of Reconciliation", "Christmas Day", "Day of Goodwill",
      ]),
    );
  });
});

describe("the calendar fixes the spec's public-holiday bug", () => {
  const cal = new Map(buildCalendar(2026, 2026).map((d) => [d.date, d]));

  it("excludes the two required days that sank the whole company", () => {
    // Both showed zero attendance across all ~75 employees in the sample data.
    // Under the naive rule that is company-wide non-compliance for April and May.
    for (const [date, label] of [
      ["2026-04-03", "Good Friday"],
      ["2026-05-01", "Workers' Day"],
    ]) {
      const day = cal.get(date)!;
      expect(dow(date), `${date} is a Friday`).toBe(5);
      expect(day.dayType).toBe("PUBLIC_HOLIDAY");
      expect(day.isRequiredDay, `${date} must not count`).toBe(false);
      expect(day.label).toBe(label);
    }
  });

  it("leaves July 1st and 3rd as genuinely ambiguous working days", () => {
    // Also zero-attendance in the data, but not public holidays. The system
    // must not quietly excuse them - only a human knows whether the office was
    // shut or the sheet was never filled in.
    for (const date of ["2026-07-01", "2026-07-03"]) {
      const day = cal.get(date)!;
      expect(day.dayType).toBe("WORKING");
      expect(day.isRequiredDay).toBe(true);
    }
  });

  it("counts only Wednesdays and Fridays as required", () => {
    const required = [...cal.values()].filter((d) => d.isRequiredDay);
    expect(required.every((d) => dow(d.date) === 3 || dow(d.date) === 5)).toBe(true);
    expect(required.some((d) => d.dayType !== "WORKING")).toBe(false);
  });

  it("December has only seven required days - both holidays land on them", () => {
    // 16 Dec is a Wednesday and 25 Dec a Friday in 2026. Worth knowing: this is
    // the month where "average 3 Wednesdays and 3 Fridays" gets hard to reach.
    const dec = [...cal.values()].filter(
      (d) => d.date.startsWith("2026-12") && d.isRequiredDay,
    );
    expect(dec).toHaveLength(7);
    expect(cal.get("2026-12-16")!.isRequiredDay).toBe(false);
    expect(cal.get("2026-12-25")!.isRequiredDay).toBe(false);
  });

  it("produces a complete year with no gaps", () => {
    expect(buildCalendar(2026, 2026)).toHaveLength(365);
    expect(buildCalendar(2024, 2024)).toHaveLength(366); // leap year
  });
});
