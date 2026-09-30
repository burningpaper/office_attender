/**
 * The public week, against a real database.
 *
 * The important test here is the negative one. Everything else on this system
 * is read by five people who already have the data; this page is read by
 * whoever the link reaches, and the failure mode is not a wrong number on a
 * screen, it is somebody's surname and the reason they were off sick on a URL
 * that cannot be recalled.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as s from "../../db/schema";
import { freshDb, importDeclining } from "../../db/__tests__/helpers";
import { lastCompletedWeek, loadPublicWeek } from "../public-week";

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

/** The workbook runs to 30 September 2026; stand after it. */
async function loaded() {
  const ctx = await freshDb();
  await importDeclining(ctx.db, buffer, "data.xlsx", "2026-10-01");
  return ctx;
}

describe("which week", () => {
  it("is the last one that finished, never the one in progress", () => {
    // Wednesday 30 September. The current week's register is still being kept,
    // and a half-filled register reads as a roomful of absentees.
    expect(lastCompletedWeek("2026-09-30")).toBe("2026-09-21");
  });

  it("does not jump forward on the Sunday", () => {
    // Sunday belongs to the week that just ended, so it must not yet show it.
    expect(lastCompletedWeek("2026-09-27")).toBe("2026-09-14");
    expect(lastCompletedWeek("2026-09-28")).toBe("2026-09-21");
  });
});

describe("what it shows", () => {
  it("lists people by first name", async () => {
    const ctx = await loaded();
    const week = await loadPublicWeek(ctx.db, "2026-10-01");

    const names = week.offices.flatMap((o) => o.people.map((p) => p.name));
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("Francesca");
    expect(names).not.toContain("Francesca Tiganis");
  }, 300_000);

  it("leaves out somebody carrying a standing exemption", async () => {
    // Kevin Irwin stays in George and is not expected in the office. He is not
    // on the register either, so the public week does not list him as absent
    // every week for the rest of his career.
    const ctx = await loaded();
    const week = await loadPublicWeek(ctx.db, "2026-10-01");

    expect(week.offices.flatMap((o) => o.people.map((p) => p.name))).not.toContain("Kevin");
  }, 300_000);

  it("reports the days of the week it says it does", async () => {
    const ctx = await loaded();
    const week = await loadPublicWeek(ctx.db, "2026-10-01");

    expect(week.monday).toBe("2026-09-21");
    for (const office of week.offices) {
      expect(office.days.map((d) => d.date)).toEqual(["2026-09-23", "2026-09-25"]);
    }
  }, 300_000);

  it("leaves out somebody who is not tracked", async () => {
    const ctx = await loaded();

    const [person] = await ctx.db
      .select({ id: s.employees.id, firstName: s.employees.firstName })
      .from(s.employees)
      .where(eq(s.employees.status, "ACTIVE"))
      .limit(1);

    const before = await loadPublicWeek(ctx.db, "2026-10-01");
    expect(before.offices.flatMap((o) => o.people.map((p) => p.name))).toContain(person.firstName);

    await ctx.db
      .insert(s.exemptions)
      .values({ employeeId: person.id, type: "OTHER", rawText: "Not tracked", active: true });

    const after = await loadPublicWeek(ctx.db, "2026-10-01");
    expect(after.offices.flatMap((o) => o.people.map((p) => p.name))).not.toContain(
      person.firstName,
    );
  }, 300_000);

  it("counts an excused absence out of the expected total", async () => {
    // Somebody signed off is not somebody who failed to turn up, so the
    // summary line should not hold them against the office's figure.
    const ctx = await loaded();
    const week = await loadPublicWeek(ctx.db, "2026-10-01");

    for (const office of week.offices) {
      office.days.forEach((_, i) => {
        const excused = office.people.filter((p) => p.states[i] === "EXCUSED").length;
        expect(office.expected[i]).toBe(office.people.length - excused);
      });
    }
  }, 300_000);
});

