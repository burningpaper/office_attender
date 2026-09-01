import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { loadRecipientList } from "@/lib/email/service";
import type { EmailCategory } from "@/lib/email/recipients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORIES: EmailCategory[] = ["MONTHLY", "TWO_WEEK", "LONG_TERM"];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const category = url.searchParams.get("category") as EmailCategory | null;
  const month = url.searchParams.get("month");
  const asOf = url.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);

  if (!category || !CATEGORIES.includes(category)) {
    return NextResponse.json({ error: "Unknown category." }, { status: 400 });
  }
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "A month is required, as YYYY-MM." }, { status: 400 });
  }

  const list = await loadRecipientList(db, category, month, asOf);
  return NextResponse.json(list);
}
