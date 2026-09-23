/**
 * Who gets a message, and what it says about them.
 *
 * This is the part of the system that reaches outside the building, so the
 * rules about who is excluded matter more than the rules about who is included.
 * Three exclusions are absolute and are enforced here rather than in the
 * interface, where a future change could quietly skip them:
 *
 *   - Anybody who has left. Chasing a former employee about their attendance is
 *     the most obviously wrong message this system could send.
 *   - Anybody exempt. Telling somebody who lives 430km away, or is on
 *     maternity leave, that they have not been in the office would be worse
 *     than sending nothing at all.
 *   - Anybody with no email address on file.
 *   - Anybody whose verdict is not NO. NA means the question could not be
 *     answered - it is not a failure, and must never be mailed as one.
 *
 * The dates quoted come straight from the compliance result rather than being
 * worked out again here. Deriving them twice is what let a message say
 * "2 attended, 0 missed" to somebody the report had marked non-compliant: the
 * verdict counted two days with no record as missed, and this side skipped
 * them. One source, one answer.
 */

import type { EmployeeRowWithDays, Verdict } from "../compliance/types";

export type EmailCategory = "MONTHLY" | "TWO_WEEK" | "LONG_TERM";

export const CATEGORY_LABELS: Record<EmailCategory, string> = {
  MONTHLY: "Not compliant this month",
  TWO_WEEK: "Missed a Wednesday or a Friday in the last two weeks",
  LONG_TERM: "Below the long-term average",
};

export type Recipient = {
  employeeId: number;
  displayName: string;
  email: string;
  /**
   * Non-compliant for the month, but has attended every required day since you
   * last wrote to them. Still on the list - you may want to say well done, or
   * nothing at all - but flagged so the list can be worked worst-first.
   */
  improving: boolean;
  /** Plain-English summary of the recent window, for the interface. */
  recentNote: string | null;
  /** Required days in the window they were present. */
  attended: string[];
  /** Required days in the window they missed, with no explanation. */
  missed: string[];
  /** Required days excused by a recorded reason. Never presented as a miss. */
  excused: string[];
};

export type ExcludedRecipient = {
  displayName: string;
  reason: "EXEMPT" | "NO_EMAIL" | "NOT_FAILING" | "LEFT";
};

export type RecipientList = {
  recipients: Recipient[];
  excluded: ExcludedRecipient[];
};

/**
 * "Every required day since the 8th" reads better than "4/4 SINCE_REMINDER",
 * and is something you could paste into a message to somebody.
 */
function describeRecent(row: EmployeeRowWithDays): string | null {
  const { basis, since, result } = row.recent;
  if (result.required === 0) return null;

  const days = `${result.attended} of ${result.required} recent required day${result.required === 1 ? "" : "s"}`;
  if (basis === "SINCE_REMINDER" && since) {
    return `${days}, since the reminder on ${since}`;
  }
  return days;
}

function resultFor(row: EmployeeRowWithDays, category: EmailCategory) {
  if (category === "TWO_WEEK") return row.twoWeek;
  /**
   * Long term is an average rather than a set of days, so it has no dates of
   * its own. The month's are the useful thing to show somebody being written to
   * about it.
   */
  return row.monthly;
}

function verdictFor(row: EmployeeRowWithDays, category: EmailCategory): Verdict {
  if (category === "MONTHLY") return row.monthly.verdict;
  if (category === "TWO_WEEK") return row.twoWeek.verdict;
  return row.longTerm.verdict;
}

/**
 * Build the list for a category.
 *
 * `emailByEmployeeId` is passed in rather than read off the row so that the
 * compliance types stay free of contact details.
 */
export function buildRecipients(
  rows: EmployeeRowWithDays[],
  category: EmailCategory,
  emailByEmployeeId: Map<number, string>,
): RecipientList {
  const recipients: Recipient[] = [];
  const excluded: ExcludedRecipient[] = [];

  for (const row of rows) {
    /**
     * Checked first, and checked on two signals rather than one: the durable
     * status, and whether they were on that month's sheet at all. Either is
     * enough - a former employee must never receive one of these.
     */
    if (row.hasLeft || !row.onRosterThisMonth) {
      excluded.push({ displayName: row.displayName, reason: "LEFT" });
      continue;
    }

    if (row.isExempt) {
      excluded.push({ displayName: row.displayName, reason: "EXEMPT" });
      continue;
    }

    if (verdictFor(row, category) !== "NO") {
      excluded.push({ displayName: row.displayName, reason: "NOT_FAILING" });
      continue;
    }

    const email = emailByEmployeeId.get(row.employeeId);
    if (!email) {
      excluded.push({ displayName: row.displayName, reason: "NO_EMAIL" });
      continue;
    }

    /**
     * Everything after asOf is already excluded upstream - requiredDaysFor
     * drops days that have not happened - so a message sent on the 2nd cannot
     * quote the 30th.
     */
    const result = resultFor(row, category);

    recipients.push({
      employeeId: row.employeeId,
      displayName: row.displayName,
      email,
      improving: row.improving,
      recentNote: describeRecent(row),
      attended: result.attendedDates,
      missed: result.missed,
      excused: result.excusedDates,
    });
  }

  return { recipients, excluded };
}
