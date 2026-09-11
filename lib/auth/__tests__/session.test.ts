import { describe, expect, it } from "vitest";
import {
  SESSION_DURATION_SECONDS,
  SESSION_RENEW_AFTER_SECONDS,
  constantTimeEquals,
  createSessionToken,
  isPublicPath,
  readSessionToken,
  verifySessionToken,
} from "../session";

const SECRET = "a-secret-that-is-long-enough-to-be-a-secret";

describe("session tokens", () => {
  it("accepts a token it just issued", async () => {
    const token = await createSessionToken(SECRET);
    expect(await verifySessionToken(token, SECRET)).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken(SECRET);
    expect(await verifySessionToken(token, "some-other-secret")).toBe(false);
  });

  it("rejects a tampered payload", async () => {
    // The obvious attack: keep the signature, extend the expiry.
    const token = await createSessionToken(SECRET);
    const [, signature] = token.split(".");
    const forged = btoa(JSON.stringify({ exp: 9_999_999_999 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifySessionToken(`${forged}.${signature}`, SECRET)).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const token = await createSessionToken(SECRET);
    const [payload] = token.split(".");
    expect(await verifySessionToken(`${payload}.deadbeef`, SECRET)).toBe(false);
  });

  it("expires", async () => {
    const issued = Date.now();
    const token = await createSessionToken(SECRET, issued);

    const justBefore = issued + (SESSION_DURATION_SECONDS - 10) * 1000;
    expect(await verifySessionToken(token, SECRET, justBefore)).toBe(true);

    const justAfter = issued + (SESSION_DURATION_SECONDS + 10) * 1000;
    expect(await verifySessionToken(token, SECRET, justAfter)).toBe(false);
  });

  it("rejects nonsense without throwing", async () => {
    for (const bad of [undefined, "", "no-dot", "a.b.c", "....", "%%%.%%%"]) {
      expect(await verifySessionToken(bad, SECRET), String(bad)).toBe(false);
    }
  });
});

describe("staying signed in", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("lasts a month rather than a working day", () => {
    // Twelve hours meant signing in every morning, which is the kind of
    // friction that gets a password written on a sticky note.
    expect(SESSION_DURATION_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it("does not ask for a refresh while the session is young", async () => {
    const issued = Date.now();
    const token = await createSessionToken(SECRET, issued);
    const state = await readSessionToken(token, SECRET, issued + DAY);
    expect(state).toMatchObject({ valid: true, shouldRenew: false });
  });

  it("asks for a refresh once past halfway", async () => {
    const issued = Date.now();
    const token = await createSessionToken(SECRET, issued);
    const past = issued + (SESSION_RENEW_AFTER_SECONDS + 60) * 1000;
    expect(await readSessionToken(token, SECRET, past)).toMatchObject({
      valid: true,
      shouldRenew: true,
    });
  });

  it("keeps somebody signed in indefinitely if they keep using it", async () => {
    /**
     * Simulates a year of weekly use: each visit that is past halfway hands
     * back a fresh token, so the window never runs out.
     */
    let token = await createSessionToken(SECRET, Date.now());
    let now = Date.now();

    for (let week = 0; week < 52; week++) {
      now += 7 * DAY;
      const state = await readSessionToken(token, SECRET, now);
      expect(state.valid, `week ${week}`).toBe(true);
      if (state.valid && state.shouldRenew) token = await createSessionToken(SECRET, now);
    }
  });

  it("still expires a session nobody comes back to", async () => {
    const issued = Date.now();
    const token = await createSessionToken(SECRET, issued);
    const muchLater = issued + (SESSION_DURATION_SECONDS + 60) * 1000;
    expect(await readSessionToken(token, SECRET, muchLater)).toEqual({ valid: false });
  });

  it("will not renew a forged token", async () => {
    const token = await createSessionToken(SECRET, Date.now());
    const [payload] = token.split(".");
    expect(await readSessionToken(`${payload}.forged`, SECRET)).toEqual({ valid: false });
  });
});

describe("constantTimeEquals", () => {
  it("compares correctly", () => {
    expect(constantTimeEquals("secret", "secret")).toBe(true);
    expect(constantTimeEquals("secret", "secreT")).toBe(false);
    expect(constantTimeEquals("secret", "secrets")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });
});

describe("which paths stay open", () => {
  it("opens only the login route and static assets", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/login")).toBe(true);
    expect(isPublicPath("/_next/static/chunk.js")).toBe(true);
    expect(isPublicPath("/favicon.ico")).toBe(true);
  });

  it("closes everything that shows or changes employee data", () => {
    for (const path of [
      "/", "/upload", "/email", "/email/addresses",
      "/api/email/recipients", "/api/email/send", "/api/email/addresses",
      "/api/import/preview", "/api/import/commit", "/api/auth/logout",
    ]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });

  it("is not fooled by a path that merely starts with an open one", () => {
    // "/login-as-someone-else" is not "/login".
    expect(isPublicPath("/login/../api/email/send")).toBe(false);
    expect(isPublicPath("/loginx")).toBe(false);
    expect(isPublicPath("/api/auth/login/extra")).toBe(false);
  });

  it("closes a route nobody has thought of yet", () => {
    // The list is explicit, so anything new is private by default.
    expect(isPublicPath("/api/some/route/added/next/year")).toBe(false);
  });
});
