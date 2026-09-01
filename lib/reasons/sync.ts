/**
 * Classifies the reason strings the database does not yet understand.
 *
 * The selection rule is the whole point: only rows still marked UNKNOWN and not
 * yet reviewed by a person are ever sent. Run it twice and the second run sends
 * nothing, because there is nothing left that needs an answer.
 */

import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as s from "../db/schema";
import { MODEL, type Classifier } from "./classify";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type SyncReport = {
  /** Strings that needed an answer and were sent. */
  sent: number;
  /** Rows updated with a new category. */
  updated: number;
  /** Strings already classified, or already asked about, which were not sent. */
  skipped: number;
  /** Strings the model could not place. Left for a person, but not re-asked. */
  unresolved: number;
  /** True when no request was made at all. */
  noCallMade: boolean;
  byCategory: Record<string, number>;
};

export async function syncReasonClassifications(
  db: Db,
  classifier: Classifier,
): Promise<SyncReport> {
  const all = await db.select().from(s.reasons);

  /**
   * Only strings nobody has an answer for yet.
   *
   * `model` being null is the record of "never asked". Without it, a note the
   * model legitimately could not place - "Sent Msg on Teams" says only that
   * someone sent a message - would be re-sent on every single run, forever, to
   * be told the same thing again. Stamping the attempt makes UNKNOWN a settled
   * outcome rather than an open question.
   *
   * A reason a person has reviewed is never re-sent either: that verdict was
   * theirs, and the model does not get to overrule it.
   */
  const pending = all.filter(
    (r) => r.category === "UNKNOWN" && r.model === null && !r.reviewedByHuman,
  );

  const report: SyncReport = {
    sent: pending.length,
    updated: 0,
    skipped: all.length - pending.length,
    unresolved: 0,
    noCallMade: pending.length === 0,
    byCategory: {},
  };

  if (pending.length === 0) return report;

  const classifications = await classifier.classify(pending.map((r) => r.rawText));

  for (const c of classifications) {
    /**
     * UNKNOWN is still written back - the category stays UNKNOWN so a person
     * sees it needs attention, but `model` records that we asked, so we do not
     * ask again.
     */
    await db
      .update(s.reasons)
      .set({
        category: c.category,
        normalisedText: c.normalisedText,
        confidence: c.confidence,
        model: MODEL,
      })
      .where(and(eq(s.reasons.rawText, c.rawText), eq(s.reasons.reviewedByHuman, false)));

    if (c.category === "UNKNOWN") report.unresolved++;
    else report.updated++;

    report.byCategory[c.category] = (report.byCategory[c.category] ?? 0) + 1;
  }

  return report;
}
