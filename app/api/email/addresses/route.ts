import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { matchAddresses, parseAddressText } from "@/lib/email/import-addresses";
import { loadPeopleForMatching, saveAddresses } from "@/lib/email/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Preview a paste, or save it. Nothing is written unless `save` is true. */
export async function POST(request: Request) {
  const payload = (await request.json()) as { text?: string; save?: boolean };

  if (!payload.text?.trim()) {
    return NextResponse.json({ error: "Nothing to import." }, { status: 400 });
  }

  const { rows, invalid } = parseAddressText(payload.text);
  const people = await loadPeopleForMatching(db);
  const result = matchAddresses(rows, people);
  result.invalid = invalid;

  if (payload.save && result.matched.length > 0) {
    await saveAddresses(
      db,
      result.matched.map((m) => ({ employeeId: m.employeeId, email: m.email })),
    );
  }

  return NextResponse.json({ ...result, saved: payload.save === true });
}

/** How many people currently have an address. */
export async function GET() {
  const people = await loadPeopleForMatching(db);
  return NextResponse.json({
    total: people.length,
    withEmail: people.filter((p) => p.email).length,
    missing: people.filter((p) => !p.email).map((p) => p.displayName).sort(),
  });
}
