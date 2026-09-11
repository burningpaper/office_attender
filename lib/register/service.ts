/**
 * Loading and saving the weekly register.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as s from "../db/schema";
import {
  dayStatusFor,
  formatWeek,
  requiredDaysOfWeek,
  type RegisterRow,
  type RegisterWeek,
} from "./week";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export async function loadWeek(
  db: Db,
  officeId: number,
  monday: string,
): Promise<RegisterWeek> {
  const { wednesday, friday } = requiredDaysOfWeek(monday);
  const dates = [wednesday, friday];

  const calendarRows = await db
    .select({
      date: s.calendarDays.date,
      isRequiredDay: s.calendarDays.isRequiredDay,
      label: s.calendarDays.label,
    })
    .from(s.calendarDays)
    .where(inArray(s.calendarDays.date, dates));

  const closureRows = await db
    .select({ date: s.officeClosures.date, label: s.officeClosures.label })
    .from(s.officeClosures)
    .where(and(eq(s.officeClosures.officeId, officeId), inArray(s.officeClosures.date, dates)));

  const calendar = new Map(
    calendarRows.map((d) => [d.date, { isRequiredDay: d.isRequiredDay, label: d.label }]),
  );
  const closures = new Map(closureRows.map((c) => [c.date, c.label ?? "Office closed"]));
  const days = dates.map((date) => dayStatusFor(date, calendar, closures));

  /**
   * Only people still here. Somebody who has left should not be presented for
   * ticking - that is the whole point of tracking departures.
   */
  const people = await db
    .select({
      id: s.employees.id,
      displayName: s.employees.displayName,
    })
    .from(s.employees)
    .where(and(eq(s.employees.officeId, officeId), eq(s.employees.status, "ACTIVE")))
    .orderBy(asc(s.employees.displayName));

  const exemptions = await db
    .select({
      employeeId: s.exemptions.employeeId,
      rawText: s.exemptions.rawText,
      type: s.exemptions.type,
    })
    .from(s.exemptions)
    .where(eq(s.exemptions.active, true));
  const exemptionByEmployee = new Map(
    exemptions.map((e) => [e.employeeId, e.rawText ?? e.type]),
  );

  const existing = people.length
    ? await db
        .select({
          employeeId: s.attendance.employeeId,
          date: s.attendance.date,
          state: s.attendance.state,
          comment: s.attendance.comment,
          source: s.attendance.source,
        })
        .from(s.attendance)
        .where(
          and(
            inArray(s.attendance.employeeId, people.map((p) => p.id)),
            inArray(s.attendance.date, dates),
          ),
        )
    : [];

  const byEmployeeDate = new Map(
    existing.map((row) => [`${row.employeeId}|${row.date}`, row]),
  );

  const rows: RegisterRow[] = people.map((person) => ({
    employeeId: person.id,
    displayName: person.displayName,
    exemptionNote: exemptionByEmployee.get(person.id) ?? null,
    entries: Object.fromEntries(
      dates.map((date) => {
        const found = byEmployeeDate.get(`${person.id}|${date}`);
        return [
          date,
          found
            ? {
                date,
                present: found.state === "PRESENT",
                comment: found.comment,
                manual: found.source === "MANUAL",
              }
            : null,
        ];
      }),
    ),
  }));

  return { monday, label: formatWeek(monday), days, rows };
}

export type SaveEntry = {
  employeeId: number;
  date: string;
  present: boolean;
  comment?: string | null;
};

/**
 * Record one person's day.
 *
 * A comment without a tick is an explained absence, which under the agreed
 * policy leaves the denominator entirely. That is the whole reason the field
 * exists: "sick" and "could not be bothered" should not score the same.
 */
export async function saveEntry(
  db: Db,
  officeId: number,
  entry: SaveEntry,
): Promise<{ state: string }> {
  const [person] = await db
    .select({ id: s.employees.id })
    .from(s.employees)
    .where(and(eq(s.employees.id, entry.employeeId), eq(s.employees.officeId, officeId)));

  if (!person) throw new Error("That person is not in this office.");

  const [day] = await db
    .select({ isRequiredDay: s.calendarDays.isRequiredDay })
    .from(s.calendarDays)
    .where(eq(s.calendarDays.date, entry.date));

  if (!day) throw new Error(`${entry.date} is not in the calendar.`);
  if (!day.isRequiredDay) throw new Error(`${entry.date} is not a required day.`);

  const [closed] = await db
    .select({ date: s.officeClosures.date })
    .from(s.officeClosures)
    .where(and(eq(s.officeClosures.officeId, officeId), eq(s.officeClosures.date, entry.date)));
  if (closed) throw new Error(`The office was closed on ${entry.date}.`);

  const comment = entry.comment?.trim() || null;
  const state = entry.present ? "PRESENT" : comment ? "ABSENT_EXPLAINED" : "ABSENT";

  const [previous] = await db
    .select({ state: s.attendance.state })
    .from(s.attendance)
    .where(
      and(eq(s.attendance.employeeId, entry.employeeId), eq(s.attendance.date, entry.date)),
    );

  await db
    .insert(s.attendance)
    .values({
      employeeId: entry.employeeId,
      date: entry.date,
      state,
      source: "MANUAL",
      comment,
      rawValue: entry.present ? "1" : comment ?? "0",
    })
    .onConflictDoUpdate({
      target: [s.attendance.employeeId, s.attendance.date],
      set: {
        state: sql`excluded.state`,
        source: sql`excluded.source`,
        comment: sql`excluded.comment`,
        rawValue: sql`excluded.raw_value`,
        updatedAt: new Date(),
      },
    });

  if (previous?.state !== state) {
    await db.insert(s.attendanceHistory).values({
      employeeId: entry.employeeId,
      date: entry.date,
      oldState: previous?.state ?? null,
      newState: state,
    });
  }

  return { state };
}
