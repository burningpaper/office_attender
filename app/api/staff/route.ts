import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { resolveOffice } from "@/lib/db/offices";
import { parseWorkbook } from "@/lib/import/parse-workbook";
import { parseAddressText } from "@/lib/email/import-addresses";
import { splitName } from "@/lib/import/normalise-name";
import { applyStaffList, type StaffPerson } from "@/lib/staff/service";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Accept a staff list, as a spreadsheet or as pasted text.
 *
 * `save` is false by default: this replaces people wholesale and marks anybody
 * absent from the list as having left, so it is shown before it is done.
 */
export async function POST(request: Request) {
  const form = await request.formData();
  const office = await resolveOffice(db, form.get("office")?.toString());
  if (!office) return NextResponse.json({ error: "No office exists." }, { status: 400 });

  const save = form.get("save") === "true";
  const file = form.get("file");
  const text = form.get("text")?.toString();

  let people: StaffPerson[] = [];
  const skipped: { line: string; reason: string }[] = [];

  try {
    if (file instanceof File) {
      const parsed = parseWorkbook(Buffer.from(await file.arrayBuffer()));
      if (parsed.roster.length === 0) {
        return NextResponse.json(
          {
            error:
              "No staff list found in that file. It needs a tab with First Name, Last Name " +
              "and Email columns, and no date columns.",
          },
          { status: 422 },
        );
      }
      people = parsed.roster.map((p) => ({
        rawName: p.rawName,
        firstName: p.firstName,
        lastName: p.lastName,
        email: p.email,
      }));
    } else if (text?.trim()) {
      const { rows, invalid } = parseAddressText(text);
      skipped.push(...invalid);
      people = rows.map((row) => {
        const { first, last } = splitName(row.rawName, "");
        return { rawName: row.rawName, firstName: first, lastName: last, email: row.email };
      });
    } else {
      return NextResponse.json({ error: "Send a file or some text." }, { status: 400 });
    }

    if (people.length === 0) {
      return NextResponse.json({ error: "No people found in that list." }, { status: 422 });
    }

    const result = await applyStaffList(db, office.id, people, { dryRun: !save });
    return NextResponse.json({ ...result, skipped: [...result.skipped, ...skipped], saved: save, office });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "That list could not be read." },
      { status: 500 },
    );
  }
}
