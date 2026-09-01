/**
 * The import pipeline: parse -> resolve -> classify -> diff -> commit.
 *
 * Two properties matter more than anything else here.
 *
 * Every upload is a full re-sync, not an append. The workbook carries all seven
 * months every time, and past months get edited - someone types "On leave" into
 * a cell for a date three weeks ago. Appending only new dates would silently
 * discard those corrections and let the app drift away from the spreadsheet
 * everyone else is reading.
 *
 * And nothing is written until the diff has been seen. `dryRun` produces the
 * whole report without touching a row, which is what the preview screen in
 * stage 7 will render.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { buildCalendar } from "../calendar/build-calendar";
import * as s from "../db/schema";
import { classifyCell } from "./classify-cell";
import { deriveExemption } from "./derive-exemptions";
import { parseWorkbook } from "./parse-workbook";
import { resolveIdentities, type ResolvedIdentity } from "./resolve-identities";
import type { ParseWarning } from "./types";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type ImportReport = {
  sha256: string;
  filename: string;
  /** True when this exact file has already been committed. */
  alreadyImported: boolean;
  uploadId?: number;
  dateRange: { start: string; end: string } | null;
  identities: {
    total: number;
    matchedExisting: number;
    created: number;
    bySimilarity: ResolvedIdentity[];
    needingReview: ResolvedIdentity[];
  };
  attendance: {
    inserted: number;
    changed: number;
    unchanged: number;
    /** Rows whose cell held free text rather than 0/1. */
    explained: number;
  };
  reasons: { distinct: number; created: number };
  exemptions: { created: number; needingReview: { name: string; note: string; reason: string }[] };
  warnings: ParseWarning[];
  committed: boolean;
};

export function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Make sure calendar_days covers every date the file mentions. */
async function ensureCalendarCoverage(db: Db, dates: string[]): Promise<void> {
  if (dates.length === 0) return;
  const years = [...new Set(dates.map((d) => Number(d.slice(0, 4))))];
  const rows = buildCalendar(Math.min(...years), Math.max(...years)).map((d) => ({
    date: d.date,
    dayType: d.dayType,
    isRequiredDay: d.isRequiredDay,
    label: d.label,
  }));

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(s.calendarDays)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoNothing();
  }
}

