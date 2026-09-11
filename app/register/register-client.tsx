"use client";

import { useCallback, useEffect, useState } from "react";
import type { RegisterWeek } from "@/lib/register/week";
import { addDays } from "@/lib/register/week";

type Saving = "idle" | "saving" | "saved" | "error";

export function RegisterClient({
  offices,
  officeCode,
  initialWeek,
  commonReasons,
}: {
  offices: { id: number; code: string; name: string }[];
  officeCode?: string;
  initialWeek: string;
  commonReasons: string[];
}) {
  const [week, setWeek] = useState(initialWeek);
  const [data, setData] = useState<RegisterWeek | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Record<string, Saving>>({});

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ week, ...(officeCode ? { office: officeCode } : {}) });

    fetch(`/api/register?${params}`, { signal: controller.signal })
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) => {
        if (controller.signal.aborted) return;
        if (!ok) setError(body.error ?? "Could not load the week.");
        else {
          setData(body);
          setError(null);
        }
        setLoading(false);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Could not load the week.");
        setLoading(false);
      });

    return () => controller.abort();
  }, [week, officeCode]);

  /**
   * Saved as you go, one cell at a time.
   *
   * No Save button: this is a register being ticked while somebody looks around
   * the office, and a button is a thing to forget. One request per cell means a
   * failure affects one person's day rather than the whole week.
   */
  const save = useCallback(
    async (employeeId: number, date: string, present: boolean, comment: string | null) => {
      const key = `${employeeId}|${date}`;
      setSaving((s) => ({ ...s, [key]: "saving" }));

      try {
        const response = await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            office: officeCode, employeeId, date, present, comment,
          }),
        });
        const body = await response.json().catch(() => ({}));

        if (!response.ok || body.ok !== true) {
          setSaving((s) => ({ ...s, [key]: "error" }));
          setError(body.error ?? "That change was not saved.");
          return false;
        }

        setSaving((s) => ({ ...s, [key]: "saved" }));
        setError(null);
        setTimeout(() => setSaving((s) => ({ ...s, [key]: "idle" })), 1200);
        return true;
      } catch (cause) {
        setSaving((s) => ({ ...s, [key]: "error" }));
        setError(
          `Could not reach the server: ${cause instanceof Error ? cause.message : "unknown error"}. That change was not saved.`,
        );
        return false;
      }
    },
    [officeCode],
  );

  function update(employeeId: number, date: string, next: { present?: boolean; comment?: string | null }) {
    setData((current) => {
      if (!current) return current;
      return {
        ...current,
        rows: current.rows.map((row) => {
          if (row.employeeId !== employeeId) return row;
          const existing = row.entries[date] ?? { date, present: false, comment: null, manual: true };
          return {
            ...row,
            entries: { ...row.entries, [date]: { ...existing, ...next, manual: true } },
          };
        }),
      };
    });
  }

  const openDays = data?.days.filter((d) => d.kind === "OPEN") ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {offices.length > 1 && (
            <label className="flex flex-col gap-1">
              <span className="text-[0.65rem] uppercase tracking-wide text-subtle">Office</span>
              <select
                defaultValue={officeCode}
                onChange={(e) => {
                  const url = new URL(window.location.href);
                  url.searchParams.set("office", e.target.value);
                  window.location.href = url.toString();
                }}
                className="rounded border border-border-soft bg-surface px-2 py-1.5 text-sm transition-colors hover:border-border-strong"
              >
                {offices.map((o) => (
                  <option key={o.id} value={o.code}>{o.name}</option>
                ))}
              </select>
            </label>
          )}

          <div className="flex flex-col gap-1">
            <span className="text-[0.65rem] uppercase tracking-wide text-subtle">Week</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setWeek(addDays(week, -7))}
                aria-label="Previous week"
                className="rounded border border-border-soft px-2 py-1.5 text-sm transition-colors hover:bg-surface-muted"
              >
                ←
              </button>
              <span className="tabular min-w-[10rem] text-center text-sm">
                {data?.label ?? "…"}
              </span>
              <button
                type="button"
                onClick={() => setWeek(addDays(week, 7))}
                aria-label="Next week"
                className="rounded border border-border-soft px-2 py-1.5 text-sm transition-colors hover:bg-surface-muted"
              >
                →
              </button>
            </div>
          </div>
        </div>

        {data && (
          <p className="text-xs text-muted">
            <span className="tabular font-medium text-foreground">
              {data.rows.filter((r) => openDays.some((d) => r.entries[d.date]?.present)).length}
            </span>{" "}
            of {data.rows.length} in this week
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-border-soft bg-no-bg px-3 py-2 text-sm text-no">
          {error}
        </p>
      )}

      {loading && <p className="text-sm text-muted">Loading the week…</p>}

      {data && !loading && (
        data.rows.length === 0 ? (
          <p className="rounded-md border border-border-soft bg-surface-muted px-3 py-3 text-sm text-muted">
            Nobody is on this office&rsquo;s staff list yet. Upload one first.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border-soft bg-surface">
            <table className="w-full min-w-[40rem] border-collapse text-sm">
              <caption className="sr-only">Attendance register for {data.label}</caption>
              <thead>
                <tr className="border-b border-border-soft">
                  <th scope="col" className="px-3 py-2 text-left text-xs uppercase tracking-wide text-subtle">
                    Name
                  </th>
                  {data.days.map((day) => (
                    <th key={day.date} scope="col" className="px-3 py-2 text-left">
                      <span className="block text-xs uppercase tracking-wide text-subtle">
                        {new Date(`${day.date}T00:00:00Z`).toLocaleDateString("en-GB", {
                          weekday: "short", day: "numeric", timeZone: "UTC",
                        })}
                      </span>
                      {day.kind === "CLOSED" && (
                        <span className="text-[0.65rem] font-normal text-muted">{day.label}</span>
                      )}
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2 text-left text-xs uppercase tracking-wide text-subtle">
                    Comment
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.employeeId} className="border-b border-border-soft last:border-0 hover:bg-surface-muted">
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      {row.displayName}
                      {row.exemptionNote && (
                        <span className="ml-2 rounded bg-exempt-bg px-1.5 py-0.5 text-[0.65rem] text-exempt">
                          {row.exemptionNote}
                        </span>
                      )}
                    </th>

                    {data.days.map((day) => {
                      const entry = row.entries[day.date];
                      const key = `${row.employeeId}|${day.date}`;
                      const status = saving[key] ?? "idle";

                      return (
                        <td key={day.date} className="px-3 py-2">
                          {day.kind === "CLOSED" ? (
                            <span className="text-xs text-subtle">—</span>
                          ) : (
                            <span className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={entry?.present ?? false}
                                aria-label={`${row.displayName} was in the office on ${day.date}`}
                                onChange={(e) => {
                                  const present = e.target.checked;
                                  update(row.employeeId, day.date, { present });
                                  void save(row.employeeId, day.date, present, entry?.comment ?? null);
                                }}
                                className="h-4 w-4"
                              />
                              <span
                                aria-live="polite"
                                className={`text-[0.65rem] transition-opacity ${
                                  status === "saved" ? "text-yes opacity-100"
                                    : status === "error" ? "text-no opacity-100"
                                    : status === "saving" ? "text-subtle opacity-100"
                                    : "opacity-0"
                                }`}
                              >
                                {status === "saved" ? "saved" : status === "error" ? "failed" : "…"}
                              </span>
                            </span>
                          )}
                        </td>
                      );
                    })}

                    <td className="px-3 py-2">
                      <CommentField
                        key={`${row.employeeId}-${data.monday}`}
                        row={row}
                        days={openDays.map((d) => d.date)}
                        suggestions={commonReasons}
                        onCommit={(comment) => {
                          for (const date of openDays.map((d) => d.date)) {
                            const entry = row.entries[date];
                            update(row.employeeId, date, { comment });
                            void save(row.employeeId, date, entry?.present ?? false, comment);
                          }
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

/**
 * One comment per person per week.
 *
 * Kept at week level rather than per day because the reasons people give are
 * almost always about the week - "on leave", "in Durban" - and asking for the
 * same sentence twice is how a register stops being filled in.
 */
function CommentField({
  row,
  days,
  suggestions,
  onCommit,
}: {
  row: { employeeId: number; entries: Record<string, { comment: string | null } | null> };
  days: string[];
  suggestions: string[];
  onCommit: (comment: string | null) => void;
}) {
  /**
   * Seeded once from what is stored, then left to the person typing.
   *
   * The parent remounts this with a key that includes the week, which is the
   * only time the stored value should win over what is in the box - syncing it
   * in an effect instead meant a saved value could overwrite something being
   * typed.
   */
  const existing = days.map((d) => row.entries[d]?.comment).find(Boolean) ?? "";
  const [value, setValue] = useState(existing);

  return (
    <>
      <input
        type="text"
        value={value}
        list="register-reasons"
        placeholder="Why not in?"
        aria-label={`Reason this person was not in the office`}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          const next = value.trim() || null;
          if (next !== (existing || null)) onCommit(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-full min-w-[10rem] rounded border border-border-soft bg-surface px-2 py-1 text-xs transition-colors hover:border-border-strong"
      />
      <datalist id="register-reasons">
        {suggestions.map((s) => <option key={s} value={s} />)}
      </datalist>
    </>
  );
}
