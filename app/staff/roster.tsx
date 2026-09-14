"use client";

import { useState } from "react";

export type Person = {
  id: number;
  displayName: string;
  email: string | null;
  status: string;
  untrackedReason: string | null;
};

/**
 * The roster, with the two ways somebody comes off it.
 *
 * Leaving and not being tracked are different and are kept visibly apart:
 * one means they have gone, the other that the policy does not apply to them
 * while they are still here. Conflating them would either chase a former
 * employee or lose somebody who is still on the payroll.
 */
export function Roster({ people, officeCode }: { people: Person[]; officeCode?: string }) {
  const [rows, setRows] = useState(people);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [query, setQuery] = useState("");
  const [showGone, setShowGone] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  async function act(employeeId: number, action: string, why?: string) {
    setBusy(employeeId);
    setError(null);
    try {
      const response = await fetch("/api/staff/person", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ office: officeCode, employeeId, action, reason: why }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) {
        setError(body.error ?? "That change was not saved.");
        return;
      }
      setRows((current) =>
        current.map((p) =>
          p.id === employeeId
            ? { ...p, status: body.status, untrackedReason: body.untracked ? (why ?? p.untrackedReason ?? "Not tracked") : null }
            : p,
        ),
      );
      setAsking(null);
      setReason("");
    } catch (cause) {
      setError(
        `Could not reach the server: ${cause instanceof Error ? cause.message : "unknown error"}.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    if (!newName.trim()) return;
    setAdding(true);
    setError(null);
    setAdded(null);

    try {
      const response = await fetch("/api/staff/person", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          office: officeCode, action: "ADD", name: newName, email: newEmail || null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) {
        setError(body.error ?? "Could not add them.");
        return;
      }

      setRows((current) => {
        const already = current.find((p) => p.id === body.id);
        if (already) {
          return current.map((p) =>
            p.id === body.id ? { ...p, status: "ACTIVE", email: newEmail || p.email } : p,
          );
        }
        return [
          ...current,
          { id: body.id, displayName: body.displayName, email: newEmail || null, status: "ACTIVE", untrackedReason: null },
        ].sort((a, b) => a.displayName.localeCompare(b.displayName));
      });

      setAdded(
        body.created
          ? `Added ${body.displayName}.`
          : body.restored
            ? `${body.displayName} was already on record as having left, and is back.`
            : `${body.displayName} was already here — nothing to add.`,
      );
      setNewName("");
      setNewEmail("");
    } catch (cause) {
      setError(
        `Could not reach the server: ${cause instanceof Error ? cause.message : "unknown error"}.`,
      );
    } finally {
      setAdding(false);
    }
  }

  const visible = rows
    .filter((p) => (showGone ? true : p.status === "ACTIVE"))
    .filter((p) => !query.trim() || p.displayName.toLowerCase().includes(query.trim().toLowerCase()));

  const gone = rows.filter((p) => p.status !== "ACTIVE").length;
  const untracked = rows.filter((p) => p.status === "ACTIVE" && p.untrackedReason).length;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border-soft bg-surface px-4 py-3">
        <label className="flex flex-col gap-1">
          <span className="text-[0.65rem] uppercase tracking-wide text-subtle">Add someone</span>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            placeholder="Full name"
            aria-label="Name of the person to add"
            className="w-44 rounded border border-border-soft bg-background px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[0.65rem] uppercase tracking-wide text-subtle">Email</span>
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            placeholder="optional"
            aria-label="Email address of the person to add"
            className="w-52 rounded border border-border-soft bg-background px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="button"
          disabled={!newName.trim() || adding}
          onClick={() => void add()}
          className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-35"
        >
          {adding ? "Adding…" : "Add"}
        </button>
        {added && <span className="pb-1.5 text-xs text-yes">{added}</span>}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find someone…"
          aria-label="Find someone on the roster"
          className="w-52 rounded border border-border-soft bg-surface px-2 py-1.5 text-sm transition-colors hover:border-border-strong"
        />
        <div className="flex items-center gap-3">
          {gone > 0 && (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={showGone}
                onChange={(e) => setShowGone(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              show {gone} who have left
            </label>
          )}
          <p className="text-xs text-muted">
            <span className="tabular font-medium text-foreground">{visible.length}</span> shown
            {untracked > 0 && <> · {untracked} not tracked</>}
          </p>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-border-soft bg-no-bg px-3 py-2 text-sm text-no">
          {error}
        </p>
      )}

      <ul className="divide-y divide-border-soft rounded-lg border border-border-soft bg-surface">
        {visible.map((p) => {
          const left = p.status !== "ACTIVE";
          return (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
              <span className={left ? "text-subtle line-through" : ""}>{p.displayName}</span>
              <span className="text-xs text-subtle">{p.email ?? "no address"}</span>

              {left && (
                <span className="rounded bg-na-bg px-1.5 py-0.5 text-[0.65rem] text-na">Left</span>
              )}
              {!left && p.untrackedReason && (
                <span className="rounded bg-exempt-bg px-1.5 py-0.5 text-[0.65rem] text-exempt">
                  {p.untrackedReason}
                </span>
              )}

              <span className="ml-auto flex items-center gap-2">
                {asking === p.id ? (
                  <>
                    <input
                      autoFocus
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Why not tracked?"
                      aria-label={`Why ${p.displayName} is not tracked`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void act(p.id, "UNTRACK", reason);
                        if (e.key === "Escape") { setAsking(null); setReason(""); }
                      }}
                      className="w-44 rounded border border-border-soft bg-surface px-2 py-1 text-xs"
                    />
                    <Action label="Save" onClick={() => void act(p.id, "UNTRACK", reason)} disabled={busy === p.id} />
                    <Action label="Cancel" onClick={() => { setAsking(null); setReason(""); }} />
                  </>
                ) : left ? (
                  <Action label="They're back" onClick={() => void act(p.id, "RESTORE")} disabled={busy === p.id} />
                ) : (
                  <>
                    {p.untrackedReason ? (
                      <Action label="Track again" onClick={() => void act(p.id, "TRACK")} disabled={busy === p.id} />
                    ) : (
                      <Action label="Stop tracking" onClick={() => setAsking(p.id)} />
                    )}
                    <Action label="Mark as left" tone="no" onClick={() => void act(p.id, "LEAVE")} disabled={busy === p.id} />
                  </>
                )}
              </span>
            </li>
          );
        })}

        {visible.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-muted">Nobody matches.</li>
        )}
      </ul>
    </section>
  );
}

function Action({
  label,
  onClick,
  disabled,
  tone,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "no";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-2 py-1 text-xs transition-colors disabled:opacity-40 ${
        tone === "no"
          ? "border-border-soft text-muted hover:border-no hover:text-no"
          : "border-border-soft text-muted hover:border-border-strong hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
