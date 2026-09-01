/**
 * The compliance engine against the real workbook, end to end.
 *
 * The unit tests prove the rules; this proves they still hold once 82 real
 * people with seven months of messy history are put through them.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "../../db/__tests__/helpers";
import { importWorkbook } from "../../import/import-workbook";
import { loadEmployeeRows } from "../load";
import type { EmployeeRow } from "../types";

const WORKBOOK = path.resolve(__dirname, "../../../data_example.xls.xlsx");

let rowsAtSept1: EmployeeRow[];
let rowsAtAug31: EmployeeRow[];

beforeAll(async () => {
  if (!existsSync(WORKBOOK)) {
    throw new Error(
      `Fixture workbook not found at ${WORKBOOK}. It is excluded from git on ` +
        `purpose (real employee data). Copy it into the project root to run these tests.`,
    );
  }
  const ctx = await freshDb();
  await importWorkbook(ctx.db, readFileSync(WORKBOOK), "data_example.xls.xlsx");
  rowsAtSept1 = await loadEmployeeRows(ctx.db, "2026-09", "2026-09-01");
  rowsAtAug31 = await loadEmployeeRows(ctx.db, "2026-08", "2026-08-31");
}, 120_000);

describe("the default view on the 1st of the month", () => {
  it("does not accuse a single person", () => {
    // The bug this whole design exists to fix. September has 1,474 cells and
    // zero attendance in the source data, because the month has not happened.
    expect(rowsAtSept1).toHaveLength(82);
    const nonCompliant = rowsAtSept1.filter((r) => r.monthly.verdict === "NO");
    expect(nonCompliant).toEqual([]);
  });

  it("says 'not yet' rather than 'no'", () => {
    const visible = rowsAtSept1.filter((r) => !r.isExempt);
    expect(visible.every((r) => r.monthly.verdict === "NA")).toBe(true);
    expect(visible[0].monthly.note).toMatch(/no required days have elapsed/i);
  });
});

describe("exemptions on real data", () => {
  it("resolves Kevin Irwin to EXEMPT rather than seven months of red", () => {
    const kevin = rowsAtAug31.find((r) => r.displayName === "Kevin Irwin")!;
    expect(kevin.isExempt).toBe(true);
    expect(kevin.exemptionNote).toMatch(/george/i);
    expect(kevin.monthly.verdict).toBe("EXEMPT");
  });

  it("exempts everyone whose standing note puts them out of reach", () => {
    const exempt = rowsAtAug31.filter((r) => r.isExempt).map((r) => r.displayName).sort();
    expect(exempt).toEqual([
      "Hannerie Lotz", "Jana Kleinloog", "Kelly-Ann Tabone", "Kevin Irwin",
      "Mary Rodrigues-Jack", "Rialene Nel", "Sandra McDiarmid",
    ]);
  });

  it("does NOT exempt the Thursday work-from-home approval", () => {
    // Thursday is not a required day, so it says nothing about Wed/Fri.
    const lorna = rowsAtAug31.find((r) => r.displayName === "Lorna Downs")!;
    expect(lorna.isExempt).toBe(false);
  });
});

describe("public holidays on real data", () => {
  it("does not fail the whole company in April", async () => {
    const ctx = await freshDb();
    await importWorkbook(ctx.db, readFileSync(WORKBOOK), "data_example.xls.xlsx");
    const april = await loadEmployeeRows(ctx.db, "2026-04", "2026-04-30");

    // Good Friday (3 April) had zero attendance company-wide. It must not be a
    // required day, so April must have eight required days rather than nine.
    const withDays = april.filter((r) => !r.isExempt && r.monthly.verdict !== "NA");
    expect(withDays.length).toBeGreaterThan(0);
    expect(Math.max(...withDays.map((r) => r.monthly.required + r.monthly.excused))).toBe(8);
  }, 120_000);
});

describe("the report is actually usable", () => {
  it("hides the exempt and keeps the roster intact", () => {
    const visible = rowsAtAug31.filter((r) => !r.isExempt);
    expect(visible).toHaveLength(75);
    expect(rowsAtAug31).toHaveLength(82);
  });

  it("gives every person a verdict in all four columns", () => {
    for (const row of rowsAtAug31) {
      expect(["YES", "NO", "EXEMPT", "NA"]).toContain(row.monthly.verdict);
      expect(["YES", "NO", "EXEMPT", "NA"]).toContain(row.twoWeek.verdict);
      expect(["YES", "NO", "EXEMPT", "NA"]).toContain(row.longTerm.verdict);
    }
  });

  it("shows excused days alongside the fraction", () => {
    // Carlos Feyder has three excused required days in August. Without the
    // count, "4/5" looks like a worse month than it was.
    const carlos = rowsAtAug31.find((r) => r.displayName === "Carlos Feyder")!;
    expect(carlos.monthly.excused).toBeGreaterThan(0);
    expect(carlos.monthly.required).toBeLessThan(8);
  });

  it("reports 'never attended' as a fact, not an error", () => {
    const never = rowsAtAug31.filter((r) => r.lastAttended === null);
    expect(never.length).toBeGreaterThan(0);
    expect(never.map((r) => r.displayName)).toContain("Francesca Tiganis");
  });

  it("gives a late joiner NA on long term rather than NO", () => {
    const intern = rowsAtAug31.find((r) => r.displayName === "Intern")!;
    expect(intern.longTerm.verdict).toBe("NA");
    expect(intern.longTerm.monthsCounted).toBeLessThan(2);
  });

  it("gives a leaver NA for a month after they left", () => {
    // Abdul-Maalik Jacobs last appears in June.
    const leaver = rowsAtAug31.find((r) => r.displayName === "Abdul-Maalik Jacobs")!;
    expect(leaver.monthly.verdict).toBe("NA");
    expect(leaver.lastAttended!.slice(0, 7) <= "2026-06").toBe(true);
  });
});
