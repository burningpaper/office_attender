CREATE TYPE "public"."email_category" AS ENUM('MONTHLY', 'TWO_WEEK', 'LONG_TERM');--> statement-breakpoint
CREATE TYPE "public"."email_send_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TABLE "email_sends" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"employee_id" integer NOT NULL,
	"email" text NOT NULL,
	"category" "email_category" NOT NULL,
	"month" text NOT NULL,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"status" "email_send_status" DEFAULT 'PENDING' NOT NULL,
	"error" text,
	"attended_dates" jsonb,
	"missed_dates" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_sends_batch_idx" ON "email_sends" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "email_sends_employee_idx" ON "email_sends" USING btree ("employee_id");