/**
 * Loads what the compliance rules need out of the database.
 *
 * Deliberately separate from rules.ts: the rules stay pure and testable, and
 * this is the only place that knows about tables.
 */

import { and, gte, lte } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as s from "../db/schema";
import { evaluateEmployee, requiredDaysFor } from "./rules";
import type {
  AttendanceState,
  CalendarDay,
  DayDetail,
  EmployeeInput,
  EmployeeRowWithDays,
} from "./types";

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
): Promise<EmployeeRowWithDays[]> {
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
      rawValue: s.attendance.rawValue,
      reasonId: s.attendance.reasonId,
    })
    .from(s.attendance);

  const reasonRows = await db.select().from(s.reasons);
  const reasonById = new Map(reasonRows.map((r) => [r.id, r]));

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
  const detailByEmployee = new Map<number, Map<string, (typeof attendance)[number]>>();
  for (const row of attendance) {
    let map = attendanceByEmployee.get(row.employeeId);
    if (!map) {
      map = new Map();
      attendanceByEmployee.set(row.employeeId, map);
    }
    map.set(row.date, row.state);

    let detail = detailByEmployee.get(row.employeeId);
    if (!detail) {
      detail = new Map();
      detailByEmployee.set(row.employeeId, detail);
    }
    detail.set(row.date, row);
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
      hasLeft: employee.status === "DEPARTED",
    };
    const row = evaluateEmployee(input, calendar, month, asOf);

    /**
     * The month's required days, whether or not the person has a record for
     * them. A day with no record at all is different from one marked absent -
     * usually it means they had not joined yet, or had already left.
     */
    const monthWindow = {
      start: `${month}-01`,
      end: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
        .toISOString()
        .slice(0, 10),
    };
    const details = detailByEmployee.get(employee.id);

    const monthDays: DayDetail[] = calendar
      .filter((d) => d.isRequiredDay && d.date >= monthWindow.start && d.date <= monthWindow.end)
      .map((day) => {
        const record = details?.get(day.date);
        const reason = record?.reasonId ? reasonById.get(record.reasonId) : undefined;
        const outsideEmployment =
          (!!employee.firstSeenDate && day.date < employee.firstSeenDate) ||
          (!!employee.lastSeenDate && day.date > employee.lastSeenDate);

        return {
          date: day.date,
          state: record ? record.state : ("NO_RECORD" as const),
          reasonText: record?.rawValue && reason ? record.rawValue : null,
          reasonLabel: reason && reason.category !== "UNKNOWN" ? reason.normalisedText : null,
          reasonCategory: reason && reason.category !== "UNKNOWN" ? reason.category : null,
          outsideEmployment,
        };
      });

    /**
     * Whether this person's name was on the sheet for the month being viewed.
     * A leaver keeps their history: they simply stop appearing once they go.
     */
    const onRosterThisMonth = [...(details?.keys() ?? [])].some((date) =>
      date.startsWith(month),
    );

    return { ...row, monthDays, onRosterThisMonth };
  });

}

/** Required days in a month, exposed for the interface's header stats. */
export function requiredDayCount(calendar: CalendarDay[], month: string, asOf: string): number {
  return requiredDaysFor(
    { id: 0, displayName: "", firstSeenDate: null, lastSeenDate: null, exemptions: [], attendance: new Map() },
    calendar,
    {
      start: `${month}-01`,
      end: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
        .toISOString()
        .slice(0, 10),
    },
    asOf,
  ).length;
}
