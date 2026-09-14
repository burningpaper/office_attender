/**
 * The register against a real database.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../db/schema";
import { freshDb, importDeclining } from "../../db/__tests__/helpers";
import { seedCalendar } from "../../db/seed-calendar";
import { closeOffice } from "../../db/offices";
import { loadWeek, saveEntry } from "../service";

type Ctx = Awaited<ReturnType<typeof freshDb>>;
let ctx: Ctx;
let office: number;

beforeEach(async () => {
  ctx = await freshDb();
  office = ctx.officeId;
  await seedCalendar(ctx.db, 2026, 2026);
  await ctx.db.insert(s.employees).values([
    { officeId: office, firstName: "Amy", lastName: "Dudley", displayName: "Amy Dudley", normalisedKey: "amy dudley" },
    { officeId: office, firstName: "Ben", lastName: "Clay", displayName: "Ben Clay", normalisedKey: "ben clay" },
    { officeId: office, firstName: "Gone", lastName: "Person", displayName: "Gone Person", normalisedKey: "gone person", status: "DEPARTED" },
  ]);
});

const MONDAY = "2026-09-07"; // Wed 9th, Fri 11th

describe("loading a week", () => {
  it("shows the Wednesday and the Friday, and nothing else", async () => {
    const week = await loadWeek(ctx.db, office, MONDAY);
    expect(week.days.map((d) => d.date)).toEqual(["2026-09-09", "2026-09-11"]);
    expect(week.days.every((d) => d.kind === "OPEN")).toBe(true);
    expect(week.label).toBe("7–11 Sept 2026");
  });

  it("leaves out people who have left", async () => {
    const week = await loadWeek(ctx.db, office, MONDAY);
    expect(week.rows.map((r) => r.displayName)).toEqual(["Amy Dudley", "Ben Clay"]);
  });

  it("starts with nothing recorded", async () => {
    const week = await loadWeek(ctx.db, office, MONDAY);
    expect(Object.values(week.rows[0].entries).every((e) => e === null)).toBe(true);
  });

  it("closes a public holiday so it cannot be ticked", async () => {
    // Christmas Day 2026 is a Friday.
    const week = await loadWeek(ctx.db, office, "2026-12-21");
    const friday = week.days.find((d) => d.date === "2026-12-25")!;
    expect(friday).toEqual({ kind: "CLOSED", date: "2026-12-25", label: "Christmas Day" });
  });

  it("closes a day this office shut", async () => {
    await closeOffice(ctx.db, office, "2026-09-09", "Building works");
    const week = await loadWeek(ctx.db, office, MONDAY);
    expect(week.days[0]).toEqual({
      kind: "CLOSED", date: "2026-09-09", label: "Building works",
    });
  });

  it("leaves out anybody who is not tracked", async () => {
    const [amy] = await ctx.db.select().from(s.employees).where(eq(s.employees.normalisedKey, "amy dudley"));
    await ctx.db.insert(s.exemptions).values({
      employeeId: amy.id, type: "REMOTE_LOCATION", rawText: "Stays in George", active: true,
    });

    const week = await loadWeek(ctx.db, office, MONDAY);
    expect(week.rows.map((r) => r.displayName)).toEqual(["Ben Clay"]);
    expect(week.untracked).toBe(1);
  });

  it("still lists them in the weeks before they were taken off tracking", async () => {
    // The register for a week already kept should not change underneath
    // somebody who filled it in.
    const [amy] = await ctx.db.select().from(s.employees).where(eq(s.employees.normalisedKey, "amy dudley"));
    await ctx.db.insert(s.exemptions).values({
      employeeId: amy.id, type: "OTHER", rawText: "Seconded", active: true,
      effectiveFrom: "2026-09-07",
    });

    const before = await loadWeek(ctx.db, office, "2026-08-31");
    expect(before.rows.map((r) => r.displayName)).toContain("Amy Dudley");
    expect(before.untracked).toBe(0);

    const after = await loadWeek(ctx.db, office, MONDAY);
    expect(after.rows.map((r) => r.displayName)).not.toContain("Amy Dudley");
  });

  it("lists them again once tracking resumes", async () => {
    const [amy] = await ctx.db.select().from(s.employees).where(eq(s.employees.normalisedKey, "amy dudley"));
    await ctx.db.insert(s.exemptions).values({
      employeeId: amy.id, type: "OTHER", rawText: "Was seconded", active: true,
      effectiveFrom: "2026-08-01", effectiveTo: "2026-09-01",
    });

    const week = await loadWeek(ctx.db, office, MONDAY);
    expect(week.rows.map((r) => r.displayName)).toContain("Amy Dudley");
  });
});

describe("saving a day", () => {
  async function amy() {
    const [row] = await ctx.db.select().from(s.employees).where(eq(s.employees.normalisedKey, "amy dudley"));
    return row;
  }

  it("records a tick as present", async () => {
    const person = await amy();
    await saveEntry(ctx.db, office, { employeeId: person.id, date: "2026-09-09", present: true });

    const week = await loadWeek(ctx.db, office, MONDAY);
    const entry = week.rows.find((r) => r.employeeId === person.id)!.entries["2026-09-09"]!;
    expect(entry).toMatchObject({ present: true, manual: true, comment: null });
  });

  it("records an untouched box as a plain absence", async () => {
    const person = await amy();
    await saveEntry(ctx.db, office, { employeeId: person.id, date: "2026-09-09", present: false });

    const [row] = await ctx.db.select().from(s.attendance);
    expect(row.state).toBe("ABSENT");
  });

  it("turns a comment into an explained absence", async () => {
    // Which, under the agreed policy, leaves the denominator entirely - the
    // whole reason the field is there.
    const person = await amy();
    await saveEntry(ctx.db, office, {
      employeeId: person.id, date: "2026-09-09", present: false, comment: "Off sick",
    });

    const [row] = await ctx.db.select().from(s.attendance);
    expect(row.state).toBe("ABSENT_EXPLAINED");
    expect(row.comment).toBe("Off sick");
  });

  it("lets a tick be taken back", async () => {
    const person = await amy();
    await saveEntry(ctx.db, office, { employeeId: person.id, date: "2026-09-09", present: true });
    await saveEntry(ctx.db, office, { employeeId: person.id, date: "2026-09-09", present: false });

    const [row] = await ctx.db.select().from(s.attendance);
    expect(row.state).toBe("ABSENT");
    const history = await ctx.db.select().from(s.attendanceHistory);
    expect(history.map((h) => h.newState)).toEqual(["PRESENT", "ABSENT"]);
  });

  it("refuses a day the office was closed", async () => {
    const person = await amy();
    await closeOffice(ctx.db, office, "2026-09-09");
    await expect(
      saveEntry(ctx.db, office, { employeeId: person.id, date: "2026-09-09", present: true }),
    ).rejects.toThrow(/closed/i);
  });

  it("refuses a day that is not a required day", async () => {
    const person = await amy();
    await expect(
      saveEntry(ctx.db, office, { employeeId: person.id, date: "2026-09-10", present: true }),
    ).rejects.toThrow(/not a required day/i);
  });

  it("refuses somebody from another office", async () => {
    const [other] = await ctx.db.insert(s.offices).values({ code: "DBN", name: "Durban" }).returning();
    const [theirs] = await ctx.db
      .insert(s.employees)
      .values({
        officeId: other.id, firstName: "Their", lastName: "Person",
        displayName: "Their Person", normalisedKey: "their person",
      })
      .returning();

    await expect(
      saveEntry(ctx.db, office, { employeeId: theirs.id, date: "2026-09-09", present: true }),
    ).rejects.toThrow(/not in this office/i);
  });
});

describe("a spreadsheet upload never undoes the register", () => {
  it("leaves hand-entered days alone", async () => {
    const WORKBOOK = path.resolve(__dirname, "../../../data_example2.xlsx");
    if (!existsSync(WORKBOOK)) return;

    const fresh = await freshDb();
    await seedCalendar(fresh.db, 2026, 2026);
    await importDeclining(fresh.db, readFileSync(WORKBOOK), "first.xlsx", "2026-09-11");

    // Somebody keeps the register for the week of 7 September.
    const [person] = await fresh.db
      .select()
      .from(s.employees)
      .where(eq(s.employees.displayName, "Amy Dudley"));

    await saveEntry(fresh.db, fresh.officeId, {
      employeeId: person.id, date: "2026-09-09", present: true,
    });

    // Then an old workbook is uploaded over the top. It says she was absent.
    await fresh.db.delete(s.uploads);
    const report = await importDeclining(
      fresh.db, readFileSync(WORKBOOK), "again.xlsx", "2026-09-11",
    );

    const [row] = await fresh.db
      .select()
      .from(s.attendance)
      .where(and(eq(s.attendance.employeeId, person.id), eq(s.attendance.date, "2026-09-09")));

    expect(row.state).toBe("PRESENT");
    expect(row.source).toBe("MANUAL");
    expect(report.attendance.manualKept).toBeGreaterThan(0);
  }, 900_000);
});
