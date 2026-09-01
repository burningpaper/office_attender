/**
 * The real workbook, through the whole pipeline, into a real Postgres.
 *
 * This is the test that proves stage 3's contract: 84 name strings become the
 * right number of people, a re-import changes nothing, and the two rows nobody
 * can identify reach a human instead of being guessed at.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as s from "../../db/schema";
import { freshDb, importDeclining } from "../../db/__tests__/helpers";
import { importWorkbook } from "../import-workbook";

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

async function importInto() {
  const ctx = await freshDb();
  // Declines every proposal, so these tests see the file exactly as parsed.
  const report = await importDeclining(ctx.db, buffer, "data_example.xls.xlsx");
  return { ctx, report };
}

describe("first import", () => {
  it("resolves 84 name strings to 82 people", async () => {
    const { ctx, report } = await importInto();

    // Zakiya/Zakiyya Karim and Zoe/zoe Flanegan each collapse to one person.
    expect(report.identities.total).toBe(84);
    const employees = await ctx.db.select().from(s.employees);
    expect(employees).toHaveLength(82);
  });

  it("merges the spelling variants without a model call", async () => {
    const { ctx } = await importInto();

    for (const [a, b] of [
      ["Zakiya Karim", "Zakiyya Karim"],
      ["Zoe Flanegan", "zoe Flanegan"],
    ]) {
      const rows = await ctx.db
        .select({ employeeId: s.employeeAliases.employeeId })
        .from(s.employeeAliases)
        .where(sql`${s.employeeAliases.rawName} in (${a}, ${b})`);
      expect(rows, `${a} / ${b}`).toHaveLength(2);
      expect(new Set(rows.map((r) => r.employeeId)).size, `${a} / ${b} are one person`).toBe(1);
    }
  });

  it("keeps people who merely resemble each other apart", async () => {
    const { ctx } = await importInto();
    // Jason Khubeka is deliberately absent: both his rows are legend rows with
    // no attendance data, so the parser drops him before this point.
    const names = ["Anthea O'Neill'", "Ashley O'Neill'", "Jason Tucker"];
    const rows = await ctx.db
      .select({ rawName: s.employeeAliases.rawName, employeeId: s.employeeAliases.employeeId })
      .from(s.employeeAliases)
      .where(sql`${s.employeeAliases.rawName} in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.employeeId)).size).toBe(3);
  });

  it("surfaces Brian and Intern for review instead of guessing", async () => {
    const { report } = await importInto();

    const noSurname = report.identities.needingReview.filter((r) =>
      /no surname/i.test(r.reviewReason ?? ""),
    );
    expect(noSurname.map((r) => r.rawName).sort()).toEqual(["Brian", "Intern"]);
    // Surfaced, but neither dropped nor merged into somebody else.
    expect(noSurname.every((r) => r.matchType === "NEW")).toBe(true);
  });

  it("shows the similarity merge in the report rather than doing it silently", async () => {
    const { report } = await importInto();
    // The merge happens - but a person gets told it happened.
    expect(report.identities.bySimilarity.map((r) => r.rawName)).toEqual(["Zakiyya Karim"]);
    expect(report.identities.bySimilarity[0].matchedKey).toBe("zakiya karim");
    expect(report.identities.needingReview).toContainEqual(
      expect.objectContaining({ rawName: "Zakiyya Karim", matchType: "SIMILARITY" }),
    );
  });

  it("computes an employment window per person", async () => {
    const { ctx } = await importInto();

    const [kevin] = await ctx.db
      .select()
      .from(s.employees)
      .where(eq(s.employees.normalisedKey, "kevin irwin"));
    // Kevin appears on every sheet - seven months of zeroes, because he lives
    // ~430km away. That is an exemption question, not an attendance one.
    expect(kevin.firstSeenDate).toBe("2026-03-02");
    expect(kevin.lastSeenDate).toBe("2026-09-30");

    // Someone who joins late must not be judged on months before they arrived.
    const [intern] = await ctx.db
      .select()
      .from(s.employees)
      .where(eq(s.employees.normalisedKey, "intern"));
    expect(intern.firstSeenDate).toBe("2026-08-03");
    expect(intern.lastSeenDate).toBe("2026-09-30");

    const all = await ctx.db.select().from(s.employees);
    expect(all.every((e) => e.firstSeenDate && e.lastSeenDate)).toBe(true);
  });

  it("loads attendance for every month and keeps the raw value", async () => {
    const { ctx, report } = await importInto();

    const [{ n }] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.attendance);
    expect(n).toBe(report.attendance.inserted);
    expect(n).toBe(10_453); // 10,221 binary cells + 232 explained absences

    const months = await ctx.db
      .select({ m: sql<string>`to_char(date, 'YYYY-MM')` })
      .from(s.attendance)
      .groupBy(sql`to_char(date, 'YYYY-MM')`);
    expect(months.map((r) => r.m).sort()).toEqual([
      "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
    ]);

    const present = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.attendance)
      .where(eq(s.attendance.state, "PRESENT"));
    expect(present[0].n).toBe(1443); // matches the parser's count exactly
  });

  it("records every distinct reason string, uncategorised until stage 5", async () => {
    const { ctx, report } = await importInto();
    const reasons = await ctx.db.select().from(s.reasons);
    // 35 genuine free-text reasons. Earlier estimates put this near 65, but
    // that count included the totals rows' numbers, which are furniture.
    expect(reasons.length).toBe(report.reasons.distinct);
    expect(reasons.length).toBe(35);
    // Nothing is classified yet - that is stage 5's job.
    expect(reasons.every((r) => r.category === "UNKNOWN")).toBe(true);
    expect(reasons.every((r) => r.reviewedByHuman === false)).toBe(true);
    expect(reasons.map((r) => r.rawText)).toContain("On leave");
  });

  it("links an explained absence to its reason", async () => {
    const { ctx } = await importInto();
    const rows = await ctx.db
      .select()
      .from(s.attendance)
      .where(eq(s.attendance.state, "ABSENT_EXPLAINED"))
      .limit(5);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.reasonId).not.toBeNull();
      expect(row.rawValue).toBeTruthy();
    }
  });

  it("withholds the columns whose date headers were malformed", async () => {
    const { ctx } = await importInto();
    for (const date of ["2026-06-01", "2026-08-10"]) {
      const rows = await ctx.db.select().from(s.attendance).where(eq(s.attendance.date, date));
      expect(rows, date).toHaveLength(0);
    }
  });

  it("writes a history row for every state it set", async () => {
    const { ctx, report } = await importInto();
    const [{ n }] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.attendanceHistory);
    expect(n).toBe(report.attendance.inserted);
  });

  it("marks the upload committed with the file hash", async () => {
    const { ctx, report } = await importInto();
    const [upload] = await ctx.db.select().from(s.uploads);
    expect(upload.status).toBe("COMMITTED");
    expect(upload.sha256).toBe(report.sha256);
    expect(upload.dateRangeStart).toBe("2026-03-02");
    expect(upload.dateRangeEnd).toBe("2026-09-30");
  });
});

describe("re-import", () => {
  it("is a no-op that changes nothing", async () => {
    const ctx = await freshDb();
    await importDeclining(ctx.db, buffer, "data_example.xls.xlsx");

    const snapshot = async () => ({
      employees: await ctx.db.select().from(s.employees).orderBy(s.employees.id),
      attendance: await ctx.db
        .select()
        .from(s.attendance)
        .orderBy(s.attendance.employeeId, s.attendance.date),
      history: await ctx.db.select().from(s.attendanceHistory),
      uploads: await ctx.db.select().from(s.uploads),
    });

    const before = await snapshot();
    const second = await importWorkbook(ctx.db, buffer, "data_example.xls.xlsx", {
      asOf: "2026-09-01",
    });
    const after = await snapshot();

    expect(second.alreadyImported).toBe(true);
    expect(second.committed).toBe(false);
    expect(after.employees).toHaveLength(before.employees.length);
    expect(after.attendance).toHaveLength(before.attendance.length);
    expect(after.history).toHaveLength(before.history.length);
    expect(after.uploads).toHaveLength(1); // no second upload row
    expect(JSON.stringify(after.attendance)).toBe(JSON.stringify(before.attendance));
  });
});

describe("dry run", () => {
  it("reports everything and writes nothing", async () => {
    const ctx = await freshDb();
    const report = await importWorkbook(ctx.db, buffer, "data_example.xls.xlsx", {
      dryRun: true,
      asOf: "2026-09-01",
    });

    expect(report.committed).toBe(false);
    expect(report.identities.total).toBe(84);
    expect(
      report.identities.needingReview
        .filter((r) => /no surname/i.test(r.reviewReason ?? ""))
        .map((r) => r.rawName)
        .sort(),
    ).toEqual(["Brian", "Intern"]);
    expect(report.reasons.distinct).toBe(35);

    expect(await ctx.db.select().from(s.employees)).toHaveLength(0);
    expect(await ctx.db.select().from(s.attendance)).toHaveLength(0);
    expect(await ctx.db.select().from(s.uploads)).toHaveLength(0);
  });
});
