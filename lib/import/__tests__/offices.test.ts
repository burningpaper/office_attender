/**
 * Office isolation.
 *
 * The re-sync deletes attendance for anybody a month's sheet no longer lists.
 * Unscoped, importing a second office's workbook would delete the first
 * office's entire history for those months, because none of its people appear
 * on the other office's sheet. These tests exist to make sure that cannot
 * happen quietly.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as s from "../../db/schema";
import { freshDb, importDeclining } from "../../db/__tests__/helpers";
import { seedCalendar } from "../../db/seed-calendar";

const WORKBOOK = path.resolve(__dirname, "../../../data_example2.xlsx");
let buffer: Buffer;

beforeAll(() => {
  if (!existsSync(WORKBOOK)) {
    throw new Error(
      `Fixture workbook not found at ${WORKBOOK}. It is excluded from git on ` +
        `purpose (real employee data). Copy it into the project root to run these tests.`,
    );
  }
  buffer = readFileSync(WORKBOOK);
});

async function twoOffices() {
  const ctx = await freshDb();
  await seedCalendar(ctx.db, 2026, 2026);
  const [jhb] = await ctx.db
    .insert(s.offices)
    .values({ code: "JHB", name: "Johannesburg" })
    .returning();
  return { ctx, ct: ctx.officeId, jhb: jhb.id };
}

describe("importing one office's workbook", () => {
  it("does not delete the other office's attendance", async () => {
    const { ctx, ct, jhb } = await twoOffices();

    await importDeclining(ctx.db, buffer, "cape-town.xlsx", "2026-10-01", ct);
    const before = await ctx.db.select().from(s.attendance);
    expect(before.length).toBeGreaterThan(10_000);

    // The same workbook, imported as Johannesburg. Nobody in it is a Cape Town
    // person as far as that import is concerned - and Cape Town must survive.
    await ctx.db.delete(s.uploads);
    const report = await importDeclining(ctx.db, buffer, "joburg.xlsx", "2026-10-01", jhb);

    const ctIds = (
      await ctx.db.select({ id: s.employees.id }).from(s.employees).where(eq(s.employees.officeId, ct))
    ).map((r) => r.id);
    const ctAfter = await ctx.db.select().from(s.attendance);
    const ctRows = ctAfter.filter((r) => ctIds.includes(r.employeeId));

    expect(ctRows.length).toBe(before.length);
    expect(report.attendance.removed).toBe(0);
  }, 900_000);

  it("keeps same-named people in different offices apart", async () => {
    const { ctx, ct, jhb } = await twoOffices();
    await importDeclining(ctx.db, buffer, "cape-town.xlsx", "2026-10-01", ct);
    await ctx.db.delete(s.uploads);
    await importDeclining(ctx.db, buffer, "joburg.xlsx", "2026-10-01", jhb);

    const zoes = await ctx.db
      .select()
      .from(s.employees)
      .where(eq(s.employees.normalisedKey, "zoe flanegan"));

    // One in each office - the same name, two different people.
    expect(zoes).toHaveLength(2);
    expect(new Set(zoes.map((z) => z.officeId))).toEqual(new Set([ct, jhb]));
  }, 900_000);

  it("counts each office's roster separately", async () => {
    const { ctx, ct, jhb } = await twoOffices();
    await importDeclining(ctx.db, buffer, "cape-town.xlsx", "2026-10-01", ct);
    await ctx.db.delete(s.uploads);
    await importDeclining(ctx.db, buffer, "joburg.xlsx", "2026-10-01", jhb);

    for (const office of [ct, jhb]) {
      const people = await ctx.db
        .select()
        .from(s.employees)
        .where(eq(s.employees.officeId, office));
      expect(people).toHaveLength(82);
    }
  }, 900_000);

  it("files the upload against the office it was imported for", async () => {
    const { ctx, jhb } = await twoOffices();
    await importDeclining(ctx.db, buffer, "joburg.xlsx", "2026-10-01", jhb);
    const [upload] = await ctx.db.select().from(s.uploads);
    expect(upload.officeId).toBe(jhb);
  }, 900_000);

  it("only rewrites employment windows for the office being imported", async () => {
    const { ctx, ct, jhb } = await twoOffices();
    await importDeclining(ctx.db, buffer, "cape-town.xlsx", "2026-10-01", ct);

    const ctBefore = await ctx.db
      .select({ id: s.employees.id, first: s.employees.firstSeenDate, last: s.employees.lastSeenDate })
      .from(s.employees)
      .where(eq(s.employees.officeId, ct))
      .orderBy(s.employees.id);

    await ctx.db.delete(s.uploads);
    await importDeclining(ctx.db, buffer, "joburg.xlsx", "2026-10-01", jhb);

    const ctAfter = await ctx.db
      .select({ id: s.employees.id, first: s.employees.firstSeenDate, last: s.employees.lastSeenDate })
      .from(s.employees)
      .where(eq(s.employees.officeId, ct))
      .orderBy(s.employees.id);

    expect(ctAfter).toEqual(ctBefore);
  }, 900_000);
});
