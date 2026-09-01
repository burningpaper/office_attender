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

  it("does NOT exempt a WFH approval that names a non-required day", () => {
    // Thursday is not a required day, so this says nothing about Wed/Fri.
    const result = deriveExemption("Approved to work from home every Thursday");
    expect(result).toMatchObject({ type: "APPROVED_WFH", exempts: false });
    expect(result!.reviewReason).toMatch(/not a required day/i);
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
