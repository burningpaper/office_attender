/**
 * Turns a date range into the calendar rows compliance is measured against.
 *
 * The denominator for every compliance question comes from here, so this is the
 * single place that decides whether a given Wednesday or Friday counts.
 */

import { southAfricanHolidays } from "./holidays";

export type DayType = "WORKING" | "WEEKEND" | "PUBLIC_HOLIDAY" | "OFFICE_CLOSED";

export type CalendarDay = {
  date: string;
  dayType: DayType;
  /** Wed or Friday AND actually a working day. The compliance denominator. */
  isRequiredDay: boolean;
  label: string | null;
};

const WEDNESDAY = 3;
const FRIDAY = 5;

/**
 * Build calendar rows for [startYear, endYear] inclusive.
 *
 * OFFICE_CLOSED is never produced here - it is only ever set by a human
 * confirming an anomaly the importer raised, because a required day with zero
 * attendance is ambiguous between "the office was shut" and "nobody filled the
 * sheet in", and the data cannot tell those apart.
 */
export function buildCalendar(startYear: number, endYear: number): CalendarDay[] {
  const days: CalendarDay[] = [];

  for (let year = startYear; year <= endYear; year++) {
    const holidays = southAfricanHolidays(year);
    const cursor = new Date(Date.UTC(year, 0, 1));

    while (cursor.getUTCFullYear() === year) {
      const date = cursor.toISOString().slice(0, 10);
      const dow = cursor.getUTCDay();
      const holidayName = holidays.get(date);

      let dayType: DayType;
      if (holidayName) dayType = "PUBLIC_HOLIDAY";
      else if (dow === 0 || dow === 6) dayType = "WEEKEND";
      else dayType = "WORKING";

      days.push({
        date,
        dayType,
        isRequiredDay: dayType === "WORKING" && (dow === WEDNESDAY || dow === FRIDAY),
        label: holidayName ?? null,
      });

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  return days;
}
