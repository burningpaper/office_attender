/**
 * Prints what is actually in the database. Handy after a migrate or seed.
 *
 *   npm run db:status
 */
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";

config({ path: ".env.local" });

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set — see .env.example");

const sql = neon(url);

async function main() {
  const tables = await sql`select table_name from information_schema.tables
                           where table_schema = 'public' order by 1`;
  console.log("Tables:");
  for (const t of tables) console.log(`  ${t.table_name}`);

  const [{ n }] = (await sql`select count(*)::int as n from calendar_days`) as { n: number }[];
  console.log(`\ncalendar_days: ${n} rows`);

  const holidays = await sql`select date::text as date, day_type, is_required_day, label
                             from calendar_days
                             where label is not null
                               and date between '2026-01-01' and '2026-12-31'
                             order by date`;
  console.log("\n2026 public holidays as stored:");
  for (const h of holidays) {
    const flag = h.is_required_day ? "REQUIRED" : "excluded";
    console.log(`  ${h.date}  ${String(h.day_type).padEnd(14)} ${flag.padEnd(9)} ${h.label}`);
  }

  const perMonth = await sql`select to_char(date, 'YYYY-MM') as m, count(*)::int as n
                             from calendar_days
                             where is_required_day
                               and date between '2026-01-01' and '2026-12-31'
                             group by 1 order by 1`;
  console.log(
    "\nRequired days per month 2026: " +
      perMonth.map((r) => `${String(r.m).slice(5)}=${r.n}`).join("  "),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
