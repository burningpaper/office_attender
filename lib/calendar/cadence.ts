/**
 * Which days of the week people are expected in the office, and since when.
 *
 * This was two constants - WEDNESDAY = 3, FRIDAY = 5 - copied into six files.
 * That was fine while the answer never changed. From 5 November 2026 Thursday
 * joins them, and the moment a rule has a start date the constants become a
 * lie: a report on October has to say what October's rule said, not what
 * today's does. Somebody who attended every required day in October did not
 * retrospectively miss four Thursdays.
 *
 * So the cadence is a list, each entry with the date it took effect, and every
 * question about a date is answered by the entry in force on that date.
 */

export const MONDAY = 1;
export const TUESDAY = 2;
export const WEDNESDAY = 3;
export const THURSDAY = 4;
export const FRIDAY = 5;

export type Cadence = {
  /** The first date this cadence applies to, inclusive. */
  from: string;
  /** Weekday numbers, as getUTCDay gives them. */
  weekdays: number[];
};

/**
 * Oldest first. The last entry whose `from` has arrived is the one in force.
 *
 * The opening entry has no real start date - it is simply how things were for
 * as long as this system has records - so it begins at the earliest date the
 * data could contain rather than pretending to a policy decision nobody made.
 */
export const CADENCES: Cadence[] = [
  { from: "0001-01-01", weekdays: [WEDNESDAY, FRIDAY] },
  { from: "2026-11-05", weekdays: [WEDNESDAY, THURSDAY, FRIDAY] },
];

/** The cadence in force on a date. */
export function cadenceOn(date: string): Cadence {
  let current = CADENCES[0];
  for (const cadence of CADENCES) {
    if (cadence.from <= date) current = cadence;
  }
  return current;
}

/** The weekdays required on a date, lowest first. */
export function requiredWeekdays(date: string): number[] {
  return cadenceOn(date).weekdays;
}

/**
 * Whether this weekday is a required one on this date.
 *
 * Says nothing about public holidays or office closures - a required weekday
 * that happens to be Workers' Day is still not a day anybody could attend.
 * Those live in the calendar, which is the thing that combines them.
 */
export function isRequiredWeekday(date: string, weekday: number): boolean {
  return requiredWeekdays(date).includes(weekday);
}

/** How many required days an ordinary, holiday-free week holds. */
export function requiredDaysPerWeek(date: string): number {
  return requiredWeekdays(date).length;
}

const NAMES: Record<number, string> = {
  [MONDAY]: "Monday",
  [TUESDAY]: "Tuesday",
  [WEDNESDAY]: "Wednesday",
  [THURSDAY]: "Thursday",
  [FRIDAY]: "Friday",
};

/** "Wednesday", "W", for the places that have room for one letter. */
export function weekdayName(weekday: number): string {
  return NAMES[weekday] ?? `Day ${weekday}`;
}

export function weekdayInitial(weekday: number): string {
  // Thursday takes T and Tuesday would clash, but Tuesday is never required.
  return weekday === THURSDAY ? "T" : weekdayName(weekday)[0];
}

/**
 * The cadence as a sentence, for the pages and emails that tell somebody what
 * is expected of them: "Wednesdays and Fridays", "Wednesdays, Thursdays and
 * Fridays".
 *
 * Generated rather than written out, because the four places that said
 * "Wednesdays and Fridays" in prose were four places that would have gone on
 * saying it after the rule changed.
 */
export function describeCadence(date: string, plural = true): string {
  const names = requiredWeekdays(date).map((d) => (plural ? `${weekdayName(d)}s` : weekdayName(d)));
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
