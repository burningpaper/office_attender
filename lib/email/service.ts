/**
 * Database-facing helpers for the emailer. Keeps the pure logic pure.
 */

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { loadEmployeeRows } from "../compliance/load";
import * as s from "../db/schema";
import { buildRecipients, type EmailCategory, type RecipientList } from "./recipients";
import { renderEmail } from "./render";
import { sendBatch, type SendOutcome } from "./send";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export async function loadRecipientList(
  db: Db,
  category: EmailCategory,
  month: string,
  asOf: string,
): Promise<RecipientList> {
  const rows = await loadEmployeeRows(db, month, asOf);
  const people = await db
    .select({ id: s.employees.id, email: s.employees.email })
    .from(s.employees);

  const emailByEmployeeId = new Map<number, string>();
  for (const person of people) {
    if (person.email) emailByEmployeeId.set(person.id, person.email);
  }

  return buildRecipients(rows, category, emailByEmployeeId, asOf);
}

export type SendResult = {
  batchId: string;
  dryRun: boolean;
  sent: number;
  failed: number;
  /**
   * Set when the request named people who are no longer in the category.
   *
   * The browser holds a list built at page load; this recomputes it at send
   * time. If the two disagree - the page has been open since yesterday, the
   * month rolled over, somebody re-imported - the intersection can be empty,
   * and the result is a silent no-op that looks exactly like a broken button.
   * Saying so is the difference between a bug report and a reload.
   */
  nothingToSend?: string;
  /** The mailbox these went from, as reported by Microsoft on a dry run. */
  sendAs?: string;
  outcomes: SendOutcome[];
};

/**
 * Render, record, send, then record what happened.
 *
 * The audit row is written *before* the send, as PENDING, so a crash midway
 * leaves evidence that a message was attempted rather than a silent gap.
 */
export async function sendCampaign(
  db: Db,
  input: {
    category: EmailCategory;
    month: string;
    asOf: string;
    subject: string;
    body: string;
    dryRun: boolean;
    /** Only these employees, when the operator has deselected some. */
    onlyEmployeeIds?: number[];
  },
): Promise<SendResult> {
  const webhookUrl = process.env.N8N_EMAIL_WEBHOOK_URL;
  const secret = process.env.N8N_EMAIL_WEBHOOK_SECRET;
  if (!webhookUrl || !secret) {
    throw new Error(
      "N8N_EMAIL_WEBHOOK_URL and N8N_EMAIL_WEBHOOK_SECRET must be set — see .env.example.",
    );
  }

  const { recipients } = await loadRecipientList(db, input.category, input.month, input.asOf);
  const chosen = input.onlyEmployeeIds
    ? recipients.filter((r) => input.onlyEmployeeIds!.includes(r.employeeId))
    : recipients;

  if (chosen.length === 0) {
    return {
      batchId: randomUUID(),
      dryRun: input.dryRun,
      sent: 0,
      failed: 0,
      nothingToSend:
        recipients.length === 0
          ? `Nobody is in this category for ${input.month} any more, so there was nothing to send.`
          : `None of the ${input.onlyEmployeeIds?.length ?? 0} selected people are still in this category for ${input.month}. The page may have been open a while - reload it and check the list.`,
      outcomes: [],
    };
  }

  const batchId = randomUUID();
  const rendered = chosen.map((recipient) => ({
    recipient,
    email: renderEmail(recipient, input.subject, input.body),
  }));

  if (!input.dryRun && rendered.length > 0) {
    await db.insert(s.emailSends).values(
      rendered.map(({ recipient, email }) => ({
        batchId,
        employeeId: recipient.employeeId,
        email: recipient.email,
        category: input.category,
        month: input.month,
        subject: email.subject,
        bodyHtml: email.html,
        status: "PENDING" as const,
        attendedDates: recipient.attended,
        missedDates: recipient.missed,
      })),
    );
  }

  const outcomes = await sendBatch(
    rendered.map(({ recipient, email }) => ({
      employeeId: recipient.employeeId,
      to: recipient.email,
      subject: email.subject,
      html: email.html,
    })),
    {
      webhookUrl,
      secret,
      batchId,
      dryRun: input.dryRun,
    },
  );

  if (!input.dryRun) {
    for (const outcome of outcomes) {
      await db
        .update(s.emailSends)
        .set({
          status: outcome.ok ? "SENT" : "FAILED",
          error: outcome.error ?? null,
          sentAt: outcome.ok ? new Date() : null,
        })
        .where(
          sql`${s.emailSends.batchId} = ${batchId} and ${s.emailSends.employeeId} = ${outcome.employeeId}`,
        );
    }
  }

  return {
    batchId,
    dryRun: input.dryRun,
    sent: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    sendAs: outcomes.find((o) => o.sendAs)?.sendAs,
    outcomes,
  };
}

/** Save matched addresses onto the employee records. */
export async function saveAddresses(
  db: Db,
  matches: { employeeId: number; email: string }[],
): Promise<number> {
  for (const match of matches) {
    await db
      .update(s.employees)
      .set({ email: match.email, updatedAt: new Date() })
      .where(eq(s.employees.id, match.employeeId));
  }
  return matches.length;
}

/** Everyone, with their aliases, for address matching. */
export async function loadPeopleForMatching(db: Db) {
  const people = await db
    .select({
      id: s.employees.id,
      displayName: s.employees.displayName,
      normalisedKey: s.employees.normalisedKey,
      email: s.employees.email,
    })
    .from(s.employees);

  const aliasRows = await db
    .select({ employeeId: s.employeeAliases.employeeId, rawName: s.employeeAliases.rawName })
    .from(s.employeeAliases)
    .where(inArray(s.employeeAliases.employeeId, people.map((p) => p.id)));

  const aliasesById = new Map<number, string[]>();
  for (const alias of aliasRows) {
    const list = aliasesById.get(alias.employeeId) ?? [];
    list.push(alias.rawName);
    aliasesById.set(alias.employeeId, list);
  }

  return people.map((p) => ({ ...p, aliases: aliasesById.get(p.id) ?? [] }));
}
