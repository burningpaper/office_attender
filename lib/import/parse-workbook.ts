/**
 * Structural parse of the attendance workbook (pipeline stages 1-2).
 *
 * The grid in this workbook is already clean - attendance cells hold literal 0
 * and 1. What is messy is the furniture around it: spacer columns that move
 * every month, a totals row hiding among the employees, legend rows below a
 * blank gap, and the occasional header typed as "O1 June" instead of a date.
 *
 * So this module is deliberately rule-based and deterministic. Re-running it on
 * the same file must produce byte-identical output - a compliance report that
 * quietly changed its mind between imports would be worse than no report.
 *
 * Anything it cannot interpret with confidence becomes a warning rather than a
 * guess. The import preview surfaces those for a human to settle.
 */

import * as XLSX from "xlsx";
import {
  dateToISODate,
  isPlausibleDateSerial,
  serialToISODate,
} from "./excel-dates";
import type {
  ParseWarning,
  ParsedEmployeeRow,
  RawAttendanceRecord,
  SheetAnnotation,
  SheetReport,
  WorkbookParseResult,
} from "./types";

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** How many rows from the top to search for the date header. */
const HEADER_SEARCH_DEPTH = 10;
/** A header row must carry at least this many date cells to count. */
const MIN_DATE_CELLS_FOR_HEADER = 3;

type Cell = { v: unknown; t?: string } | undefined;

/** A column in the header row that resolved to a real date. */
type DateColumn = { col: number; letter: string; iso: string };

function cellAt(ws: XLSX.WorkSheet, row: number, col: number): Cell {
  return ws[XLSX.utils.encode_cell({ r: row, c: col })] as Cell;
}

function colLetter(col: number): string {
  return XLSX.utils.encode_col(col);
}

/**
 * Cell value as a trimmed string. Empty string for blank cells.
 *
 * This workbook stores attendance as Excel booleans (`t:"b"`, rendered TRUE and
 * FALSE), not as the numbers the grid appears to show. TRUE and 1 are the same
 * assertion here, so booleans are rendered as "1"/"0" and nothing downstream
 * has to know which spelling a given month happened to use.
 */
function cellText(cell: Cell): string {
  if (!cell || cell.v === null || cell.v === undefined) return "";
  if (typeof cell.v === "boolean") return cell.v ? "1" : "0";
  if (cell.v instanceof Date) return dateToISODate(cell.v);
  return String(cell.v).trim();
}

/** Collapse internal whitespace, for names. */
function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The date this header cell represents, or null if it isn't one. */
function headerDate(cell: Cell): string | null {
  if (!cell) return null;
  if (cell.v instanceof Date) return dateToISODate(cell.v);
  if (isPlausibleDateSerial(cell.v)) return serialToISODate(cell.v as number);
  return null;
}

/**
 * Try to read a malformed header like "O1 June" or "10 Aug" as a date.
 *
 * Only returns a proposal when the resulting date sits strictly between the
 * dates of the surrounding columns - the sheet's own left-to-right ordering is
 * the corroboration. Without that check this would be guesswork; with it, a
 * wrong proposal is very unlikely to survive.
 *
 * The caller still withholds the column's data until a human confirms.
 */
function proposeDateForStrayHeader(
  text: string,
  year: number,
  monthIndex: number,
  before: string | null,
  after: string | null,
): string | null {
  // "O1" is a capital O typed for a zero; "l" for a one. Fix only in digit runs.
  const normalised = text.toLowerCase().replace(/[ol]/g, (ch) => (ch === "o" ? "0" : "1"));

  const dayMatch = normalised.match(/\b(\d{1,2})\b/);
  if (!dayMatch) return null;
  const day = Number(dayMatch[1]);
  if (day < 1 || day > 31) return null;

  // If the text names a month, prefer it over the sheet's month.
  let month = monthIndex;
  const lower = text.toLowerCase();
  for (let i = 0; i < MONTH_NAMES.length; i++) {
    if (lower.includes(MONTH_NAMES[i].slice(0, 3))) {
      month = i;
      break;
    }
  }

  const candidate = new Date(Date.UTC(year, month, day));
  if (candidate.getUTCMonth() !== month || candidate.getUTCDate() !== day) return null;
  const iso = candidate.toISOString().slice(0, 10);

  // Corroborate against the neighbours: the sheet reads left to right in time.
  if (before && !(iso > before)) return null;
  if (after && !(iso < after)) return null;

  return iso;
}

