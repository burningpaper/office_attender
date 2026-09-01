import { NextResponse } from "next/server";
import { importWorkbook } from "@/lib/import/import-workbook";
import { db } from "@/lib/db/client";
import type { AnomalyResolution } from "@/lib/import/anomalies";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Commit an import.
 *
 * The file is sent again rather than held server-side between preview and
 * approval. It is small, and it means there is no half-finished import sitting
 * anywhere waiting to be forgotten about. The sha256 in the response confirms
 * the bytes that were approved are the bytes that were written.
 */
export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  const raw = form.get("resolutions");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was uploaded." }, { status: 400 });
  }

  let resolutions: AnomalyResolution[] = [];
  if (typeof raw === "string" && raw.trim()) {
    try {
      resolutions = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Malformed decisions." }, { status: 400 });
    }
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const report = await importWorkbook(db, buffer, file.name, { resolutions });
    // A refusal is a normal outcome, not an error - it means a question is open.
    return NextResponse.json(report, { status: report.blockedBy ? 409 : 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The import failed." },
      { status: 500 },
    );
  }
}
