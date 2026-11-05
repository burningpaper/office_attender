/**
 * The dry run, for a workbook that is a staff roster and nothing else.
 *
 * An HR export is a different animal to an attendance sheet: 248 names, job
 * titles, a location column, and not a single date. The importer already knew
 * how to read one, but its preview returned before it looked, so the dry run
 * for the Johannesburg roster read:
 *
 *     identities   0 names → 0 people
 *     attendance   0 new, 0 changed, 0 unchanged
 *
 * which is exactly what an unreadable file looks like. The preview was there
 * and said nothing, which is worse than not having one - somebody checking
 * their work would have concluded the file was broken, or committed blind.
 *
 * The second test is the one that matters. A roster is authoritative about who
 * works somewhere, so a roster imported under the wrong office retires that
 * office's entire staff. These tests pin the preview that makes that visible.
 */
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../db/schema";
import { freshDb } from "../../db/__tests__/helpers";
import { seedCalendar } from "../../db/seed-calendar";
import { importWorkbook } from "../import-workbook";

/**
 * A roster in the shape the real HR export has: prefixed headers, an email
 * column, no dates. The prefixes are kept because they are what the shape
 * detection has to survive - "GenEntity - First Name" is not "First Name".
 */
function rosterWorkbook(people: { first: string; last: string }[]): Buffer {
  const rows = [
    [
      "Company",
      "Company Rule",
      "GenEntity - First Name",
      "GenEntity - Last Name",
      "Employee - Job Title",
      "Hierarchy : LOCATION - Hierarchy Name",
      "GenEntity - Email Address",
    ],
    ...people.map((p) => [
      "001-VMLSA",
      "VML_SA",
      p.first,
      p.last,
      "Senior Something",
      "Johannesburg",
      `${p.first.toLowerCase()}.${p.last.toLowerCase()}@example.com`,
    ]),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Table1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function twoOffices() {
  const ctx = await freshDb();
  await seedCalendar(ctx.db, 2026, 2026);
  const [jhb] = await ctx.db
    .insert(s.offices)
    .values({ code: "JHB", name: "Johannesburg" })
    .returning();
  return { ctx, ct: ctx.officeId, jhb: jhb.id };
}

describe("previewing a roster-only workbook", () => {
  it("says how many people it would create", async () => {
    const { ctx, jhb } = await twoOffices();
    const buffer = rosterWorkbook([
      { first: "Johannes", last: "Matthysen" },
      { first: "Marina", last: "Greenhalgh" },
      { first: "Joel", last: "Monyonga" },
    ]);

    const report = await importWorkbook(ctx.db, buffer, "jhb.xlsx", {
      dryRun: true,
      officeId: jhb,
    });

    expect(report.people.addedFromRoster).toHaveLength(3);
    expect(report.people.addedFromRoster).toContain("Johannes Matthysen");
    expect(report.people.departed).toHaveLength(0);
  }, 120_000);

  it("writes nothing", async () => {
    const { ctx, jhb } = await twoOffices();
    const buffer = rosterWorkbook([{ first: "Johannes", last: "Matthysen" }]);

    await importWorkbook(ctx.db, buffer, "jhb.xlsx", { dryRun: true, officeId: jhb });

    const people = await ctx.db
      .select()
      .from(s.employees)
      .where(eq(s.employees.officeId, jhb));
    expect(people).toHaveLength(0);
  }, 120_000);

  it("commits the same people the preview promised", async () => {
    const { ctx, jhb } = await twoOffices();
    const buffer = rosterWorkbook([
      { first: "Johannes", last: "Matthysen" },
      { first: "Marina", last: "Greenhalgh" },
    ]);

    const preview = await importWorkbook(ctx.db, buffer, "jhb.xlsx", {
      dryRun: true,
      officeId: jhb,
    });
    await ctx.db.delete(s.uploads);
    const committed = await importWorkbook(ctx.db, buffer, "jhb.xlsx", { officeId: jhb });

    expect(committed.people.addedFromRoster.sort()).toEqual(
      preview.people.addedFromRoster.sort(),
    );
    const people = await ctx.db
      .select()
      .from(s.employees)
      .where(eq(s.employees.officeId, jhb));
    expect(people).toHaveLength(2);
  }, 120_000);
});

describe("a roster aimed at the wrong office", () => {
  it("shows every one of that office's people as a departure, before committing", async () => {
    const { ctx, ct } = await twoOffices();

    // Cape Town, with staff of its own.
    await ctx.db.insert(s.employees).values([
      { officeId: ct, firstName: "Adam", lastName: "Whitehouse",
        displayName: "Adam Whitehouse", normalisedKey: "adam|whitehouse" },
      { officeId: ct, firstName: "Amy", lastName: "Dudley",
        displayName: "Amy Dudley", normalisedKey: "amy|dudley" },
    ]);

    const buffer = rosterWorkbook([{ first: "Johannes", last: "Matthysen" }]);

    const report = await importWorkbook(ctx.db, buffer, "jhb.xlsx", {
      dryRun: true,
      officeId: ct,
    });

    expect(report.people.departed.map((p) => p.displayName).sort()).toEqual([
      "Adam Whitehouse",
      "Amy Dudley",
    ]);

    // And the preview kept its promise not to touch anything.
    const stillActive = await ctx.db
      .select()
      .from(s.employees)
      .where(eq(s.employees.status, "ACTIVE"));
    expect(stillActive).toHaveLength(2);
  }, 120_000);
});
