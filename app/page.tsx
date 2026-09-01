import { sql } from "drizzle-orm";
import { ComplianceTable } from "./components/compliance-table";
import { loadEmployeeRows } from "@/lib/compliance/load";
import { db } from "@/lib/db/client";
import { attendance } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/** Today, as the server sees it. Overridable for looking at a past day. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; asOf?: string }>;
}) {
  const params = await searchParams;
  const asOf = params.asOf ?? today();
  const month = params.month ?? asOf.slice(0, 7);

  // The months that actually have data, for the picker.
  const monthRows = await db
    .select({ month: sql<string>`to_char(${attendance.date}, 'YYYY-MM')` })
    .from(attendance)
    .groupBy(sql`to_char(${attendance.date}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${attendance.date}, 'YYYY-MM')`);

  const months = monthRows.map((r) => r.month);
  if (!months.includes(month)) months.push(month);
  months.sort();

  const rows = await loadEmployeeRows(db, month, asOf);

  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  /**
   * How many required days have actually elapsed. Worth stating plainly at the
   * top: it is the denominator behind every verdict in the table, and when it
   * is zero the whole column reading "—" stops being alarming.
   */
  const elapsed = rows.find((r) => !r.isExempt);
  const elapsedRequired = elapsed
    ? elapsed.monthly.required + elapsed.monthly.excused
    : 0;

  /**
   * The month defaults to the current one, as specified - but on the 1st that
   * means every verdict is honestly "not yet", and the column is dead. Rather
   * than change the default, point at the last month that can actually answer
   * the question.
   */
  const previousMonth =
    elapsedRequired === 0
      ? months.filter((m) => m < month).sort().pop() ?? null
      : null;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-7">
        <h1 className="text-xl font-semibold tracking-tight">Office attendance</h1>
        <p className="mt-1 text-sm text-muted">
          {monthLabel} · Wednesdays and Fridays ·{" "}
          <span className="tabular">
            {elapsedRequired} required day{elapsedRequired === 1 ? "" : "s"} so far
          </span>
          {elapsedRequired === 0 && (
            <span className="text-subtle"> — the month has not started yet</span>
          )}
        </p>

        {previousMonth && (
          <p className="mt-3 rounded-md border border-border-soft bg-surface-muted px-3 py-2 text-sm text-muted">
            No required day has come round yet this month, so every verdict below
            reads &ldquo;not yet&rdquo;.{" "}
            <a
              href={`?month=${previousMonth}`}
              className="font-medium text-foreground underline underline-offset-2 transition-opacity hover:opacity-70"
            >
              Look at{" "}
              {new Date(`${previousMonth}-01T00:00:00Z`).toLocaleDateString("en-GB", {
                month: "long",
                timeZone: "UTC",
              })}{" "}
              instead
            </a>
            .
          </p>
        )}
      </header>

      <ComplianceTable rows={rows} month={month} asOf={asOf} months={months} />

      <footer className="mt-8 border-t border-border-soft pt-4 text-xs text-subtle">
        <p>
          Compliance counts only required days that have already happened, excludes public
          holidays, and treats an explained absence as neutral. Exempt people are hidden by
          default.
        </p>
        <p className="mt-1">
          Showing the report as at <span className="tabular">{asOf}</span>.
        </p>
      </footer>
    </main>
  );
}
