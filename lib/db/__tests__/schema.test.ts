/**
 * Schema tests, run against Postgres-in-WASM so the constraints are real.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../schema";
import { seedCalendar } from "../seed-calendar";
import { PG, expectPgError, freshDb } from "./helpers";

type Ctx = Awaited<ReturnType<typeof freshDb>>;
let ctx: Ctx;

beforeEach(async () => {
  ctx = await freshDb();
});

const anEmployee = {
  firstName: "Test",
  lastName: "Person",
  displayName: "Test Person",
  normalisedKey: "test person",
};

describe("migrations", () => {
  it("apply cleanly and create every table", async () => {
    const { rows } = await ctx.client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "attendance",
      "attendance_history",
      "calendar_days",
      "email_sends",
      "employee_aliases",
      "employees",
      "exemptions",
      "reasons",
      "uploads",
    ]);
  });

  it("are reversible - dropping the schema leaves nothing behind", async () => {
    await ctx.client.exec("drop schema public cascade; create schema public;");
    const { rows } = await ctx.client.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables where table_schema='public'`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("calendar seeding", () => {
  it("seeds a year and marks the holidays that broke the spec", async () => {
    const count = await seedCalendar(ctx.db, 2026, 2026);
    expect(count).toBe(365);

    const goodFriday = await ctx.db.query.calendarDays.findFirst({
      where: eq(s.calendarDays.date, "2026-04-03"),
    });
    expect(goodFriday).toMatchObject({
      dayType: "PUBLIC_HOLIDAY",
      isRequiredDay: false,
      label: "Good Friday",
    });

    const workersDay = await ctx.db.query.calendarDays.findFirst({
      where: eq(s.calendarDays.date, "2026-05-01"),
    });
    expect(workersDay).toMatchObject({
      dayType: "PUBLIC_HOLIDAY",
      isRequiredDay: false,
      label: "Workers' Day",
    });
  });

  it("is idempotent - re-seeding changes nothing", async () => {
    await seedCalendar(ctx.db, 2026, 2026);
    const before = await ctx.db.select().from(s.calendarDays);
    await seedCalendar(ctx.db, 2026, 2026);
    const after = await ctx.db.select().from(s.calendarDays);
    expect(after).toEqual(before);
    expect(after).toHaveLength(365);
  });

  it("never overwrites a day a human has ruled on", async () => {
    await seedCalendar(ctx.db, 2026, 2026);

    // Someone confirms the office was shut on 1 July - the ambiguous day.
    await ctx.db
      .update(s.calendarDays)
      .set({ dayType: "OFFICE_CLOSED", isRequiredDay: false, confirmedByHuman: true })
      .where(eq(s.calendarDays.date, "2026-07-01"));

    await seedCalendar(ctx.db, 2026, 2026);

    const day = await ctx.db.query.calendarDays.findFirst({
      where: eq(s.calendarDays.date, "2026-07-01"),
    });
    expect(day).toMatchObject({ dayType: "OFFICE_CLOSED", isRequiredDay: false });
  });

  it("spans multiple years in one call", async () => {
    const count = await seedCalendar(ctx.db, 2025, 2027);
    expect(count).toBe(365 + 365 + 365);
    const rows = await ctx.db.select().from(s.calendarDays);
    expect(rows).toHaveLength(1095);
  });
});

describe("constraints", () => {
  it("rejects a duplicate (employee, date) attendance row", async () => {
    await seedCalendar(ctx.db, 2026, 2026);
    const [emp] = await ctx.db.insert(s.employees).values(anEmployee).returning();

    await ctx.db.insert(s.attendance).values({
      employeeId: emp.id,
      date: "2026-03-04",
      state: "PRESENT",
      rawValue: "1",
    });

    await expectPgError(
      ctx.db.insert(s.attendance).values({
        employeeId: emp.id,
        date: "2026-03-04",
        state: "ABSENT",
        rawValue: "0",
      }),
      PG.UNIQUE_VIOLATION,
    );
  });

  it("refuses attendance on a date the calendar does not know about", async () => {
    // Without this, attendance could exist on a day compliance cannot evaluate.
    const [emp] = await ctx.db.insert(s.employees).values(anEmployee).returning();
    await expectPgError(
      ctx.db.insert(s.attendance).values({
        employeeId: emp.id,
        date: "2030-01-02",
        state: "PRESENT",
      }),
      PG.FOREIGN_KEY_VIOLATION,
    );
  });

  it("rejects two employees sharing a normalised key", async () => {
    // This is what stops "zoe Flanegan" and "Zoe Flanegan" becoming two people.
    await ctx.db.insert(s.employees).values(anEmployee);
    await expectPgError(
      ctx.db.insert(s.employees).values({ ...anEmployee, firstName: "Different" }),
      PG.UNIQUE_VIOLATION,
    );
  });

  it("rejects a duplicate raw name alias", async () => {
    const [emp] = await ctx.db.insert(s.employees).values(anEmployee).returning();
    await ctx.db.insert(s.employeeAliases).values({ employeeId: emp.id, rawName: "Zakiyya Karim" });
    await expectPgError(
      ctx.db.insert(s.employeeAliases).values({ employeeId: emp.id, rawName: "Zakiyya Karim" }),
      PG.UNIQUE_VIOLATION,
    );
  });

  it("rejects a duplicate reason - the AI cache is keyed by exact text", async () => {
    const reason = { rawText: "On leave", category: "ANNUAL_LEAVE" as const, normalisedText: "On leave" };
    await ctx.db.insert(s.reasons).values(reason);
    await expectPgError(ctx.db.insert(s.reasons).values(reason), PG.UNIQUE_VIOLATION);
  });

  it("rejects re-uploading an identical file", async () => {
    const upload = { filename: "attendance.xlsx", sha256: "abc123" };
    await ctx.db.insert(s.uploads).values(upload);
    await expectPgError(
      ctx.db.insert(s.uploads).values({ ...upload, filename: "renamed.xlsx" }),
      PG.UNIQUE_VIOLATION,
    );
  });

  it("cascades attendance away when an employee is deleted", async () => {
    await seedCalendar(ctx.db, 2026, 2026);
    const [emp] = await ctx.db.insert(s.employees).values(anEmployee).returning();
    await ctx.db.insert(s.attendance).values({
      employeeId: emp.id, date: "2026-03-04", state: "PRESENT",
    });

    await ctx.db.delete(s.employees).where(eq(s.employees.id, emp.id));
    expect(await ctx.db.select().from(s.attendance)).toHaveLength(0);
  });

  it("keeps history when the upload that caused it is deleted", async () => {
    // History is the audit trail; losing it with an upload would defeat it.
    const [emp] = await ctx.db.insert(s.employees).values(anEmployee).returning();
    const [up] = await ctx.db.insert(s.uploads).values({ filename: "f.xlsx", sha256: "z" }).returning();
    await ctx.db.insert(s.attendanceHistory).values({
      employeeId: emp.id, date: "2026-03-04", oldState: "ABSENT", newState: "PRESENT", uploadId: up.id,
    });

    await ctx.db.delete(s.uploads).where(eq(s.uploads.id, up.id));
    const rows = await ctx.db.select().from(s.attendanceHistory);
    expect(rows).toHaveLength(1);
    expect(rows[0].uploadId).toBeNull();
  });

  it("enforces the enum vocabularies", async () => {
    await expectPgError(
      ctx.client.exec(`insert into employees (first_name, display_name, normalised_key, status)
                       values ('A','A','a','RESIGNED')`),
      PG.INVALID_ENUM_VALUE,
    );
  });

  it("defaults a reason to EXCUSED, per the agreed policy", async () => {
    const [r] = await ctx.db
      .insert(s.reasons)
      .values({ rawText: "Plumbing situation", category: "PERSONAL_EMERGENCY", normalisedText: "Plumbing emergency" })
      .returning();
    expect(r.countsAs).toBe("EXCUSED");
    expect(r.reviewedByHuman).toBe(false);
  });
});
