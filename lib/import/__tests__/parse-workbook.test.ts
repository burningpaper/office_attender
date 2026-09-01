/**
 * Golden fixture tests against the real workbook.
 *
 * These assert exact counts. That is deliberate: the parser's contract is that
 * the same file always yields the same records, so a change in any number here
 * should be a decision someone made, not a surprise.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseWorkbook } from "../parse-workbook";
import type { WorkbookParseResult } from "../types";

/**
 * The real workbook is deliberately NOT in version control - it holds named
 * employees alongside illness and maternity records. It lives on disk only.
 *
 * These tests fail loudly rather than skipping when it is absent: a green run
 * that silently tested nothing would be worse than a red one.
 */
const WORKBOOK = path.resolve(__dirname, "../../../data_example.xls.xlsx");

let result: WorkbookParseResult;

beforeAll(() => {
  if (!existsSync(WORKBOOK)) {
    throw new Error(
      `Fixture workbook not found at ${WORKBOOK}.\n` +
        `It is excluded from git on purpose (real employee data). Copy it into ` +
        `the project root to run these tests.`,
    );
  }
  result = parseWorkbook(readFileSync(WORKBOOK));
});

const sheet = (name: string) => result.sheets.find((s) => s.sheetName === name)!;
const warningsOfType = (code: string) => result.warnings.filter((w) => w.code === code);

describe("sheet discovery", () => {
  it("finds the seven month sheets and skips the Pdf sheet", () => {
    const data = result.sheets.filter((s) => s.isDataSheet).map((s) => s.sheetName);
    expect(data).toEqual([
      "March", "April", "May", "June", "July", "August", "September",
    ]);

    const skipped = result.sheets.filter((s) => !s.isDataSheet);
    expect(skipped.map((s) => s.sheetName)).toEqual(["Pdf"]);
    expect(warningsOfType("SHEET_SKIPPED")).toHaveLength(1);
  });

  it("locates the header row on every data sheet", () => {
    for (const s of result.sheets.filter((x) => x.isDataSheet)) {
      expect(s.headerRow, `${s.sheetName} header row`).toBe(1);
    }
  });
});

describe("date decoding", () => {
  it("decodes each sheet's date range correctly", () => {
    expect(sheet("March").dateRange).toEqual({ start: "2026-03-02", end: "2026-03-31" });
    expect(sheet("April").dateRange).toEqual({ start: "2026-04-01", end: "2026-04-30" });
    expect(sheet("May").dateRange).toEqual({ start: "2026-05-01", end: "2026-05-29" });
    expect(sheet("June").dateRange).toEqual({ start: "2026-06-02", end: "2026-06-30" });
    expect(sheet("July").dateRange).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    expect(sheet("August").dateRange).toEqual({ start: "2026-08-03", end: "2026-08-31" });
    expect(sheet("September").dateRange).toEqual({ start: "2026-09-01", end: "2026-09-30" });
  });

  it("never produces a weekend date - spacer columns are not mistaken for dates", () => {
    const weekend = result.records.filter((r) => {
      const d = new Date(`${r.date}T00:00:00Z`).getUTCDay();
      return d === 0 || d === 6;
    });
    expect(weekend).toEqual([]);
  });

  it("counts date columns per sheet", () => {
    expect(sheet("March").dateColumnCount).toBe(22);
    expect(sheet("April").dateColumnCount).toBe(22);
    expect(sheet("May").dateColumnCount).toBe(21);
    expect(sheet("June").dateColumnCount).toBe(21);
    expect(sheet("July").dateColumnCount).toBe(23);
    expect(sheet("August").dateColumnCount).toBe(20);
    expect(sheet("September").dateColumnCount).toBe(22);
  });
});

