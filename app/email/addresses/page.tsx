import Link from "next/link";
import { AddressesClient } from "./addresses-client";
import { db } from "@/lib/db/client";
import { loadPeopleForMatching } from "@/lib/email/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Addresses · Office Attendance" };

export default async function AddressesPage() {
  const people = await loadPeopleForMatching(db);
  const missing = people.filter((p) => !p.email).map((p) => p.displayName).sort();

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-7">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Email addresses</h1>
          <Link href="/email" className="rounded border border-border-soft px-2.5 py-1.5 text-sm text-muted transition-colors hover:border-border-strong hover:text-foreground">
            Back to email
          </Link>
        </div>
        <p className="mt-1 text-sm text-muted">
          <span className="tabular">{people.length - missing.length}</span> of{" "}
          <span className="tabular">{people.length}</span> people have an address. The
          attendance workbook has never contained one, so they come from here.
        </p>
      </header>

      <AddressesClient missing={missing} />
    </main>
  );
}
