/**
 * The secret in the URL.
 *
 * This is the whole of the access control on the public week, which is a thin
 * thing to rest on, so it is worth being precise about what it does and does
 * not do. It stops the page being found - by a crawler, by somebody trying
 * /attendance, by anybody who has not been given the link. It does nothing at
 * all once the link is forwarded. That is the deal a shareable link makes, and
 * the reason the page shows first names and no reasons.
 *
 * Rotating PUBLIC_SHARE_TOKEN revokes every copy of the old link at once.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** 32 hex characters: 128 bits, which is not getting guessed. */
export const TOKEN_BYTES = 16;

/**
 * Compare without leaking the answer in the timing.
 *
 * Hashed first so the comparison is over two equal-length digests. Comparing
 * the raw strings would return early on the first wrong character and let
 * somebody recover the token one character at a time.
 */
function equals(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Whether this token opens the public page.
 *
 * An unset or blank PUBLIC_SHARE_TOKEN means no, for every token including the
 * empty one. A misconfigured deployment must not accidentally publish the
 * company's attendance to anybody who visits /share/.
 */
export function isValidShareToken(token: string | undefined): boolean {
  const expected = process.env.PUBLIC_SHARE_TOKEN?.trim();
  if (!expected) return false;
  if (!token) return false;
  return equals(token, expected);
}
