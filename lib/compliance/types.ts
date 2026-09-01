/** Inputs and outputs for the compliance rules. Plain data, no database. */

export type AttendanceState = "PRESENT" | "ABSENT" | "ABSENT_EXPLAINED" | "NOT_EMPLOYED";

/** YES/NO are not enough. See DESIGN.md §2.3 and §10. */
export type Verdict = "YES" | "NO" | "EXEMPT" | "NA";

export type CalendarDay = {
  date: string;
  isRequiredDay: boolean;
  label: string | null;
};

export type Exemption = {
  type: string;
  rawText: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  active: boolean;
};

export type EmployeeInput = {
  id: number;
  displayName: string;
  /** The employment window, derived from where they appear in the sheets. */
  firstSeenDate: string | null;
  lastSeenDate: string | null;
  exemptions: Exemption[];
  /** date -> state. Absent dates may simply be missing. */
  attendance: Map<string, AttendanceState>;
  /** Marked as having left the company. */
  hasLeft?: boolean;
};

export type ComplianceResult = {
  verdict: Verdict;
  /** Required days attended. */
  attended: number;
  /**
   * Required days that counted. Excused days are removed before this is
   * computed, so it is the denominator the verdict actually used.
   */
  required: number;
  /** Required days removed because a reason was recorded. */
  excused: number;
  /** Required days missed with no explanation. */
  missed: string[];
  /** Why the verdict is EXEMPT or NA, for display. */
  note?: string;
};

export type LongTermResult = ComplianceResult & {
  wednesdayAverage: number;
  fridayAverage: number;
  monthsCounted: number;
};

/** One required day in the selected month, for the expanded row. */
export type DayDetail = {
  date: string;
  state: AttendanceState | "NO_RECORD";
  /** The reason as written in the cell, when there was one. */
  reasonText: string | null;
  /** The tidied reason, once stage 5 has classified it. */
  reasonLabel: string | null;
  reasonCategory: string | null;
  /** Outside this person's employment window. */
  outsideEmployment: boolean;
};

export type EmployeeRow = {
  employeeId: number;
  displayName: string;
  isExempt: boolean;
  exemptionNote: string | null;
  /** Marked as having left: no longer printed on the newest sheet. */
  hasLeft: boolean;
  /**
   * Whether their name appears on the selected month's sheet at all.
   *
   * Distinct from hasLeft, which is a single current fact. This one is
   * per-month, so a leaver still shows correctly in the months they worked.
   */
  onRosterThisMonth: boolean;
  monthly: ComplianceResult;
  twoWeek: ComplianceResult;
  longTerm: LongTermResult;
  lastAttended: string | null;
};

/** A row plus the day-by-day detail the interface expands into. */
export type EmployeeRowWithDays = EmployeeRow & { monthDays: DayDetail[] };
