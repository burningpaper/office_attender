import Link from "next/link";
import { UploadClient } from "./upload-client";

export const metadata = { title: "Upload · Office Attendance" };

export default function UploadPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-7">
        <h1 className="text-xl font-semibold tracking-tight">Upload the workbook</h1>
        <p className="mt-1 text-sm text-muted">
          Every upload is read in full and compared against what is already stored. Nothing
          is written until you have seen the result and answered anything ambiguous.
        </p>
      </header>

      <UploadClient />

      <footer className="mt-8 border-t border-border-soft pt-4 text-xs text-subtle">
        <p>
          Re-uploading a file that has already been imported does nothing. Uploading a
          corrected version updates the dates that changed and records what changed.
        </p>
        <p className="mt-2">
          <Link href="/" className="underline underline-offset-2">Back to the report</Link>
        </p>
      </footer>
    </main>
  );
}
