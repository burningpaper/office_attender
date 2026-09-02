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
 * And one rule about the dates: only days that have actually happened are
 * quoted. The month's required days are laid out in advance, so without this a
 * message sent on the 2nd tells somebody they failed to attend on the 30th.
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
  /** Today. Days after this have not happened and are never quoted. */
  asOf: string = new Date().toISOString().slice(0, 10),
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

    const attended: string[] = [];
    const missed: string[] = [];
    const excused: string[] = [];

    for (const day of row.monthDays) {
      if (day.outsideEmployment || day.state === "NO_RECORD") continue;
      // Never tell somebody they missed a day that has not arrived.
      if (day.date > asOf) continue;
      if (day.state === "PRESENT") attended.push(day.date);
      else if (day.state === "ABSENT_EXPLAINED") excused.push(day.date);
      else missed.push(day.date);
    }

    recipients.push({
      employeeId: row.employeeId,
      displayName: row.displayName,
      email,
      attended,
      missed,
      excused,
    });
  }

  return { recipients, excluded };
}
