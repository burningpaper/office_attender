/**
 * Matching email addresses to people.
 *
 * The workbook has never contained an address, so they arrive separately - as
 * pasted "Name, email" lines. Matching reuses the same normalised key that
 * resolved 84 name spellings to 82 people, so the spellings that were already
 * reconciled do not have to be reconciled again.
 *
 * Nothing is guessed. A line that does not match an existing person is reported
 * rather than creating one, because an unknown name here almost always means a
 * typo or somebody who has left, not a new employee.
 */

import { normaliseName } from "../import/normalise-name";

export type AddressRow = {
  rawName: string;
  email: string;
};

export type AddressMatch = {
  rawName: string;
  email: string;
  employeeId: number;
  displayName: string;
  /** They already had a different address on file. */
  replaces?: string;
};

export type AddressImportResult = {
  matched: AddressMatch[];
  unmatched: { rawName: string; email: string; reason: string }[];
  invalid: { line: string; reason: string }[];
};

/** Deliberately permissive - the workflow validates properly before sending. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Parse pasted text. Accepts "Name, email", "Name<TAB>email", or a bare
 * address, one per line. A header row naming the columns is skipped.
 */
export function parseAddressText(text: string): {
  rows: AddressRow[];
  invalid: { line: string; reason: string }[];
} {
  const rows: AddressRow[] = [];
  const invalid: { line: string; reason: string }[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(name|full\s*name|employee)\s*[,\t;]\s*e?-?mail/i.test(line)) continue;

    const parts = line.split(/[,\t;]/).map((p) => p.trim());
    const email = parts.find((p) => EMAIL.test(p));

    if (!email) {
      invalid.push({ line, reason: "No email address found on this line." });
      continue;
    }

    const name = parts.filter((p) => p !== email).join(" ").trim();
    if (!name) {
      // A bare address: the local part is the best name guess available.
      const guess = email.split("@")[0].replace(/[._-]+/g, " ").trim();
      rows.push({ rawName: guess, email: email.toLowerCase() });
      continue;
    }

    rows.push({ rawName: name, email: email.toLowerCase() });
  }

  return { rows, invalid };
}

export type KnownPerson = {
  id: number;
  displayName: string;
  normalisedKey: string;
  email: string | null;
  /** Every spelling of this person's name already on record. */
  aliases: string[];
};

/** Match parsed rows to people. Exact normalised key, then known aliases. */
export function matchAddresses(
  rows: AddressRow[],
  people: KnownPerson[],
): AddressImportResult {
  const byKey = new Map(people.map((p) => [p.normalisedKey, p]));
  const byAlias = new Map<string, KnownPerson>();
  for (const person of people) {
    for (const alias of person.aliases) byAlias.set(normaliseName(alias), person);
  }

  const matched: AddressMatch[] = [];
  const unmatched: { rawName: string; email: string; reason: string }[] = [];
  const claimed = new Set<number>();

  for (const row of rows) {
    const key = normaliseName(row.rawName);
    const person = byKey.get(key) ?? byAlias.get(key);

    if (!person) {
      unmatched.push({
        rawName: row.rawName,
        email: row.email,
        reason: `No employee matches "${row.rawName}".`,
      });
      continue;
    }

    if (claimed.has(person.id)) {
      unmatched.push({
        rawName: row.rawName,
        email: row.email,
        reason: `${person.displayName} already has an address in this paste.`,
      });
      continue;
    }

    claimed.add(person.id);
    matched.push({
      rawName: row.rawName,
      email: row.email,
      employeeId: person.id,
      displayName: person.displayName,
      ...(person.email && person.email !== row.email ? { replaces: person.email } : {}),
    });
  }

  return { matched, unmatched, invalid: [] };
}
