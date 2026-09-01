/**
 * Classifies the reason strings the database does not yet understand.
 *
 *   npm run reasons:classify            # the real call
 *   npm run reasons:classify -- --show  # print what would be sent, call nothing
 *
 * Safe to re-run: a string is classified once in the life of the system.
 */
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../lib/db/schema";
import { buildSystemPrompt, buildUserPrompt, createAnthropicClassifier } from "../lib/reasons/classify";
import { syncReasonClassifications } from "../lib/reasons/sync";
import { reasons as reasonsTable } from "../lib/db/schema";

config({ path: ".env.local" });

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set — see .env.example");

const showOnly = process.argv.includes("--show");

async function main() {
  const db = drizzle(neon(url!), { schema });

  if (showOnly) {
    const all = await db.select().from(reasonsTable);
    const pending = all.filter((r) => r.category === "UNKNOWN" && r.model === null);
    console.log(`${pending.length} of ${all.length} strings would be sent.\n`);
    console.log("--- system prompt ---");
    console.log(buildSystemPrompt());
    console.log("\n--- user prompt ---");
    console.log(buildUserPrompt(pending.map((r) => r.rawText)));
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error(
      "No Anthropic credentials found.\n" +
        "Set ANTHROPIC_API_KEY in .env.local, or run `ant auth login`.\n" +
        "Use --show to see exactly what would be sent without calling anything.",
    );
    process.exit(1);
  }

  const report = await syncReasonClassifications(db, createAnthropicClassifier()).catch(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);

      if (/credit balance is too low/i.test(message)) {
        console.error(
          "The API key and workspace are correct, but the account has no credits.\n\n" +
            "Add credits at console.anthropic.com → Plans & Billing, then re-run.\n" +
            "This job is one request covering 35 strings — a few cents at most.\n\n" +
            "Nothing else is blocked: the app works with reasons left unclassified,\n" +
            "and running this later reclassifies them without a re-import.",
        );
        process.exit(1);
      }

      if (/anthropic-workspace-id/i.test(message)) {
        console.error(
          "This API key is identity-linked, so it must name the workspace it acts in.\n\n" +
            "Add to .env.local:\n  ANTHROPIC_WORKSPACE_ID=wrkspc_...\n\n" +
            "Find it in the Anthropic Console under Settings → Workspaces (the id in\n" +
            "the workspace's URL). Then re-run this command.",
        );
        process.exit(1);
      }

      throw error;
    },
  );

  if (report.noCallMade) {
    console.log(`Nothing to classify — all ${report.skipped} strings are already settled.`);
    return;
  }

  console.log(`Sent ${report.sent} strings in one request.`);
  console.log(`  classified   ${report.updated}`);
  console.log(`  unresolved   ${report.unresolved} (left as UNKNOWN for a person to rule on)`);
  console.log(`  not sent     ${report.skipped} (already settled)`);
  console.log(`\n  by category:`);
  for (const [category, n] of Object.entries(report.byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${category.padEnd(28)} ${n}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
