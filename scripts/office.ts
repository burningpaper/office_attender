/**
 * Manage offices from the command line.
 *
 *   npm run office -- list
 *   npm run office -- add JHB "Johannesburg"
 *   npm run office -- close CT 2026-07-01 "Office closed"
 */
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, sql } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import { closeOffice, createOffice, listOffices } from "../lib/db/offices";

config({ path: ".env.local" });
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set — see .env.example");

const db = drizzle(neon(url), { schema });
const [command, ...args] = process.argv.slice(2);

async function main() {
  if (command === "add") {
    const [code, ...nameParts] = args;
    if (!code || nameParts.length === 0) {
      throw new Error('Usage: npm run office -- add <CODE> "<Name>"');
    }
    const office = await createOffice(db, code, nameParts.join(" "));
    console.log(`Office ${office.code} (${office.name}) is id ${office.id}.`);
    console.log(`Upload its workbook at /upload and pick "${office.name}".`);
    return;
  }

  if (command === "close") {
    const [code, date, ...labelParts] = args;
    if (!code || !date) throw new Error("Usage: npm run office -- close <CODE> <YYYY-MM-DD> [label]");
    const office = (await listOffices(db)).find((o) => o.code === code.toUpperCase());
    if (!office) throw new Error(`No office with code ${code}.`);
    await closeOffice(db, office.id, date, labelParts.join(" ") || "Office closed");
    console.log(`${office.name} is marked closed on ${date}. It counts against nobody there.`);
    return;
  }

  const offices = await listOffices(db);
  if (offices.length === 0) {
    console.log("No offices yet. Add one with: npm run office -- add CT \"Cape Town\"");
    return;
  }

  for (const office of offices) {
    const [{ people, active }] = await db
      .select({
        people: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${schema.employees.status} = 'ACTIVE')::int`,
      })
      .from(schema.employees)
      .where(eq(schema.employees.officeId, office.id));

    const closures = await db
      .select({ date: schema.officeClosures.date })
      .from(schema.officeClosures)
      .where(eq(schema.officeClosures.officeId, office.id));

    console.log(
      `  ${office.code.padEnd(5)} ${office.name.padEnd(18)} ${String(people).padStart(4)} people ` +
        `(${active} active)` +
        (closures.length ? `  closures: ${closures.map((c) => c.date).join(", ")}` : ""),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
