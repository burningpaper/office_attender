import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { resolveOffice } from "@/lib/db/offices";
import { loadWeek, saveEntry } from "@/lib/register/service";
import { weekStart } from "@/lib/register/week";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const office = await resolveOffice(db, url.searchParams.get("office") ?? undefined);
  if (!office) return NextResponse.json({ error: "No office exists." }, { status: 400 });

  const week = url.searchParams.get("week") ?? new Date().toISOString().slice(0, 10);
  return NextResponse.json({
    office,
    ...(await loadWeek(db, office.id, weekStart(week))),
  });
}

/** Save one person's day. One call per tick keeps failures local. */
export async function POST(request: Request) {
  let payload: {
    office?: string;
    employeeId?: number;
    date?: string;
    present?: boolean;
    comment?: string | null;
  };

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const office = await resolveOffice(db, payload.office);
  if (!office) return NextResponse.json({ error: "No office exists." }, { status: 400 });

  if (typeof payload.employeeId !== "number" || !payload.date) {
    return NextResponse.json({ error: "An employee and a date are required." }, { status: 400 });
  }

  try {
    const result = await saveEntry(db, office.id, {
      employeeId: payload.employeeId,
      date: payload.date,
      present: payload.present === true,
      comment: payload.comment ?? null,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save." },
      { status: 400 },
    );
  }
}
