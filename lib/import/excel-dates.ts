/**
 * Excel serial dates.
 *
 * Excel counts days from 1899-12-30 (the epoch is offset by two because Excel
 * believes 1900 was a leap year). Every serial in this workbook is ~46,000 -
 * far above the 1900 fudge window - so the plain offset is exact.
 */

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/**
 * Serials we will accept as plausible calendar dates: roughly 2009 to 2064.
 * Narrow enough that a stray count or percentage in a header row is rejected.
 */
export const MIN_PLAUSIBLE_SERIAL = 40_000;
export const MAX_PLAUSIBLE_SERIAL = 60_000;

export function isPlausibleDateSerial(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_PLAUSIBLE_SERIAL &&
    value <= MAX_PLAUSIBLE_SERIAL
  );
}

/** Excel serial -> ISO yyyy-mm-dd. Fractional days (times) are truncated. */
export function serialToISODate(serial: number): string {
  const ms = EXCEL_EPOCH_UTC + Math.floor(serial) * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

/** A JS Date (SheetJS sometimes hands one back) -> ISO yyyy-mm-dd. */
export function dateToISODate(d: Date): string {
  return new Date(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()),
  )
    .toISOString()
    .slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday, for an ISO yyyy-mm-dd string. */
import { isRequiredWeekday as cadenceRequires } from "../calendar/cadence";

export function isoWeekday(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

export { WEDNESDAY, FRIDAY, THURSDAY } from "../calendar/cadence";

/**
 * Is this date one the attendance policy cares about?
 *
 * Asked of the cadence, per date, so a column dated a Thursday in an old
 * workbook is still furniture while one dated after 5 November 2026 is
 * attendance.
 */
export function isRequiredWeekday(iso: string): boolean {
  return cadenceRequires(iso, isoWeekday(iso));
}
