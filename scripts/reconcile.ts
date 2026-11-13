/**
 * Does the report agree with the register?
 *
 *   npm run reconcile                    # the current month
 *   npm run reconcile -- 2026-11         # a given month, as at today
 *   npm run reconcile -- 2026-10 2026-11-01
 *
 * Counts attendance two ways and compares them. The register's count is a
 * single SQL sum over PRESENT rows on finished required days; the report's is
 * whatever the compliance engine says. They should be identical, and for two
 * months they silently were not.
 *
 * `last_seen_date` was invented when a month arrived as a spreadsheet, where it
 * meant "the last sheet this person's name appeared on" and doubled as the day
 * they left. The register replaced the spreadsheet and nothing advances the
 * column any more, so all 61 people from Cape Town's last workbook carried
 * `last_seen_date = 2026-09-30` into October and November. The rule read that
 * as a departure date and returned zero required days, so sixty people were
 * ticked in on the register and reported as 0/0, nothing to judge. Cape Town
 * lost 95 of its 98 November attendances. Durban and Johannesburg were correct
 * throughout, having been created by paths that never set the column.
 *
 * The rules no longer trust that column for anybody still employed, and there
 * are unit tests to keep it that way. This script exists for the other half of
 * the problem: a discrepancy that is nobody's bug, like a person marked
 * departed who is still being ticked in. No test can catch that, because the
 * code is behaving correctly and the data disagrees with itself.
 *
 * Exits non-zero when the two counts differ, so it can gate a deploy.
 */
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import { loadEmployeeRows } from "../lib/compliance/load";

config({ path: ".env.local" });

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set — see .env.example");

const today = new Date().toISOString().slice(0, 10);
const month = process.argv[2] ?? today.slice(0, 7);
const asOf = process.argv[3] ?? today;

type PersonCount = {
  id: number;
  display_name: string;
  office: string;
  status: string;
  present: number;
};

async function main() {
  const db = drizzle(neon(url!), { schema });

  const start = `${month}-01`;
  /** The first of the next month, so the range holds for any month length. */
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1))
    .toISOString()
    .slice(0, 10);

  /**
   * The register's own count, per person: in the office, on a required day, on
   * a day that has finished. Deliberately computed in SQL rather than through
   * any of the code under test.
   */
  const perPerson = (
    await db.execute(sql`
      select e.id, e.display_name, o.code as office, e.status, count(*)::int as present
      from attendance a
      join employees e on e.id = a.employee_id
      join offices o on o.id = e.office_id
      join calendar_days c on c.date = a.date
      where a.date >= ${start} and a.date < ${end}
        and a.state = 'PRESENT' and c.is_required_day and a.date < ${asOf}
      group by e.id, e.display_name, o.code, e.status
      order by o.code, e.display_name`)
  ).rows as PersonCount[];

  const rows = await loadEmployeeRows(db, month, asOf);
  const reportById = new Map(rows.map((row) => [row.employeeId, row]));

  const register = perPerson.reduce((n, p) => n + p.present, 0);
  const reported = rows.reduce((n, r) => n + r.monthly.attended, 0);

  console.log(`${month}, as at ${asOf}\n`);

  const byOffice = new Map<string, { register: number; report: number }>();
  for (const person of perPerson) {
    const entry = byOffice.get(person.office) ?? { register: 0, report: 0 };
    entry.register += person.present;
    entry.report += reportById.get(person.id)?.monthly.attended ?? 0;
    byOffice.set(person.office, entry);
  }

  for (const [office, counts] of [...byOffice].sort()) {
    const flag = counts.register === counts.report ? "ok" : "MISMATCH";
    console.log(
      `  ${office.padEnd(5)} register ${String(counts.register).padStart(4)}   ` +
        `report ${String(counts.report).padStart(4)}   ${flag}`,
    );
  }

  const disagreements = perPerson.filter(
    (person) => (reportById.get(person.id)?.monthly.attended ?? -1) !== person.present,
  );

  if (disagreements.length === 0) {
    console.log(`\nAll ${perPerson.length} people agree. Register and report both say ${register}.`);
    return;
  }

  console.log(`\n${disagreements.length} of ${perPerson.length} people disagree:\n`);
  for (const person of disagreements) {
    const row = reportById.get(person.id);
    console.log(
      `  ${person.office.padEnd(4)} ${person.display_name.padEnd(26)} ${person.status.padEnd(9)} ` +
        `register ${person.present}  ` +
        (row
          ? `report ${row.monthly.attended}/${row.monthly.required} ${row.monthly.verdict}`
          : `absent from the report entirely`),
    );
  }

  /**
   * Somebody marked departed who is still being ticked in is the likeliest
   * cause now that the rules are fixed, and it is a data question rather than
   * a code one - so name it rather than leaving a bare number.
   */
  const departed = disagreements.filter((person) => person.status === "DEPARTED");
  if (departed.length > 0) {
    console.log(
      `\n  ${departed.length} of them are marked DEPARTED but were ticked in. Either they\n` +
        `  have not left, or the register was kept for them by mistake. The report is\n` +
        `  right not to judge somebody who has left; the disagreement is in the data.`,
    );
  }

  console.log(`\nRegister says ${register}, report says ${reported}.`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
