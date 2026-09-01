/**
 * Prints the compliance report from the command line.
 *
 *   npm run report -- 2026-08            # as at the end of that month
 *   npm run report -- 2026-09 2026-09-01 # as at a specific day
 */
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../lib/db/schema";
import { loadEmployeeRows } from "../lib/compliance/load";
import { VERDICT_ORDER } from "../lib/compliance/rules";

config({ path: ".env.local" });
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set");

const month = process.argv[2] ?? "2026-09";
const asOf = process.argv[3] ?? `${month}-28`;

function cell(r: { verdict: string; attended: number; required: number; excused: number }) {
  if (r.verdict === "EXEMPT") return "EXEMPT";
  if (r.verdict === "NA") return "—";
  return `${r.verdict} ${r.attended}/${r.required}` + (r.excused ? ` (+${r.excused}ex)` : "");
}

/**
 * Long term is two separate averages, not a total, so showing "37/36" invites
 * exactly the wrong reading - someone can clear the total and still fail on
 * Fridays. Show the two numbers the rule actually tests.
 */
function longTermCell(r: {
  verdict: string; wednesdayAverage: number; fridayAverage: number; monthsCounted: number;
}) {
  if (r.verdict === "EXEMPT") return "EXEMPT";
  if (r.verdict === "NA") return `— (${r.monthsCounted}mo)`;
  return `${r.verdict} ${r.wednesdayAverage.toFixed(1)}W/${r.fridayAverage.toFixed(1)}F`;
}

async function main() {
  const db = drizzle(neon(url!), { schema });
  const rows = await loadEmployeeRows(db, month, asOf);

  const visible = rows.filter((r) => !r.isExempt);
  visible.sort(
    (a, b) =>
      VERDICT_ORDER[a.monthly.verdict] - VERDICT_ORDER[b.monthly.verdict] ||
      a.displayName.localeCompare(b.displayName),
  );

  console.log(`\nCompliance for ${month}, as at ${asOf}`);
  console.log(`${visible.length} shown · ${rows.length - visible.length} exempt hidden\n`);
  console.log(
    "  " + "Name".padEnd(26) + "This month".padEnd(16) + "Two week".padEnd(14) +
    "Long term".padEnd(16) + "Last attended",
  );
  console.log("  " + "-".repeat(84));
  for (const r of visible) {
    console.log(
      "  " + r.displayName.slice(0, 25).padEnd(26) +
      cell(r.monthly).padEnd(16) + cell(r.twoWeek).padEnd(14) +
      longTermCell(r.longTerm).padEnd(16) + (r.lastAttended ?? "Never"),
    );
  }

  const tally = (key: "monthly" | "twoWeek" | "longTerm") => {
    const t: Record<string, number> = {};
    for (const r of rows) t[r[key].verdict] = (t[r[key].verdict] ?? 0) + 1;
    return t;
  };
  console.log("\n  monthly:  ", tally("monthly"));
  console.log("  two week: ", tally("twoWeek"));
  console.log("  long term:", tally("longTerm"));
}

main().catch((e) => { console.error(e); process.exit(1); });
