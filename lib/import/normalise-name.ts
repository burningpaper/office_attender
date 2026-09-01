/**
 * Name normalisation and similarity.
 *
 * The sheets spell the same person several ways: "zoe Flanegan" and "Zoe
 * Flanegan", "Zakiya Karim" and "Zakiyya Karim", trailing spaces on "Ben " and
 * "Ricardo ", a stray apostrophe on "Anthea O'Neill'". None of that needs a
 * model to sort out - it needs a normal form and one conservative similarity
 * rule.
 *
 * The rule has to be conservative because the roster contains genuine traps:
 * "Anthea O'Neill'" and "Ashley O'Neill'" are two people, as are "Jason Tucker"
 * and "Jason Khubeka". Merging those would silently combine two employees'
 * attendance into one record.
 */

/**
 * The normal form used as the identity key: casefolded, accent-stripped,
 * punctuation removed, hyphens treated as spaces, whitespace collapsed.
 *
 *   "zoe Flanegan"        -> "zoe flanegan"
 *   "Anthea O'Neill'"     -> "anthea oneill"
 *   "Kelly-Ann Tabone"    -> "kelly ann tabone"
 *   "Mary Rodrigues-Jack" -> "mary rodrigues jack"
 */
export function normaliseName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining accents
    .toLowerCase()
    .replace(/[-–—]/g, " ") // hyphenated names are the same name
    .replace(/[^a-z0-9\s]/g, "") // apostrophes, stray punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein edit distance, iterative with a single row of state. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    previous = current;
  }

  return previous[b.length];
}

/** Maximum edit distance between two spellings of one name. */
const MAX_DISTANCE = 2;
/** Below this length, a two-character edit is too much of the name to trust. */
const MIN_LENGTH = 8;

/**
 * Are these two normalised names probably the same person?
 *
 * Every condition has to hold:
 *
 *  - the same number of name parts, so "Matthew Rudd" cannot absorb
 *    "Matthew van Niekerk";
 *  - at least one part identical, so the match is anchored to something real
 *    rather than being two mutually fuzzy strings;
 *  - an edit distance of at most 2 across the whole name, which admits
 *    "zakiya karim"/"zakiyya karim" and refuses "jason tucker"/"jason khubeka";
 *  - a name long enough that two edits are a typo rather than a difference.
 *
 * Single-part names never match. "Brian" and "Intern" carry no surname, so
 * there is nothing to be confident about, and they go to a human instead.
 */
export function isProbablySamePerson(a: string, b: string): boolean {
  if (a === b) return true;

  const partsA = a.split(" ");
  const partsB = b.split(" ");

  if (partsA.length !== partsB.length) return false;
  if (partsA.length < 2) return false;
  if (Math.max(a.length, b.length) < MIN_LENGTH) return false;
  if (!partsA.some((part, i) => part === partsB[i])) return false;

  return levenshtein(a, b) <= MAX_DISTANCE;
}

/** Split a normalised name into a display-friendly first/last pair. */
export function splitName(firstName: string, lastName: string) {
  const first = firstName.replace(/\s+/g, " ").trim();
  const last = lastName.replace(/\s+/g, " ").trim();

  // Rows like June's "Weslee Johannesen" put the whole name in the first-name
  // column. Split on the last space so the surname lands where it belongs.
  if (!last && first.includes(" ")) {
    const parts = first.split(" ");
    return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
  }
  return { first, last };
}
