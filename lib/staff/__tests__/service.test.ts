import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../db/schema";
import { freshDb } from "../../db/__tests__/helpers";
import { seedCalendar } from "../../db/seed-calendar";
import { parseWorkbook } from "../../import/parse-workbook";
import { applyStaffList, type StaffPerson } from "../service";

type Ctx = Awaited<ReturnType<typeof freshDb>>;
let ctx: Ctx;
let office: number;

beforeEach(async () => {
  ctx = await freshDb();
  office = ctx.officeId;
  await seedCalendar(ctx.db, 2026, 2026);
});

const person = (first: string, last: string, email: string | null = null): StaffPerson => ({
  rawName: `${first} ${last}`, firstName: first, lastName: last, email,
});

describe("applying a staff list", () => {
  it("creates everybody on a first upload", async () => {
    const result = await applyStaffList(ctx.db, office, [
      person("Amy", "Dudley", "amy@example.invalid"),
      person("Ben", "Clay", "ben@example.invalid"),
    ]);

    expect(result.created.map((c) => c.displayName).sort()).toEqual(["Amy Dudley", "Ben Clay"]);
    const people = await ctx.db.select().from(s.employees);
    expect(people).toHaveLength(2);
    expect(people.every((p) => p.officeId === office && p.status === "ACTIVE")).toBe(true);
  });

  it("does not duplicate anybody when the same list is uploaded again", async () => {
    const list = [person("Amy", "Dudley", "amy@example.invalid")];
    await applyStaffList(ctx.db, office, list);
    const second = await applyStaffList(ctx.db, office, list);

    expect(second.created).toHaveLength(0);
    expect(second.matched).toHaveLength(1);
    expect(await ctx.db.select().from(s.employees)).toHaveLength(1);
  });

  it("matches a spelling it has seen before rather than creating a second person", async () => {
    await applyStaffList(ctx.db, office, [person("Zakiya", "Karim")]);
    const result = await applyStaffList(ctx.db, office, [person("Zakiyya", "Karim")]);

    expect(result.created).toHaveLength(0);
    expect(await ctx.db.select().from(s.employees)).toHaveLength(1);
  });

  it("marks anybody absent from the list as having left", async () => {
    await applyStaffList(ctx.db, office, [
      person("Amy", "Dudley"), person("Ben", "Clay"),
    ]);
    const result = await applyStaffList(ctx.db, office, [person("Amy", "Dudley")]);

    expect(result.departed).toEqual(["Ben Clay"]);
    const [ben] = await ctx.db.select().from(s.employees).where(eq(s.employees.displayName, "Ben Clay"));
    expect(ben.status).toBe("DEPARTED");
  });

  it("brings somebody back when they reappear", async () => {
    await applyStaffList(ctx.db, office, [person("Amy", "Dudley"), person("Ben", "Clay")]);
    await applyStaffList(ctx.db, office, [person("Amy", "Dudley")]);
    const result = await applyStaffList(ctx.db, office, [
      person("Amy", "Dudley"), person("Ben", "Clay"),
    ]);

    expect(result.returned).toEqual(["Ben Clay"]);
  });

  it("keeps a leaver's attendance history", async () => {
    await applyStaffList(ctx.db, office, [person("Ben", "Clay")]);
    const [ben] = await ctx.db.select().from(s.employees);
    await ctx.db.insert(s.attendance).values({
      employeeId: ben.id, date: "2026-09-09", state: "PRESENT", source: "MANUAL",
    });

    await applyStaffList(ctx.db, office, [person("Amy", "Dudley")]);

    // Marked as gone, but the day they were in the office survives.
    const rows = await ctx.db.select().from(s.attendance);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("PRESENT");
  });

  it("writes nothing on a dry run", async () => {
    const result = await applyStaffList(
      ctx.db, office, [person("Amy", "Dudley")], { dryRun: true },
    );
    expect(result.created).toHaveLength(1);
    expect(await ctx.db.select().from(s.employees)).toHaveLength(0);
  });

  it("never touches another office", async () => {
    const [other] = await ctx.db.insert(s.offices).values({ code: "DBN", name: "Durban" }).returning();
    await applyStaffList(ctx.db, other.id, [person("Amy", "Dudley")]);
    await applyStaffList(ctx.db, office, [person("Ben", "Clay")]);

    const theirs = await ctx.db.select().from(s.employees).where(eq(s.employees.officeId, other.id));
    expect(theirs).toHaveLength(1);
    expect(theirs[0].status).toBe("ACTIVE");
  });

  it("reads a staff list straight out of a workbook tab", async () => {
    const REGISTER = path.resolve(__dirname, "../../../CT Registry 8 Sept 2026.xlsx");
    if (!existsSync(REGISTER)) return;

    const parsed = parseWorkbook(readFileSync(REGISTER));
    const result = await applyStaffList(
      ctx.db,
      office,
      parsed.roster.map((p) => ({
        rawName: p.rawName, firstName: p.firstName, lastName: p.lastName, email: p.email,
      })),
    );

    expect(result.created).toHaveLength(56);
    const people = await ctx.db.select().from(s.employees);
    expect(people.filter((p) => p.email)).toHaveLength(56);
  }, 120_000);
});
