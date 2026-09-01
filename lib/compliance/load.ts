/**
 * Loads what the compliance rules need out of the database.
 *
 * Deliberately separate from rules.ts: the rules stay pure and testable, and
 * this is the only place that knows about tables.
 */

import { and, gte, lte } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as s from "../db/schema";
import { evaluateEmployee } from "./rules";
import type { AttendanceState, CalendarDay, EmployeeInput, EmployeeRow } from "./types";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Everything the table needs, for one month.
 *
 * `asOf` is passed in rather than read from the clock so callers - and tests -
 * can ask what the report looked like on any given day.
 */
export async function loadEmployeeRows(
  db: Db,
  month: string,
  asOf: string,
): Promise<EmployeeRow[]> {
  const employees = await db.select().from(s.employees);
  const exemptions = await db.select().from(s.exemptions);

  /**
   * Attendance is loaded for the whole history, not just the month: long-term
   * compliance averages over every complete month a person has worked.
   */
  const attendance = await db
    .select({
      employeeId: s.attendance.employeeId,
      date: s.attendance.date,
      state: s.attendance.state,
    })
    .from(s.attendance);

  const calendarRows = await db
    .select({
      date: s.calendarDays.date,
      isRequiredDay: s.calendarDays.isRequiredDay,
      label: s.calendarDays.label,
    })
    .from(s.calendarDays)
    .where(and(gte(s.calendarDays.date, "2020-01-01"), lte(s.calendarDays.date, "2100-01-01")));

  const calendar: CalendarDay[] = calendarRows;

  const attendanceByEmployee = new Map<number, Map<string, AttendanceState>>();
  for (const row of attendance) {
    let map = attendanceByEmployee.get(row.employeeId);
    if (!map) {
      map = new Map();
      attendanceByEmployee.set(row.employeeId, map);
    }
    map.set(row.date, row.state);
  }

  const exemptionsByEmployee = new Map<number, typeof exemptions>();
  for (const e of exemptions) {
    const list = exemptionsByEmployee.get(e.employeeId) ?? [];
    list.push(e);
    exemptionsByEmployee.set(e.employeeId, list);
  }

  return employees.map((employee) => {
    const input: EmployeeInput = {
      id: employee.id,
      displayName: employee.displayName,
      firstSeenDate: employee.firstSeenDate,
      lastSeenDate: employee.lastSeenDate,
      exemptions: (exemptionsByEmployee.get(employee.id) ?? []).map((e) => ({
        type: e.type,
        rawText: e.rawText,
        effectiveFrom: e.effectiveFrom,
        effectiveTo: e.effectiveTo,
        active: e.active,
      })),
      attendance: attendanceByEmployee.get(employee.id) ?? new Map(),
    };
    return evaluateEmployee(input, calendar, month, asOf);
  });
}
