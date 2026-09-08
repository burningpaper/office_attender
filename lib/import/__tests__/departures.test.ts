/**
 * Marking people who have left.
 *
 * The signal is the roster, not attendance. Somebody on the newest sheet with a
 * month of zeroes has not left - they have just not come in, which is the whole
 * thing this system is meant to notice.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as s from "../../db/schema";
import { freshDb, importDeclining } from "../../db/__tests__/helpers";
import { seedCalendar } from "../../db/seed-calendar";
import { loadEmployeeRows } from "../../compliance/load";
import { buildRecipients } from "../../email/recipients";
import { filterRows } from "../../compliance/sort";

const WORKBOOK = path.resolve(__dirname, "../../../data_example.xls.xlsx");
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

async function imported() {
  const ctx = await freshDb();
  await seedCalendar(ctx.db, 2026, 2026);
  const report = await importDeclining(ctx.db, buffer, "data.xlsx");
  return { ctx, report };
}

describe("who gets marked as having left", () => {
  it("marks everybody missing from the newest sheet", async () => {
    const { ctx, report } = await imported();

    const departed = await ctx.db
      .select({ name: s.employees.displayName })
      .from(s.employees)
      .where(eq(s.employees.status, "DEPARTED"));

    expect(departed.map((d) => d.name).sort()).toEqual([
      "Abdul-Maalik Jacobs", "Brian", "Chadley Potgieter", "Chantal Brunette",
      "Cikizwa Ndlovu", "Dominique Warr", "Etienne Cronje", "Glenn Alexander",
      "Kelly-Ann Tabone", "Lonwabo Mbadlanyana", "Malefetsane Makondo",
      "Samantha Mtethwa", "Stefan Labuschagne", "Thakiera Karriem",
      "Weslee Johannesen",
    ]);
    expect(report.people.departed).toHaveLength(15);
  }, 180_000);

  it("does NOT mark somebody who is on the sheet but never comes in", async () => {
    // Francesca Tiganis has not attended once in seven months. She has not
    // left - she is exactly who the report exists to surface.
    const { ctx } = await imported();
    const [francesca] = await ctx.db
      .select()
      .from(s.employees)
      .where(eq(s.employees.displayName, "Francesca Tiganis"));
    expect(francesca.status).toBe("ACTIVE");
    expect(francesca.lastSeenDate).toBe("2026-09-30");
  }, 180_000);

  it("leaves the 67 people still on the sheet active", async () => {
    const { ctx } = await imported();
    const active = await ctx.db
      .select()
      .from(s.employees)
      .where(eq(s.employees.status, "ACTIVE"));
    expect(active).toHaveLength(67);
  }, 180_000);

  it("brings somebody back if they reappear", async () => {
    // A name left off one month by mistake must correct itself, not need
    // somebody to remember it.
    const { ctx } = await imported();

    await ctx.db
      .update(s.employees)
      .set({ status: "DEPARTED" })
      .where(eq(s.employees.displayName, "Ben Clay"));

    // Re-import the same file. Ben is on the September sheet, so he comes back.
    await ctx.db.delete(s.uploads);
    const second = await importDeclining(ctx.db, buffer, "data.xlsx");

    const [ben] = await ctx.db
      .select()
      .from(s.employees)
      .where(eq(s.employees.displayName, "Ben Clay"));
    expect(ben.status).toBe("ACTIVE");
    expect(second.people.returned).toContain("Ben Clay");
  }, 300_000);
});

describe("what leaving changes", () => {
  it("keeps them out of this month's report", async () => {
    const { ctx } = await imported();
    const rows = await loadEmployeeRows(ctx.db, "2026-09", "2026-09-30");

    const visible = filterRows(rows, { showExempt: true, onlyProblems: false, query: "" });
    expect(visible.map((r) => r.displayName)).not.toContain("Chadley Potgieter");
    expect(visible).toHaveLength(67);

    // But they can still be shown deliberately.
    const all = filterRows(rows, {
      showExempt: true, onlyProblems: false, query: "", showLeavers: true,
    });
    expect(all).toHaveLength(82);
  }, 180_000);

  it("keeps their history intact in the months they worked", async () => {
    // Chadley Potgieter was on the August sheet, so August must still show him.
    const { ctx } = await imported();
    const august = await loadEmployeeRows(ctx.db, "2026-08", "2026-08-31");
    const visible = filterRows(august, { showExempt: true, onlyProblems: false, query: "" });
    expect(visible.map((r) => r.displayName)).toContain("Chadley Potgieter");
  }, 180_000);

  it("never emails them", async () => {
    const { ctx } = await imported();
    const august = await loadEmployeeRows(ctx.db, "2026-08", "2026-08-31");

    // Give everybody an address so the only reason to exclude is having left.
    const emails = new Map(august.map((r) => [r.employeeId, `${r.employeeId}@example.invalid`]));
    const { recipients, excluded } = buildRecipients(august, "MONTHLY", emails);

    // Chadley is on the August sheet and non-compliant, but has since left.
    const chadley = august.find((r) => r.displayName === "Chadley Potgieter")!;
    expect(chadley.monthly.verdict).toBe("NO");
    expect(chadley.hasLeft).toBe(true);

    expect(recipients.map((r) => r.displayName)).not.toContain("Chadley Potgieter");
    expect(excluded).toContainEqual({ displayName: "Chadley Potgieter", reason: "LEFT" });
  }, 180_000);

  it("excludes a leaver even before their status is written", async () => {
    // Belt and braces: the per-month roster check catches them too.
    const { ctx } = await imported();
    const september = await loadEmployeeRows(ctx.db, "2026-09", "2026-09-30");
    const gone = september.find((r) => r.displayName === "Chantal Brunette")!;
    expect(gone.onRosterThisMonth).toBe(false);

    const emails = new Map([[gone.employeeId, "x@example.invalid"]]);
    const { recipients } = buildRecipients([{ ...gone, hasLeft: false }], "MONTHLY", emails);
    expect(recipients).toHaveLength(0);
  }, 180_000);
});

describe("email addresses carried in the workbook", () => {
  const WITH_EMAILS = path.resolve(__dirname, "../../../data_example2.xlsx");

  it("reads an Email column without mistaking it for a standing note", async () => {
    // From August 2026 the workbook inserted an "Email" column in the same
    // position the standing notes had occupied, shifting every date right by
    // one. Reading those addresses as notes would have produced 65 spurious
    // exemption warnings on every upload.
    if (!existsSync(WITH_EMAILS)) return;

    const { parseWorkbook } = await import("../parse-workbook");
    const parsed = parseWorkbook(readFileSync(WITH_EMAILS));

    const withEmail = new Set(parsed.employees.filter((e) => e.email).map((e) => e.rawName));
    expect(withEmail.size).toBe(65);

    const notes = [...new Set(parsed.employees.map((e) => e.standingNote).filter(Boolean))];
    expect(notes.some((n) => n!.includes("@"))).toBe(false);
    expect(notes).toContain("Stays in George");
  });

  it("still finds the dates after the inserted column shifted them", async () => {
    if (!existsSync(WITH_EMAILS)) return;
    const { parseWorkbook } = await import("../parse-workbook");
    const parsed = parseWorkbook(readFileSync(WITH_EMAILS));

    const august = parsed.sheets.find((s) => s.sheetName === "August")!;
    expect(august.dateRange).toEqual({ start: "2026-08-03", end: "2026-08-31" });
  });

  it("saves the addresses onto the right people", async () => {
    if (!existsSync(WITH_EMAILS)) return;
    const ctx = await freshDb();
    await seedCalendar(ctx.db, 2026, 2026);
    const report = await importDeclining(ctx.db, readFileSync(WITH_EMAILS), "with-emails.xlsx");

    expect(report.addresses.imported).toBe(65);

    const [kevin] = await ctx.db
      .select()
      .from(s.employees)
      .where(eq(s.employees.displayName, "Kevin Irwin"));
    expect(kevin.email).toBe("kevin.irwin@es.wpp.com");

    // Everyone still on the sheet who has an address, has it.
    const active = await ctx.db
      .select()
      .from(s.employees)
      .where(eq(s.employees.status, "ACTIVE"));
    expect(active.filter((e) => e.email)).toHaveLength(65);
  }, 300_000);
});

describe("a workbook that carries a staff roster", () => {
  const REGISTER = path.resolve(__dirname, "../../../CT Registry 8 Sept 2026.xlsx");

  it("reads the roster tab by shape, not by tab name", async () => {
    if (!existsSync(REGISTER)) return;
    const { parseWorkbook } = await import("../parse-workbook");
    const parsed = parseWorkbook(readFileSync(REGISTER));

    expect(parsed.roster).toHaveLength(56);
    expect(parsed.roster.every((p) => p.email)).toBe(true);
    // A roster has no date columns, so it contributes no attendance.
    expect(parsed.records.some((r) => r.sheetName === "CT STAFF")).toBe(false);
  });

  it("does not mistake an attendance tab for a roster", async () => {
    if (!existsSync(REGISTER)) return;
    const { parseWorkbook } = await import("../parse-workbook");
    const parsed = parseWorkbook(readFileSync(REGISTER));
    expect(new Set(parsed.roster.map((p) => p.sheetName))).toEqual(new Set(["CT STAFF"]));
  });

  it("treats attendance as proof of employment, whatever the roster says", async () => {
    if (!existsSync(REGISTER)) return;
    const ctx = await freshDb();
    await seedCalendar(ctx.db, 2026, 2026);
    await importDeclining(ctx.db, readFileSync(REGISTER), "register.xlsx", "2026-09-08");

    /**
     * The September 2026 roster omits thirteen people who are on that month's
     * attendance sheet, six of whom were in the office on the 4th. A roster
     * cannot overrule somebody having physically been there.
     */
    for (const name of [
      "Daniel Rivas", "Isabella Martinez", "Matthew Rudd",
      "Khanyisa Ketse", "Matthew van Niekerk",
    ]) {
      const [person] = await ctx.db
        .select()
        .from(s.employees)
        .where(eq(s.employees.displayName, name));
      expect(person?.status, name).toBe("ACTIVE");
    }
  }, 300_000);

  it("creates people who are on the roster but not yet on record", async () => {
    if (!existsSync(REGISTER)) return;
    const ctx = await freshDb();
    await seedCalendar(ctx.db, 2026, 2026);
    const report = await importDeclining(
      ctx.db, readFileSync(REGISTER), "register.xlsx", "2026-09-08",
    );

    expect(report.people.addedFromRoster.length).toBeGreaterThan(0);
    const [beach] = await ctx.db
      .select()
      .from(s.employees)
      .where(eq(s.employees.displayName, "Beach Gumede"));
    expect(beach?.email).toBe("beach.gumede@vml.com");
  }, 300_000);
});
