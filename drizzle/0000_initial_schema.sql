CREATE TYPE "public"."attendance_state" AS ENUM('PRESENT', 'ABSENT', 'ABSENT_EXPLAINED', 'NOT_EMPLOYED');--> statement-breakpoint
CREATE TYPE "public"."day_type" AS ENUM('WORKING', 'WEEKEND', 'PUBLIC_HOLIDAY', 'OFFICE_CLOSED');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('ACTIVE', 'DEPARTED');--> statement-breakpoint
CREATE TYPE "public"."exemption_type" AS ENUM('REMOTE_LOCATION', 'PARENTAL_LEAVE', 'APPROVED_WFH', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."reason_category" AS ENUM('SICK', 'ANNUAL_LEAVE', 'FAMILY_RESPONSIBILITY', 'TRAVEL_OTHER_OFFICE', 'WFH_APPROVED', 'PUBLIC_HOLIDAY_OR_CLOSURE', 'PERSONAL_EMERGENCY', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."reason_counts_as" AS ENUM('EXCUSED', 'UNEXCUSED', 'NOT_A_REASON');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('PENDING', 'PREVIEWED', 'COMMITTED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "attendance" (
	"employee_id" integer NOT NULL,
	"date" date NOT NULL,
	"state" "attendance_state" NOT NULL,
	"raw_value" text,
	"reason_id" integer,
	"source_upload_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_employee_id_date_pk" PRIMARY KEY("employee_id","date")
);
--> statement-breakpoint
CREATE TABLE "attendance_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"date" date NOT NULL,
	"old_state" "attendance_state",
	"new_state" "attendance_state" NOT NULL,
	"upload_id" integer,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_days" (
	"date" date PRIMARY KEY NOT NULL,
	"day_type" "day_type" NOT NULL,
	"is_required_day" boolean NOT NULL,
	"label" text,
	"confirmed_by_human" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"raw_name" text NOT NULL,
	"source_upload_id" integer,
	"confirmed_by_human" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"display_name" text NOT NULL,
	"normalised_key" text NOT NULL,
	"first_seen_date" date,
	"last_seen_date" date,
	"status" "employee_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"type" "exemption_type" NOT NULL,
	"raw_text" text,
	"effective_from" date,
	"effective_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reasons" (
	"id" serial PRIMARY KEY NOT NULL,
	"raw_text" text NOT NULL,
	"category" "reason_category" NOT NULL,
	"normalised_text" text NOT NULL,
	"counts_as" "reason_counts_as" DEFAULT 'EXCUSED' NOT NULL,
	"confidence" real,
	"model" text,
	"reviewed_by_human" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_by" text,
	"status" "upload_status" DEFAULT 'PENDING' NOT NULL,
	"date_range_start" date,
	"date_range_end" date,
	"stats" jsonb,
	"warnings" jsonb
);
--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_date_calendar_days_date_fk" FOREIGN KEY ("date") REFERENCES "public"."calendar_days"("date") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_reason_id_reasons_id_fk" FOREIGN KEY ("reason_id") REFERENCES "public"."reasons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_source_upload_id_uploads_id_fk" FOREIGN KEY ("source_upload_id") REFERENCES "public"."uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_history" ADD CONSTRAINT "attendance_history_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_history" ADD CONSTRAINT "attendance_history_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_aliases" ADD CONSTRAINT "employee_aliases_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_aliases" ADD CONSTRAINT "employee_aliases_source_upload_id_uploads_id_fk" FOREIGN KEY ("source_upload_id") REFERENCES "public"."uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exemptions" ADD CONSTRAINT "exemptions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_date_idx" ON "attendance" USING btree ("date");--> statement-breakpoint
CREATE INDEX "attendance_history_employee_date_idx" ON "attendance_history" USING btree ("employee_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_aliases_raw_name_key" ON "employee_aliases" USING btree ("raw_name");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_normalised_key_key" ON "employees" USING btree ("normalised_key");--> statement-breakpoint
CREATE INDEX "exemptions_employee_idx" ON "exemptions" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reasons_raw_text_key" ON "reasons" USING btree ("raw_text");--> statement-breakpoint
CREATE UNIQUE INDEX "uploads_sha256_key" ON "uploads" USING btree ("sha256");