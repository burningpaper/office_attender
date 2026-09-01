/**
 * Database schema. See DESIGN.md §4 for the reasoning behind each table.
 *
 * Two principles run through this file:
 *
 * 1. Raw values are never thrown away. Every attendance row keeps exactly what
 *    the cell held, so if the reason vocabulary changes later, everything can be
 *    reclassified from source without asking anyone to re-upload.
 * 2. Compliance is computed, never stored. The rules will change once real
 *    output is in front of someone, and stored verdicts go stale silently.
 */

import {
  boolean,
  date,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const employeeStatus = pgEnum("employee_status", ["ACTIVE", "DEPARTED"]);

export const exemptionType = pgEnum("exemption_type", [
  /** Lives too far to commute - "Stays in George", "From Hermanus". */
  "REMOTE_LOCATION",
  "PARENTAL_LEAVE",
  "APPROVED_WFH",
  "OTHER",
]);

/**
 * ABSENT and ABSENT_EXPLAINED are deliberately different facts. Under the
 * agreed policy an explained absence is compliance-neutral, so collapsing them
 * would erase the distinction the whole verdict rests on. NOT_EMPLOYED keeps
 * joiners and leavers out of denominators without special-casing every query.
 */
export const attendanceState = pgEnum("attendance_state", [
  "PRESENT",
  "ABSENT",
  "ABSENT_EXPLAINED",
  "NOT_EMPLOYED",
]);

export const reasonCategory = pgEnum("reason_category", [
  "SICK",
  "ANNUAL_LEAVE",
  "FAMILY_RESPONSIBILITY",
  "TRAVEL_OTHER_OFFICE",
  "WFH_APPROVED",
  "PUBLIC_HOLIDAY_OR_CLOSURE",
  "PERSONAL_EMERGENCY",
  "UNKNOWN",
]);

/**
 * What a reason does to the numbers. Policy, not language - the model assigns
 * the category, this decides the consequence, and it is editable without a
 * deploy. Default per DESIGN.md §10: any recorded reason excuses the day.
 */
export const reasonCountsAs = pgEnum("reason_counts_as", [
  "EXCUSED",
  "UNEXCUSED",
  "NOT_A_REASON",
]);

export const dayType = pgEnum("day_type", [
  "WORKING",
  "WEEKEND",
  "PUBLIC_HOLIDAY",
  "OFFICE_CLOSED",
]);

/** Which compliance failure a mailing was aimed at. */
export const emailCategory = pgEnum("email_category", [
  "MONTHLY",
  "TWO_WEEK",
  "LONG_TERM",
]);

export const emailSendStatus = pgEnum("email_send_status", [
  "PENDING",
  "SENT",
  "FAILED",
  "SKIPPED",
]);

export const uploadStatus = pgEnum("upload_status", [
  "PENDING",
  "PREVIEWED",
  "COMMITTED",
  "REJECTED",
]);

// ---------------------------------------------------------------------------
// Calendar - the compliance denominator
// ---------------------------------------------------------------------------

/**
 * One row per calendar day. Everything that asks "was this a day they were
 * meant to be here?" reads from this table and nowhere else.
 *
 * confirmedByHuman marks days a person has ruled on - chiefly OFFICE_CLOSED,
 * which the importer can only ever propose.
 */
export const calendarDays = pgTable("calendar_days", {
  date: date("date").primaryKey(),
  dayType: dayType("day_type").notNull(),
  isRequiredDay: boolean("is_required_day").notNull(),
  label: text("label"),
  confirmedByHuman: boolean("confirmed_by_human").notNull().default(false),
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export const uploads = pgTable(
  "uploads",
  {
    id: serial("id").primaryKey(),
    filename: text("filename").notNull(),
    /** Re-uploading an identical file is a no-op rather than a duplicate run. */
    sha256: text("sha256").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    uploadedBy: text("uploaded_by"),
    status: uploadStatus("status").notNull().default("PENDING"),
    dateRangeStart: date("date_range_start"),
    dateRangeEnd: date("date_range_end"),
    stats: jsonb("stats"),
    warnings: jsonb("warnings"),
  },
  (t) => [uniqueIndex("uploads_sha256_key").on(t.sha256)],
);

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export const employees = pgTable(
  "employees",
  {
    id: serial("id").primaryKey(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull().default(""),
    displayName: text("display_name").notNull(),
    /**
     * Casefolded, accent-stripped, punctuation-free, whitespace-collapsed.
     * This is what makes "zoe Flanegan" and "Zoe Flanegan" the same person
     * without anyone having to ask a model.
     */
    normalisedKey: text("normalised_key").notNull(),
    /**
     * The employment window, derived from the sheets. Long-term averages divide
     * by months employed, not months elapsed, or everyone who joined in July
     * looks like a persistent offender.
     */
    firstSeenDate: date("first_seen_date"),
    lastSeenDate: date("last_seen_date"),
    status: employeeStatus("status").notNull().default("ACTIVE"),
    /**
     * Work email. Nullable on purpose - the roster comes from a spreadsheet
     * that has never contained one, so somebody has to supply them separately
     * and there will always be people who have not been matched yet.
     */
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("employees_normalised_key_key").on(t.normalisedKey)],
);

/**
 * Every raw name string ever seen, including the typos. This is the memory that
 * stops the importer asking about "Zakiyya Karim" twice.
 */
export const employeeAliases = pgTable(
  "employee_aliases",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    rawName: text("raw_name").notNull(),
    sourceUploadId: integer("source_upload_id").references(() => uploads.id, {
      onDelete: "set null",
    }),
    confirmedByHuman: boolean("confirmed_by_human").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("employee_aliases_raw_name_key").on(t.rawName)],
);

/**
 * Structured, not free text, because "on maternity leave" ends and "lives in
 * George" does not - and because the sheet's own wording drifts ("Stays in
 * Hermanus" became "From Hermanus" between March and August).
 */
export const exemptions = pgTable(
  "exemptions",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    type: exemptionType("type").notNull(),
    /** The note as written on the sheet, kept for provenance. */
    rawText: text("raw_text"),
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("exemptions_employee_idx").on(t.employeeId)],
);

// ---------------------------------------------------------------------------
// Reasons - the AI cache
// ---------------------------------------------------------------------------

/**
 * One row per distinct raw string, ever. Keyed by the exact text, so the model
 * is called once per novel string across the life of the system - in steady
 * state a monthly upload makes zero to three calls.
 */
export const reasons = pgTable(
  "reasons",
  {
    id: serial("id").primaryKey(),
    rawText: text("raw_text").notNull(),
    category: reasonCategory("category").notNull(),
    normalisedText: text("normalised_text").notNull(),
    countsAs: reasonCountsAs("counts_as").notNull().default("EXCUSED"),
    confidence: real("confidence"),
    model: text("model"),
    /** Once a person has confirmed a classification it is never re-sent. */
    reviewedByHuman: boolean("reviewed_by_human").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("reasons_raw_text_key").on(t.rawText)],
);

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

/**
 * Current truth: one row per employee per date.
 *
 * The date references calendar_days so attendance can never exist on a day the
 * system cannot evaluate. That makes calendar coverage a hard requirement of
 * import rather than something discovered later when a month reads oddly.
 */
export const attendance = pgTable(
  "attendance",
  {
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    date: date("date")
      .notNull()
      .references(() => calendarDays.date),
    state: attendanceState("state").notNull(),
    /** Exactly what the cell held. Never normalised away. */
    rawValue: text("raw_value"),
    reasonId: integer("reason_id").references(() => reasons.id, { onDelete: "set null" }),
    sourceUploadId: integer("source_upload_id").references(() => uploads.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.employeeId, t.date] }),
    index("attendance_date_idx").on(t.date),
  ],
);

