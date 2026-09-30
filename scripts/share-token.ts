/**
 * Makes a token for the public week, and tells you what to do with it.
 *
 *   npm run share:token
 *
 * Generating a new one does not publish anything on its own: the page reads
 * PUBLIC_SHARE_TOKEN from the environment, so the link only starts working
 * once the token is set there. Setting a different one revokes every copy of
 * the old link at the same moment.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { TOKEN_BYTES } from "../lib/share/token";

config({ path: ".env.local" });

const token = randomBytes(TOKEN_BYTES).toString("hex");
const existing = process.env.PUBLIC_SHARE_TOKEN?.trim();
const base = process.env.APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

console.log(`\n  New token: ${token}\n`);

if (existing) {
  console.log("  PUBLIC_SHARE_TOKEN is already set. Replacing it will break the");
  console.log("  link anybody is currently using, which is how you revoke one.\n");
}

console.log("  1. Put this line in .env.local:\n");
console.log(`       PUBLIC_SHARE_TOKEN=${token}\n`);
console.log("  2. For the deployed site, set the same variable there");
console.log("     (on Vercel: vercel env add PUBLIC_SHARE_TOKEN production).\n");
console.log("  3. Restart the server, then share:\n");
console.log(`       ${base}/share/${token}\n`);
