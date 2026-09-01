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

/** How long a session lasts before it has to be established again. */
export const SESSION_DURATION_SECONDS = 60 * 60 * 12;

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

/** Is this token ours, and still current? */
export async function verifySessionToken(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;

  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;

  const expected = base64url(await hmac(secret, payload));
  if (!constantTimeEquals(signature, expected)) return false;

  try {
    const { exp } = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    return typeof exp === "number" && exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
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
