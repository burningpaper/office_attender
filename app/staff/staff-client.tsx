"use client";

import { useRef, useState } from "react";

type Result = {
  matched: { displayName: string; email: string | null; via: string }[];
  created: { displayName: string; email: string | null }[];
  departed: string[];
  returned: string[];
  skipped: { line: string; reason: string }[];
  saved: boolean;
};

export function StaffClient({
  offices,
  officeCode,
}: {
  offices: { id: number; code: string; name: string }[];
  officeCode?: string;
}) {
  const [office, setOffice] = useState(officeCode ?? offices[0]?.code ?? "");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(save: boolean) {
    setBusy(true);
    setError(null);

    const form = new FormData();
    form.append("office", office);
    form.append("save", String(save));
    if (file) form.append("file", file);
    else form.append("text", text);

    try {
      const response = await fetch("/api/staff", { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? "That list could not be read.");
        setResult(null);
        return;
      }
      setResult(body as Result);
    } catch (cause) {
      setError(
        `Could not reach the server: ${cause instanceof Error ? cause.message : "unknown error"}.`,
      );
    } finally {
      setBusy(false);
    }
  }

  const ready = Boolean(file || text.trim());

  return (
    <div className="flex flex-col gap-5">
      {offices.length > 1 && (
        <label className="flex flex-col gap-1">
          <span className="text-[0.65rem] uppercase tracking-wide text-subtle">Office</span>
          <select
            value={office}
            onChange={(e) => {
              setOffice(e.target.value);
              setResult(null);
            }}
            className="w-56 rounded border border-border-soft bg-surface px-2 py-1.5 text-sm transition-colors hover:border-border-strong"
          >
            {offices.map((o) => (
              <option key={o.id} value={o.code}>{o.name}</option>
            ))}
          </select>
        </label>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-[0.65rem] uppercase tracking-wide text-subtle">Staff list</span>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="rounded border border-border-strong px-3 py-1.5 text-sm transition-colors hover:bg-surface-muted"
          >
            {file ? file.name : "Choose a spreadsheet"}
          </button>
          {file && (
            <button
              type="button"
              onClick={() => { setFile(null); setResult(null); }}
              className="text-xs text-muted underline underline-offset-2 hover:text-foreground"
            >
              clear
            </button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls"
            className="sr-only"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              if (chosen) { setFile(chosen); setResult(null); }
            }}
          />
          <span className="text-xs text-subtle">
            a tab with First Name, Last Name and Email — or paste below
          </span>
        </div>

        {!file && (
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setResult(null); }}
            rows={8}
            placeholder={"Zoe Flanegan, zoe.flanegan@example.com\nBen Clay, ben.clay@example.com"}
            className="rounded border border-border-soft bg-surface px-3 py-2 font-mono text-xs leading-relaxed transition-colors hover:border-border-strong"
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => void submit(false)}
          className="rounded border border-border-strong px-3 py-2 text-sm transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Reading…" : "Check the list"}
        </button>
        <button
          type="button"
          disabled={!result || result.saved || busy}
          onClick={() => void submit(true)}
          className="rounded bg-foreground px-3 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-35"
        >
          Apply this list
        </button>
        {result && !result.saved && result.departed.length > 0 && (
          <span className="text-xs text-no">
            {result.departed.length} {result.departed.length === 1 ? "person" : "people"} will be
            marked as having left
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-border-soft bg-no-bg px-3 py-2 text-sm text-no">
          {error}
        </p>
      )}

      {result && (
        <section className="flex flex-col gap-4">
          {result.saved && (
            <p className="animate-row-in rounded-md border border-border-soft bg-yes-bg px-3 py-2 text-sm text-yes">
              Applied. {result.matched.length} matched, {result.created.length} added,{" "}
              {result.departed.length} marked as having left.
            </p>
          )}

          <Group title="Already on record" items={result.matched.map((m) => m.displayName)} />
          <Group title="Will be added" items={result.created.map((c) => c.displayName)} tone="yes" />
          <Group
            title="Not on this list — will be marked as having left"
            items={result.departed}
            tone="no"
          />
          <Group title="Back on the list" items={result.returned} />

          {result.skipped.length > 0 && (
            <Group
              title="Could not be read"
              items={result.skipped.map((s) => `${s.line} — ${s.reason}`)}
              tone="no"
            />
          )}
        </section>
      )}
    </div>
  );
}

function Group({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone?: "yes" | "no";
}) {
  if (items.length === 0) return null;
  const colour = tone === "no" ? "text-no" : tone === "yes" ? "text-yes" : "text-foreground";

  return (
    <details className="rounded-lg border border-border-soft bg-surface px-4 py-3" open={items.length <= 12}>
      <summary className={`cursor-pointer text-sm font-medium ${colour}`}>
        {title}
        <span className="ml-2 font-normal text-subtle">{items.length}</span>
      </summary>
      <ul className="mt-2 grid grid-cols-1 gap-1 text-sm text-muted sm:grid-cols-2">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </details>
  );
}
