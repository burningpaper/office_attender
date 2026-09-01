/**
 * South African public holidays.
 *
 * This is not decoration. April and May in the sample data read as
 * company-wide non-compliance purely because Good Friday and Workers' Day fall
 * on Fridays - required days nobody could possibly have attended. Without a
 * holiday calendar the report accuses all ~75 employees of the same failure
 * twice a year, and someone had already noticed and typed "Office closed" into
 * a cell as a workaround.
 *
 * Governed by the Public Holidays Act 36 of 1994.
 */

/** The twelve holidays, as (month, day) where they are fixed. */
const FIXED_HOLIDAYS: { month: number; day: number; name: string }[] = [
  { month: 1, day: 1, name: "New Year's Day" },
  { month: 3, day: 21, name: "Human Rights Day" },
  { month: 4, day: 27, name: "Freedom Day" },
  { month: 5, day: 1, name: "Workers' Day" },
  { month: 6, day: 16, name: "Youth Day" },
  { month: 8, day: 9, name: "National Women's Day" },
  { month: 9, day: 24, name: "Heritage Day" },
  { month: 12, day: 16, name: "Day of Reconciliation" },
  { month: 12, day: 25, name: "Christmas Day" },
  { month: 12, day: 26, name: "Day of Goodwill" },
];

function iso(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

/**
 * Easter Sunday by the anonymous Gregorian computus.
 *
 * Computed rather than hardcoded so the calendar keeps working next year
 * without anyone remembering to update a table.
 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

function addDays(isoDate: string, days: number): string {
  const t = new Date(`${isoDate}T00:00:00Z`).getTime();
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

function weekday(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

/**
 * Every public holiday in a year, keyed by ISO date.
 *
 * Includes the Act's Sunday rule: a holiday falling on a Sunday moves the
 * public holiday to the following Monday. In 2026 that matters - National
 * Women's Day is a Sunday, so Monday 10 August is a public holiday. The August
 * sheet has a column headed "10 Aug" with nothing under it, which is exactly
 * what an unworked public holiday looks like.
 */
export function southAfricanHolidays(year: number): Map<string, string> {
  const holidays = new Map<string, string>();

  const easter = easterSunday(year);
  holidays.set(addDays(easter, -2), "Good Friday");
  holidays.set(addDays(easter, 1), "Family Day");

  for (const { month, day, name } of FIXED_HOLIDAYS) {
    holidays.set(iso(year, month, day), name);
  }

  // The Sunday rule, applied after all base holidays are known.
  for (const [date, name] of [...holidays]) {
    if (weekday(date) === 0) {
      holidays.set(addDays(date, 1), `${name} (observed)`);
    }
  }

  return holidays;
}