/** Locate the row carrying the date headers. */
function findHeaderRow(ws: XLSX.WorkSheet, range: XLSX.Range): number | null {
  let best: { row: number; count: number } | null = null;
  const limit = Math.min(range.e.r, range.s.r + HEADER_SEARCH_DEPTH);

  for (let row = range.s.r; row <= limit; row++) {
    let count = 0;
    for (let col = range.s.c; col <= range.e.c; col++) {
      if (headerDate(cellAt(ws, row, col))) count++;
    }
    if (count >= MIN_DATE_CELLS_FOR_HEADER && (!best || count > best.count)) {
      best = { row, count };
    }
  }
  return best ? best.row : null;
}

/** Which columns hold the first name, surname, and the standing note. */
function findNameColumns(
  ws: XLSX.WorkSheet,
  range: XLSX.Range,
  headerRow: number,
  firstDateCol: number,
) {
  let firstNameCol: number | null = null;
  let lastNameCol: number | null = null;

  for (let col = range.s.c; col < firstDateCol; col++) {
    const text = cellText(cellAt(ws, headerRow, col)).toLowerCase();
    if (/first\s*name/.test(text)) firstNameCol = col;
    if (/last\s*name|surname/.test(text)) lastNameCol = col;
  }

  // Fall back to the conventional layout if the headers are missing.
  const firstCol: number = firstNameCol ?? range.s.c;
  const lastCol: number = lastNameCol ?? firstCol + 1;

  /**
   * The standing-note column is whatever sits between the surname and the first
   * date. Deliberately positional rather than looking for a "Comment" header:
   * from July onward that header is blank while the column still holds notes
   * like "From Hermanus".
   */
  const noteCols: number[] = [];
  for (let col = lastCol + 1; col < firstDateCol; col++) noteCols.push(col);

  return { firstNameCol: firstCol, lastNameCol: lastCol, noteCols };
}

