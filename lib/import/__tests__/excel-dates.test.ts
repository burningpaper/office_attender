import { describe, expect, it } from "vitest";
import {
  isPlausibleDateSerial,
  isRequiredWeekday,
  isoWeekday,
  serialToISODate,
} from "../excel-dates";

describe("Excel serial dates", () => {
  it("decodes the serials actually present in the workbook", () => {
    // Spot values read straight out of the sheet XML.
    expect(serialToISODate(46083)).toBe("2026-03-02"); // March col D
    expect(serialToISODate(46258)).toBe("2026-08-24"); // Pdf sheet col D
    expect(serialToISODate(46112)).toBe("2026-03-31"); // March col AC
  });

  it("round-trips a known anchor", () => {
    // 1 Jan 2026 is serial 46023 under the 1899-12-30 epoch.
    expect(serialToISODate(46023)).toBe("2026-01-01");
  });

  it("rejects values that are counts rather than dates", () => {
    // The August totals row holds 6, 5, 3, 1, 7, 7 - none may parse as a date.
    for (const n of [0, 1, 3, 5, 6, 7, 22, 36]) {
      expect(isPlausibleDateSerial(n)).toBe(false);
    }
    expect(isPlausibleDateSerial(46083)).toBe(true);
  });

  it("identifies the required weekdays", () => {
    expect(isoWeekday("2026-03-04")).toBe(3); // Wednesday
    expect(isRequiredWeekday("2026-03-04")).toBe(true);
    expect(isRequiredWeekday("2026-03-06")).toBe(true); // Friday
    expect(isRequiredWeekday("2026-03-05")).toBe(false); // Thursday
    expect(isRequiredWeekday("2026-03-02")).toBe(false); // Monday
  });
});
