/**
 * Applying a staff list to an office.
 *
 * This is the replacement for parsing attendance out of a spreadsheet: upload
 * who works here, then keep the register in the app. The list decides three
 * things - who exists, who is still here, and what their address is.
 *
 * The importer has its own copy of this logic for legacy workbooks, where the
 * roster arrives alongside months of attendance and has to be reconciled with
 * it. This path is simpler because there is no attendance to reconcile, and the
 * two are expected to diverge rather than converge.
 */

import { eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as s from "../db/schema";
import { resolveIdentities } from "../import/resolve-identities";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type StaffPerson = { rawName: string; firstName: string; lastName: string; email: string | null };

export type StaffListResult = {
  /** People already on record, matched to this list. */
  matched: { displayName: string; email: string | null; via: string }[];
  /** People created because the list has them and the database did not. */
  created: { displayName: string; email: string | null }[];
  /** People marked as having left, because the list no longer has them. */
  departed: string[];
  /** People marked active again, having reappeared on the list. */
  returned: string[];
  /** Lines that could not be read as a person. */
  skipped: { line: string; reason: string }[];
};

export async function applyStaffList(
  db: Db,
  officeId: number,
  people: StaffPerson[],
  options: { dryRun?: boolean } = {},
): Promise<StaffListResult> {
  const dryRun = options.dryRun ?? false;

  const result: StaffListResult = {
    matched: [], created: [], departed: [], returned: [], skipped: [],
  };

  const existing = await db
    .select({
      id: s.employees.id,
      normalisedKey: s.employees.normalisedKey,
      displayName: s.employees.displayName,
      status: s.employees.status,
      email: s.employees.email,
    })
    .from(s.employees)
    .where(eq(s.employees.officeId, officeId));

  const aliasRows = await db
    .select({ rawName: s.employeeAliases.rawName, employeeId: s.employeeAliases.employeeId })
    .from(s.employeeAliases)
    .innerJoin(s.employees, eq(s.employees.id, s.employeeAliases.employeeId))
    .where(eq(s.employees.officeId, officeId));

  const knownAliases = new Map(
    aliasRows.map((a) => {
      const row = a as unknown as {
        employee_aliases?: { rawName: string; employeeId: number };
        rawName?: string;
        employeeId?: number;
      };
      return [
        row.employee_aliases?.rawName ?? row.rawName!,
        row.employee_aliases?.employeeId ?? row.employeeId!,
      ] as const;
    }),
  );

  const identities = resolveIdentities(
    people.map((p, index) => ({
      sheetName: "staff list",
      rowNumber: index + 2,
      firstName: p.firstName,
      lastName: p.lastName,
      rawName: p.rawName,
      standingNote: null,
      email: p.email,
    })),
    existing,
    knownAliases,
  );

  const emailByRawName = new Map(people.map((p) => [p.rawName, p.email]));
  const onList = new Set<number>();

  for (const identity of identities) {
    const email = emailByRawName.get(identity.rawName) ?? null;

    if (identity.employeeId !== undefined) {
      onList.add(identity.employeeId);
      const person = existing.find((e) => e.id === identity.employeeId);
      result.matched.push({
        displayName: person?.displayName ?? identity.displayName,
        email,
        via: identity.matchType,
      });

      if (!dryRun) {
        await db
          .insert(s.employeeAliases)
          .values({ rawName: identity.rawName, employeeId: identity.employeeId })
          .onConflictDoNothing();
        if (email && email !== person?.email) {
          await db
            .update(s.employees)
            .set({ email, updatedAt: new Date() })
            .where(eq(s.employees.id, identity.employeeId));
        }
      }
      continue;
    }

    result.created.push({ displayName: identity.displayName, email });

    if (!dryRun) {
      const [created] = await db
        .insert(s.employees)
        .values({
          officeId,
          firstName: identity.firstName,
          lastName: identity.lastName,
          displayName: identity.displayName,
          normalisedKey: identity.canonicalKey,
          email,
        })
        .onConflictDoUpdate({
          target: [s.employees.officeId, s.employees.normalisedKey],
          set: { updatedAt: new Date(), ...(email ? { email } : {}) },
        })
        .returning();
      onList.add(created.id);
      await db
        .insert(s.employeeAliases)
        .values({ rawName: identity.rawName, employeeId: created.id })
        .onConflictDoNothing();
    }
  }

  /**
   * The list is the definition of who works here, so anybody absent from it has
   * left. Unlike the spreadsheet path there is no attendance sheet to argue
   * with - this list is the only claim being made.
   */
  const gone = existing.filter((e) => !onList.has(e.id) && e.status !== "DEPARTED");
  const back = existing.filter((e) => onList.has(e.id) && e.status === "DEPARTED");

  result.departed = gone.map((e) => e.displayName);
  result.returned = back.map((e) => e.displayName);

  if (!dryRun) {
    if (gone.length) {
      await db
        .update(s.employees)
        .set({ status: "DEPARTED", updatedAt: new Date() })
        .where(inArray(s.employees.id, gone.map((e) => e.id)));
    }
    if (back.length) {
      await db
        .update(s.employees)
        .set({ status: "ACTIVE", updatedAt: new Date() })
        .where(inArray(s.employees.id, back.map((e) => e.id)));
    }
  }

  return result;
}
