/**
 * Removes imported attendance for days that had not happened when the file
 * arrived.
 *
 *   npm run attendance:drop-unhappened          # show what would go
 *   npm run attendance:drop-unhappened -- --run # do it
 *
 * These workbooks are laid out for the whole month in advance, so a file
 * uploaded on the 8th already has a column for every remaining Wednesday and
 * Friday - and an empty cell in those columns reads as FALSE, as absent. The
 * September 2026 registry carried 694 such rows, fifty-three people across
 * every required day to the 30th, and not one of them said PRESENT.
 *
 * The importer now refuses them at the door. This clears what it let through
 * before, matching on the same rule: an IMPORT row dated after the upload that
 * created it. Nothing PRESENT is touched, nothing typed into the register is
 * touched, and every removal is written to attendance_history first, so the
 * audit trail still answers "where did this row go?".
 *
 * Safe to re-run: a second call finds nothing.
 */
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import * as schema from "../lib/db/schema";

config({ path: ".env.local" });

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set — see .env.example");

const commit = process.argv.includes("--run");

/**
 * The rule, in one place so the preview and the deletion cannot disagree.
 *
 * `state <> 'PRESENT'` is belt and braces: a placeholder cell is a zero by
 * definition, and if one of these rows ever says somebody was in the office,
 * that is a record and it stays.
 */
const CONDEMNED = sql`
  select a.employee_id, a.date, a.state, u.filename, u.uploaded_at::date as uploaded
  from attendance a
  join uploads u on u.id = a.source_upload_id
  where a.source = 'IMPORT'
    and a.state <> 'PRESENT'
    and a.date > u.uploaded_at::date
`;

async function main() {
  const db = drizzle(neon(url!), { schema });

  const rows = (
    await db.execute(sql`${CONDEMNED} order by u.filename, a.date`)
  ).rows as { employee_id: number; date: string; filename: string; uploaded: string }[];

  if (rows.length === 0) {
    console.log("Nothing to remove: no imported row is dated after its own upload.");
    return;
  }

  const byFile = new Map<string, { uploaded: string; dates: Set<string>; rows: number }>();
  for (const row of rows) {
    const entry = byFile.get(row.filename) ?? { uploaded: row.uploaded, dates: new Set(), rows: 0 };
    entry.dates.add(row.date);
    entry.rows++;
    byFile.set(row.filename, entry);
  }

  for (const [filename, entry] of byFile) {
    const dates = [...entry.dates].sort();
    console.log(
      `${filename} (uploaded ${entry.uploaded}): ${entry.rows} rows across ` +
        `${dates.length} days, ${dates[0]} to ${dates[dates.length - 1]}`,
    );
  }

  if (!commit) {
    console.log(`\n${rows.length} rows would be removed. Re-run with --run to do it.`);
    return;
  }

  // History first. If the delete fails, the journal is merely ahead of itself;
  // if it were the other way round the rows would vanish unexplained.
  await db.execute(sql`
    insert into attendance_history (employee_id, date, old_state, new_state, changed_at)
    select c.employee_id, c.date, c.state, 'NOT_EMPLOYED', now()
    from (${CONDEMNED}) c
  `);

  const deleted = await db.execute(sql`
    delete from attendance a
    using uploads u
    where u.id = a.source_upload_id
      and a.source = 'IMPORT'
      and a.state <> 'PRESENT'
      and a.date > u.uploaded_at::date
  `);

  console.log(`\nRemoved ${deleted.rowCount ?? rows.length} rows.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
