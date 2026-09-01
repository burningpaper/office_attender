/**
 * A real Postgres, in-process.
 *
 * PGlite runs actual Postgres compiled to WASM, so constraint behaviour,
 * enums and foreign keys are the genuine article rather than a mock. That
 * means these tests can prove the schema holds without a network round trip
 * or anyone's credentials.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as schema from "../schema";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../drizzle");

export async function freshDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  // Apply the generated migrations exactly as production will receive them.
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sqlText = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of sqlText.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }

  return { db, client, migrationCount: files.length };
}

/**
 * Postgres error codes worth naming.
 * Drizzle wraps driver errors in a "Failed query: ..." Error, so the real
 * SQLSTATE lives on the cause. Asserting the code beats matching prose.
 */
export const PG = {
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  INVALID_ENUM_VALUE: "22P02",
} as const;

/** The SQLSTATE of a thrown query error, unwrapping Drizzle's wrapper. */
export function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Assert a query fails with a specific Postgres constraint violation. */
export async function expectPgError(
  promise: Promise<unknown> | (() => Promise<unknown>),
  code: (typeof PG)[keyof typeof PG],
): Promise<void> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    const actual = pgCode(error);
    if (actual !== code) {
      throw new Error(`Expected Postgres error ${code}, got ${actual ?? "none"}: ${String(error)}`);
    }
    return;
  }
  throw new Error(`Expected Postgres error ${code}, but the query succeeded.`);
}

/**
 * Import a workbook, answering every blocking question with "leave it as it
 * is".
 *
 * Stage 7 added a gate: nothing is written while a question the importer
 * raised is unanswered. Tests that are about something else - identity
 * resolution, compliance maths - still have to get past it, and declining
 * every proposal is the option that changes no data.
 */
export async function importDeclining(
  db: Parameters<typeof import("../../import/import-workbook").importWorkbook>[0],
  buffer: Buffer,
  filename: string,
  asOf = "2026-09-01",
) {
  const { importWorkbook } = await import("../../import/import-workbook");
  const preview = await importWorkbook(db, buffer, filename, { dryRun: true, asOf });
  const resolutions = preview.anomalies
    .filter((a) => a.blocking)
    .map((a) => ({ id: a.id, accept: false }));
  return importWorkbook(db, buffer, filename, { resolutions, asOf });
}
