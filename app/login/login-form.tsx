"use client";

import { useState } from "react";

export function LoginForm({ next }: { next: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (response.ok) {
      window.location.href = next;
      return;
    }

    const body = await response.json().catch(() => ({}));
    setError(body.error ?? "Could not sign in.");
    setPassword("");
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[0.65rem] uppercase tracking-wide text-subtle">Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          autoComplete="current-password"
          className="rounded border border-border-soft bg-surface px-3 py-2 text-sm transition-colors hover:border-border-strong"
        />
      </label>

      {error && (
        <p role="alert" className="rounded-md border border-border-soft bg-no-bg px-3 py-2 text-sm text-no">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!password || busy}
        className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-35"
      >
        {busy ? "Checking…" : "Sign in"}
      </button>
    </form>
  );
}
