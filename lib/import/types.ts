/**
 * Types for the deterministic spreadsheet parser (pipeline stages 1-2).
 *
 * Nothing in this module knows about the database, compliance rules, or AI.
 * It turns a workbook into typed records plus an honest list of everything it
 * could not confidently interpret.
 */

/** Everything the parser could not confidently interpret. */
export type WarningCode =
  /** Header cell where a date should be, that isn't a date. e.g. "O1 June". */
  | "UNPARSEABLE_DATE_HEADER"
  /** A numeric attendance cell that is neither 0 nor 1 - marks a totals row. */
  | "NON_BINARY_NUMERIC_CELL"
  /** A named row carrying no attendance data at all - a legend/footer row. */
  | "DROPPED_ROW_NO_DATA"
  /** Same person listed twice on one sheet, both rows carrying data. */
  | "DUPLICATE_NAME_IN_SHEET"
  /** A row with a first name but no surname. e.g. "Brian", "Intern". */
  | "MISSING_LAST_NAME"
  /** A sheet deliberately not parsed. */
  | "SHEET_SKIPPED"
  /** A sheet with no recognisable date header row. */
  | "NO_DATE_HEADER";

export type ParseWarning = {
  code: WarningCode;
  sheetName: string;
  /** 1-indexed spreadsheet row, where the warning is about a row. */
  rowNumber?: number;
  /** Column letter, where the warning is about a column. */
  column?: string;
  message: string;
  /**
   * A date the parser believes a malformed header was meant to be. Present only
   * on UNPARSEABLE_DATE_HEADER, and only when the guess is corroborated by the
   * surrounding columns. It is a proposal for a human to confirm - the records
   * for that column are withheld until they do.
   */
  proposedDate?: string;
  detail?: Record<string, unknown>;
};

/** One employee as they appear on one sheet. */
export type ParsedEmployeeRow = {
  sheetName: string;
  rowNumber: number;
  firstName: string;
  lastName: string;
  /** "First Last", collapsed whitespace. The key for identity resolution. */
  rawName: string;
  /** The standing note from the column between the names and the dates. */
  standingNote: string | null;
};

/** One cell: this person, this date, whatever the cell actually held. */
export type RawAttendanceRecord = {
  sheetName: string;
  rowNumber: number;
  rawName: string;
  /** ISO yyyy-mm-dd. */
  date: string;
  /** Exactly what the cell contained, stringified. Never normalised here. */
  rawValue: string;
};

export type SheetReport = {
  sheetName: string;
  isDataSheet: boolean;
  skippedReason?: string;
  headerRow?: number;
  dateColumnCount: number;
  dateRange: { start: string; end: string } | null;
  employeeRowCount: number;
  recordCount: number;
  /** Rows that looked like employees but were discarded as furniture. */
  droppedRowCount: number;
};

export type WorkbookParseResult = {
  sheets: SheetReport[];
  employees: ParsedEmployeeRow[];
  records: RawAttendanceRecord[];
  warnings: ParseWarning[];
};
