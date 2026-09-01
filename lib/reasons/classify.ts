/**
 * Reason normalisation — the one place a model is used in this system.
 *
 * It is used narrowly and for a reason. The attendance grid is already clean
 * binary data, so parsing it with a model would be slow, expensive and
 * non-deterministic. What genuinely needs language understanding is the 35
 * free-text notes people typed where a 0 or 1 should have gone: "On leave",
 * "On Leave", "on leave", "booked off", "B/day Leave", "son at ER".
 *
 * Three properties matter:
 *
 *  - **No employee names are ever sent.** Only the distinct reason strings go
 *    into the prompt, with no identifiers attached. That is both correct under
 *    POPIA and, conveniently, cheaper.
 *  - **The database is the cache, not the prompt.** Every classification is
 *    stored against the exact raw string, so a given string is classified once
 *    in the life of the system. In steady state a monthly upload sends nothing
 *    at all. Prompt caching is not the lever here - not calling is.
 *  - **A wrong answer is cheap.** Under the agreed policy any recorded reason
 *    excuses the day, so a misclassification changes a label in the interface,
 *    never a verdict about a person.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CATEGORY_GUIDE, REASON_CATEGORIES } from "./vocabulary";
import type { ReasonCategory } from "./vocabulary";

export const MODEL = "claude-opus-5";

const ClassificationSchema = z.object({
  classifications: z.array(
    z.object({
      rawText: z.string().describe("The input string, copied back exactly and unchanged."),
      category: z.enum(REASON_CATEGORIES),
      normalisedText: z
        .string()
        .describe("A tidy, human-readable version of the note, in sentence case."),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export type ReasonClassification = {
  rawText: string;
  category: ReasonCategory;
  normalisedText: string;
  confidence: number;
};

/** Injectable so the logic can be tested without a network or an API key. */
export interface Classifier {
  classify(texts: string[]): Promise<ReasonClassification[]>;
}

export function buildSystemPrompt(): string {
  const categories = REASON_CATEGORIES.map(
    (c) => `- ${c}: ${CATEGORY_GUIDE[c]}`,
  ).join("\n");

  return `You are normalising the free-text notes people typed into an office attendance spreadsheet, in place of a tick, to explain why they were not in the office that day.

These are terse notes jotted into a cell, not sentences. They are abbreviated, inconsistently capitalised, and sometimes misspelled. The workplace is a South African advertising agency with offices in Cape Town and Johannesburg.

Context that helps read them:
- "JHB" is Johannesburg; "Jhb", "In JHB" and "In Jhb this week" all mean the same thing. Durban, Pretoria and George are other South African cities.
- "Fam Res" is Family Responsibility Leave, a distinct entitlement in South African labour law.
- "Booked off" means signed off work, usually sick. "B/day" is birthday.
- "Cannes" is the Cannes Lions advertising festival — a work trip, not a holiday.
- Notes may be typo'd: "Booke off" means "Booked off".

Classify each note into exactly one category:

${categories}

Rules:
- Return exactly one entry per input string, in the same order.
- Copy rawText back byte-for-byte. Do not trim, correct or re-case it.
- normalisedText is a tidy human-readable version for display, in sentence case.
- Judge only what the note says. If it does not give a reason for the absence — "Sent Msg on Teams" says only that someone sent a message — use UNKNOWN rather than inferring one.
- confidence reflects how clearly the note supports the category, from 0 to 1.`;
}

export function buildUserPrompt(texts: string[]): string {
  return `Classify these ${texts.length} notes:\n\n${texts
    .map((t, i) => `${i + 1}. ${JSON.stringify(t)}`)
    .join("\n")}`;
}

/**
 * The real classifier. Batches every string into one request - 35 notes is a
 * few thousand tokens, so splitting them would cost more than it saved.
 */
export function createAnthropicClassifier(client = new Anthropic()): Classifier {
  return {
    async classify(texts) {
      if (texts.length === 0) return [];

      const response = await client.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        system: buildSystemPrompt(),
        messages: [{ role: "user", content: buildUserPrompt(texts) }],
        output_config: { format: zodOutputFormat(ClassificationSchema) },
      });

      const parsed = response.parsed_output;
      if (!parsed) {
        throw new Error("The model's response did not match the expected schema.");
      }

      return reconcile(texts, parsed.classifications);
    },
  };
}

/**
 * Match the model's answers back to the strings we asked about.
 *
 * Matching on the returned rawText rather than trusting array position means a
 * dropped or reordered entry becomes an explicit UNKNOWN instead of quietly
 * attaching one note's category to a different note.
 */
export function reconcile(
  requested: string[],
  returned: ReasonClassification[],
): ReasonClassification[] {
  const byText = new Map(returned.map((c) => [c.rawText, c]));

  return requested.map((rawText) => {
    const match = byText.get(rawText);
    if (match) return { ...match, rawText };
    return {
      rawText,
      category: "UNKNOWN" as const,
      normalisedText: rawText,
      confidence: 0,
    };
  });
}
