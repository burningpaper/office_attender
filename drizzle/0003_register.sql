CREATE TYPE "public"."attendance_source" AS ENUM('IMPORT', 'MANUAL');--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "office_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "uploads" ALTER COLUMN "office_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "source" "attendance_source" DEFAULT 'IMPORT' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "comment" text;