function parseSheet(
  ws: XLSX.WorkSheet,
  sheetName: string,
  /**
   * Columns a person has confirmed the date for, keyed "Sheet:Column".
   * A confirmed column stops being withheld and becomes an ordinary date column.
   */
  confirmedDateColumns: Record<string, string>,
  out: {
    employees: ParsedEmployeeRow[];
    records: RawAttendanceRecord[];
    annotations: SheetAnnotation[];
    warnings: ParseWarning[];
  },
): SheetReport {
  const emptyReport: SheetReport = {
    sheetName,
    isDataSheet: true,
    dateColumnCount: 0,
    dateRange: null,
    employeeRowCount: 0,
    recordCount: 0,
    droppedRowCount: 0,
  };

  const ref = ws["!ref"];
  if (!ref) {
    out.warnings.push({
      code: "NO_DATE_HEADER",
      sheetName,
      message: `Sheet "${sheetName}" is empty.`,
    });
    return emptyReport;
  }

  const range = XLSX.utils.decode_range(ref);
  const headerRow = findHeaderRow(ws, range);
  if (headerRow === null) {
    out.warnings.push({
      code: "NO_DATE_HEADER",
      sheetName,
      message: `Sheet "${sheetName}" has no row of date headers; skipped.`,
    });
    return emptyReport;
  }

  // --- Header row: real dates, and anything sitting where a date should be ---
  const dateColumns: DateColumn[] = [];
  const strayHeaders: { col: number; text: string }[] = [];

  for (let col = range.s.c; col <= range.e.c; col++) {
    const cell = cellAt(ws, headerRow, col);
    const iso = headerDate(cell);
    if (iso) {
      dateColumns.push({ col, letter: colLetter(col), iso });
    } else {
      const text = cellText(cell);
      if (text) strayHeaders.push({ col, text });
    }
  }

  if (dateColumns.length === 0) {
    out.warnings.push({
      code: "NO_DATE_HEADER",
      sheetName,
      message: `Sheet "${sheetName}" has a header row but no readable dates.`,
    });
    return emptyReport;
  }

  /**
   * Whether a column is an attendance column cannot be decided from its header
   * - June's reads "O1 June" and September's note column has no header at all.
   * It can be decided from its contents: attendance columns are full of 0/1,
   * note columns and spacers never contain any. That is the test used here.
   */
  const binaryCountInColumn = (col: number): number => {
    let n = 0;
    for (let row = headerRow + 1; row <= range.e.r; row++) {
      const t = cellText(cellAt(ws, row, col));
      if (t === "0" || t === "1") n++;
    }
    return n;
  };
  const MIN_BINARY_FOR_DATE_COLUMN = 3;

  const recognisedCols = new Set(dateColumns.map((d) => d.col));

  /** A column that holds attendance but whose header did not read as a date. */
  const brokenDateCols: { col: number; text: string; hasData: boolean }[] = [];
  for (let col = range.s.c; col <= range.e.c; col++) {
    if (recognisedCols.has(col)) continue;
    if (binaryCountInColumn(col) < MIN_BINARY_FOR_DATE_COLUMN) continue;
    brokenDateCols.push({
      col,
      text: cellText(cellAt(ws, headerRow, col)),
      hasData: true,
    });
  }

  const brokenCols = new Set(brokenDateCols.map((b) => b.col));
  const firstDateCol = Math.min(
    dateColumns[0].col,
    ...brokenDateCols.map((b) => b.col),
  );

  /**
   * A header that tried to name a date but sits above an empty column - August
   * has "10 Aug" over nothing at all. No data is lost, but it records a day the
   * sheet meant to capture and never did, which is worth saying out loud.
   */
  for (const stray of strayHeaders) {
    if (recognisedCols.has(stray.col)) continue;
    if (brokenCols.has(stray.col)) continue;
    if (stray.col <= firstDateCol) continue; // a name or note header
    brokenDateCols.push({ col: stray.col, text: stray.text, hasData: false });
  }
  brokenDateCols.sort((a, b) => a.col - b.col);

  const names = findNameColumns(ws, range, headerRow, firstDateCol);
  const { firstNameCol, lastNameCol } = names;
  const noteCols = names.noteCols.filter((c) => !brokenCols.has(c));

  const sheetYear = Number(dateColumns[0].iso.slice(0, 4));
  const sheetMonth = Number(dateColumns[0].iso.slice(5, 7)) - 1;

  /**
   * A column whose date somebody has confirmed is promoted to a real date
   * column and its attendance imported. Until then it stays withheld - the
   * importer proposes a reading, it does not adopt one.
   */
  const promoted: typeof brokenDateCols = [];
  for (const stray of brokenDateCols) {
    const confirmed = confirmedDateColumns[`${sheetName}:${colLetter(stray.col)}`];
    if (confirmed && stray.hasData) {
      dateColumns.push({ col: stray.col, letter: colLetter(stray.col), iso: confirmed });
      promoted.push(stray);
    }
  }
  dateColumns.sort((a, b) => a.col - b.col);

  for (const stray of brokenDateCols) {
    if (promoted.includes(stray)) continue;
    const before =
      [...dateColumns].filter((d) => d.col < stray.col).pop()?.iso ?? null;
    const after = dateColumns.find((d) => d.col > stray.col)?.iso ?? null;
    const proposed = proposeDateForStrayHeader(
      stray.text,
      sheetYear,
      sheetMonth,
      before,
      after,
    );
    out.warnings.push({
      code: "UNPARSEABLE_DATE_HEADER",
      sheetName,
      column: colLetter(stray.col),
      message:
        `Column ${colLetter(stray.col)} ` +
        (stray.hasData ? `holds attendance data but its header ` : `has the header `) +
        (stray.text ? `"${stray.text}", which is not a date. ` : `blank. `) +
        (proposed ? `It appears to mean ${proposed}. ` : "") +
        (stray.hasData
          ? `Attendance in this column is withheld pending confirmation.`
          : `The column is empty, so no attendance was recorded for that day.`),
      ...(proposed ? { proposedDate: proposed } : {}),
      detail: { headerText: stray.text, hasData: stray.hasData },
    });
  }

  // --- Data rows ---
  const seenNames = new Map<string, number[]>();
  let employeeRowCount = 0;
  let recordCount = 0;
  let droppedRowCount = 0;

  for (let row = headerRow + 1; row <= range.e.r; row++) {
    const first = tidy(cellText(cellAt(ws, row, firstNameCol)));
    const last = tidy(cellText(cellAt(ws, row, lastNameCol)));
    const rawName = tidy(`${first} ${last}`);

    // Read the attendance cells once; every decision below keys off them.
    const cells = dateColumns.map((dc) => ({
      dc,
      text: cellText(cellAt(ws, row, dc.col)),
    }));
    const nonEmpty = cells.filter((c) => c.text !== "");

    /**
     * A numeric cell that is neither 0 nor 1 means this row is a column-sum,
     * not a person. August row 72 holds "6, 5, 3, 1, 7, 7" and no name.
     */
    const numericNotBinary = nonEmpty.filter(
      (c) => /^-?\d+(\.\d+)?$/.test(c.text) && c.text !== "0" && c.text !== "1",
    );
    if (numericNotBinary.length > 0) {
      droppedRowCount++;

      /**
       * Keep any prose written on this row before discarding it. A totals row
       * is not attendance, but somebody may have annotated a column on it -
       * "Office closed" under 1 July, for instance - and that is evidence the
       * import preview should put in front of a person.
       */
      for (const { dc, text } of nonEmpty) {
        if (!/^-?\d+(\.\d+)?$/.test(text)) {
          out.annotations.push({
            sheetName,
            rowNumber: row + 1,
            date: dc.iso,
            text,
          });
        }
      }

      out.warnings.push({
        code: "NON_BINARY_NUMERIC_CELL",
        sheetName,
        rowNumber: row + 1,
        message:
          `Row ${row + 1} holds numeric values other than 0/1 ` +
          `(${numericNotBinary.map((c) => c.text).join(", ")}) - treated as a totals row and dropped.`,
        detail: { rawName: rawName || null },
      });
      continue;
    }

    if (!rawName) continue; // genuinely blank spacer row

    /**
     * A named row with no attendance data at all is a legend entry from below
     * the blank gap - May lists Ben Clay, Zoe Flanegan and Jason Tucker a second
     * time there. But June's Weslee Johannesen sits in the same place and does
     * carry a 1, so the test is "no data", never "below the gap".
     */
    if (nonEmpty.length === 0) {
      droppedRowCount++;
      out.warnings.push({
        code: "DROPPED_ROW_NO_DATA",
        sheetName,
        rowNumber: row + 1,
        message: `Row ${row + 1} ("${rawName}") carries no attendance data - treated as a legend row and dropped.`,
        detail: { rawName },
      });
      continue;
    }

    if (!last) {
      out.warnings.push({
        code: "MISSING_LAST_NAME",
        sheetName,
        rowNumber: row + 1,
        message: `Row ${row + 1} ("${rawName}") has no surname; identity cannot be resolved automatically.`,
        detail: { rawName },
      });
    }

    const noteParts = noteCols
      .map((col) => cellText(cellAt(ws, row, col)))
      .filter((t) => t !== "");
    const standingNote = noteParts.length > 0 ? tidy(noteParts.join(" ")) : null;

    out.employees.push({
      sheetName,
      rowNumber: row + 1,
      firstName: first,
      lastName: last,
      rawName,
      standingNote,
    });
    employeeRowCount++;

    const rows = seenNames.get(rawName) ?? [];
    rows.push(row + 1);
    seenNames.set(rawName, rows);

    for (const { dc, text } of nonEmpty) {
      out.records.push({
        sheetName,
        rowNumber: row + 1,
        rawName,
        date: dc.iso,
        rawValue: text,
      });
      recordCount++;
    }
  }

  for (const [name, rows] of seenNames) {
    if (rows.length > 1) {
      out.warnings.push({
        code: "DUPLICATE_NAME_IN_SHEET",
        sheetName,
        message: `"${name}" appears on ${rows.length} rows (${rows.join(", ")}), each carrying data. Records will be merged with attendance winning.`,
        detail: { rawName: name, rows },
      });
    }
  }

  const isos = dateColumns.map((d) => d.iso).sort();

  return {
    sheetName,
    isDataSheet: true,
    headerRow: headerRow + 1,
    dateColumnCount: dateColumns.length,
    dateRange: { start: isos[0], end: isos[isos.length - 1] },
    employeeRowCount,
    recordCount,
    droppedRowCount,
  };
}

