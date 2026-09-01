/**
 * Database client for the running app.
 *
 * Uses the pooled (pgbouncer) endpoint - right for the app's short queries.
 * Migrations and seeds use the unpooled endpoint instead; see drizzle.config.ts.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.",
  );
}

export const db = drizzle(neon(url), { schema });
export { schema };
