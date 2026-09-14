import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { resolveOffice } from "@/lib/db/offices";
import { addPerson, updatePerson, type PersonAction } from "@/lib/staff/service";

export const runtime = "nodejs";

const ACTIONS: PersonAction[] = ["LEAVE", "RESTORE", "UNTRACK", "TRACK"];

export async function POST(request: Request) {
  let payload: {
    office?: string;
    employeeId?: number;
    action?: string;
    reason?: string;
    name?: string;
    email?: string;
  };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const office = await resolveOffice(db, payload.office);
  if (!office) return NextResponse.json({ error: "No office exists." }, { status: 400 });

  if (payload.action === "ADD") {
    try {
      const result = await addPerson(db, office.id, {
        name: payload.name ?? "",
        email: payload.email ?? null,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Could not add them." },
        { status: 400 },
      );
    }
  }

  const action = payload.action as PersonAction | undefined;
  if (!action || !ACTIONS.includes(action)) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  if (typeof payload.employeeId !== "number") {
    return NextResponse.json({ error: "An employee is required." }, { status: 400 });
  }

  try {
    const result = await updatePerson(
      db, office.id, payload.employeeId, action, payload.reason,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update." },
      { status: 400 },
    );
  }
}
