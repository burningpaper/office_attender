import Link from "next/link";
import { sql } from "drizzle-orm";
import { EmailClient } from "./email-client";
import { db } from "@/lib/db/client";
import { attendance, employees } from "@/lib/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Email · Office Attendance" };

export default async function EmailPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; asOf?: string }>;
}) {
  const params = await searchParams;
  const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);

  const monthRows = await db
    .select({ month: sql<string>`to_char(${attendance.date}, 'YYYY-MM')` })
    .from(attendance)
    .groupBy(sql`to_char(${attendance.date}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${attendance.date}, 'YYYY-MM')`);
  const months = monthRows.map((r) => r.month);

  /**
   * Default to the last month with data rather than the current one. On the
   * 1st nobody is non-compliant yet - every verdict is "not yet" - so the
   * current month would open on an empty list and look broken.
   */
  const month = params.month ?? months[months.length - 1] ?? asOf.slice(0, 7);

  const [{ total, withEmail }] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withEmail: sql<number>`count(${employees.email})::int`,
    })
    .from(employees);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-7">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Email non-compliant people</h1>
          <nav className="flex gap-2 text-sm">
            <Link href="/" className="rounded border border-border-soft px-2.5 py-1.5 text-muted transition-colors hover:border-border-strong hover:text-foreground">
              Report
            </Link>
            <Link href="/email/addresses" className="rounded border border-border-soft px-2.5 py-1.5 text-muted transition-colors hover:border-border-strong hover:text-foreground">
              Addresses
            </Link>
          </nav>
        </div>
        <p className="mt-1 text-sm text-muted">
          <span className="tabular">{withEmail}</span> of{" "}
          <span className="tabular">{total}</span> people have an email address.
          {withEmail < total && (
            <>
              {" "}
              <Link href="/email/addresses" className="underline underline-offset-2">
                Add the rest
              </Link>
              .
            </>
          )}
        </p>
      </header>

      {months.length === 0 ? (
        <p className="rounded-md border border-border-soft bg-surface-muted px-3 py-3 text-sm text-muted">
          There is no attendance data yet.{" "}
          <Link href="/upload" className="underline underline-offset-2">Upload a workbook</Link> first.
        </p>
      ) : (
        <EmailClient months={months} month={month} asOf={asOf} />
      )}

      <footer className="mt-8 border-t border-border-soft pt-4 text-xs text-subtle">
        <p>
          Nobody who has left is emailed, and neither is anybody exempt, whatever their
          verdict. Nor anybody whose verdict is &ldquo;not yet&rdquo; — that means the
          question could not be answered, not that they failed.
        </p>
        <p className="mt-1">
          Each message quotes only that person&rsquo;s own dates. Everything sent is recorded.
        </p>
        <p className="mt-1">
          Sent from{" "}
          <span className="tabular">
            {process.env.OFFICE_ATTENDANCE_SENDER ?? "(no sender configured)"}
          </span>
          . Run a dry run to confirm before sending.
        </p>
      </footer>
    </main>
  );
}