/** Is this sheet name a month? Anything else is not attendance data. */
function isMonthSheet(name: string): boolean {
  return MONTH_NAMES.includes(name.trim().toLowerCase());
}

/**
 * Parse the workbook into employees, raw attendance records, and warnings.
 *
 * Sheets not named after a month are skipped and reported - the "Pdf" sheet in
 * the sample duplicates a week already covered by August.
 */
export function parseWorkbook(
  buffer: ArrayBuffer | Buffer,
  options: { confirmedDateColumns?: Record<string, string> } = {},
): WorkbookParseResult {
  const confirmedDateColumns = options.confirmedDateColumns ?? {};
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });

  const out = {
    employees: [] as ParsedEmployeeRow[],
    records: [] as RawAttendanceRecord[],
    annotations: [] as SheetAnnotation[],
    warnings: [] as ParseWarning[],
  };
  const sheets: SheetReport[] = [];

  for (const sheetName of wb.SheetNames) {
    if (!isMonthSheet(sheetName)) {
      out.warnings.push({
        code: "SHEET_SKIPPED",
        sheetName,
        message: `Sheet "${sheetName}" is not named after a month; skipped as non-attendance data.`,
      });
      sheets.push({
        sheetName,
        isDataSheet: false,
        skippedReason: "not a month sheet",
        dateColumnCount: 0,
        dateRange: null,
        employeeRowCount: 0,
        recordCount: 0,
        droppedRowCount: 0,
      });
      continue;
    }
    sheets.push(
      parseSheet(wb.Sheets[sheetName], sheetName.trim(), confirmedDateColumns, out),
    );
  }

  return { sheets, ...out };
}
