import { describe, expect, it } from "vitest";
import { classifyCell } from "../classify-cell";

describe("classifyCell", () => {
  it("reads the binary grid", () => {
    expect(classifyCell("1")).toEqual({ state: "PRESENT", reasonText: null });
    expect(classifyCell("0")).toEqual({ state: "ABSENT", reasonText: null });
    expect(classifyCell("")).toEqual({ state: "ABSENT", reasonText: null });
  });

  it("treats free text as an explained absence, keeping the text", () => {
    expect(classifyCell("On leave")).toEqual({
      state: "ABSENT_EXPLAINED",
      reasonText: "On leave",
    });
    expect(classifyCell("  Sick  ")).toEqual({
      state: "ABSENT_EXPLAINED",
      reasonText: "Sick",
    });
    // Even something odd is an explanation - stage 5 decides what it means.
    expect(classifyCell("Plumbing situation").state).toBe("ABSENT_EXPLAINED");
    expect(classifyCell('"Office closed"').state).toBe("ABSENT_EXPLAINED");
  });
});
