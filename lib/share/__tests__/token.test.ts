/**
 * The secret in the URL.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isValidShareToken } from "../token";

const original = process.env.PUBLIC_SHARE_TOKEN;
afterEach(() => {
  if (original === undefined) delete process.env.PUBLIC_SHARE_TOKEN;
  else process.env.PUBLIC_SHARE_TOKEN = original;
});

describe("the share token", () => {
  it("accepts the configured token", () => {
    process.env.PUBLIC_SHARE_TOKEN = "k7f3p9x2m4qh8w";
    expect(isValidShareToken("k7f3p9x2m4qh8w")).toBe(true);
  });

  it("rejects a wrong one, including a prefix of the right one", () => {
    process.env.PUBLIC_SHARE_TOKEN = "k7f3p9x2m4qh8w";
    expect(isValidShareToken("k7f3p9x2m4qh8")).toBe(false);
    expect(isValidShareToken("k7f3p9x2m4qh8x")).toBe(false);
    expect(isValidShareToken("K7F3P9X2M4QH8W")).toBe(false);
  });

  it("refuses everything when no token is configured", () => {
    // The dangerous failure is a deployment that forgot to set it and
    // published the company's attendance to anybody who visited /share/.
    delete process.env.PUBLIC_SHARE_TOKEN;
    expect(isValidShareToken("anything")).toBe(false);
    expect(isValidShareToken("")).toBe(false);
    expect(isValidShareToken(undefined)).toBe(false);
  });

  it("treats a blank token as not configured", () => {
    process.env.PUBLIC_SHARE_TOKEN = "   ";
    expect(isValidShareToken("   ")).toBe(false);
    expect(isValidShareToken("")).toBe(false);
  });
});
