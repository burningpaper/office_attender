import Link from "next/link";
import { desc, sql } from "drizzle-orm";
import { RegisterClient } from "./register-client";
import { db } from "@/lib/db/client";
import { listOffices, resolveOffice } from "@/lib/db/offices";
import { attendance, reasons } from "@/lib/db/schema";
import { weekStart } from "@/lib/register/week";

export const dynamic = "force-dynamic";
export const metadata = { title: "Register · Office Attendance" };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string; week?: string }>;
}) {
  const params = await searchParams;
  const offices = await listOffices(db);
  const office = await resolveOffice(db, params.office);
  const week = weekStart(params.week ?? new Date().toISOString().slice(0, 10));

  /**
   * Offer the reasons already in use as suggestions.
   *
   * The old spreadsheets produced "On leave", "On Leave" and "on leave" as
   * three separate things. Offering what is already there is the cheapest way
   * to stop that happening again.
   */
  const common = await db
    .select({
      text: reasons.normalisedText,
      n: sql<number>`count(${attendance.employeeId})::int`,
    })
    .from(reasons)
    .leftJoin(attendance, sql`${attendance.reasonId} = ${reasons.id}`)
    .groupBy(reasons.normalisedText)
    .orderBy(desc(sql`count(${attendance.employeeId})`))
    .limit(12);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-7">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            Attendance register
            {office && offices.length > 1 && (
              <span className="ml-2 text-sm font-normal text-muted">{office.name}</span>
            )}
          </h1>
          <nav className="flex gap-2 text-sm">
            <Link href="/" className="rounded border border-border-soft px-2.5 py-1.5 text-muted transition-colors hover:border-border-strong hover:text-foreground">
              Report
            </Link>
            <Link href="/staff" className="rounded border border-border-soft px-2.5 py-1.5 text-muted transition-colors hover:border-border-strong hover:text-foreground">
              Staff list
            </Link>
          </nav>
        </div>
        <p className="mt-1 text-sm text-muted">
          Tick who was in the office. Saved as you go — there is no save button.
        </p>
      </header>

      <RegisterClient
        offices={offices}
        officeCode={office?.code}
        initialWeek={week}
        commonReasons={common.map((c) => c.text).filter(Boolean)}
      />

      <footer className="mt-8 border-t border-border-soft pt-4 text-xs text-subtle">
        <p>
          Only Wednesdays and Fridays appear, because they are the only days the policy
          counts. Public holidays and days the office was closed cannot be ticked.
        </p>
        <p className="mt-1">
          A comment marks the week as an explained absence, which counts against nobody.
          Anything recorded here is never overwritten by a later spreadsheet upload.
        </p>
      </footer>
    </main>
  );
}
