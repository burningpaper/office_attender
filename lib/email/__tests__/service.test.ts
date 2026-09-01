/**
 * The emailer against a real database, with the network stubbed.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as s from "../../db/schema";
import { freshDb, importDeclining } from "../../db/__tests__/helpers";
import { seedCalendar } from "../../db/seed-calendar";
import { loadRecipientList, sendCampaign } from "../service";

const WORKBOOK = path.resolve(__dirname, "../../../data_example.xls.xlsx");
let buffer: Buffer;

beforeAll(() => {
  if (!existsSync(WORKBOOK)) {
    throw new Error(
      `Fixture workbook not found at ${WORKBOOK}. It is excluded from git on ` +
        `purpose (real employee data). Copy it into the project root to run these tests.`,
    );
  }
  buffer = readFileSync(WORKBOOK);
  process.env.N8N_EMAIL_WEBHOOK_URL = "https://n8n.example/webhook/test";
  process.env.N8N_EMAIL_WEBHOOK_SECRET = "test-secret";
});

afterEach(() => vi.unstubAllGlobals());

async function seeded() {
  const ctx = await freshDb();
  await seedCalendar(ctx.db, 2026, 2026);
  await importDeclining(ctx.db, buffer, "data.xlsx");
  // Give everyone an undeliverable address so nothing can ever reach a person.
  await ctx.db.execute(
    sql`update employees set email = lower(replace(display_name, ' ', '.')) || '@example.invalid'`,
  );
  return ctx;
}

describe("building the list from real data", () => {
  it("never includes an exempt person", async () => {
    const ctx = await seeded();
    const { recipients, excluded } = await loadRecipientList(
      ctx.db, "MONTHLY", "2026-08", "2026-08-31",
    );

    const exemptNames = excluded.filter((e) => e.reason === "EXEMPT").map((e) => e.displayName);
    expect(exemptNames.sort()).toEqual([
      "Hannerie Lotz", "Jana Kleinloog", "Kelly-Ann Tabone", "Kevin Irwin",
      "Mary Rodrigues-Jack", "Rialene Nel", "Sandra McDiarmid",
    ]);
    for (const name of exemptNames) {
      expect(recipients.map((r) => r.displayName)).not.toContain(name);
    }
  }, 180_000);

  it("emails nobody at all for a month that has not happened", async () => {
    // Every September verdict is NA. NA is not a failure and must never be
    // mailed as one - this is the bug the whole system exists to avoid.
    const ctx = await seeded();
    const { recipients } = await loadRecipientList(
      ctx.db, "MONTHLY", "2026-09", "2026-09-01",
    );
    expect(recipients).toEqual([]);
  }, 180_000);

  it("skips anybody without an address", async () => {
    const ctx = await seeded();
    await ctx.db.update(s.employees).set({ email: null }).where(eq(s.employees.displayName, "Ben Clay"));

    const { recipients, excluded } = await loadRecipientList(
      ctx.db, "MONTHLY", "2026-08", "2026-08-31",
    );
    expect(recipients.map((r) => r.displayName)).not.toContain("Ben Clay");
    expect(excluded).toContainEqual({ displayName: "Ben Clay", reason: "NO_EMAIL" });
  }, 180_000);
});

describe("sending", () => {
  it("records every message, with the dates it quoted", async () => {
    const ctx = await seeded();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const { recipients } = await loadRecipientList(ctx.db, "MONTHLY", "2026-08", "2026-08-31");
    const three = recipients.slice(0, 3).map((r) => r.employeeId);

    const result = await sendCampaign(ctx.db, {
      category: "MONTHLY", month: "2026-08", asOf: "2026-08-31",
      subject: "Office attendance", body: "A note.", dryRun: false,
      onlyEmployeeIds: three,
    });

    expect(result.sent).toBe(3);
    const rows = await ctx.db.select().from(s.emailSends);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe("SENT");
      expect(row.sentAt).not.toBeNull();
      expect(row.bodyHtml).toContain("You did not attend on");
      expect(Array.isArray(row.missedDates)).toBe(true);
      expect(row.batchId).toBe(result.batchId);
    }
  }, 180_000);

  it("records a failure as FAILED, with the reason", async () => {
    const ctx = await seeded();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "mailbox full" }), { status: 400 })));

    const { recipients } = await loadRecipientList(ctx.db, "MONTHLY", "2026-08", "2026-08-31");
    const result = await sendCampaign(ctx.db, {
      category: "MONTHLY", month: "2026-08", asOf: "2026-08-31",
      subject: "s", body: "b", dryRun: false,
      onlyEmployeeIds: [recipients[0].employeeId],
    });

    expect(result.failed).toBe(1);
    const [row] = await ctx.db.select().from(s.emailSends);
    expect(row.status).toBe("FAILED");
    expect(row.error).toBe("mailbox full");
    expect(row.sentAt).toBeNull();
  }, 180_000);

  it("writes nothing to the audit trail on a dry run", async () => {
    const ctx = await seeded();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, dryRun: true }), { status: 200 })));

    const { recipients } = await loadRecipientList(ctx.db, "MONTHLY", "2026-08", "2026-08-31");
    const result = await sendCampaign(ctx.db, {
      category: "MONTHLY", month: "2026-08", asOf: "2026-08-31",
      subject: "s", body: "b", dryRun: true,
      onlyEmployeeIds: [recipients[0].employeeId],
    });

    expect(result.dryRun).toBe(true);
    expect(await ctx.db.select().from(s.emailSends)).toHaveLength(0);
  }, 180_000);

  it("refuses to run with no webhook configured", async () => {
    const ctx = await seeded();
    const saved = process.env.N8N_EMAIL_WEBHOOK_URL;
    delete process.env.N8N_EMAIL_WEBHOOK_URL;

    await expect(
      sendCampaign(ctx.db, {
        category: "MONTHLY", month: "2026-08", asOf: "2026-08-31",
        subject: "s", body: "b", dryRun: true,
      }),
    ).rejects.toThrow(/N8N_EMAIL_WEBHOOK_URL/);

    process.env.N8N_EMAIL_WEBHOOK_URL = saved;
  }, 180_000);
});
