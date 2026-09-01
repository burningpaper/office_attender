"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CATEGORY_LABELS, type EmailCategory, type RecipientList } from "@/lib/email/recipients";
import { formatDate } from "@/lib/email/render";
import type { SendResult } from "@/lib/email/service";

const CATEGORIES: EmailCategory[] = ["MONTHLY", "TWO_WEEK", "LONG_TERM"];

const EXCLUSION_LABELS: Record<string, string> = {
  EXEMPT: "Exempt — never emailed",
  NO_EMAIL: "No email address on file",
  NOT_FAILING: "Not failing this category",
};

export function EmailClient({ months, month: initialMonth, asOf }: {
  months: string[];
  month: string;
  asOf: string;
}) {
  const [category, setCategory] = useState<EmailCategory>("MONTHLY");
  const [month, setMonth] = useState(initialMonth);
  const [list, setList] = useState<RecipientList | null>(null);
  const [loading, setLoading] = useState(true);
  const [deselected, setDeselected] = useState<Set<number>>(new Set());
  const [subject, setSubject] = useState("Office attendance");
  const [body, setBody] = useState(
    "A quick note about your office attendance this month. The days recorded for you are below — please let me know if anything looks wrong.",
  );
  const [result, setResult] = useState<SendResult | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");

  /**
   * Load the list whenever the filters change.
   *
   * The request is abortable and the result is discarded if a newer one has
   * started, so flicking between categories cannot land an older answer on top
   * of a newer one - which would show the wrong people as about to be emailed.
   */
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ category, month, asOf });

    fetch(`/api/email/recipients?${params}`, { signal: controller.signal })
      .then(async (response) => ({ ok: response.ok, body: await response.json() }))
      .then(({ ok, body }) => {
        if (controller.signal.aborted) return;
        if (!ok) {
          setError(body.error ?? "Could not build the list.");
          setList(null);
        } else {
          setList(body);
          setDeselected(new Set());
          setError(null);
        }
        setLoading(false);
        setResult(null);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Could not build the list.");
        setLoading(false);
      });

    return () => controller.abort();
  }, [category, month, asOf]);

  const selected = useMemo(
    () => (list?.recipients ?? []).filter((r) => !deselected.has(r.employeeId)),
    [list, deselected],
  );

  async function submit(dryRun: boolean) {
    setSending(true);
    setError(null);

    const response = await fetch("/api/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category, month, asOf, subject, body, dryRun,
        onlyEmployeeIds: selected.map((r) => r.employeeId),
        ...(dryRun ? {} : { confirm: "SEND" }),
      }),
    });

    const payload = await response.json();
    if (!response.ok) setError(payload.error ?? "The send failed.");
    else setResult(payload);

    setSending(false);
    setConfirmText("");
  }

  const canSend = selected.length > 0 && subject.trim() && body.trim() && !sending;
  const confirmed = confirmText.trim().toUpperCase() === "SEND";

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[0.65rem] uppercase tracking-wide text-subtle">Who</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as EmailCategory)}
            className="rounded border border-border-soft bg-surface px-2 py-1.5 text-sm transition-colors hover:border-border-strong"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[0.65rem] uppercase tracking-wide text-subtle">Month</span>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded border border-border-soft bg-surface px-2 py-1.5 text-sm transition-colors hover:border-border-strong"
          >
            {months.map((m) => (
              <option key={m} value={m}>
                {new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", {
                  month: "long", year: "numeric", timeZone: "UTC",
                })}
              </option>
            ))}
          </select>
        </label>

        <p className="pb-1.5 text-sm text-muted">
          {loading ? "Building the list…" : (
            <>
              <span className="tabular font-medium text-foreground">{selected.length}</span>
              {" "}will be emailed
              {list && list.excluded.length > 0 && (
                <> · <span className="text-subtle">{list.excluded.length} excluded</span></>
              )}
            </>
          )}
        </p>
      </section>

      {error && (
        <p className="rounded-md border border-border-soft bg-no-bg px-3 py-2 text-sm text-no">{error}</p>
      )}

      {list && !loading && (
        <>
          {list.recipients.length === 0 ? (
            <p className="rounded-md border border-border-soft bg-surface-muted px-3 py-3 text-sm text-muted">
              Nobody is in this category with an email address on file.{" "}
              <Link href="/email/addresses" className="underline underline-offset-2">
                Add addresses
              </Link>{" "}
              if that looks wrong.
            </p>
          ) : (
            <Recipients
              list={list}
              deselected={deselected}
              onToggle={(id) =>
                setDeselected((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
            />
          )}

          <section className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[0.65rem] uppercase tracking-wide text-subtle">Subject</span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="rounded border border-border-soft bg-surface px-3 py-2 text-sm transition-colors hover:border-border-strong"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[0.65rem] uppercase tracking-wide text-subtle">Message</span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                className="rounded border border-border-soft bg-surface px-3 py-2 text-sm leading-relaxed transition-colors hover:border-border-strong"
              />
              <span className="text-xs text-subtle">
                Each person&rsquo;s own dates are appended automatically. Nobody sees anyone else&rsquo;s.
              </span>
            </label>
          </section>

          {selected.length > 0 && <Preview recipient={selected[0]} subject={subject} body={body} />}

          <section className="flex flex-col gap-3 rounded-lg border border-border-soft bg-surface px-4 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={!canSend}
                onClick={() => void submit(true)}
                className="rounded border border-border-strong px-3 py-2 text-sm transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sending ? "Working…" : "Dry run"}
              </button>
              <span className="text-xs text-muted">
                Exercises the whole chain — including Microsoft authentication — and sends nothing.
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-border-soft pt-3">
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="Type SEND"
                aria-label="Type SEND to confirm"
                className="w-32 rounded border border-border-soft bg-surface px-2 py-1.5 text-sm"
              />
              <button
                type="button"
                disabled={!canSend || !confirmed}
                onClick={() => void submit(false)}
                className="rounded bg-no px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-35"
              >
                Send to {selected.length} {selected.length === 1 ? "person" : "people"}
              </button>
              <span className="text-xs text-muted">
                This sends real email. It cannot be undone.
              </span>
            </div>
          </section>

          {result && <Result result={result} />}
        </>
      )}
    </div>
  );
}

function Recipients({ list, deselected, onToggle }: {
  list: RecipientList;
  deselected: Set<number>;
  onToggle: (id: number) => void;
}) {
  const [showExcluded, setShowExcluded] = useState(false);

  return (
    <section className="rounded-lg border border-border-soft bg-surface">
      <ul className="divide-y divide-border-soft">
        {list.recipients.map((r) => {
          const on = !deselected.has(r.employeeId);
          return (
            <li key={r.employeeId} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <input
                type="checkbox"
                checked={on}
                onChange={() => onToggle(r.employeeId)}
                aria-label={`Include ${r.displayName}`}
                className="h-3.5 w-3.5"
              />
              <span className={on ? "" : "text-subtle line-through"}>{r.displayName}</span>
              <span className="text-xs text-subtle">{r.email}</span>
              <span className="tabular ml-auto text-xs text-muted">
                {r.attended.length} attended · <span className="text-no">{r.missed.length} missed</span>
                {r.excused.length > 0 && <span className="text-subtle"> · {r.excused.length} excused</span>}
              </span>
            </li>
          );
        })}
      </ul>

      {list.excluded.length > 0 && (
        <div className="border-t border-border-soft px-4 py-2.5">
          <button
            type="button"
            onClick={() => setShowExcluded((v) => !v)}
            aria-expanded={showExcluded}
            className="text-xs text-muted underline underline-offset-2 hover:text-foreground"
          >
            {showExcluded ? "Hide" : "Show"} the {list.excluded.length} not being emailed
          </button>
          {showExcluded && (
            <ul className="animate-expand-in mt-2 flex flex-col gap-1">
              {list.excluded.map((e) => (
                <li key={e.displayName} className="flex justify-between gap-4 text-xs">
                  <span className="text-muted">{e.displayName}</span>
                  <span className="text-subtle">{EXCLUSION_LABELS[e.reason]}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function Preview({ recipient, subject, body }: {
  recipient: { displayName: string; attended: string[]; missed: string[]; excused: string[] };
  subject: string;
  body: string;
}) {
  return (
    <details className="rounded-lg border border-border-soft bg-surface px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">
        Preview
        <span className="ml-2 font-normal text-subtle">as {recipient.displayName} will see it</span>
      </summary>
      <div className="mt-3 rounded border border-border-soft bg-background px-4 py-3 text-sm">
        <p className="mb-3 border-b border-border-soft pb-2 text-xs text-subtle">
          Subject: <span className="text-foreground">{subject}</span>
        </p>
        <p className="mb-3">Hi {recipient.displayName.split(" ")[0]},</p>
        <p className="mb-3 whitespace-pre-wrap">{body}</p>
        <dl className="mt-4 border-t border-border-soft pt-3 text-sm">
          <div className="flex gap-3 py-1">
            <dt className="w-52 shrink-0 text-muted">You attended at the office on</dt>
            <dd>{recipient.attended.map(formatDate).join(", ") || "—"}</dd>
          </div>
          <div className="flex gap-3 py-1">
            <dt className="w-52 shrink-0 text-muted">You did not attend on</dt>
            <dd>{recipient.missed.map(formatDate).join(", ") || "—"}</dd>
          </div>
          {recipient.excused.length > 0 && (
            <div className="flex gap-3 py-1">
              <dt className="w-52 shrink-0 text-muted">Explained, not counted against you</dt>
              <dd>{recipient.excused.map(formatDate).join(", ")}</dd>
            </div>
          )}
        </dl>
      </div>
    </details>
  );
}

function Result({ result }: { result: SendResult }) {
  const failures = result.outcomes.filter((o) => !o.ok);
  return (
    <section
      className={`animate-row-in rounded-lg border px-4 py-3 text-sm ${
        result.failed > 0 ? "border-border-soft bg-no-bg" : "border-border-soft bg-yes-bg"
      }`}
    >
      <p className={result.failed > 0 ? "text-no" : "text-yes"}>
        {result.dryRun ? "Dry run: " : ""}
        {result.sent} succeeded, {result.failed} failed.
        {result.dryRun && " Nothing was sent."}
      </p>
      {failures.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {failures.map((f) => (
            <li key={f.employeeId} className="text-xs text-muted">
              {f.email}: {f.error}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
