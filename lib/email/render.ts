/**
 * Rendering a message for one person.
 *
 * The spec asks for two lines appended to whatever is typed:
 *
 *   You attended at the office on: [dates]
 *   You did not attend on: [dates]
 *
 * A third is added for excused days. Under the agreed policy those days are
 * compliance-neutral, so listing them under "did not attend" would be telling
 * somebody they failed on a day they were signed off sick. That is the kind of
 * mistake that gets a system switched off.
 */

import type { Recipient } from "./recipients";

/** 2026-08-05 -> "Wed 5 Aug". */
export function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function formatList(dates: string[]): string {
  return dates.length ? dates.map(formatDate).join(", ") : "—";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The typed message body, with paragraph breaks preserved. */
function bodyToHtml(text: string): string {
  return escapeHtml(text.trim())
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 14px;">${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

export function renderEmail(
  recipient: Recipient,
  subject: string,
  body: string,
): RenderedEmail {
  const firstName = recipient.displayName.split(" ")[0];

  const rows: [string, string[]][] = [
    ["You attended at the office on", recipient.attended],
    ["You did not attend on", recipient.missed],
  ];
  if (recipient.excused.length > 0) {
    rows.push(["Recorded as explained, and not counted against you", recipient.excused]);
  }

  const summaryRows = rows
    .map(
      ([label, dates]) => `
      <tr>
        <td style="padding:6px 12px 6px 0;color:#6b6b64;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
        <td style="padding:6px 0;color:#1a1a18;">${escapeHtml(formatList(dates))}</td>
      </tr>`,
    )
    .join("");

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#1a1a18;max-width:620px;">
  <p style="margin:0 0 14px;">Hi ${escapeHtml(firstName)},</p>
  ${bodyToHtml(body)}
  <table style="border-collapse:collapse;font-size:14px;margin:20px 0 0;border-top:1px solid #e4e4e1;padding-top:16px;width:100%;">
    ${summaryRows}
  </table>
  <p style="margin:20px 0 0;font-size:12px;color:#94948c;">Wednesdays and Fridays are the required days. Public holidays and days the office was closed are not counted.</p>
</div>`;

  const textLines = [
    `Hi ${firstName},`,
    "",
    body.trim(),
    "",
    ...rows.map(([label, dates]) => `${label}: ${formatList(dates)}`),
  ];

  return { subject, html, text: textLines.join("\n") };
}
