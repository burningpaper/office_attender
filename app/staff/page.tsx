import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { StaffClient } from "./staff-client";
import { db } from "@/lib/db/client";
import { listOffices, resolveOffice } from "@/lib/db/offices";
import { employees } from "@/lib/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Staff list · Office Attendance" };

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>;
}) {
  const params = await searchParams;
  const offices = await listOffices(db);
  const office = await resolveOffice(db, params.office);

  const [counts] = office
    ? await db
        .select({
          total: sql<number>`count(*)::int`,
          active: sql<number>`count(*) filter (where ${employees.status} = 'ACTIVE')::int`,
        })
        .from(employees)
        .where(eq(employees.officeId, office.id))
    : [{ total: 0, active: 0 }];

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-7">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            Staff list
            {office && offices.length > 1 && (
              <span className="ml-2 text-sm font-normal text-muted">{office.name}</span>
            )}
          </h1>
          <nav className="flex gap-2 text-sm">
            <Link href="/register" className="rounded border border-border-soft px-2.5 py-1.5 text-muted transition-colors hover:border-border-strong hover:text-foreground">
              Register
            </Link>
            <Link href="/" className="rounded border border-border-soft px-2.5 py-1.5 text-muted transition-colors hover:border-border-strong hover:text-foreground">
              Report
            </Link>
          </nav>
        </div>
        <p className="mt-1 text-sm text-muted">
          {office ? (
            <>
              <span className="tabular">{counts.active}</span> active of{" "}
              <span className="tabular">{counts.total}</span> on record. This list decides who
              appears in the register.
            </>
          ) : (
            "No offices yet."
          )}
        </p>
      </header>

      <StaffClient offices={offices} officeCode={office?.code} />

      <footer className="mt-8 border-t border-border-soft pt-4 text-xs text-subtle">
        <p>
          The list is the whole truth about who works here: anybody on it is active, anybody
          absent from it is marked as having left. Their attendance history is kept either way.
        </p>
        <p className="mt-1">
          Names are matched against people already on record, including spellings seen before,
          so re-uploading a list does not create duplicates.
        </p>
      </footer>
    </main>
  );
}
