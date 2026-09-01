/**
 * The preview-and-approve gate.
 *
 * The point of this stage is that the importer never resolves an ambiguity on
 * its own. These tests are mostly about what it refuses to do.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as s from "../../db/schema";
import { freshDb } from "../../db/__tests__/helpers";
import { seedCalendar } from "../../db/seed-calendar";
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

async function preview() {
  const ctx = await freshDb();
  await seedCalendar(ctx.db, 2026, 2026);
  const report = await importWorkbook(ctx.db, buffer, "data.xlsx", {
    dryRun: true,
    asOf: "2026-09-01",
  });
  return { ctx, report };
}

describe("what the importer refuses to decide", () => {
  it("raises the two ambiguous July days rather than guessing", async () => {
    const { report } = await preview();
    const closures = report.anomalies.filter(
      (a) => a.kind === "ZERO_ATTENDANCE_REQUIRED_DAY",
    );
    // Only these two. September's required days are all empty too, but they
    // have not happened yet, which is not an anomaly.
    expect(closures.map((c) => c.date)).toEqual(["2026-07-01", "2026-07-03"]);
    expect(closures.every((c) => c.blocking)).toBe(true);
  });

  it("does not raise Good Friday or Workers' Day - the calendar settles those", async () => {
    const { report } = await preview();
    const dates = report.anomalies.map((a) => a.date);
    expect(dates).not.toContain("2026-04-03");
    expect(dates).not.toContain("2026-05-01");
  });

  it("surfaces the evidence the sheet already contains", async () => {
    // Somebody wrote "Office closed" against 1 July on the totals row. The
    // parser discards that row as attendance, but the note is the answer to
    // the exact question being asked.
    const { report } = await preview();
    const july1 = report.anomalies.find((a) => a.id === "closure:2026-07-01")!;
    expect(july1.evidence).toMatch(/office closed/i);
    expect(july1.evidence).toMatch(/July row 59/);

    // 3 July has no such note, so it is raised without evidence.
    const july3 = report.anomalies.find((a) => a.id === "closure:2026-07-03")!;
    expect(july3.evidence).toBeUndefined();
  });

  it("raises the malformed date columns", async () => {
    const { report } = await preview();
    const columns = report.anomalies.filter((a) => a.kind === "UNREADABLE_DATE_COLUMN");
    expect(columns).toHaveLength(2);

    // June's column holds real attendance, so it blocks. August's is empty.
    const withData = columns.find((c) => c.date === "2026-06-01")!;
    expect(withData.blocking).toBe(true);
    const empty = columns.find((c) => c.date === "2026-08-10")!;
    expect(empty.blocking).toBe(false);
  });

  it("raises unidentified people without blocking on them", async () => {
    const { report } = await preview();
    const identities = report.anomalies.filter((a) => a.kind === "UNRESOLVED_IDENTITY");
    expect(identities.map((i) => i.title).join(" ")).toMatch(/Brian/);
    expect(identities.every((i) => !i.blocking)).toBe(true);
  });

  it("raises the Thursday work-from-home note for confirmation", async () => {
    const { report } = await preview();
    const exemptions = report.anomalies.filter((a) => a.kind === "EXEMPTION_TO_CONFIRM");
    expect(exemptions.map((e) => e.title).join(" ")).toMatch(/Lorna Downs/);
  });
});

describe("the gate", () => {
  it("refuses to commit while a blocking question is unanswered", async () => {
    const ctx = await freshDb();
    await seedCalendar(ctx.db, 2026, 2026);

    const report = await importWorkbook(ctx.db, buffer, "data.xlsx", { asOf: "2026-09-01" });

    expect(report.committed).toBe(false);
    expect(report.blockedBy!.length).toBeGreaterThan(0);
    expect(await ctx.db.select().from(s.employees)).toHaveLength(0);
    expect(await ctx.db.select().from(s.attendance)).toHaveLength(0);
  });

  it("commits once every blocking question is answered", async () => {
    const ctx = await freshDb();
    await seedCalendar(ctx.db, 2026, 2026);

    const preview = await importWorkbook(ctx.db, buffer, "data.xlsx", {
      dryRun: true,
      asOf: "2026-09-01",
    });
    const resolutions = preview.anomalies
      .filter((a) => a.blocking)
      .map((a) => ({ id: a.id, accept: true }));

    const report = await importWorkbook(ctx.db, buffer, "data.xlsx", {
      resolutions,
      asOf: "2026-09-01",
    });

    expect(report.committed).toBe(true);
    expect(report.blockedBy).toBeUndefined();
    expect((await ctx.db.select().from(s.employees)).length).toBe(82);
  });

  it("applies a confirmed closure to the calendar, permanently", async () => {
    const ctx = await freshDb();
    await seedCalendar(ctx.db, 2026, 2026);

    const preview = await importWorkbook(ctx.db, buffer, "data.xlsx", {
      dryRun: true,
      asOf: "2026-09-01",
    });
    const resolutions = preview.anomalies
      .filter((a) => a.blocking)
      .map((a) => ({ id: a.id, accept: a.id === "closure:2026-07-01" }));

    await importWorkbook(ctx.db, buffer, "data.xlsx", { resolutions, asOf: "2026-09-01" });

    const [july1] = await ctx.db
      .select()
      .from(s.calendarDays)
      .where(eq(s.calendarDays.date, "2026-07-01"));
    expect(july1).toMatchObject({
      dayType: "OFFICE_CLOSED",
      isRequiredDay: false,
      confirmedByHuman: true,
    });

    // Declined, so it stays a required day that people are judged on.
    const [july3] = await ctx.db
      .select()
      .from(s.calendarDays)
      .where(eq(s.calendarDays.date, "2026-07-03"));
    expect(july3.isRequiredDay).toBe(true);

    // And a re-seed must never undo the decision.
    await seedCalendar(ctx.db, 2026, 2026);
    const [after] = await ctx.db
      .select()
      .from(s.calendarDays)
      .where(eq(s.calendarDays.date, "2026-07-01"));
    expect(after.dayType).toBe("OFFICE_CLOSED");
  });

  it("does not ask about a day already ruled on", async () => {
    const ctx = await freshDb();
    await seedCalendar(ctx.db, 2026, 2026);
    await ctx.db
      .update(s.calendarDays)
      .set({ dayType: "OFFICE_CLOSED", isRequiredDay: false, confirmedByHuman: true })
      .where(eq(s.calendarDays.date, "2026-07-01"));

    const report = await importWorkbook(ctx.db, buffer, "data.xlsx", {
      dryRun: true,
      asOf: "2026-09-01",
    });
    expect(report.anomalies.map((a) => a.id)).not.toContain("closure:2026-07-01");
    expect(report.anomalies.map((a) => a.id)).toContain("closure:2026-07-03");
  });

  it("writes nothing during a preview", async () => {
    const { ctx } = await preview();
    expect(await ctx.db.select().from(s.employees)).toHaveLength(0);
    expect(await ctx.db.select().from(s.uploads)).toHaveLength(0);
  });
});

describe("honouring the decisions", () => {
  it("imports a confirmed date column that was previously withheld", async () => {
    const ctx = await freshDb();
    await seedCalendar(ctx.db, 2026, 2026);

    const preview = await importWorkbook(ctx.db, buffer, "data.xlsx", {
      dryRun: true,
      asOf: "2026-09-01",
    });

    // June's "O1 June" column holds real attendance that is withheld until
    // somebody confirms the date it means.
    const column = preview.anomalies.find((a) => a.id === "datecol:June:D")!;
    expect(column.date).toBe("2026-06-01");

    const resolutions = preview.anomalies
      .filter((a) => a.blocking)
      .map((a) => ({ id: a.id, accept: true }));

    await importWorkbook(ctx.db, buffer, "data.xlsx", { resolutions, asOf: "2026-09-01" });

    const onThatDay = await ctx.db
      .select()
      .from(s.attendance)
      .where(eq(s.attendance.date, "2026-06-01"));
    expect(onThatDay.length).toBeGreaterThan(50);
  }, 120_000);

  it("keeps a declined column withheld", async () => {
    const ctx = await freshDb();
    await seedCalendar(ctx.db, 2026, 2026);

    const preview = await importWorkbook(ctx.db, buffer, "data.xlsx", {
      dryRun: true,
      asOf: "2026-09-01",
    });
    const resolutions = preview.anomalies
      .filter((a) => a.blocking)
      .map((a) => ({ id: a.id, accept: a.kind !== "UNREADABLE_DATE_COLUMN" }));

    await importWorkbook(ctx.db, buffer, "data.xlsx", { resolutions, asOf: "2026-09-01" });

    const onThatDay = await ctx.db
      .select()
      .from(s.attendance)
      .where(eq(s.attendance.date, "2026-06-01"));
    expect(onThatDay).toHaveLength(0);
  }, 120_000);
});
