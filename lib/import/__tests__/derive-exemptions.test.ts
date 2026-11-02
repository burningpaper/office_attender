import { describe, expect, it } from "vitest";
import { deriveExemption } from "../derive-exemptions";

describe("deriveExemption", () => {
  it("exempts people who live too far to commute", () => {
    for (const note of [
      "Stays in George", "From George", "Stays in Hermanus",
      "From Hermanus", "Stays in Paarl", "From Paarl", "Stays in Lagebaan",
    ]) {
      expect(deriveExemption(note), note).toMatchObject({
        type: "REMOTE_LOCATION",
        exempts: true,
      });
    }
  });

  it("exempts parental leave", () => {
    expect(deriveExemption("On Maternity Leave")).toMatchObject({
      type: "PARENTAL_LEAVE",
      exempts: true,
    });
  });

  it("does NOT exempt a WFH approval that names particular days", () => {
    // "every Thursday" is an arrangement for one day of the week. An exemption
    // here applies to every required day or none, so acting on this would
    // excuse the Wednesday and Friday it says nothing about. Recorded, flagged,
    // and left to a person.
    const derived = deriveExemption("Approved to work from home every Thursday")!;
    expect(derived.type).toBe("APPROVED_WFH");
    expect(derived.exempts).toBe(false);
    expect(derived.reviewReason).toMatch(/names particular days/i);
    expect(derived.reviewReason).toMatch(/thursday/i);
  });

  it("does exempt a blanket WFH arrangement", () => {
    const derived = deriveExemption("Full-time WFH")!;
    expect(derived.exempts).toBe(true);
  });

  it("treats a blanket WFH approval as an exemption, but asks", () => {
    const result = deriveExemption("Approved to work from home");
    expect(result).toMatchObject({ type: "APPROVED_WFH", exempts: true });
    expect(result!.reviewReason).toMatch(/confirm/i);
  });

  it("records an unrecognised note without exempting anyone", () => {
    const result = deriveExemption("Something nobody anticipated");
    expect(result).toMatchObject({ type: "OTHER", exempts: false });
  });

  it("ignores an empty note", () => {
    expect(deriveExemption("")).toBeNull();
    expect(deriveExemption("   ")).toBeNull();
  });
});
