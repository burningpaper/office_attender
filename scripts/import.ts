/**
 * Imports a workbook into the real database.
 *
 *   npm run db:import -- data_example.xls.xlsx          # commits
 *   npm run db:import -- data_example.xls.xlsx --dry-run # reports only
 */
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../lib/db/schema";
import { importWorkbook } from "../lib/import/import-workbook";

config({ path: ".env.local" });

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set — see .env.example");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--"));
if (!file) throw new Error("Usage: npm run db:import -- <file.xlsx> [--dry-run]");

async function main() {
  const db = drizzle(neon(url!), { schema });
  const report = await importWorkbook(db, readFileSync(file!), file!, { dryRun });

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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
