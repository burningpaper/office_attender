import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { sendCampaign } from "@/lib/email/service";
import type { EmailCategory } from "@/lib/email/recipients";

export const runtime = "nodejs";
export const maxDuration = 300;

const CATEGORIES: EmailCategory[] = ["MONTHLY", "TWO_WEEK", "LONG_TERM"];

/**
 * Send, or dry run.
 *
 * `dryRun` defaults to true. Sending real mail to real people has to be asked
 * for explicitly - a missing or malformed flag must never fall through to
 * "send it".
 */
export async function POST(request: Request) {
  let payload: {
    category?: string;
    month?: string;
    asOf?: string;
    subject?: string;
    body?: string;
    dryRun?: unknown;
    onlyEmployeeIds?: number[];
    confirm?: string;
  };

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const category = payload.category as EmailCategory | undefined;
  if (!category || !CATEGORIES.includes(category)) {
    return NextResponse.json({ error: "Unknown category." }, { status: 400 });
  }
  if (!payload.month || !/^\d{4}-\d{2}$/.test(payload.month)) {
    return NextResponse.json({ error: "A month is required, as YYYY-MM." }, { status: 400 });
  }
  if (!payload.subject?.trim()) {
    return NextResponse.json({ error: "A subject is required." }, { status: 400 });
  }
  if (!payload.body?.trim()) {
    return NextResponse.json({ error: "A message is required." }, { status: 400 });
  }

  const dryRun = payload.dryRun !== false;

  /**
   * A real send needs the word typed out. The confirmation is checked on the
   * server, not just in the browser, so no amount of clicking about in the
   * network tab can shortcut it.
   */
  if (!dryRun && payload.confirm !== "SEND") {
    return NextResponse.json(
      { error: 'A real send must be confirmed by passing confirm: "SEND".' },
      { status: 428 },
    );
  }

  try {
    const result = await sendCampaign(db, {
      category,
      month: payload.month,
      asOf: payload.asOf ?? new Date().toISOString().slice(0, 10),
      subject: payload.subject.trim(),
      body: payload.body,
      dryRun,
      onlyEmployeeIds: payload.onlyEmployeeIds,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The send failed." },
      { status: 500 },
    );
  }
}