/**
 * Every message this system has sent, or tried to.
 *
 * Append-only and complete, including the rendered body. Mailing somebody about
 * their own attendance is the one thing here that reaches outside the building,
 * so "what exactly did we send Nadine on the 3rd, and why was she on the list?"
 * has to be answerable months later without anyone guessing.
 */
export const emailSends = pgTable(
  "email_sends",
  {
    id: serial("id").primaryKey(),
    /** Groups everything sent in one go. */
    batchId: text("batch_id").notNull(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** The address used, kept even if the employee record later changes. */
    email: text("email").notNull(),
    category: emailCategory("category").notNull(),
    /** The month the report was showing when this was sent. */
    month: text("month").notNull(),
    subject: text("subject").notNull(),
    /** Exactly what was sent, rendered. */
    bodyHtml: text("body_html").notNull(),
    status: emailSendStatus("status").notNull().default("PENDING"),
    error: text("error"),
    /** Dates quoted in the message, so the claim can be checked later. */
    attendedDates: jsonb("attended_dates"),
    missedDates: jsonb("missed_dates"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    index("email_sends_batch_idx").on(t.batchId),
    index("email_sends_employee_idx").on(t.employeeId),
  ],
);

/**
 * Append-only. Answers "when did Mary's 12 June change from absent to on-leave,
 * and which upload did it?" - which append-only importing could never answer,
 * because it would have silently discarded the correction.
 */
export const attendanceHistory = pgTable(
  "attendance_history",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    oldState: attendanceState("old_state"),
    newState: attendanceState("new_state").notNull(),
    uploadId: integer("upload_id").references(() => uploads.id, { onDelete: "set null" }),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("attendance_history_employee_date_idx").on(t.employeeId, t.date)],
);