describe("furniture rejection", () => {
  it("drops every totals row - there are nine, not one", () => {
    // Each sheet carries a column-sum row (no name, values well above 1), and
    // several carry a second one lower down. All nine must be rejected.
    const totals = warningsOfType("NON_BINARY_NUMERIC_CELL");
    expect(totals.map((w) => `${w.sheetName}:${w.rowNumber}`)).toEqual([
      "March:64", "April:64", "May:60", "May:74", "June:60",
      "July:59", "July:73", "August:58", "August:72",
    ]);
    // None of them carries a name - that is what makes them safe to drop.
    expect(totals.every((w) => w.detail?.rawName === null)).toBe(true);
  });

  it("leaves no stray non-binary value in the parsed records", () => {
    const bad = result.records.filter(
      (r) => /^-?\d+(\.\d+)?$/.test(r.rawValue) && r.rawValue !== "0" && r.rawValue !== "1",
    );
    expect(bad).toEqual([]);
  });

  it("drops legend rows and section dividers that carry no attendance data", () => {
    const dropped = warningsOfType("DROPPED_ROW_NO_DATA");
    const names = dropped.map((w) => w.detail?.rawName);

    // "YONDER" is a division divider, present on every sheet.
    expect(dropped.filter((w) => w.detail?.rawName === "YONDER")).toHaveLength(7);
    expect(names).toContain("Richard Shelton");

    // May lists five people a second time below the blank gap, all with empty
    // cells. These are the duplicates that must not become real attendance.
    expect(
      dropped.filter((w) => w.sheetName === "May").map((w) => w.detail?.rawName).sort(),
    ).toEqual(["Ben Clay", "Jason Khubeka", "Jason Tucker", "Weslee Johanneson", "YONDER", "Zoe Flanegan"].sort());
  });

  it("leaves no duplicate name carrying data on a single sheet", () => {
    // May's apparent duplicates are all legend rows; once those are dropped,
    // nothing should remain that needs merging.
    expect(warningsOfType("DUPLICATE_NAME_IN_SHEET")).toEqual([]);
  });

  it("KEEPS June's Weslee Johannesen, who sits below the gap but has real data", () => {
    // The trap: position says legend, content says employee. Content wins.
    const kept = result.employees.filter(
      (e) => e.sheetName === "June" && e.rawName === "Weslee Johannesen",
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].rowNumber).toBe(80);

    const records = result.records.filter(
      (r) => r.sheetName === "June" && r.rawName === "Weslee Johannesen",
    );
    // Column E is 2 June, so column F - the one cell filled in - is 3 June.
    expect(records).toEqual([
      { sheetName: "June", rowNumber: 80, rawName: "Weslee Johannesen", date: "2026-06-03", rawValue: "1" },
    ]);
  });
});

describe("malformed date headers", () => {
  it("flags them, proposes a reading, and withholds the data", () => {
    const strays = warningsOfType("UNPARSEABLE_DATE_HEADER");
    const byText = Object.fromEntries(
      strays.map((w) => [w.detail?.headerText as string, w]),
    );

    expect(byText["O1 June"]).toBeDefined();
    expect(byText["O1 June"].sheetName).toBe("June");
    expect(byText["O1 June"].proposedDate).toBe("2026-06-01");

    expect(byText["O1 June"].detail?.hasData).toBe(true);

    expect(byText["10 Aug"]).toBeDefined();
    expect(byText["10 Aug"].sheetName).toBe("August");
    expect(byText["10 Aug"].proposedDate).toBe("2026-08-10");
    // August's column is empty below the header - nothing was ever recorded.
    expect(byText["10 Aug"].detail?.hasData).toBe(false);

    // Withheld until confirmed: no records exist for either proposed date.
    expect(result.records.filter((r) => r.date === "2026-06-01")).toEqual([]);
    expect(result.records.filter((r) => r.date === "2026-08-10")).toEqual([]);
  });
});

describe("names", () => {
  it("surfaces the two rows with no surname", () => {
    const missing = warningsOfType("MISSING_LAST_NAME");
    const names = [...new Set(missing.map((w) => w.detail?.rawName))].sort();
    // "Weslee Johannesen" joins them: the full name sits in the first-name
    // column with the surname column left empty, so structurally it has none.
    expect(names).toEqual(["Brian", "Intern", "Weslee Johannesen"]);
  });

  it("captures standing notes from the column with no header", () => {
    // September's note column has a blank header but real content.
    const sept = result.employees.filter((e) => e.sheetName === "September" && e.standingNote);
    const notes = Object.fromEntries(sept.map((e) => [e.rawName, e.standingNote]));
    expect(notes["Jana Kleinloog"]).toBe("From Hermanus");
    expect(notes["Mary Rodrigues-Jack"]).toBe("On Maternity Leave");
  });
});

describe("determinism", () => {
  it("produces byte-identical output when re-run on the same file", () => {
    const again = parseWorkbook(readFileSync(WORKBOOK));
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
  });
});

describe("totals", () => {
  it("matches the expected record and employee-row counts", () => {
    const perSheet = Object.fromEntries(
      result.sheets.filter((s) => s.isDataSheet).map((s) => [s.sheetName, s.employeeRowCount]),
    );
    expect(perSheet).toMatchInlineSnapshot(`
      {
        "April": 75,
        "August": 68,
        "July": 69,
        "June": 71,
        "March": 74,
        "May": 70,
        "September": 67,
      }
    `);
  });
});
