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
import { detectAnomalies, isResolved, type Anomaly, type AnomalyResolution } from "./anomalies";
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
  /** Things a person must rule on before this can be committed. */
  anomalies: Anomaly[];
  /** Set when a commit was refused because a blocking anomaly was unanswered. */
  blockedBy?: string[];
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

  // 6 columns per row, well inside Postgres's 65,535 parameter ceiling.
  const CHUNK = 2000;
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
  options: { dryRun?: boolean; resolutions?: AnomalyResolution[]; asOf?: string } = {},
): Promise<ImportReport> {
  const dryRun = options.dryRun ?? false;
  const resolutions = options.resolutions ?? [];
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);
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
      anomalies: [],
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

  /**
   * Standing notes are read before anything is written, so the preview can show
   * which ones will not exempt anybody and why.
   */
  const exemptionsToConfirm: { name: string; note: string; reason: string }[] = [];
  const notesSeen = new Set<string>();
  for (const row of parsed.employees) {
    if (!row.standingNote || notesSeen.has(row.rawName)) continue;
    notesSeen.add(row.rawName);
    const derived = deriveExemption(row.standingNote);
    if (derived?.reviewReason) {
      exemptionsToConfirm.push({
        name: row.rawName,
        note: derived.rawText,
        reason: derived.reviewReason,
      });
    }
  }

  const calendarRows = await db
    .select({
      date: s.calendarDays.date,
      isRequiredDay: s.calendarDays.isRequiredDay,
      label: s.calendarDays.label,
      dayType: s.calendarDays.dayType,
      confirmedByHuman: s.calendarDays.confirmedByHuman,
    })
    .from(s.calendarDays);

  const anomalies = detectAnomalies({
    records: parsed.records,
    annotations: parsed.annotations,
    warnings: parsed.warnings,
    calendar: calendarRows,
    alreadyConfirmedDates: new Set(
      calendarRows.filter((c) => c.confirmedByHuman).map((c) => c.date),
    ),
    asOf,
    unresolvedNames: identities
      .filter((i) => i.needsReview)
      .map((i) => ({ rawName: i.rawName, reason: i.reviewReason ?? "" })),
    exemptionsToConfirm,
  });

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
    exemptions: { created: 0, needingReview: exemptionsToConfirm },
    anomalies,
    warnings: parsed.warnings,
    committed: false,
  };

  if (dryRun) {
    report.attendance.explained = classified.filter((c) => c.reasonText).length;

    /**
     * Work out what would actually change, so the preview can say "47 new, 3
     * changed" rather than just "here is a file". For a re-upload carrying
     * corrections, that difference is the entire reason to look at a preview.
     *
     * Employees who do not exist yet obviously have nothing to compare against,
     * so everything of theirs counts as new.
     */
    const knownIdByRawName = new Map<string, number>();
    for (const identity of identities) {
      if (identity.employeeId !== undefined) {
        knownIdByRawName.set(identity.rawName, identity.employeeId);
      }
    }

    const knownIds = [...new Set(knownIdByRawName.values())];
    const currentRows = knownIds.length
      ? await db
          .select({
            employeeId: s.attendance.employeeId,
            date: s.attendance.date,
            state: s.attendance.state,
          })
          .from(s.attendance)
          .where(inArray(s.attendance.employeeId, knownIds))
      : [];
    const currentState = new Map(currentRows.map((r) => [`${r.employeeId}|${r.date}`, r.state]));

    const seen = new Set<string>();
    for (const record of classified) {
      const employeeId = knownIdByRawName.get(record.rawName);
      const key = employeeId === undefined ? `new|${record.rawName}|${record.date}` : `${employeeId}|${record.date}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const previous = employeeId === undefined ? undefined : currentState.get(key);
      if (previous === undefined) report.attendance.inserted++;
      else if (previous !== record.state) report.attendance.changed++;
      else report.attendance.unchanged++;
    }

    return report;
  }

  // -------------------------------------------------------------------------
  // Commit
  // -------------------------------------------------------------------------

  /**
   * The gate. Nothing is written while a question the importer raised is still
   * unanswered - a compliance report built on a silent guess is worse than no
   * report at all.
   */
  if (!isResolved(anomalies, resolutions)) {
    const answered = new Set(resolutions.map((r) => r.id));
    report.blockedBy = anomalies
      .filter((a) => a.blocking && !answered.has(a.id))
      .map((a) => a.title);
    return report;
  }

  /**
   * A confirmed date column changes what the file says, so the workbook is read
   * again with those confirmations applied. Only done when there is something to
   * apply - parsing is not free.
   */
  const accepted = new Set(resolutions.filter((r) => r.accept).map((r) => r.id));
  const confirmedDateColumns: Record<string, string> = {};
  for (const anomaly of anomalies) {
    if (anomaly.kind !== "UNREADABLE_DATE_COLUMN" || !anomaly.date) continue;
    if (!accepted.has(anomaly.id)) continue;
    const [, sheetName, column] = anomaly.id.split(":");
    confirmedDateColumns[`${sheetName}:${column}`] = anomaly.date;
  }

  const finalParse = Object.keys(confirmedDateColumns).length
    ? parseWorkbook(buffer, { confirmedDateColumns })
    : parsed;

  const finalClassified = finalParse.records.map((r) => ({ ...r, ...classifyCell(r.rawValue) }));
  const finalDates = [...new Set(finalParse.records.map((r) => r.date))].sort();
  const finalDistinctReasons = [
    ...new Set(finalClassified.filter((c) => c.reasonText).map((c) => c.reasonText!)),
  ].sort();

  await ensureCalendarCoverage(db, finalDates);

  /**
   * Apply the decisions before importing attendance, so the calendar is already
   * correct when compliance is next computed. A confirmed closure is stamped
   * confirmedByHuman so no future re-seed or re-import quietly reverts it.
   */
  for (const anomaly of anomalies) {
    if (anomaly.kind !== "ZERO_ATTENDANCE_REQUIRED_DAY") continue;
    if (!accepted.has(anomaly.id) || !anomaly.date) continue;

    await db
      .update(s.calendarDays)
      .set({
        dayType: "OFFICE_CLOSED",
        isRequiredDay: false,
        label: "Office closed",
        confirmedByHuman: true,
      })
      .where(eq(s.calendarDays.date, anomaly.date));
  }

  const [upload] = await db
    .insert(s.uploads)
    .values({
      filename,
      sha256,
      status: "PENDING",
      dateRangeStart: dateRange?.start,
      dateRangeEnd: dateRange?.end,
      warnings: finalParse.warnings,
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

  /**
   * Batched, because every statement here is a network round trip to Neon.
   * Row-at-a-time turned an 82-person import into several hundred round trips
   * and the better part of a minute.
   */
  const toCreate = new Map<string, (typeof s.employees.$inferInsert)>();
  for (const identity of identities) {
    if (idByCanonicalKey.has(identity.canonicalKey)) continue;
    if (toCreate.has(identity.canonicalKey)) continue;
    toCreate.set(identity.canonicalKey, {
      firstName: identity.firstName,
      lastName: identity.lastName,
      displayName: identity.displayName,
      normalisedKey: identity.canonicalKey,
    });
  }

  if (toCreate.size > 0) {
    const created = await db
      .insert(s.employees)
      .values([...toCreate.values()])
      .onConflictDoUpdate({
        target: s.employees.normalisedKey,
        set: { updatedAt: new Date() },
      })
      .returning({ id: s.employees.id, normalisedKey: s.employees.normalisedKey });
    for (const row of created) idByCanonicalKey.set(row.normalisedKey, row.id);
  }

  const idByRawName = new Map<string, number>();
  const aliasRowsToInsert: (typeof s.employeeAliases.$inferInsert)[] = [];
  for (const identity of identities) {
    const employeeId = idByCanonicalKey.get(identity.canonicalKey);
    if (employeeId === undefined) continue;
    idByRawName.set(identity.rawName, employeeId);
    aliasRowsToInsert.push({
      rawName: identity.rawName,
      employeeId,
      sourceUploadId: upload.id,
    });
  }

  if (aliasRowsToInsert.length > 0) {
    await db.insert(s.employeeAliases).values(aliasRowsToInsert).onConflictDoNothing();
  }

  /**
   * Exemptions from the standing-note column. Only notes that clearly excuse
   * the required days become active exemptions - a work-from-home approval
   * naming Thursday is recorded but does not exempt anyone, because Thursday is
   * not a day anyone is required in.
   */
  const notesByRawName = new Map<string, string>();
  for (const row of finalParse.employees) {
    if (row.standingNote) notesByRawName.set(row.rawName, row.standingNote);
  }

  const existingExemptions = await db
    .select({ employeeId: s.exemptions.employeeId, rawText: s.exemptions.rawText })
    .from(s.exemptions);
  const seenExemptions = new Set(
    existingExemptions.map((e) => `${e.employeeId}|${e.rawText}`),
  );

  const exemptionRows: (typeof s.exemptions.$inferInsert)[] = [];
  for (const [rawName, note] of notesByRawName) {
    const employeeId = idByRawName.get(rawName);
    if (employeeId === undefined) continue;

    const derived = deriveExemption(note);
    if (!derived) continue;

    if (!seenExemptions.has(`${employeeId}|${derived.rawText}`)) {
      seenExemptions.add(`${employeeId}|${derived.rawText}`);
      exemptionRows.push({
        employeeId,
        type: derived.type,
        rawText: derived.rawText,
        active: derived.exempts,
      });
    }
  }

  if (exemptionRows.length > 0) {
    await db.insert(s.exemptions).values(exemptionRows);
    report.exemptions.created = exemptionRows.length;
  }

  // Reasons: one row per distinct string, categorised as UNKNOWN until stage 5.
  const reasonIdByText = new Map<string, number>();
  if (finalDistinctReasons.length > 0) {
    const [{ before }] = await db
      .select({ before: sql<number>`count(*)::int` })
      .from(s.reasons);

    await db
      .insert(s.reasons)
      .values(
        finalDistinctReasons.map((text) => ({
          rawText: text,
          category: "UNKNOWN" as const,
          normalisedText: text,
        })),
      )
      .onConflictDoNothing();

    const after = await db
      .select({ id: s.reasons.id, rawText: s.reasons.rawText })
      .from(s.reasons)
      .where(inArray(s.reasons.rawText, finalDistinctReasons));
    for (const r of after) reasonIdByText.set(r.rawText, r.id);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(s.reasons);
    report.reasons.created = total - before;
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
  const merged = new Map<string, (typeof finalClassified)[number]>();
  for (const record of finalClassified) {
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

  // 6 columns per row, well inside Postgres's 65,535 parameter ceiling.
  const CHUNK = 2000;
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