export async function importWorkbook(
  db: Db,
  buffer: Buffer,
  filename: string,
  options: { dryRun?: boolean } = {},
): Promise<ImportReport> {
  const dryRun = options.dryRun ?? false;
  const sha256 = hashBuffer(buffer);

  // An identical file is a no-op. Re-uploading must never duplicate anything.
  const existing = await db
    .select()
    .from(s.uploads)
    .where(and(eq(s.uploads.sha256, sha256), eq(s.uploads.status, "COMMITTED")))
    .limit(1);

  if (existing.length > 0) {
    return {
      sha256,
      filename,
      alreadyImported: true,
      uploadId: existing[0].id,
      dateRange: existing[0].dateRangeStart
        ? { start: existing[0].dateRangeStart, end: existing[0].dateRangeEnd! }
        : null,
      identities: { total: 0, matchedExisting: 0, created: 0, bySimilarity: [], needingReview: [] },
      attendance: { inserted: 0, changed: 0, unchanged: 0, explained: 0 },
      reasons: { distinct: 0, created: 0 },
      exemptions: { created: 0, needingReview: [] },
      warnings: [],
      committed: false,
    };
  }

  const parsed = parseWorkbook(buffer);
  const allDates = [...new Set(parsed.records.map((r) => r.date))].sort();
  const dateRange = allDates.length
    ? { start: allDates[0], end: allDates[allDates.length - 1] }
    : null;

  // --- Identity resolution against what the database already knows ---
  const knownEmployees = await db
    .select({
      id: s.employees.id,
      normalisedKey: s.employees.normalisedKey,
      displayName: s.employees.displayName,
    })
    .from(s.employees);

  const aliasRows = await db
    .select({ rawName: s.employeeAliases.rawName, employeeId: s.employeeAliases.employeeId })
    .from(s.employeeAliases);
  const knownAliases = new Map(aliasRows.map((a) => [a.rawName, a.employeeId]));

  const identities = resolveIdentities(parsed.employees, knownEmployees, knownAliases);

  // --- Classify every cell, and collect the distinct reason strings ---
  const classified = parsed.records.map((r) => ({
    ...r,
    ...classifyCell(r.rawValue),
  }));
  const distinctReasons = [
    ...new Set(classified.filter((c) => c.reasonText).map((c) => c.reasonText!)),
  ].sort();

  const report: ImportReport = {
    sha256,
    filename,
    alreadyImported: false,
    dateRange,
    identities: {
      total: identities.length,
      matchedExisting: identities.filter((i) => i.employeeId !== undefined).length,
      created: new Set(
        identities.filter((i) => i.employeeId === undefined).map((i) => i.canonicalKey),
      ).size,
      bySimilarity: identities.filter((i) => i.matchType === "SIMILARITY"),
      needingReview: identities.filter((i) => i.needsReview),
    },
    attendance: { inserted: 0, changed: 0, unchanged: 0, explained: 0 },
    reasons: { distinct: distinctReasons.length, created: 0 },
    exemptions: { created: 0, needingReview: [] },
    warnings: parsed.warnings,
    committed: false,
  };

  if (dryRun) {
    report.attendance.explained = classified.filter((c) => c.reasonText).length;
    return report;
  }

  // -------------------------------------------------------------------------
  // Commit
  // -------------------------------------------------------------------------

  await ensureCalendarCoverage(db, allDates);

  const [upload] = await db
    .insert(s.uploads)
    .values({
      filename,
      sha256,
      status: "PENDING",
      dateRangeStart: dateRange?.start,
      dateRangeEnd: dateRange?.end,
      warnings: parsed.warnings,
    })
    .returning();
  report.uploadId = upload.id;

  /**
   * Employees: create one per canonical key, then point every spelling at it.
   *
   * Grouping by canonical key rather than by row is what makes two spellings
   * arriving in the same file - "Zakiya Karim" and "Zakiyya Karim" - become a
   * single employee. Neither has a database id when the resolver runs, so the
   * key is the only thing that can link them.
   */
  const idByCanonicalKey = new Map<string, number>();
  for (const identity of identities) {
    if (identity.employeeId !== undefined) {
      idByCanonicalKey.set(identity.canonicalKey, identity.employeeId);
    }
  }

  const idByRawName = new Map<string, number>();
  for (const identity of identities) {
    let employeeId = idByCanonicalKey.get(identity.canonicalKey);

    if (employeeId === undefined) {
      const [created] = await db
        .insert(s.employees)
        .values({
          firstName: identity.firstName,
          lastName: identity.lastName,
          displayName: identity.displayName,
          normalisedKey: identity.canonicalKey,
        })
        .onConflictDoUpdate({
          target: s.employees.normalisedKey,
          set: { updatedAt: new Date() },
        })
        .returning();
      employeeId = created.id;
      idByCanonicalKey.set(identity.canonicalKey, employeeId);
    }

    idByRawName.set(identity.rawName, employeeId);

    await db
      .insert(s.employeeAliases)
      .values({ rawName: identity.rawName, employeeId, sourceUploadId: upload.id })
      .onConflictDoNothing();
  }

  /**
   * Exemptions from the standing-note column. Only notes that clearly excuse
   * the required days become active exemptions - a work-from-home approval
   * naming Thursday is recorded but does not exempt anyone, because Thursday is
   * not a day anyone is required in.
   */
  const notesByRawName = new Map<string, string>();
  for (const row of parsed.employees) {
    if (row.standingNote) notesByRawName.set(row.rawName, row.standingNote);
  }

  for (const [rawName, note] of notesByRawName) {
    const employeeId = idByRawName.get(rawName);
    if (employeeId === undefined) continue;

    const derived = deriveExemption(note);
    if (!derived) continue;

    const existing = await db
      .select()
      .from(s.exemptions)
      .where(and(eq(s.exemptions.employeeId, employeeId), eq(s.exemptions.rawText, derived.rawText)))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(s.exemptions).values({
        employeeId,
        type: derived.type,
        rawText: derived.rawText,
        active: derived.exempts,
      });
      report.exemptions.created++;
    }

    if (derived.reviewReason) {
      report.exemptions.needingReview.push({
        name: rawName,
        note: derived.rawText,
        reason: derived.reviewReason,
      });
    }
  }

  // Reasons: one row per distinct string, categorised as UNKNOWN until stage 5.
  const reasonIdByText = new Map<string, number>();
  if (distinctReasons.length > 0) {
    const before = await db.select({ id: s.reasons.id, rawText: s.reasons.rawText }).from(s.reasons);
    const beforeCount = before.length;

    for (const text of distinctReasons) {
      await db
        .insert(s.reasons)
        .values({ rawText: text, category: "UNKNOWN", normalisedText: text })
        .onConflictDoNothing();
    }

    const after = await db
      .select({ id: s.reasons.id, rawText: s.reasons.rawText })
      .from(s.reasons)
      .where(inArray(s.reasons.rawText, distinctReasons));
    for (const r of after) reasonIdByText.set(r.rawText, r.id);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(s.reasons);
    report.reasons.created = total - beforeCount;
  }

  // Attendance: full re-sync over the range this file covers.
  const employeeIds = [...new Set(idByRawName.values())];
  const currentRows = employeeIds.length
    ? await db
        .select({
          employeeId: s.attendance.employeeId,
          date: s.attendance.date,
          state: s.attendance.state,
        })
        .from(s.attendance)
        .where(inArray(s.attendance.employeeId, employeeIds))
    : [];
  const currentState = new Map(
    currentRows.map((r) => [`${r.employeeId}|${r.date}`, r.state]),
  );

  /**
   * Duplicate names on one sheet are merged with attendance winning: a person
   * listed twice is present if either row says so.
   */
  const merged = new Map<string, (typeof classified)[number]>();
  for (const record of classified) {
    const employeeId = idByRawName.get(record.rawName);
    if (employeeId === undefined) continue;
    const key = `${employeeId}|${record.date}`;
    const existingRecord = merged.get(key);
    if (!existingRecord || rank(record.state) > rank(existingRecord.state)) {
      merged.set(key, record);
    }
  }

  const historyRows: (typeof s.attendanceHistory.$inferInsert)[] = [];
  const attendanceRows: (typeof s.attendance.$inferInsert)[] = [];

  for (const [key, record] of merged) {
    const [employeeIdText, date] = key.split("|");
    const employeeId = Number(employeeIdText);
    const previous = currentState.get(key);

    if (previous === undefined) report.attendance.inserted++;
    else if (previous !== record.state) report.attendance.changed++;
    else report.attendance.unchanged++;

    if (record.reasonText) report.attendance.explained++;

    attendanceRows.push({
      employeeId,
      date,
      state: record.state,
      rawValue: record.rawValue,
      reasonId: record.reasonText ? reasonIdByText.get(record.reasonText) : null,
      sourceUploadId: upload.id,
    });

    if (previous !== record.state) {
      historyRows.push({
        employeeId,
        date,
        oldState: previous ?? null,
        newState: record.state,
        uploadId: upload.id,
      });
    }
  }

  const CHUNK = 500;
  for (let i = 0; i < attendanceRows.length; i += CHUNK) {
    await db
      .insert(s.attendance)
      .values(attendanceRows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [s.attendance.employeeId, s.attendance.date],
        set: {
          state: sql`excluded.state`,
          rawValue: sql`excluded.raw_value`,
          reasonId: sql`excluded.reason_id`,
          sourceUploadId: sql`excluded.source_upload_id`,
          updatedAt: new Date(),
        },
      });
  }
  for (let i = 0; i < historyRows.length; i += CHUNK) {
    await db.insert(s.attendanceHistory).values(historyRows.slice(i, i + CHUNK));
  }

  // Employment windows, derived from where each person appears in the sheets.
  await db.execute(sql`
    update employees e
    set first_seen_date = w.first_seen,
        last_seen_date  = w.last_seen,
        updated_at      = now()
    from (
      select employee_id, min(date) as first_seen, max(date) as last_seen
      from attendance group by employee_id
    ) w
    where w.employee_id = e.id
  `);

  await db
    .update(s.uploads)
    .set({ status: "COMMITTED", stats: report.attendance })
    .where(eq(s.uploads.id, upload.id));

  report.committed = true;
  return report;
}

/** Attendance beats an explanation, which beats a plain absence. */
function rank(state: string): number {
  if (state === "PRESENT") return 3;
  if (state === "ABSENT_EXPLAINED") return 2;
  return 1;
}
