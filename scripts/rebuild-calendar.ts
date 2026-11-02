/**
 * Recomputes which stored days are required days.
 *
 *   npm run calendar:rebuild            # show what would change
 *   npm run calendar:rebuild -- --run   # change it
 *
 * `calendar_days.is_required_day` is the denominator every verdict is measured
 * against, and it is stored rather than derived - so changing the cadence in
 * the code changes nothing until this has run. Thursday became a required day
 * on 5 November 2026 and the rows for every Thursday after it still said
 * otherwise.
 *
 * Only `is_required_day` is touched, and never on a day somebody has marked
 * OFFICE_CLOSED. That matters more than it sounds: 1 and 3 July 2026 are closed
 * in this database because a person looked at a Wednesday and a Friday with no
 * attendance on them and said the office was shut. `buildCalendar` cannot know
 * that - it only produces WORKING, WEEKEND and PUBLIC_HOLIDAY - so a rebuild
 * that trusted it would have made both days required again and handed the whole
 * company two absences on days there was nothing to attend.
 *
 * Public holidays and labels are left alone for the same reason the cadence has
 * no opinion about them: a required Thursday that is also Christmas is still
 * not a day anybody could attend, and the calendar already knows that.
 *
 * Safe to re-run: a second call finds nothing.
 */
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import { buildCalendar } from "../lib/calendar/build-calendar";
import { describeCadence } from "../lib/calendar/cadence";

config({ path: ".env.local" });

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set — see .env.example");

const commit = process.argv.includes("--run");

async function main() {
  const db = drizzle(neon(url!), { schema });

  const stored = (
    await db.execute(sql`
      select date::text as date, is_required_day, day_type
      from calendar_days order by date`)
  ).rows as { date: string; is_required_day: boolean; day_type: string }[];

  if (stored.length === 0) {
    console.log("No calendar rows yet. Run the seed first.");
    return;
  }

  const years = stored.map((row) => Number(row.date.slice(0, 4)));
  const expected = new Map(
    buildCalendar(Math.min(...years), Math.max(...years)).map((d) => [d.date, d.isRequiredDay]),
  );

  /**
   * A day somebody has closed by hand stays closed. This is the one place the
   * stored calendar knows something the code cannot work out for itself.
   */
  const closed = stored.filter(
    (row) => row.day_type === "OFFICE_CLOSED" && expected.get(row.date) !== row.is_required_day,
  );

  const changes = stored.filter(
    (row) =>
      row.day_type !== "OFFICE_CLOSED" &&
      expected.has(row.date) &&
      expected.get(row.date) !== row.is_required_day,
  );

  if (closed.length > 0) {
    console.log(
      `Leaving ${closed.length} day${closed.length === 1 ? "" : "s"} alone: ` +
        `${closed.map((row) => row.date).join(", ")} ` +
        `${closed.length === 1 ? "is" : "are"} marked closed by hand.\n`,
    );
  }

  if (changes.length === 0) {
    console.log(
      `Nothing to change: all ${stored.length} stored days already agree with the cadence.`,
    );
    return;
  }

  /** Grouped by month and direction, because a day-by-day list is unreadable. */
  const byMonth = new Map<string, { becoming: string[]; ceasing: string[] }>();
  for (const row of changes) {
    const month = row.date.slice(0, 7);
    const entry = byMonth.get(month) ?? { becoming: [], ceasing: [] };
    if (expected.get(row.date)) entry.becoming.push(row.date);
    else entry.ceasing.push(row.date);
    byMonth.set(month, entry);
  }

  console.log(`Cadence today: ${describeCadence(new Date().toISOString().slice(0, 10))}\n`);
  for (const [month, entry] of [...byMonth].sort()) {
    const parts = [
      entry.becoming.length > 0 ? `+${entry.becoming.length} now required` : null,
      entry.ceasing.length > 0 ? `-${entry.ceasing.length} no longer required` : null,
    ].filter(Boolean);
    console.log(`  ${month}  ${parts.join(", ")}`);
  }

  const earliest = changes[0].date;
  const today = new Date().toISOString().slice(0, 10);
  if (earliest < today) {
    console.log(
      `\n  Note: the earliest change is ${earliest}, which has already passed. ` +
        `Verdicts for that period will move.`,
    );
  }

  if (!commit) {
    console.log(`\n${changes.length} days would change. Re-run with --run to do it.`);
    return;
  }

  const CHUNK = 500;
  for (let i = 0; i < changes.length; i += CHUNK) {
    const batch = changes.slice(i, i + CHUNK);
    await db.execute(sql`
      update calendar_days set is_required_day = v.required
      from (values ${sql.join(
        batch.map((row) => sql`(${row.date}::date, ${expected.get(row.date)}::boolean)`),
        sql`, `,
      )}) as v(date, required)
      where calendar_days.date = v.date`);
  }

  console.log(`\nUpdated ${changes.length} days.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
