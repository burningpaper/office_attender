/**
 * Reading and creating offices.
 *
 * Small enough not to need a service layer, but it lives here so pages and
 * route handlers agree on what "the current office" means.
 */

import { asc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as s from "./schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type Office = { id: number; code: string; name: string };

export async function listOffices(db: Db): Promise<Office[]> {
  return db
    .select({ id: s.offices.id, code: s.offices.code, name: s.offices.name })
    .from(s.offices)
    .orderBy(asc(s.offices.code));
}

/**
 * Work out which office a request means.
 *
 * Falls back to the first office rather than to "all", because the two views
 * that use this - the report and the emailer - are both safer scoped. An
 * emailer that quietly defaulted to every office would be one careless click
 * from mailing two cities at once.
 */
export async function resolveOffice(
  db: Db,
  requested: string | undefined,
): Promise<Office | null> {
  const offices = await listOffices(db);
  if (offices.length === 0) return null;

  if (requested) {
    const byId = Number(requested);
    const match = offices.find(
      (o) => o.code.toLowerCase() === requested.toLowerCase() || o.id === byId,
    );
    if (match) return match;
  }

  return offices[0];
}

export async function createOffice(
  db: Db,
  code: string,
  name: string,
): Promise<Office> {
  const [office] = await db
    .insert(s.offices)
    .values({ code: code.trim().toUpperCase(), name: name.trim() })
    .onConflictDoUpdate({ target: s.offices.code, set: { name: name.trim() } })
    .returning({ id: s.offices.id, code: s.offices.code, name: s.offices.name });
  return office;
}

/**
 * Change an office's code or name.
 *
 * Safe at any time: everything else refers to offices by id, so renaming does
 * not move a single employee or attendance row.
 */
export async function renameOffice(
  db: Db,
  currentCode: string,
  next: { code?: string; name?: string },
): Promise<Office | null> {
  const [office] = await db
    .update(s.offices)
    .set({
      ...(next.code ? { code: next.code.trim().toUpperCase() } : {}),
      ...(next.name ? { name: next.name.trim() } : {}),
    })
    .where(eq(s.offices.code, currentCode.trim().toUpperCase()))
    .returning({ id: s.offices.id, code: s.offices.code, name: s.offices.name });
  return office ?? null;
}

/** Mark a day as closed for one office. */
export async function closeOffice(
  db: Db,
  officeId: number,
  date: string,
  label = "Office closed",
): Promise<void> {
  await db
    .insert(s.officeClosures)
    .values({ officeId, date, label, confirmedByHuman: true })
    .onConflictDoUpdate({
      target: [s.officeClosures.officeId, s.officeClosures.date],
      set: { label, confirmedByHuman: true },
    });
}

export { eq };
