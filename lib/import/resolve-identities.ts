/**
 * Turns the 84 distinct name strings in the workbook into real people.
 *
 * Deterministic throughout - exact key, then known alias, then one conservative
 * similarity rule. No model is involved, and in this dataset none is needed:
 * every genuine variant is a case difference, a stray space, or a one-character
 * typo. What the rules cannot settle is escalated rather than guessed.
 */

import { isProbablySamePerson, normaliseName, splitName } from "./normalise-name";
import type { ParsedEmployeeRow } from "./types";

export type MatchType =
  /** Normalised key already known. */
  | "EXACT"
  /** Seen before under this exact raw spelling. */
  | "ALIAS"
  /** Matched by the similarity rule - recorded, but shown in the report. */
  | "SIMILARITY"
  /** Nobody like this exists yet. */
  | "NEW";

export type ResolvedIdentity = {
  rawName: string;
  normalisedKey: string;
  firstName: string;
  lastName: string;
  displayName: string;
  matchType: MatchType;
  /** Existing employee id, when matched to somebody already in the database. */
  employeeId?: number;
  /**
   * The normalised key of the person this row belongs to.
   *
   * Needed because a similarity match can land on someone created earlier in
   * the same run, who has no database id yet. Grouping by this key is what
   * makes "Zakiya Karim" and "Zakiyya Karim" one employee when both arrive in
   * the same file, rather than two rows that merely think they matched.
   */
  canonicalKey: string;
  /** The normalised key this was matched to, for SIMILARITY matches. */
  matchedKey?: string;
  /**
   * Whether a person should look at this before it is trusted. True for
   * similarity matches and for names with no surname.
   */
  needsReview: boolean;
  reviewReason?: string;
};

export type KnownEmployee = {
  id: number;
  normalisedKey: string;
  displayName: string;
};

/** Raw name -> employee id, for spellings already confirmed. */
export type KnownAliases = Map<string, number>;

/**
 * Resolve every parsed row to an identity.
 *
 * Rows are processed in a stable order so that repeated imports of the same
 * file produce the same decisions - which is what makes a re-import a no-op.
 */
export function resolveIdentities(
  rows: ParsedEmployeeRow[],
  knownEmployees: KnownEmployee[] = [],
  knownAliases: KnownAliases = new Map(),
): ResolvedIdentity[] {
  const byKey = new Map(knownEmployees.map((e) => [e.normalisedKey, e]));
  /** Keys created during this run, so two spellings in one file converge. */
  const createdKeys = new Map<string, ResolvedIdentity>();

  const distinct = [...new Set(rows.map((r) => r.rawName))].sort();
  const firstRowFor = new Map<string, ParsedEmployeeRow>();
  for (const row of rows) {
    if (!firstRowFor.has(row.rawName)) firstRowFor.set(row.rawName, row);
  }

  const results: ResolvedIdentity[] = [];

  for (const rawName of distinct) {
    const row = firstRowFor.get(rawName)!;
    const { first, last } = splitName(row.firstName, row.lastName);
    const displayName = [first, last].filter(Boolean).join(" ");
    const key = normaliseName(displayName || rawName);

    const base = {
      rawName,
      normalisedKey: key,
      firstName: first,
      lastName: last,
      displayName,
    };

    // 1. A spelling we have already confirmed.
    const aliasId = knownAliases.get(rawName);
    if (aliasId !== undefined) {
      results.push({
        ...base,
        matchType: "ALIAS",
        employeeId: aliasId,
        canonicalKey: key,
        needsReview: false,
      });
      continue;
    }

    // 2. The normal form is already a known person.
    const exact = byKey.get(key);
    if (exact) {
      results.push({
        ...base,
        matchType: "EXACT",
        employeeId: exact.id,
        canonicalKey: exact.normalisedKey,
        needsReview: false,
      });
      continue;
    }

    // 3. Another spelling in this same file already resolved to this person.
    const createdExact = createdKeys.get(key);
    if (createdExact) {
      results.push({
        ...base,
        matchType: "EXACT",
        employeeId: createdExact.employeeId,
        canonicalKey: createdExact.canonicalKey,
        needsReview: false,
      });
      continue;
    }

    // 4. The similarity rule, against known people and this run's new ones.
    const candidates = [
      ...[...byKey.values()].map((e) => ({
        id: e.id as number | undefined,
        canonicalKey: e.normalisedKey,
        normalisedKey: e.normalisedKey,
        displayName: e.displayName,
      })),
      ...[...createdKeys.values()].map((c) => ({
        id: c.employeeId,
        canonicalKey: c.canonicalKey,
        normalisedKey: c.normalisedKey,
        displayName: c.displayName,
      })),
    ];
    const similar = candidates.find((c) => isProbablySamePerson(key, c.normalisedKey));
    if (similar) {
      results.push({
        ...base,
        matchType: "SIMILARITY",
        employeeId: similar.id,
        // The match belongs to the other person, id or no id.
        canonicalKey: similar.canonicalKey,
        matchedKey: similar.normalisedKey,
        needsReview: true,
        reviewReason: `Matched to "${similar.displayName}" by spelling similarity.`,
      });
      continue;
    }

    // 5. Nobody like this. A name with no surname cannot be trusted as new.
    const noSurname = !last;
    const resolved: ResolvedIdentity = {
      ...base,
      matchType: "NEW",
      canonicalKey: key,
      needsReview: noSurname,
      ...(noSurname
        ? { reviewReason: `"${rawName}" has no surname, so it cannot be matched automatically. Confirm whether this is a new person or an existing one.` }
        : {}),
    };
    results.push(resolved);
    createdKeys.set(key, resolved);
  }

  return results;
}
