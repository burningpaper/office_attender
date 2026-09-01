/**
 * Seeds calendar_days.
 *
 * Idempotent, and deliberately non-destructive about human decisions: a day
 * someone has confirmed - typically an OFFICE_CLOSED ruling on an ambiguous
 * zero-attendance day - is never overwritten by a re-seed.
 */

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { buildCalendar } from "../calendar/build-calendar";
import { calendarDays } from "./schema";

/**
 * Any Drizzle Postgres database. Generic over the driver's result type so the
 * same seeder serves the Neon client in production and PGlite in tests -
 * which is what lets the seeding tests run without a network or credentials.
 */
type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export async function seedCalendar(
  db: AnyPgDatabase,
  startYear: number,
  endYear: number,
): Promise<number> {
  const days = buildCalendar(startYear, endYear).map((d) => ({
    date: d.date,
    dayType: d.dayType,
    isRequiredDay: d.isRequiredDay,
    label: d.label,
  }));

  // Chunked: a three-year seed is ~1,100 rows and parameter limits are real.
  const CHUNK = 500;
  for (let i = 0; i < days.length; i += CHUNK) {
    await db
      .insert(calendarDays)
      .values(days.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: calendarDays.date,
        set: {
          dayType: sql`excluded.day_type`,
          isRequiredDay: sql`excluded.is_required_day`,
          label: sql`excluded.label`,
        },
        // A human's ruling outranks anything the seeder computes.
        where: sql`${calendarDays.confirmedByHuman} = false`,
      });
  }

  return days.length;
}
