/**
 * Imports a workbook into the real database.
 *
 *   npm run db:import -- --office JHB roster.xlsx            # commits
 *   npm run db:import -- --office JHB roster.xlsx --dry-run  # reports only
 *
 * The office is required whenever more than one exists, and that is a guard
 * rather than pedantry. `importWorkbook` scopes everything it touches to one
 * office and, left to itself, falls back to the lowest id - which is Cape Town.
 * A Johannesburg roster imported under that default would have created 248
 * Johannesburg people in Cape Town and then marked every real Cape Town
 * employee as departed, because a roster is authoritative about who works
 * somewhere and nobody from Cape Town appears on a Johannesburg sheet.
 *
 * Nothing about the file says which office it belongs to - this one is named
 * "johannesburg staff list.xlsx" and holds a Location column reading
 * Johannesburg 248 times, and neither is something to bet a database on. So
 * the person running the command says, out loud, every time.
 */
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { asc, eq } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import * as s from "../lib/db/schema";
import { importWorkbook } from "../lib/import/import-workbook";

config({ path: ".env.local" });

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set — see .env.example");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const officeFlag = args.indexOf("--office");
const officeCode = officeFlag >= 0 ? args[officeFlag + 1] : undefined;
if (officeFlag >= 0 && (!officeCode || officeCode.startsWith("--"))) {
  throw new Error("--office needs a code, e.g. --office JHB");
}

/** The file is the one argument that is not a flag or a flag's value. */
const file = args.find(
  (arg, i) => !arg.startsWith("--") && !(officeFlag >= 0 && i === officeFlag + 1),
);
if (!file) {
  throw new Error("Usage: npm run db:import -- [--office CODE] <file.xlsx> [--dry-run]");
}

async function main() {
  const db = drizzle(neon(url!), { schema });

  const offices = await db
    .select({ id: s.offices.id, code: s.offices.code, name: s.offices.name })
    .from(s.offices)
    .orderBy(asc(s.offices.id));

  if (offices.length === 0) throw new Error("No office exists to import into. Create one first.");

  const listing = offices.map((o) => `${o.code} (${o.name})`).join(", ");

  let officeId: number | undefined;
  if (officeCode) {
    const match = offices.find((o) => o.code.toLowerCase() === officeCode.toLowerCase());
    if (!match) throw new Error(`No office with code "${officeCode}". Known offices: ${listing}`);
    officeId = match.id;
  } else if (offices.length > 1) {
    throw new Error(
      `This database has ${offices.length} offices, so --office is required.\n` +
        `  Known offices: ${listing}\n` +
        `  e.g. npm run db:import -- --office JHB "${file}"`,
    );
  } else {
    officeId = offices[0].id;
  }

  const office = offices.find((o) => o.id === officeId)!;
  const before = await db
    .select({ id: s.employees.id })
    .from(s.employees)
    .where(eq(s.employees.officeId, office.id));

  console.log(
    `${dryRun ? "DRY RUN" : "Importing"} into ${office.name} (${office.code}), ` +
      `which currently holds ${before.length} ${before.length === 1 ? "person" : "people"}.\n`,
  );

  const report = await importWorkbook(db, readFileSync(file!), file!, { dryRun, officeId });

  if (report.alreadyImported) {
    console.log(`Already imported (upload #${report.uploadId}). Nothing to do.`);
    return;
  }

  console.log(`${dryRun ? "DRY RUN" : "Imported"} ${report.filename}`);
  console.log(`  range        ${report.dateRange?.start} → ${report.dateRange?.end}`);
  console.log(`  identities   ${report.identities.total} names → ${report.identities.created} people`);
  console.log(`  attendance   ${report.attendance.inserted} new, ${report.attendance.changed} changed, ${report.attendance.unchanged} unchanged`);
  console.log(`  explained    ${report.attendance.explained} absences with a reason`);
  console.log(`  reasons      ${report.reasons.distinct} distinct strings`);
  console.log(`  exemptions   ${report.exemptions.created} derived from standing notes`);

  const roster = report.people.addedFromRoster;
  if (roster.length) {
    console.log(`\n  Added from the staff roster (${roster.length}):`);
    for (const name of roster.slice(0, 10)) console.log(`    • ${name}`);
    if (roster.length > 10) console.log(`    … and ${roster.length - 10} more`);
  }

  /**
   * Departures get their own heading and a full list. A roster that is missing
   * people reads as a roster of leavers, and that is the one outcome here
   * nobody would want to discover a month later.
   */
  const departed = report.people.departed;
  if (departed.length) {
    console.log(`\n  Marked as departed (${departed.length}):`);
    for (const person of departed) {
      console.log(`    • ${person.displayName} (last seen ${person.lastSeenDate ?? "never"})`);
    }
  }

  if (report.exemptions.needingReview.length) {
    console.log(`\n  Exemptions to confirm (${report.exemptions.needingReview.length}):`);
    for (const e of report.exemptions.needingReview) {
      console.log(`    • ${e.name} — ${e.reason}`);
    }
  }

  if (report.identities.needingReview.length) {
    console.log(`\n  Needs review (${report.identities.needingReview.length}):`);
    for (const r of report.identities.needingReview) {
      console.log(`    • ${r.rawName} — ${r.reviewReason}`);
    }
  }

  const byCode = new Map<string, number>();
  for (const w of report.warnings) byCode.set(w.code, (byCode.get(w.code) ?? 0) + 1);
  if (byCode.size) {
    console.log(`\n  Parser warnings:`);
    for (const [code, n] of byCode) console.log(`    ${code}: ${n}`);
  }

  if (dryRun) console.log(`\nNothing was written. Re-run without --dry-run to commit.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
