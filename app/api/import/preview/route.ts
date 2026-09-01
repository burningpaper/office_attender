import { NextResponse } from "next/server";
import { importWorkbook } from "@/lib/import/import-workbook";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Parse and report, writing nothing. */
export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was uploaded." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const report = await importWorkbook(db, buffer, file.name, { dryRun: true });
    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The file could not be read." },
      { status: 422 },
    );
  }
}
