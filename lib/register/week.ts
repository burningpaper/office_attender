/**
 * The weekly register.
 *
 * Replaces the spreadsheet round trip for new data: the people who keep the
 * register tick boxes here instead of editing a workbook that then has to be
 * parsed, reconciled and second-guessed.
 *
 * Only Wednesdays and Fridays appear, because they are the only days the policy
 * counts. The old sheets recorded all five weekdays and the system discarded
 * three of them, which is a lot of typing for nothing.
 */

/** Monday of the week containing this date. */
export function weekStart(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  const day = date.getUTCDay();
  // getUTCDay is 0 for Sunday, so Sunday belongs to the week that just ended.
  const backToMonday = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - backToMonday);
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** The Wednesday and Friday of a week, given its Monday. */
export function requiredDaysOfWeek(monday: string): { wednesday: string; friday: string } {
  return { wednesday: addDays(monday, 2), friday: addDays(monday, 4) };
}

export function formatWeek(monday: string): string {
  const friday = addDays(monday, 4);
  const from = new Date(`${monday}T00:00:00Z`);
  const to = new Date(`${friday}T00:00:00Z`);
  const sameMonth = from.getUTCMonth() === to.getUTCMonth();

  const day = (d: Date) => d.getUTCDate();
  const month = (d: Date) =>
    d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });

  return sameMonth
    ? `${day(from)}–${day(to)} ${month(to)} ${to.getUTCFullYear()}`
    : `${day(from)} ${month(from)} – ${day(to)} ${month(to)} ${to.getUTCFullYear()}`;
}

export type DayStatus =
  /** A required day the register can record. */
  | { kind: "OPEN"; date: string }
  /** Nobody could attend, so there is nothing to tick. */
  | { kind: "CLOSED"; date: string; label: string };

export type RegisterEntry = {
  date: string;
  present: boolean;
  comment: string | null;
  /** True when this day was last set by hand rather than by an import. */
  manual: boolean;
};

export type RegisterRow = {
  employeeId: number;
  displayName: string;
  /** Exempt people are shown but not expected - the note says why. */
  exemptionNote: string | null;
  entries: Record<string, RegisterEntry | null>;
};

export type RegisterWeek = {
  monday: string;
  label: string;
  days: DayStatus[];
  rows: RegisterRow[];
};

/**
 * Decide what a day is, for this office, in this week.
 *
 * A public holiday or a closure is shown as such and cannot be ticked: the
 * point of the calendar work was that nobody is marked absent on a day the
 * office was shut, and the register should not invite somebody to do it by hand.
 */
export function dayStatusFor(
  date: string,
  calendar: Map<string, { isRequiredDay: boolean; label: string | null }>,
  closures: Map<string, string>,
): DayStatus {
  const closure = closures.get(date);
  if (closure) return { kind: "CLOSED", date, label: closure };

  const day = calendar.get(date);
  if (!day) return { kind: "CLOSED", date, label: "Not in the calendar" };
  if (!day.isRequiredDay) {
    return { kind: "CLOSED", date, label: day.label ?? "Not a required day" };
  }

  return { kind: "OPEN", date };
}
