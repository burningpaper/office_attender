/**
 * Handing messages to the n8n workflow, one recipient per call.
 *
 * There is no sender option. The n8n Microsoft Graph credential is delegated,
 * so `/me/sendMail` goes from whoever authorised it and there is nothing here
 * to choose. A dry run asks Graph who that is and reports it back, because the
 * one time it was assumed rather than read, the wrong mailbox was used.
 *
 * One call each rather than one call for the batch, because partial failure is
 * the normal case: an address bounces, a token expires halfway through. Per
 * recipient, the audit row records exactly what happened to that person.
 *
 * The workflow answers 400 with a reason for anything malformed, so a silent
 * empty 200 is treated as failure rather than success. That matters: an earlier
 * version of the workflow threw inside a Code node, which skipped the respond
 * node and returned 200 with an empty body - indistinguishable from a send.
 */

export type SendOutcome = {
  employeeId: number;
  email: string;
  ok: boolean;
  dryRun: boolean;
  /**
   * The mailbox this went from, as Microsoft reports it on a dry run.
   *
   * Not configured anywhere: the n8n credential is delegated, so the sender is
   * whoever authorised it, and the only honest way to know is to ask Graph.
   * Guessing it once bound the wrong person's mailbox without complaint.
   */
  sendAs?: string;
  error?: string;
};

export type SendMessage = {
  employeeId: number;
  to: string;
  subject: string;
  html: string;
};

export type SendOptions = {
  webhookUrl: string;
  secret: string;
  batchId: string;
  dryRun: boolean;
  /** Kept low: this is somebody's mail server, not a load test. */
  concurrency?: number;
  timeoutMs?: number;
};

async function sendOne(
  message: SendMessage,
  options: SendOptions,
): Promise<SendOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  try {
    const response = await fetch(options.webhookUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-office-attendance-secret": options.secret,
      },
      body: JSON.stringify({
        to: message.to,
        subject: message.subject,
        html: message.html,
        employeeId: message.employeeId,
        batchId: options.batchId,
        dryRun: options.dryRun,
      }),
    });

    const text = await response.text();
    let payload: { ok?: boolean; error?: string; wouldSendAs?: string } = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      // Left empty; the ok check below fails on its own.
    }

    /**
     * Success has to be asserted, not assumed. Anything that is not an explicit
     * ok:true - a 500, an empty body, HTML from a proxy - counts as a failure,
     * because the alternative is recording a send that never happened.
     */
    if (!response.ok || payload.ok !== true) {
      return {
        employeeId: message.employeeId,
        email: message.to,
        ok: false,
        dryRun: options.dryRun,
        error:
          payload.error ??
          `The mail workflow answered ${response.status} with ${text ? "an unexpected body" : "an empty body"}.`,
      };
    }

    return {
      employeeId: message.employeeId,
      email: message.to,
      ok: true,
      dryRun: options.dryRun,
      ...(payload.wouldSendAs ? { sendAs: payload.wouldSendAs } : {}),
    };
  } catch (error) {
    return {
      employeeId: message.employeeId,
      email: message.to,
      ok: false,
      dryRun: options.dryRun,
      error:
        error instanceof Error && error.name === "AbortError"
          ? "The mail workflow did not respond in time."
          : error instanceof Error
            ? error.message
            : "The mail workflow could not be reached.",
    };
  } finally {
    // Without this the timer keeps the process alive for its full duration
    // after a fast response - 50 recipients meant 50 dangling timers.
    clearTimeout(timeout);
  }
}

/** Send a batch, a few at a time, in the order given. */
export async function sendBatch(
  messages: SendMessage[],
  options: SendOptions,
): Promise<SendOutcome[]> {
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const outcomes: SendOutcome[] = new Array(messages.length);
  let cursor = 0;

  async function worker() {
    while (cursor < messages.length) {
      const index = cursor++;
      outcomes[index] = await sendOne(messages[index], options);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, messages.length) }, worker),
  );

  return outcomes;
}
