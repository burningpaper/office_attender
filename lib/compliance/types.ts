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
  /**
   * When this person was last sent a reminder, if ever.
   *
   * Anchors the recency window: the question worth asking about somebody you
   * have already written to is not "how has the month gone" but "have they
   * come in since you asked".
   */
  lastReminderDate?: string | null;
  /**
   * Days the register was kept for this office, whoever it was kept for.
   *
   * This is what tells a blank apart from a silence. If anybody in the office
   * has a record for a day, the register was filled in that day, so somebody
   * with no row was absent - which is exactly what a keeper means by leaving a
   * box unticked. If nobody has a record, the day has not been done yet and
   * nothing can be concluded about anyone.
   */
  recordedDates?: Set<string>;
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
  /** Required days they were in the office. */
  attendedDates: string[];
  /** Required days removed from the denominator by a recorded reason. */
  excusedDates: string[];
  /** Required days missed with no explanation. */
  missed: string[];
  /**
   * Required days nothing is known about.
   *
   * Not a failure. Before the register existed people only had rows for days a
   * spreadsheet mentioned them; now a week simply has not been ticked yet.
   * Either way, silence is not evidence of absence, and counting it as one
   * makes everybody non-compliant until somebody gets round to them.
   */
  unrecorded: string[];
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

/**
 * How somebody has behaved lately, as opposed to cumulatively.
 *
 * A monthly fraction never forgives: miss the 2nd and the 4th and you are stuck
 * at 4/6 however faithfully you attend for the rest of the month. This looks at
 * a short recent window on its own, so somebody who has mended their ways can
 * be seen to have done so.
 */
export type RecentForm = {
  /** Which window was used, and why. */
  basis: "SINCE_REMINDER" | "LAST_FEW_DAYS";
  /** Required days are counted after this date, exclusive. Null when none. */
  since: string | null;
  /** Scored over the window only. NA when the window holds nothing judgeable. */
  result: ComplianceResult;
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
  recent: RecentForm;
  /**
   * Non-compliant for the month, but has attended every required day in the
   * recent window. Both halves matter: somebody already compliant is not
   * "improving", and neither is somebody with nothing recorded lately.
   */
  improving: boolean;
};

/** A row plus the day-by-day detail the interface expands into. */
export type EmployeeRowWithDays = EmployeeRow & { monthDays: DayDetail[] };
