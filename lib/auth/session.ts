/**
 * Session tokens.
 *
 * A single shared password guards the whole application, which is the right
 * weight for one person looking at their own company's attendance. What it must
 * not be is casual: the app holds named employees, reasons for absence
 * including illness and maternity leave, and everybody's work email address.
 *
 * Web Crypto throughout, because this runs in the proxy (edge runtime) where
 * node:crypto is unavailable.
 */

const encoder = new TextEncoder();

/**
 * How long a session lasts without being used.
 *
 * Thirty days, and it slides: every request more than halfway through the
 * window issues a fresh cookie, so somebody who uses this weekly never signs in
 * again, while an abandoned session still dies thirty days after its last use.
 *
 * Twelve hours was the first guess and it meant logging in every morning, which
 * is the kind of friction that gets a password written on a sticky note.
 */
export const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30;

/**
 * Reissue the cookie once a session is this far through its life.
 *
 * Half, so an ordinary week of use always renews, without re-signing on every
 * single request.
 */
export const SESSION_RENEW_AFTER_SECONDS = SESSION_DURATION_SECONDS / 2;

export const SESSION_COOKIE = "office_attendance_session";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/**
 * Compare without leaking where two strings differ.
 *
 * A plain === returns as soon as it finds a mismatch, so how long it takes
 * says something about how much of the value was right. That is a real attack
 * on a password check, if a slow one.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** Issue a signed token that expires. */
export async function createSessionToken(
  secret: string,
  now = Date.now(),
): Promise<string> {
  const payload = base64url(
    encoder.encode(
      JSON.stringify({ exp: Math.floor(now / 1000) + SESSION_DURATION_SECONDS }),
    ),
  );
  const signature = base64url(await hmac(secret, payload));
  return `${payload}.${signature}`;
}

export type SessionState =
  | { valid: false }
  /** Valid, with the moment it runs out and whether it is due a refresh. */
  | { valid: true; expiresAt: number; shouldRenew: boolean };

/**
 * Check a token and report how much life it has left.
 *
 * Returning the expiry rather than a bare boolean is what makes sliding
 * sessions possible: the proxy needs to know whether to hand back a fresh
 * cookie, and only the token can say.
 */
export async function readSessionToken(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<SessionState> {
  if (!token) return { valid: false };

  const [payload, signature] = token.split(".");
  if (!payload || !signature) return { valid: false };

  const expected = base64url(await hmac(secret, payload));
  if (!constantTimeEquals(signature, expected)) return { valid: false };

  try {
    const { exp } = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    if (typeof exp !== "number") return { valid: false };

    const seconds = Math.floor(now / 1000);
    if (exp <= seconds) return { valid: false };

    return {
      valid: true,
      expiresAt: exp,
      shouldRenew: exp - seconds < SESSION_RENEW_AFTER_SECONDS,
    };
  } catch {
    return { valid: false };
  }
}

/** Is this token ours, and still current? */
export async function verifySessionToken(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  return (await readSessionToken(token, secret, now)).valid;
}

/**
 * Paths that stay open.
 *
 * Deliberately a short, explicit list rather than a pattern with exceptions:
 * everything else is closed, so a new route is private the moment it is
 * created rather than whenever somebody remembers to protect it.
 */
const PUBLIC_PATHS = ["/login", "/api/auth/login"];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  // Next's own assets, and the favicon.
  return (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt"
  );
}
