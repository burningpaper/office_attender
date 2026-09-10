CREATE TABLE "office_closures" (
	"office_id" integer NOT NULL,
	"date" date NOT NULL,
	"label" text,
	"confirmed_by_human" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "office_closures_office_id_date_pk" PRIMARY KEY("office_id","date")
);
--> statement-breakpoint
CREATE TABLE "offices" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "employee_aliases_raw_name_key";--> statement-breakpoint
DROP INDEX "employees_normalised_key_key";--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "office_id" integer;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "office_id" integer;--> statement-breakpoint
--
-- Everything that exists was Cape Town. Backfill before the column is made
-- required and before the unique index lands: Postgres treats NULLs as
-- distinct, so an index over a nullable office_id would not actually stop two
-- people with the same name from coexisting.
--
INSERT INTO "offices" ("code", "name") VALUES ('CT', 'Cape Town') ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "employees" SET "office_id" = (SELECT "id" FROM "offices" WHERE "code" = 'CT') WHERE "office_id" IS NULL;--> statement-breakpoint
UPDATE "uploads" SET "office_id" = (SELECT "id" FROM "offices" WHERE "code" = 'CT') WHERE "office_id" IS NULL;--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "office_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "uploads" ALTER COLUMN "office_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "office_closures" ADD CONSTRAINT "office_closures_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_closures" ADD CONSTRAINT "office_closures_date_calendar_days_date_fk" FOREIGN KEY ("date") REFERENCES "public"."calendar_days"("date") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offices_code_key" ON "offices" USING btree ("code");--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_aliases_employee_raw_name_key" ON "employee_aliases" USING btree ("employee_id","raw_name");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_office_key" ON "employees" USING btree ("office_id","normalised_key");