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

import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as s from "../db/schema";
import { splitName } from "../import/normalise-name";
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

/**
 * Taking one person off the register.
 *
 * Two different things get confused here, so they are separate actions:
 *
 *   Leaving   - they have gone. They vanish from the register and every
 *               report, and their history is kept.
 *   Untracked - they are still here but the attendance policy does not apply:
 *               permanently remote, seconded elsewhere, on parental leave.
 *               They stay on the register so a visit can still be recorded,
 *               but count towards nothing and are never emailed.
 *
 * Both are reversible, which matters - somebody comes back from leave, or a
 * secondment ends, and neither should need a spreadsheet re-upload to fix.
 */
export type PersonAction = "LEAVE" | "RESTORE" | "UNTRACK" | "TRACK";

export async function updatePerson(
  db: Db,
  officeId: number,
  employeeId: number,
  action: PersonAction,
  reason?: string,
): Promise<{ displayName: string; status: string; untracked: boolean }> {
  const [person] = await db
    .select({ id: s.employees.id, displayName: s.employees.displayName })
    .from(s.employees)
    .where(eq(s.employees.id, employeeId));

  if (!person) throw new Error("No such person.");

  const [check] = await db
    .select({ officeId: s.employees.officeId })
    .from(s.employees)
    .where(eq(s.employees.id, employeeId));
  if (check.officeId !== officeId) throw new Error("That person is not in this office.");

  if (action === "LEAVE" || action === "RESTORE") {
    await db
      .update(s.employees)
      .set({ status: action === "LEAVE" ? "DEPARTED" : "ACTIVE", updatedAt: new Date() })
      .where(eq(s.employees.id, employeeId));
  }

  if (action === "UNTRACK") {
    const text = reason?.trim() || "Not tracked";
    const [existing] = await db
      .select({ id: s.exemptions.id })
      .from(s.exemptions)
      .where(and(eq(s.exemptions.employeeId, employeeId), eq(s.exemptions.rawText, text)));

    if (existing) {
      await db
        .update(s.exemptions)
        .set({ active: true })
        .where(eq(s.exemptions.id, existing.id));
    } else {
      await db.insert(s.exemptions).values({
        employeeId,
        type: "OTHER",
        rawText: text,
        active: true,
        effectiveFrom: new Date().toISOString().slice(0, 10),
      });
    }
  }

  if (action === "TRACK") {
    /**
     * Ends every exemption rather than the newest, because somebody can have
     * collected more than one over time - a standing note from a spreadsheet
     * and a later manual one - and leaving any active would keep them hidden.
     */
    await db
      .update(s.exemptions)
      .set({ active: false, effectiveTo: new Date().toISOString().slice(0, 10) })
      .where(eq(s.exemptions.employeeId, employeeId));
  }

  const [after] = await db
    .select({ status: s.employees.status })
    .from(s.employees)
    .where(eq(s.employees.id, employeeId));

  const active = await db
    .select({ id: s.exemptions.id })
    .from(s.exemptions)
    .where(and(eq(s.exemptions.employeeId, employeeId), eq(s.exemptions.active, true)));

  return {
    displayName: person.displayName,
    status: after.status,
    untracked: active.length > 0,
  };
}

/** Everybody in an office, with enough to render the roster screen. */
export async function listPeople(db: Db, officeId: number) {
  const people = await db
    .select({
      id: s.employees.id,
      displayName: s.employees.displayName,
      email: s.employees.email,
      status: s.employees.status,
    })
    .from(s.employees)
    .where(eq(s.employees.officeId, officeId))
    .orderBy(s.employees.displayName);

  const exemptions = await db
    .select({
      employeeId: s.exemptions.employeeId,
      rawText: s.exemptions.rawText,
      type: s.exemptions.type,
    })
    .from(s.exemptions)
    .where(eq(s.exemptions.active, true));

  const byEmployee = new Map(exemptions.map((e) => [e.employeeId, e.rawText ?? e.type]));

  return people.map((p) => ({
    ...p,
    untrackedReason: byEmployee.get(p.id) ?? null,
  }));
}

/**
 * Add one person, without re-uploading the whole list.
 *
 * Matched the same way an uploaded list is, so typing a name that already
 * exists in a different spelling finds the person rather than making a second
 * one. Somebody previously marked as having left comes back rather than being
 * duplicated.
 */
export async function addPerson(
  db: Db,
  officeId: number,
  input: { name: string; email?: string | null },
): Promise<{ id: number; displayName: string; created: boolean; restored: boolean }> {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name) throw new Error("A name is required.");

  const email = input.email?.trim().toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new Error(`That does not look like an email address: ${email}`);
  }

  const { first, last } = splitName(name, "");
  const result = await applyStaffListAdditive(db, officeId, [
    { rawName: name, firstName: first, lastName: last, email },
  ]);

  return result;
}

/**
 * Add or match one person, touching nobody else.
 *
 * Deliberately not applyStaffList: that treats the list as the whole truth and
 * marks everybody absent from it as departed, which is catastrophic if what you
 * meant was "and also this person".
 */
async function applyStaffListAdditive(
  db: Db,
  officeId: number,
  people: StaffPerson[],
): Promise<{ id: number; displayName: string; created: boolean; restored: boolean }> {
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

  const [identity] = resolveIdentities(
    people.map((p, index) => ({
      sheetName: "added by hand",
      rowNumber: index + 1,
      firstName: p.firstName,
      lastName: p.lastName,
      rawName: p.rawName,
      standingNote: null,
      email: p.email,
    })),
    existing,
    knownAliases,
  );

  const email = people[0].email;

  if (identity.employeeId !== undefined) {
    const person = existing.find((e) => e.id === identity.employeeId)!;
    const restored = person.status === "DEPARTED";

    await db
      .update(s.employees)
      .set({
        status: "ACTIVE",
        ...(email ? { email } : {}),
        updatedAt: new Date(),
      })
      .where(eq(s.employees.id, identity.employeeId));

    await db
      .insert(s.employeeAliases)
      .values({ rawName: identity.rawName, employeeId: identity.employeeId })
      .onConflictDoNothing();

    return { id: identity.employeeId, displayName: person.displayName, created: false, restored };
  }

  const [created] = await db
    .insert(s.employees)
    .values({
      officeId,
      firstName: identity.firstName,
      lastName: identity.lastName,
      displayName: identity.displayName,
      normalisedKey: identity.canonicalKey,
      email,
      /**
       * Joined today, so they are not judged on days before somebody added
       * them. Without this the four people created from a staff list read as
       * absent for every day of a month they were not yet on record for.
       */
      firstSeenDate: new Date().toISOString().slice(0, 10),
    })
    .returning();

  await db
    .insert(s.employeeAliases)
    .values({ rawName: identity.rawName, employeeId: created.id })
    .onConflictDoNothing();

  return { id: created.id, displayName: created.displayName, created: true, restored: false };
}
