import { describe, expect, it } from "vitest";
import { filterRows, sortRows } from "../sort";
import type { ComplianceResult, EmployeeRowWithDays, Verdict } from "../types";

const result = (verdict: Verdict): ComplianceResult => ({
  verdict,
  attended: 0,
  required: 0,
  excused: 0,
  missed: [],
});

function row(
  name: string,
  overrides: Partial<EmployeeRowWithDays> = {},
): EmployeeRowWithDays {
  return {
    employeeId: name.length,
    displayName: name,
    isExempt: false,
    exemptionNote: null,
    monthly: result("YES"),
    twoWeek: result("YES"),
    longTerm: { ...result("YES"), wednesdayAverage: 3, fridayAverage: 3, monthsCounted: 3 },
    lastAttended: "2026-08-28",
    monthDays: [],
    ...overrides,
  };
}

describe("sorting by verdict", () => {
  it("puts the people who need attention first", () => {
    const rows = [
      row("Yes Person", { monthly: result("YES") }),
      row("Exempt Person", { monthly: result("EXEMPT"), isExempt: true }),
      row("No Person", { monthly: result("NO") }),
      row("Na Person", { monthly: result("NA") }),
    ];

    expect(sortRows(rows, "monthly", "asc").map((r) => r.monthly.verdict)).toEqual([
      "NO", "YES", "NA", "EXEMPT",
    ]);
  });

  it("reverses cleanly", () => {
    const rows = [
      row("A", { monthly: result("NO") }),
      row("B", { monthly: result("YES") }),
      row("C", { monthly: result("EXEMPT") }),
    ];
    expect(sortRows(rows, "monthly", "desc").map((r) => r.monthly.verdict)).toEqual([
      "EXEMPT", "YES", "NO",
    ]);
  });

  it("breaks ties by name so the order is stable", () => {
    const rows = [
      row("Zoe", { monthly: result("NO") }),
      row("Adam", { monthly: result("NO") }),
      row("Mary", { monthly: result("NO") }),
    ];
    expect(sortRows(rows, "monthly", "asc").map((r) => r.displayName)).toEqual([
      "Adam", "Mary", "Zoe",
    ]);
  });

  it("sorts each of the three verdict columns", () => {
    for (const key of ["monthly", "twoWeek", "longTerm"] as const) {
      const rows = [
        row("Good", { [key]: { ...result("YES"), wednesdayAverage: 3, fridayAverage: 3, monthsCounted: 3 } } as Partial<EmployeeRowWithDays>),
        row("Bad", { [key]: { ...result("NO"), wednesdayAverage: 0, fridayAverage: 0, monthsCounted: 3 } } as Partial<EmployeeRowWithDays>),
      ];
      expect(sortRows(rows, key, "asc")[0].displayName, key).toBe("Bad");
    }
  });
});

describe("sorting by name and last attended", () => {
  it("sorts by name", () => {
    const rows = [row("Zoe Flanegan"), row("Adam Whitehouse"), row("Mary Rodrigues-Jack")];
    expect(sortRows(rows, "name", "asc").map((r) => r.displayName)).toEqual([
      "Adam Whitehouse", "Mary Rodrigues-Jack", "Zoe Flanegan",
    ]);
  });

  it("treats never-attended as the most overdue, not as missing data", () => {
    const rows = [
      row("Recent", { lastAttended: "2026-08-31" }),
      row("Never", { lastAttended: null }),
      row("Old", { lastAttended: "2026-03-04" }),
    ];
    expect(sortRows(rows, "lastAttended", "asc").map((r) => r.displayName)).toEqual([
      "Never", "Old", "Recent",
    ]);
  });

  it("does not mutate the input", () => {
    const rows = [row("Zoe"), row("Adam")];
    const before = rows.map((r) => r.displayName);
    sortRows(rows, "name", "asc");
    expect(rows.map((r) => r.displayName)).toEqual(before);
  });
});

describe("filtering", () => {
  const rows = [
    row("Kevin Irwin", { isExempt: true, monthly: result("EXEMPT") }),
    row("Ben Clay", { monthly: result("NO") }),
    row("Amy Dudley", { monthly: result("YES") }),
  ];

  it("hides exempt people by default", () => {
    const out = filterRows(rows, { showExempt: false, onlyProblems: false, query: "" });
    expect(out.map((r) => r.displayName)).toEqual(["Ben Clay", "Amy Dudley"]);
  });

  it("shows them when asked", () => {
    const out = filterRows(rows, { showExempt: true, onlyProblems: false, query: "" });
    expect(out).toHaveLength(3);
  });

  it("narrows to the non-compliant", () => {
    const out = filterRows(rows, { showExempt: true, onlyProblems: true, query: "" });
    expect(out.map((r) => r.displayName)).toEqual(["Ben Clay"]);
  });

  it("searches by name, case-insensitively", () => {
    const out = filterRows(rows, { showExempt: true, onlyProblems: false, query: "dUdL" });
    expect(out.map((r) => r.displayName)).toEqual(["Amy Dudley"]);
  });

  it("combines filters", () => {
    const out = filterRows(rows, { showExempt: false, onlyProblems: true, query: "clay" });
    expect(out.map((r) => r.displayName)).toEqual(["Ben Clay"]);
  });
});
