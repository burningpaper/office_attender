/**
 * Tests for reason normalisation.
 *
 * The model is stubbed. What is being tested is everything around it: that the
 * right strings are sent, that a second run sends nothing, that no employee
 * name can reach a prompt, and that a mangled response degrades safely.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as s from "../../db/schema";
import { freshDb } from "../../db/__tests__/helpers";
import {
  buildSystemPrompt,
  buildUserPrompt,
  reconcile,
  type Classifier,
  type ReasonClassification,
} from "../classify";
import { syncReasonClassifications } from "../sync";
import { REASON_CATEGORIES } from "../vocabulary";

/** The real strings, straight from the sample data. */
const REAL_REASONS = [
  "On leave", "Sick", "On Leave", "JHB", "In JHB", "on leave", "Off Sick",
  "At Cannes", "Pretoria", "Fam Emerg", "B/day Leave", "BOOKED OFF SICK",
  '"Office closed"', "son at ER", "Plumbing situation", "Sent Msg on Teams",
  "WFH", "Booke off for the rest of the week", "Moved house", "Car Problems",
];

/** A stub that answers plausibly and counts how often it was asked. */
function stubClassifier(overrides: Record<string, string> = {}) {
  const calls: string[][] = [];
  const classifier: Classifier = {
    async classify(texts) {
      calls.push(texts);
      return texts.map((rawText) => ({
        rawText,
        category: (overrides[rawText] ?? guess(rawText)) as ReasonClassification["category"],
        normalisedText: rawText.trim(),
        confidence: 0.9,
      }));
    },
  };
  return { classifier, calls };
}

function guess(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("office closed")) return "PUBLIC_HOLIDAY_OR_CLOSURE";
  if (t.includes("sick")) return "SICK";
  if (t.includes("leave") || t.includes("booke")) return "ANNUAL_LEAVE";
  if (t.includes("jhb") || t.includes("cannes") || t.includes("pretoria")) return "TRAVEL_OTHER_OFFICE";
  if (t.includes("wfh")) return "WFH_APPROVED";
  if (t.includes("fam") || t.includes("son at")) return "FAMILY_RESPONSIBILITY";
  if (t.includes("plumbing") || t.includes("car") || t.includes("moved")) return "PERSONAL_EMERGENCY";
  return "UNKNOWN";
}

async function seedReasons(texts: string[]) {
  const ctx = await freshDb();
  await ctx.db
    .insert(s.reasons)
    .values(texts.map((rawText) => ({ rawText, category: "UNKNOWN" as const, normalisedText: rawText })));
  return ctx;
}