describe("a day the office was shut", () => {
  it("says so, instead of showing everybody as absent", async () => {
    // Foundation Day, 23 September 2026: the whole company was out doing
    // community work. The page read "0 of 44 in on Wednesday" until somebody
    // who knew that said so.
    const ctx = await loaded();
    await ctx.db
      .insert(s.officeClosures)
      .values({ officeId: ctx.officeId, date: "2026-09-23", label: "Foundation Day" });

    const week = await loadPublicWeek(ctx.db, "2026-10-01");
    const office = week.offices.find((o) => o.days[0].kind === "CLOSED")!;
    expect(office).toBeDefined();

    const wednesday = office.days[0];
    expect(wednesday.kind === "CLOSED" && wednesday.label).toBe("Foundation Day");

    // Nobody is absent on a day there was nothing to attend.
    expect(office.people.every((p) => p.states[0] === "CLOSED")).toBe(true);
    expect(office.attended[0]).toBe(0);
    expect(office.expected[0]).toBe(0);
  }, 300_000);

  it("leaves the other day of that week alone", async () => {
    const ctx = await loaded();
    await ctx.db
      .insert(s.officeClosures)
      .values({ officeId: ctx.officeId, date: "2026-09-23", label: "Foundation Day" });

    const week = await loadPublicWeek(ctx.db, "2026-10-01");
    const office = week.offices.find((o) => o.days[0].kind === "CLOSED")!;
    expect(office.days[1].kind).toBe("OPEN");
    expect(office.expected[1]).toBeGreaterThan(0);
  }, 300_000);
});

describe("what it must never show", () => {
  it("carries no surname, no comment and no email anywhere in its output", async () => {
    const ctx = await loaded();

    // Put a comment of exactly the kind that must not escape on a real row.
    const [row] = await ctx.db
      .select({ employeeId: s.attendance.employeeId })
      .from(s.attendance)
      .where(eq(s.attendance.date, "2026-09-23"))
      .limit(1);
    await ctx.db
      .update(s.attendance)
      .set({ state: "ABSENT_EXPLAINED", comment: "At his father's funeral" })
      .where(
        sql`${s.attendance.employeeId} = ${row.employeeId} and ${s.attendance.date} = '2026-09-23'`,
      );

    const week = await loadPublicWeek(ctx.db, "2026-10-01");
    const serialised = JSON.stringify(week);

    expect(serialised).not.toContain("funeral");

    const people = await ctx.db
      .select({
        firstName: s.employees.firstName,
        lastName: s.employees.lastName,
        email: s.employees.email,
      })
      .from(s.employees);

    for (const person of people) {
      if (person.email) expect(serialised).not.toContain(person.email);
    }

    /**
     * Every rendered name is a bare first name, unless it belongs to somebody
     * who genuinely shares one.
     *
     * Asserted this way round rather than by hunting for surnames in the
     * output, because "Khan" is a substring of "Khanyisa" and a test that
     * cries wolf about a colleague's first name is a test that gets deleted.
     */
    const firstNames = new Set(people.map((p) => p.firstName));
    const shared = new Set(
      [...firstNames].filter(
        (first) => people.filter((p) => p.firstName === first).length > 1,
      ),
    );

    for (const office of week.offices) {
      for (const person of office.people) {
        if (firstNames.has(person.name)) continue; // a bare first name
        const [first] = person.name.split(" ");
        expect(shared.has(first), `${person.name} is not a bare first name`).toBe(true);
      }
    }
  }, 300_000);

  it("never says why somebody was excused", async () => {
    const ctx = await loaded();

    // Exemption notes are the other reason text in the system: "Stays in
    // George" is somebody's home address, roughly.
    const notes = await ctx.db
      .select({ rawText: s.exemptions.rawText })
      .from(s.exemptions)
      .where(eq(s.exemptions.active, true));

    const week = await loadPublicWeek(ctx.db, "2026-10-01");
    const serialised = JSON.stringify(week);

    for (const note of notes) {
      if (note.rawText) expect(serialised).not.toContain(note.rawText);
    }
  }, 300_000);
});
