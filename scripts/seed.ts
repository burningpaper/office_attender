/**
 * Seeds the calendar into the real database.
 *
 * Runs over the unpooled connection, and is safe to re-run: days a human has
 * ruled on are never overwritten.
 *
 *   npm run db:seed
 */
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { seedCalendar } from "../lib/db/seed-calendar";
import * as schema from "../lib/db/schema";

config({ path: ".env.local" });

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set — see .env.example");

const START_YEAR = 2025;
const END_YEAR = 2027;

async function main() {
  const db = drizzle(neon(url!), { schema });
  const count = await seedCalendar(db, START_YEAR, END_YEAR);
  console.log(`Seeded ${count} calendar days (${START_YEAR}–${END_YEAR}).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
