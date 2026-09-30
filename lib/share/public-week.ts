/**
 * Last week's attendance, for a page with no login in front of it.
 *
 * Written subtractively, and deliberately not as a view over `loadWeek`. That
 * function returns display names and absence comments because the register
 * screen needs both; a filter over it would be one careless spread away from
 * putting "at his father's funeral" on a URL anybody can open. This selects the
 * three columns it may show and has no access to the rest.
 *
 * Who appears is the same rule the register uses: active, and not carrying an
 * active exemption. Somebody taken off tracking is not on the register and is
 * not here either - "every person being tracked" is exactly the list.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as s from "../db/schema";
import { addDays, dayStatusFor, formatWeek, requiredDaysOfWeek, weekStart } from "../register/week";
import type { DayStatus } from "../register/week";
import { publicNames } from "./display-names";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * What the page is allowed to say about one person on one day.
 *
 * `EXCUSED` carries no reason with it, by design. That a sanctioned reason
 * exists is fair to show - somebody on approved leave should not read as
 * having simply not turned up - but what the reason was is nobody's business.
 *
 * `CLOSED` is a fact about the day rather than the person. It is distinct from
 * `NO_RECORD` because a column of "not recorded" under a shut office invites
 * the reader to wonder who failed to fill it in, when the answer is that there
 * was nothing to fill in. The 23rd of September was Foundation Day: the whole
 * company was out doing community work, and the page read "0 of 44 in on
 * Wednesday" until somebody who knew that said so.
 */
export type PublicDayState = "IN" | "OUT" | "EXCUSED" | "NO_RECORD" | "CLOSED";

export type PublicPerson = {
  /** A first name, with a surname initial only where one is needed. */
  name: string;
  states: PublicDayState[];
};

export type PublicOffice = {
  name: string;
  days: DayStatus[];
  people: PublicPerson[];
  /** Attendance per day, for the summary line. */
  attended: number[];
  expected: number[];
};

export type PublicWeek = {
  monday: string;
  label: string;
  offices: PublicOffice[];
};

/**
 * The Monday of the last week that has finished.
 *
 * A completed week, never the current one. Partly because a static page people
 * are sent should not change under them during the day, and partly because a
 * register still being filled in reads as a roomful of absentees - which is
 * exactly the mistake the compliance engine was taught not to make.
 */
export function lastCompletedWeek(asOf: string): string {
  return addDays(weekStart(asOf), -7);
}

function publicStateOf(state: string | undefined): PublicDayState {
  if (state === "PRESENT") return "IN";
  if (state === "ABSENT_EXPLAINED") return "EXCUSED";
  if (state === undefined || state === "NOT_EMPLOYED") return "NO_RECORD";
  return "OUT";
}

export async function loadPublicWeek(db: Db, asOf: string): Promise<PublicWeek> {
  const monday = lastCompletedWeek(asOf);
  const { wednesday, friday } = requiredDaysOfWeek(monday);
  const dates = [wednesday, friday];

  const offices = await db
    .select({ id: s.offices.id, name: s.offices.name })
    .from(s.offices)
    .orderBy(asc(s.offices.name));

  const calendarRows = await db
    .select({
      date: s.calendarDays.date,
      isRequiredDay: s.calendarDays.isRequiredDay,
      label: s.calendarDays.label,
    })
    .from(s.calendarDays)
    .where(inArray(s.calendarDays.date, dates));
  const calendar = new Map(
    calendarRows.map((d) => [d.date, { isRequiredDay: d.isRequiredDay, label: d.label }]),
  );

  /** Every currently exempt person, in one read rather than one per office. */
  const exempt = new Set(
    (
      await db
        .select({
          employeeId: s.exemptions.employeeId,
          effectiveFrom: s.exemptions.effectiveFrom,
          effectiveTo: s.exemptions.effectiveTo,
        })
        .from(s.exemptions)
        .where(eq(s.exemptions.active, true))
    )
      .filter(
        (e) =>
          (!e.effectiveFrom || e.effectiveFrom <= friday) &&
          (!e.effectiveTo || e.effectiveTo >= friday),
      )
      .map((e) => e.employeeId),
  );

  const result: PublicOffice[] = [];

  for (const office of offices) {
    const closureRows = await db
      .select({ date: s.officeClosures.date, label: s.officeClosures.label })
      .from(s.officeClosures)
      .where(and(eq(s.officeClosures.officeId, office.id), inArray(s.officeClosures.date, dates)));
    const closures = new Map(closureRows.map((c) => [c.date, c.label ?? "Office closed"]));
    const days = dates.map((date) => dayStatusFor(date, calendar, closures));

    /**
     * First and last name, and nothing else. The surname never reaches the
     * page - it is read only to tell two people with one first name apart.
     */
    const roster = (
      await db
        .select({
          id: s.employees.id,
          firstName: s.employees.firstName,
          lastName: s.employees.lastName,
        })
        .from(s.employees)
        .where(and(eq(s.employees.officeId, office.id), eq(s.employees.status, "ACTIVE")))
        .orderBy(asc(s.employees.firstName), asc(s.employees.lastName))
    ).filter((person) => !exempt.has(person.id));

    if (roster.length === 0) continue;

    const rows = roster.length
      ? await db
          .select({
            employeeId: s.attendance.employeeId,
            date: s.attendance.date,
            state: s.attendance.state,
          })
          .from(s.attendance)
          .where(
            and(
              inArray(
                s.attendance.employeeId,
                roster.map((p) => p.id),
              ),
              inArray(s.attendance.date, dates),
            ),
          )
      : [];

    const byPersonDate = new Map(rows.map((r) => [`${r.employeeId}|${r.date}`, r.state]));
    const names = publicNames(roster);

    const people: PublicPerson[] = roster.map((person, index) => ({
      name: names[index],
      states: days.map((day) =>
        day.kind === "CLOSED"
          ? "CLOSED"
          : publicStateOf(byPersonDate.get(`${person.id}|${day.date}`)),
      ),
    }));

    // Sorted by the name actually shown, so the page reads alphabetically.
    people.sort((a, b) => a.name.localeCompare(b.name));

    result.push({
      name: office.name,
      days,
      people,
      attended: days.map((_, i) => people.filter((p) => p.states[i] === "IN").length),
      expected: days.map((day, i) =>
        day.kind === "CLOSED"
          ? 0
          : people.filter((p) => p.states[i] !== "EXCUSED").length,
      ),
    });
  }

  return { monday, label: formatWeek(monday), offices: result };
}
