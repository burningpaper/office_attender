/**
 * Sorting and filtering for the table.
 *
 * Extracted from the component so the ordering rules can be tested. The tricky
 * part is that verdicts are not booleans: NO, YES, NA and EXEMPT have to order
 * sensibly, and "sensibly" means the people who need attention come first.
 */

import type { EmployeeRowWithDays } from "./types";
import { VERDICT_ORDER } from "./rules";

export type SortKey = "name" | "monthly" | "twoWeek" | "longTerm" | "lastAttended";
export type Direction = "asc" | "desc";

export type Filters = {
  showExempt: boolean;
  onlyProblems: boolean;
  query: string;
};

export function filterRows(
  rows: EmployeeRowWithDays[],
  filters: Filters,
): EmployeeRowWithDays[] {
  let list = rows;
  if (!filters.showExempt) list = list.filter((r) => !r.isExempt);
  if (filters.onlyProblems) list = list.filter((r) => r.monthly.verdict === "NO");

  const query = filters.query.trim().toLowerCase();
  if (query) list = list.filter((r) => r.displayName.toLowerCase().includes(query));

  return list;
}

export function sortRows(
  rows: EmployeeRowWithDays[],
  key: SortKey,
  direction: Direction,
): EmployeeRowWithDays[] {
  const factor = direction === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    switch (key) {
      case "name":
        return factor * a.displayName.localeCompare(b.displayName);

      case "lastAttended": {
        /**
         * Somebody who has never attended sorts as the most overdue, not as
         * missing data - an empty string sorts before every real date, so
         * ascending puts them at the top where they belong.
         */
        const av = a.lastAttended ?? "";
        const bv = b.lastAttended ?? "";
        if (av !== bv) return factor * av.localeCompare(bv);
        return a.displayName.localeCompare(b.displayName);
      }

      default: {
        /**
         * NO before YES before NA before EXEMPT. Ascending therefore means
         * "worst first", which is what someone opening this report wants.
         */
        const byVerdict =
          VERDICT_ORDER[a[key].verdict] - VERDICT_ORDER[b[key].verdict];
        if (byVerdict !== 0) return factor * byVerdict;
        return a.displayName.localeCompare(b.displayName);
      }
    }
  });
}
