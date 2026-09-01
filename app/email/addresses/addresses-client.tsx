"use client";

import { useState } from "react";

type Result = {
  matched: { rawName: string; email: string; displayName: string; replaces?: string }[];
  unmatched: { rawName: string; email: string; reason: string }[];
  invalid: { line: string; reason: string }[];
  saved: boolean;
};

export function AddressesClient({ missing }: { missing: string[] }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(save: boolean) {
    setBusy(true);
    const response = await fetch("/api/email/addresses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, save }),
    });
    setResult(await response.json());
    setBusy(false);
    if (save) setText("");
  }

  return (
    <div className="flex flex-col gap-5">
      <label className="flex flex-col gap-1">
        <span className="text-[0.65rem] uppercase tracking-wide text-subtle">
          Paste names and addresses
        </span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder={"Zoe Flanegan, zoe.flanegan@example.com\nBen Clay, ben.clay@example.com"}
          className="rounded border border-border-soft bg-surface px-3 py-2 font-mono text-xs leading-relaxed transition-colors hover:border-border-strong"
        />
        <span className="text-xs text-subtle">
          One per line. Comma, tab or semicolon between the name and the address. Names are
          matched against the roster, including spellings already reconciled during import.
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!text.trim() || busy}
          onClick={() => void submit(false)}
          className="rounded border border-border-strong px-3 py-2 text-sm transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          Check the matches
        </button>
        <button
          type="button"
          disabled={!result || result.matched.length === 0 || busy}
          onClick={() => void submit(true)}
          className="rounded bg-foreground px-3 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-35"
        >
          Save {result?.matched.length ?? 0} addresses
        </button>
      </div>

      {result && (
        <section className="flex flex-col gap-4">
          {result.saved && (
            <p className="animate-row-in rounded-md border border-border-soft bg-yes-bg px-3 py-2 text-sm text-yes">
              Saved {result.matched.length} addresses.
            </p>
          )}

          {result.matched.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-medium">Matched ({result.matched.length})</h2>
              <ul className="divide-y divide-border-soft rounded-lg border border-border-soft bg-surface">
                {result.matched.map((m) => (
                  <li key={m.email} className="flex flex-wrap items-baseline gap-2 px-4 py-2 text-sm">
                    <span>{m.displayName}</span>
                    <span className="text-xs text-subtle">{m.email}</span>
                    {m.replaces && (
                      <span className="ml-auto text-xs text-muted">replaces {m.replaces}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(result.unmatched.length > 0 || result.invalid.length > 0) && (
            <div>
              <h2 className="mb-2 text-sm font-medium">
                Not matched ({result.unmatched.length + result.invalid.length})
                <span className="ml-2 font-normal text-subtle">nothing was created for these</span>
              </h2>
              <ul className="divide-y divide-border-soft rounded-lg border border-border-soft bg-surface">
                {result.unmatched.map((u) => (
                  <li key={u.email + u.rawName} className="px-4 py-2 text-sm">
                    <span className="text-muted">{u.rawName}</span>{" "}
                    <span className="text-xs text-subtle">{u.email}</span>
                    <p className="text-xs text-muted">{u.reason}</p>
                  </li>
                ))}
                {result.invalid.map((i) => (
                  <li key={i.line} className="px-4 py-2 text-sm">
                    <span className="font-mono text-xs text-muted">{i.line}</span>
                    <p className="text-xs text-muted">{i.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {missing.length > 0 && (
        <details className="rounded-lg border border-border-soft bg-surface px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            Still without an address
            <span className="ml-2 font-normal text-subtle">{missing.length} people</span>
          </summary>
          <ul className="mt-3 grid grid-cols-1 gap-1 text-sm text-muted sm:grid-cols-2">
            {missing.map((name) => <li key={name}>{name}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
