"use client";

import { useState } from "react";
import { filterRows, sortRows, type Direction, type SortKey } from "@/lib/compliance/sort";
import type { EmployeeRowWithDays } from "@/lib/compliance/types";
import { LongTermCell, VerdictCell } from "./verdict";

const COLUMNS: { key: SortKey; label: string; hint: string; className: string }[] = [
  { key: "name", label: "Name", hint: "Employee", className: "text-left" },
  {
    key: "monthly",
    label: "This month",
    hint: "Present on every required day that has already happened",
    className: "text-left",
  },
  {
    key: "twoWeek",
    label: "Two week",
    hint: "At least one Wednesday and one Friday in the last 14 days",
    className: "text-left",
  },
  {
    key: "longTerm",
    label: "Long term",
    hint: "Averaging 3 Wednesdays and 3 Fridays a month since joining",
    className: "text-left",
  },
  {
    key: "lastAttended",
    label: "Last attended",
    hint: "The most recent day in the office",
    className: "text-left",
  },
];

export function ComplianceTable({
  rows,
  month,
  asOf,
  months,
}: {
  rows: EmployeeRowWithDays[];
  month: string;
  asOf: string;
  months: string[];
}) {
  const [sortKey, setSortKey] = useState<SortKey>("monthly");
  const [direction, setDirection] = useState<Direction>("asc");
  const [showExempt, setShowExempt] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [showLeavers, setShowLeavers] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  const onRoster = rows.filter((r) => r.onRosterThisMonth);
  const exemptCount = onRoster.filter((r) => r.isExempt).length;
  const leaverCount = rows.length - onRoster.length;

  /**
   * Not memoised. Eighty-odd rows sort in well under a millisecond, and the
   * React Compiler handles this better than a hand-written useMemo - which it
   * flagged as unpreservable anyway.
   */
  const visible = sortRows(
    filterRows(rows, { showExempt, onlyProblems, query, showLeavers }),
    sortKey,
    direction,
  );

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setDirection("asc");
    }
  }

  const needAttention = onRoster.filter((r) => r.monthly.verdict === "NO").length;

  return (
    <div className="flex flex-col gap-5">
      <Controls
        month={month}
        months={months}
        asOf={asOf}
        query={query}
        setQuery={setQuery}
        showExempt={showExempt}
        setShowExempt={setShowExempt}
        onlyProblems={onlyProblems}
        setOnlyProblems={setOnlyProblems}
        shown={visible.length}
        exemptCount={exemptCount}
        leaverCount={leaverCount}
        showLeavers={showLeavers}
        setShowLeavers={setShowLeavers}
        needAttention={needAttention}
      />

      <div className="overflow-x-auto rounded-lg border border-border-soft bg-surface">
        <table className="w-full min-w-[46rem] border-collapse text-sm">
          <caption className="sr-only">
            Office attendance compliance for {month}, as at {asOf}
          </caption>
          <thead>
            <tr className="border-b border-border-soft">
              {COLUMNS.map((column) => {
                const active = sortKey === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={
                      active ? (direction === "asc" ? "ascending" : "descending") : "none"
                    }
                    className={`${column.className} px-3 py-2 font-medium`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      title={column.hint}
                      className={`group inline-flex items-center gap-1 rounded text-xs uppercase tracking-wide transition-colors hover:text-foreground ${
                        active ? "text-foreground" : "text-subtle"
                      }`}
                    >
                      {column.label}
                      <span
                        aria-hidden
                        className={`text-[0.65rem] transition-opacity ${
                          active ? "opacity-100" : "opacity-0 group-hover:opacity-40"
                        }`}
                      >
                        {active && direction === "desc" ? "▼" : "▲"}
                      </span>
                    </button>
                  </th>
                );
              })}
              <th scope="col" className="w-8 px-2 py-2">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <Row
                key={row.employeeId}
                row={row}
                expanded={expanded === row.employeeId}
                onToggle={() =>
                  setExpanded((current) =>
                    current === row.employeeId ? null : row.employeeId,
                  )
                }
              />
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-sm text-muted">
                  Nobody matches these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({
  row,
  expanded,
  onToggle,
}: {
  row: EmployeeRowWithDays;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={`animate-row-in border-b border-border-soft transition-colors last:border-0 hover:bg-surface-muted ${
          expanded ? "bg-surface-muted" : ""
        }`}
      >
        <th scope="row" className="px-3 py-2 text-left font-normal">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="text-left transition-colors hover:text-foreground"
          >
            {row.displayName}
            {row.isExempt && (
              <span className="ml-2 rounded bg-exempt-bg px-1.5 py-0.5 text-[0.65rem] text-exempt">
                {row.exemptionNote ?? "Exempt"}
              </span>
            )}
            {!row.onRosterThisMonth && (
              <span className="ml-2 rounded bg-na-bg px-1.5 py-0.5 text-[0.65rem] text-na">
                {row.hasLeft ? "Left" : "Not on this sheet"}
              </span>
            )}
          </button>
        </th>
        <td className="px-3 py-2">
          <VerdictCell result={row.monthly} />
        </td>
        <td className="px-3 py-2">
          <VerdictCell result={row.twoWeek} />
        </td>
        <td className="px-3 py-2">
          <LongTermCell result={row.longTerm} />
        </td>
        <td className="tabular px-3 py-2 text-xs text-muted">
          {row.lastAttended ?? <span className="text-no">Never</span>}
        </td>
        <td className="px-2 py-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} required days for ${row.displayName}`}
            className="flex h-6 w-6 items-center justify-center rounded text-subtle transition-all hover:bg-border-soft hover:text-foreground"
          >
            <span
              aria-hidden
              className={`text-[0.6rem] transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
            >
              ▶
            </span>
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border-soft bg-surface-muted">
          <td colSpan={6} className="px-3 pb-4 pt-1">
            <DayDetail row={row} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The month's required days for one person.
 *
 * The first question after "why is this person red?" is always "which days,
 * and did they say why?", so the answer lives one click away rather than in
 * another screen.
 */
function DayDetail({ row }: { row: EmployeeRowWithDays }) {
  if (row.monthDays.length === 0) {
    return <p className="text-xs text-muted">No required days this month.</p>;
  }

  return (
    <div className="animate-expand-in flex flex-wrap gap-1.5">
      {row.monthDays.map((day) => {
        const weekday = new Date(`${day.date}T00:00:00Z`).toLocaleDateString("en-GB", {
          weekday: "short",
          timeZone: "UTC",
        });
        const dayNum = day.date.slice(8);

        const style =
          day.outsideEmployment || day.state === "NO_RECORD"
            ? "border-border-soft bg-transparent text-subtle"
            : day.state === "PRESENT"
              ? "border-transparent bg-yes-bg text-yes"
              : day.state === "ABSENT_EXPLAINED"
                ? "border-transparent bg-na-bg text-muted"
                : "border-transparent bg-no-bg text-no";

        const label = day.outsideEmployment
          ? "Not employed"
          : day.state === "NO_RECORD"
            ? "No record"
            : day.state === "PRESENT"
              ? "In the office"
              : day.state === "ABSENT_EXPLAINED"
                ? (day.reasonLabel ?? day.reasonText ?? "Explained")
                : "Absent";

        return (
          <div
            key={day.date}
            title={`${day.date} — ${label}`}
            className={`flex min-w-[4.5rem] flex-col gap-0.5 rounded border px-2 py-1.5 ${style}`}
          >
            <span className="tabular text-[0.65rem] uppercase tracking-wide opacity-70">
              {weekday} {dayNum}
            </span>
            <span className="truncate text-xs" style={{ maxWidth: "10rem" }}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Controls(props: {
  month: string;
  months: string[];
  asOf: string;
  query: string;
  setQuery: (v: string) => void;
  showExempt: boolean;
  setShowExempt: (v: boolean) => void;
  onlyProblems: boolean;
  setOnlyProblems: (v: boolean) => void;
  shown: number;
  exemptCount: number;
  leaverCount: number;
  showLeavers: boolean;
  setShowLeavers: (v: boolean) => void;
  needAttention: number;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[0.65rem] uppercase tracking-wide text-subtle">Month</span>
          <select
            defaultValue={props.month}
            onChange={(event) => {
              const url = new URL(window.location.href);
              url.searchParams.set("month", event.target.value);
              window.location.href = url.toString();
            }}
            className="rounded border border-border-soft bg-surface px-2 py-1.5 text-sm transition-colors hover:border-border-strong"
          >
            {props.months.map((m) => (
              <option key={m} value={m}>
                {new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", {
                  month: "long",
                  year: "numeric",
                  timeZone: "UTC",
                })}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[0.65rem] uppercase tracking-wide text-subtle">Search</span>
          <input
            type="search"
            value={props.query}
            onChange={(event) => props.setQuery(event.target.value)}
            placeholder="Name…"
            className="w-44 rounded border border-border-soft bg-surface px-2 py-1.5 text-sm transition-colors hover:border-border-strong"
          />
        </label>

        <Toggle
          label="Only non-compliant"
          checked={props.onlyProblems}
          onChange={props.setOnlyProblems}
        />
        <Toggle
          label={`Show exempt (${props.exemptCount})`}
          checked={props.showExempt}
          onChange={props.setShowExempt}
        />
        {props.leaverCount > 0 && (
          <Toggle
            label={`Show people who have left (${props.leaverCount})`}
            checked={props.showLeavers}
            onChange={props.setShowLeavers}
          />
        )}
      </div>

      <p className="text-xs text-muted">
        <span className="tabular font-medium text-foreground">{props.shown}</span> shown
        {!props.showExempt && props.exemptCount > 0 && (
          <> · {props.exemptCount} exempt hidden</>
        )}
        {!props.showLeavers && props.leaverCount > 0 && (
          <> · {props.leaverCount} not on this month&rsquo;s sheet</>
        )}
        {props.needAttention > 0 && (
          <>
            {" "}
            · <span className="text-no">{props.needAttention} need attention</span>
          </>
        )}
      </p>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded border border-border-soft bg-surface px-2.5 py-1.5 text-sm transition-colors hover:border-border-strong">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 accent-current"
      />
      <span className={checked ? "text-foreground" : "text-muted"}>{label}</span>
    </label>
  );
}
