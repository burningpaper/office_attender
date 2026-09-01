/**
 * Turns the standing notes in the sheet's comment column into exemption records.
 *
 * Deterministic, and deliberately unwilling to exempt anyone on a guess. An
 * exemption removes a person from the report entirely, so a wrong one hides a
 * genuine problem - the expensive direction of error.
 *
 * The notes in seven months of data are:
 *
 *   Stays in George / From George / Stays in Hermanus / From Hermanus
 *   Stays in Paarl / From Paarl / Stays in Lagebaan     -> too far to commute
 *   On Maternity Leave                                  -> parental leave
 *   Approved to work from home every Thursday           -> NOT an exemption
 *
 * That last one matters. Thursday is not a required day, so an approval to work
 * from home on Thursdays says nothing about Wednesday and Friday attendance.
 * Treating it as a blanket exemption would quietly excuse someone who is in
 * fact expected in the office on both required days.
 */

export type DerivedExemption = {
  type: "REMOTE_LOCATION" | "PARENTAL_LEAVE" | "APPROVED_WFH" | "OTHER";
  rawText: string;
  /** Whether this note actually excuses the required days. */
  exempts: boolean;
  reviewReason?: string;
};

/** "Stays in George", "From Paarl", "Lives in Hermanus". */
const REMOTE = /\b(stays?|lives?|based)\s+in\b|\bfrom\s+(george|hermanus|paarl|lagebaan|langebaan|durban|jhb|johannesburg|pretoria|cape\s*town)\b/i;
const PARENTAL = /\b(maternity|paternity|parental)\b/i;
const WFH = /\b(work\s*from\s*home|wfh|remote)\b/i;

export function deriveExemption(note: string): DerivedExemption | null {
  const text = note.trim();
  if (!text) return null;

  if (REMOTE.test(text)) {
    return { type: "REMOTE_LOCATION", rawText: text, exempts: true };
  }

  if (PARENTAL.test(text)) {
    return { type: "PARENTAL_LEAVE", rawText: text, exempts: true };
  }

  if (WFH.test(text)) {
    /**
     * Only a blanket arrangement excuses the required days. An approval naming
     * specific days is scoped to those days, and Wednesday and Friday are the
     * only ones that count.
     */
    const namesARequiredDay = /\b(wednesday|weds?|friday|fri)\b/i.test(text);
    const namesAnyWeekday =
      /\b(monday|mon|tuesday|tues?|wednesday|weds?|thursday|thurs?|friday|fri)\b/i.test(text);

    if (namesAnyWeekday && !namesARequiredDay) {
      return {
        type: "APPROVED_WFH",
        rawText: text,
        exempts: false,
        reviewReason:
          `"${text}" covers a day that is not a required day, so it does not excuse ` +
          `Wednesday or Friday attendance. Recorded, but not treated as an exemption.`,
      };
    }

    return {
      type: "APPROVED_WFH",
      rawText: text,
      exempts: true,
      reviewReason: `"${text}" is being treated as a standing exemption. Confirm that is right.`,
    };
  }

  return {
    type: "OTHER",
    rawText: text,
    exempts: false,
    reviewReason: `"${text}" was not recognised as an exemption. Recorded for review.`,
  };
}
