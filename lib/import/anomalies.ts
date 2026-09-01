/**
 * Things the importer noticed but will not decide on its own.
 *
 * The governing idea is that a required day with nobody in the office is
 * genuinely ambiguous. It might mean the office was shut; it might mean nobody
 * filled the sheet in. Those are opposite verdicts - one excuses everybody, the
 * other condemns them - and the data cannot tell them apart. So the importer
 * proposes and a person decides.
 */

import type { CalendarDay } from "../compliance/types";
import type { ParseWarning, RawAttendanceRecord, SheetAnnotation } from "./types";

export type AnomalyKind =
  /** A required day where nobody at all was present. */
  | "ZERO_ATTENDANCE_REQUIRED_DAY"
  /** A date column whose header did not read as a date. */
  | "UNREADABLE_DATE_COLUMN"
  /** A person the matcher could not confidently identify. */
  | "UNRESOLVED_IDENTITY"
  /** A standing note that was not recognised as an exemption. */
  | "EXEMPTION_TO_CONFIRM";

export type Anomaly = {
  kind: AnomalyKind;
  /** Stable id so the browser can send decisions back. */
  id: string;
  title: string;
  detail: string;
  /** Evidence found in the file itself, when there is any. */
  evidence?: string;
  /** What the importer would do if told to go ahead. */
  proposal?: string;
  /** The date this concerns, where it concerns one. */
  date?: string;
  /** Whether a person must answer before the import can proceed. */
  blocking: boolean;
};

export type AnomalyResolution = {
  id: string;
  /** true = do what was proposed, false = leave things as they are. */
  accept: boolean;
};

const REQUIRED_DAY_ATTENDANCE_FLOOR = 0;

/**
 * Work out what needs asking about.
 *
 * `existingCalendar` is consulted so a day somebody has already ruled on is not
 * raised a second time on every subsequent upload.
 */
export function detectAnomalies(input: {
  records: RawAttendanceRecord[];
  annotations: SheetAnnotation[];
  warnings: ParseWarning[];
  calendar: CalendarDay[];
  alreadyConfirmedDates: Set<string>;
  /** Today. Days that have not happened yet are not anomalies. */
  asOf: string;
  unresolvedNames: { rawName: string; reason: string }[];
  exemptionsToConfirm: { name: string; note: string; reason: string }[];
}): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // --- Required days nobody attended ---------------------------------------
  const requiredDates = new Set(
    input.calendar.filter((d) => d.isRequiredDay).map((d) => d.date),
  );

  const presentByDate = new Map<string, number>();
  const seenDates = new Set<string>();
  for (const record of input.records) {
    seenDates.add(record.date);
    if (record.rawValue === "1") {
      presentByDate.set(record.date, (presentByDate.get(record.date) ?? 0) + 1);
    }
  }

  const annotationByDate = new Map<string, SheetAnnotation>();
  for (const annotation of input.annotations) {
    annotationByDate.set(annotation.date, annotation);
  }

  for (const date of [...seenDates].sort()) {
    if (!requiredDates.has(date)) continue;
    /**
     * A day that has not arrived yet is empty for the dullest possible reason.
     * The sheet is laid out a month in advance, so September carries a full set
     * of zeroes on the 1st - asking whether the office is closed on each of them
     * would bury the two questions that genuinely need answering.
     */
    if (date > input.asOf) continue;
    if (input.alreadyConfirmedDates.has(date)) continue;
    if ((presentByDate.get(date) ?? 0) > REQUIRED_DAY_ATTENDANCE_FLOOR) continue;

    const annotation = annotationByDate.get(date);
    anomalies.push({
      kind: "ZERO_ATTENDANCE_REQUIRED_DAY",
      id: `closure:${date}`,
      date,
      title: `Nobody was in the office on ${date}`,
      detail:
        `${date} is a required day, and not one person is marked present. Either the ` +
        `office was closed, or the sheet was never filled in for that day. Those give ` +
        `opposite answers and the spreadsheet cannot say which.`,
      evidence: annotation
        ? `The sheet has \u201C${annotation.text.replace(/^["']+|["']+$/g, "")}\u201D written ` +
          `against this date on ${annotation.sheetName} row ${annotation.rowNumber}.`
        : undefined,
      proposal: `Mark ${date} as office closed, so it counts against nobody.`,
      blocking: true,
    });
  }

  // --- Columns whose header was not a date ---------------------------------
  for (const warning of input.warnings) {
    if (warning.code !== "UNPARSEABLE_DATE_HEADER") continue;
    const hasData = warning.detail?.hasData === true;
    anomalies.push({
      kind: "UNREADABLE_DATE_COLUMN",
      id: `datecol:${warning.sheetName}:${warning.column}`,
      title: `Column ${warning.column} on ${warning.sheetName} is not headed by a date`,
      detail: warning.message,
      evidence: `The header reads \u201C${String(warning.detail?.headerText ?? "")}\u201D.`,
      proposal: warning.proposedDate
        ? hasData
          ? `Read the column as ${warning.proposedDate} and import its attendance.`
          : `Record ${warning.proposedDate} as a day with no attendance captured.`
        : undefined,
      date: warning.proposedDate,
      // Only blocking when accepting it would add data.
      blocking: hasData,
    });
  }

  // --- People the matcher could not place ----------------------------------
  for (const person of input.unresolvedNames) {
    anomalies.push({
      kind: "UNRESOLVED_IDENTITY",
      id: `identity:${person.rawName}`,
      title: `"${person.rawName}" could not be identified`,
      detail: person.reason,
      proposal: `Import them as a new person named "${person.rawName}".`,
      blocking: false,
    });
  }

  // --- Standing notes that need a ruling -----------------------------------
  for (const exemption of input.exemptionsToConfirm) {
    anomalies.push({
      kind: "EXEMPTION_TO_CONFIRM",
      id: `exemption:${exemption.name}`,
      title: `${exemption.name}: ${exemption.note}`,
      detail: exemption.reason,
      blocking: false,
    });
  }

  return anomalies;
}

/** Anomalies that must be answered before the import may proceed. */
export function blockingAnomalies(anomalies: Anomaly[]): Anomaly[] {
  return anomalies.filter((a) => a.blocking);
}

/** Are all blocking anomalies answered? */
export function isResolved(
  anomalies: Anomaly[],
  resolutions: AnomalyResolution[],
): boolean {
  const answered = new Set(resolutions.map((r) => r.id));
  return blockingAnomalies(anomalies).every((a) => answered.has(a.id));
}