describe("what gets sent", () => {
  it("sends every unclassified string in one request", async () => {
    const ctx = await seedReasons(REAL_REASONS);
    const { classifier, calls } = stubClassifier();

    const report = await syncReasonClassifications(ctx.db, classifier);

    expect(calls).toHaveLength(1); // batched, not one call per string
    expect(calls[0]).toHaveLength(REAL_REASONS.length);
    expect(report.sent).toBe(REAL_REASONS.length);
  });

  it("makes zero model calls on a second run", async () => {
    const ctx = await seedReasons(REAL_REASONS);
    const { classifier, calls } = stubClassifier();

    await syncReasonClassifications(ctx.db, classifier);
    const second = await syncReasonClassifications(ctx.db, classifier);

    expect(second.noCallMade).toBe(true);
    expect(second.sent).toBe(0);
    expect(calls).toHaveLength(1); // still just the first run's call
  });

  it("never re-sends a classification a person has reviewed", async () => {
    const ctx = await seedReasons(["Sent Msg on Teams"]);
    await ctx.db
      .update(s.reasons)
      .set({ reviewedByHuman: true })
      .where(eq(s.reasons.rawText, "Sent Msg on Teams"));

    const { classifier, calls } = stubClassifier();
    const report = await syncReasonClassifications(ctx.db, classifier);

    expect(calls).toHaveLength(0);
    expect(report.skipped).toBe(1);
  });

  it("leaves a genuine UNKNOWN visible, but does not ask twice", async () => {
    // "Sent Msg on Teams" gives no reason for the absence. The model saying so
    // is a settled answer, not an open question.
    const ctx = await seedReasons(["Sent Msg on Teams"]);
    const { classifier, calls } = stubClassifier({ "Sent Msg on Teams": "UNKNOWN" });

    const first = await syncReasonClassifications(ctx.db, classifier);
    expect(first.updated).toBe(0);
    expect(first.unresolved).toBe(1);

    const [row] = await ctx.db.select().from(s.reasons);
    expect(row.category).toBe("UNKNOWN"); // still flagged for a person
    expect(row.model).toBe("claude-opus-5"); // but we know we asked

    const second = await syncReasonClassifications(ctx.db, classifier);
    expect(second.noCallMade).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("the spelling variants finally collapse", () => {
  it("maps On leave / On Leave / on leave to one category", async () => {
    const ctx = await seedReasons(["On leave", "On Leave", "on leave"]);
    const { classifier } = stubClassifier();

    await syncReasonClassifications(ctx.db, classifier);

    const rows = await ctx.db.select().from(s.reasons);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.category))).toEqual(new Set(["ANNUAL_LEAVE"]));
  });

  it("treats an office closure as a closure, not a personal absence", async () => {
    const ctx = await seedReasons(['"Office closed"']);
    const { classifier } = stubClassifier();

    await syncReasonClassifications(ctx.db, classifier);

    const [row] = await ctx.db.select().from(s.reasons);
    expect(row.category).toBe("PUBLIC_HOLIDAY_OR_CLOSURE");
  });

  it("records the model and confidence it used", async () => {
    const ctx = await seedReasons(["Sick"]);
    const { classifier } = stubClassifier();
    await syncReasonClassifications(ctx.db, classifier);

    const [row] = await ctx.db.select().from(s.reasons);
    expect(row.model).toBe("claude-opus-5");
    expect(row.confidence).toBeCloseTo(0.9);
    expect(row.reviewedByHuman).toBe(false);
  });
});

describe("privacy", () => {
  it("puts no employee name anywhere in the prompt", () => {
    // Only distinct reason strings are ever sent. Nothing identifies anyone.
    const prompt = buildSystemPrompt() + "\n" + buildUserPrompt(REAL_REASONS);
    for (const name of [
      "Kevin", "Irwin", "Zakiya", "Karim", "Flanegan", "Rodrigues-Jack",
      "Hannerie", "Lotz", "McDiarmid", "Tabone", "O'Neill",
    ]) {
      expect(prompt, `prompt must not contain "${name}"`).not.toContain(name);
    }
  });

  it("sends only the reason strings themselves", () => {
    const prompt = buildUserPrompt(["Sick", "On leave"]);
    expect(prompt).toContain("Sick");
    expect(prompt).toContain("On leave");
    expect(prompt.split("\n").filter((l) => /^\d+\./.test(l))).toHaveLength(2);
  });

  it("offers every category to the model", () => {
    const prompt = buildSystemPrompt();
    for (const category of REASON_CATEGORIES) expect(prompt).toContain(category);
  });
});

describe("when the model misbehaves", () => {
  it("degrades a dropped entry to UNKNOWN rather than misattributing it", () => {
    // If answers were matched by position, "Sick" would inherit JHB's category.
    const result = reconcile(
      ["Sick", "JHB", "On leave"],
      [
        { rawText: "Sick", category: "SICK", normalisedText: "Sick", confidence: 0.9 },
        { rawText: "On leave", category: "ANNUAL_LEAVE", normalisedText: "On leave", confidence: 0.9 },
      ],
    );
    expect(result.map((r) => [r.rawText, r.category])).toEqual([
      ["Sick", "SICK"],
      ["JHB", "UNKNOWN"],
      ["On leave", "ANNUAL_LEAVE"],
    ]);
  });

  it("is not fooled by reordering", () => {
    const result = reconcile(
      ["A", "B"],
      [
        { rawText: "B", category: "SICK", normalisedText: "B", confidence: 1 },
        { rawText: "A", category: "ANNUAL_LEAVE", normalisedText: "A", confidence: 1 },
      ],
    );
    expect(result[0]).toMatchObject({ rawText: "A", category: "ANNUAL_LEAVE" });
    expect(result[1]).toMatchObject({ rawText: "B", category: "SICK" });
  });

  it("does not call the model when there is nothing to ask", async () => {
    const ctx = await freshDb();
    const classify = vi.fn();
    const report = await syncReasonClassifications(ctx.db, { classify } as unknown as Classifier);
    expect(classify).not.toHaveBeenCalled();
    expect(report.noCallMade).toBe(true);
  });
});
