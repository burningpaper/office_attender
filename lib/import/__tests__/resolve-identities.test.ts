import { describe, expect, it } from "vitest";
import { resolveIdentities } from "../resolve-identities";
import type { ParsedEmployeeRow } from "../types";

const row = (firstName: string, lastName = ""): ParsedEmployeeRow => ({
  sheetName: "March",
  rowNumber: 2,
  firstName,
  lastName,
  rawName: `${firstName} ${lastName}`.trim(),
  standingNote: null,
  email: null,
});

describe("resolveIdentities", () => {
  it("collapses spelling variants onto one person", () => {
    const out = resolveIdentities([row("Zakiya", "Karim"), row("Zakiyya", "Karim")]);
    const keys = new Set(out.map((r) => r.employeeId ?? r.normalisedKey));
    // Both rows resolve to the same identity - one is NEW, the other matches it.
    expect(out).toHaveLength(2);
    expect(new Set(out.map((r) => r.matchType))).toEqual(new Set(["NEW", "SIMILARITY"]));
    expect(keys.size).toBeLessThanOrEqual(2);
  });

  it("treats a case difference as the same person with no review needed", () => {
    const out = resolveIdentities([row("Zoe", "Flanegan"), row("zoe", "Flanegan")]);
    expect(out.map((r) => r.normalisedKey)).toEqual(["zoe flanegan", "zoe flanegan"]);
    expect(out.some((r) => r.needsReview)).toBe(false);
  });

  it("keeps two people who share a surname apart", () => {
    const out = resolveIdentities([row("Anthea", "O'Neill'"), row("Ashley", "O'Neill'")]);
    expect(out.every((r) => r.matchType === "NEW")).toBe(true);
    expect(new Set(out.map((r) => r.normalisedKey)).size).toBe(2);
  });

  it("flags a name with no surname instead of guessing", () => {
    const out = resolveIdentities([row("Brian"), row("Intern"), row("Ben", "Clay")]);
    const flagged = out.filter((r) => r.needsReview);
    expect(flagged.map((r) => r.rawName).sort()).toEqual(["Brian", "Intern"]);
    for (const f of flagged) {
      expect(f.matchType).toBe("NEW"); // created, never merged
      expect(f.reviewReason).toMatch(/no surname/i);
    }
  });

  it("reuses a known employee by exact normalised key", () => {
    const out = resolveIdentities(
      [row("zoe", "Flanegan")],
      [{ id: 7, normalisedKey: "zoe flanegan", displayName: "Zoe Flanegan" }],
    );
    expect(out[0]).toMatchObject({ matchType: "EXACT", employeeId: 7, needsReview: false });
  });

  it("prefers a confirmed alias over everything else", () => {
    const out = resolveIdentities(
      [row("Brian")],
      [{ id: 3, normalisedKey: "brian wiid", displayName: "Brian Wiid" }],
      new Map([["Brian", 3]]),
    );
    expect(out[0]).toMatchObject({ matchType: "ALIAS", employeeId: 3, needsReview: false });
  });

  it("marks similarity matches for review rather than trusting them silently", () => {
    const out = resolveIdentities(
      [row("Zakiyya", "Karim")],
      [{ id: 9, normalisedKey: "zakiya karim", displayName: "Zakiya Karim" }],
    );
    expect(out[0]).toMatchObject({ matchType: "SIMILARITY", employeeId: 9, needsReview: true });
    expect(out[0].reviewReason).toMatch(/similarity/i);
  });

  it("is order-independent, so repeat imports decide the same way", () => {
    const rows = [row("Ben", "Clay"), row("Zoe", "Flanegan"), row("Brian")];
    const a = resolveIdentities(rows);
    const b = resolveIdentities([...rows].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
