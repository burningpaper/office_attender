"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import type { Anomaly, AnomalyResolution } from "@/lib/import/anomalies";
import type { ImportReport } from "@/lib/import/import-workbook";

type Phase = "idle" | "previewing" | "reviewing" | "committing" | "done" | "error";

export function UploadClient() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const preview = useCallback(async (chosen: File) => {
    setPhase("previewing");
    setError(null);
    setFile(chosen);

    const form = new FormData();
    form.append("file", chosen);

    try {
      const response = await fetch("/api/import/preview", { method: "POST", body: form });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;

      if (!response.ok || !body) {
        setError(body?.error ?? `The server answered ${response.status}.`);
        setPhase("error");
        return;
      }

      setReport(body as ImportReport);
      setDecisions({});
      setPhase("reviewing");
    } catch (cause) {
      // A rejected fetch used to leave the screen stuck on "Reading the
      // workbook..." with nothing to explain it.
      setError(
        `Could not reach the server: ${cause instanceof Error ? cause.message : "unknown error"}.`,
      );
      setPhase("error");
    }
  }, []);

  async function commit() {
    if (!file || !report) return;
    setPhase("committing");
    setError(null);

    const resolutions: AnomalyResolution[] = report.anomalies
      .filter((a) => a.id in decisions)
      .map((a) => ({ id: a.id, accept: decisions[a.id] }));

    const form = new FormData();
    form.append("file", file);
    form.append("resolutions", JSON.stringify(resolutions));

    try {
      const response = await fetch("/api/import/commit", { method: "POST", body: form });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;

      // 409 means a question is still open - a normal outcome, not an error.
      if ((!response.ok && response.status !== 409) || !body) {
        setError(body?.error ?? `The server answered ${response.status}.`);
        setPhase("error");
        return;
      }

      setReport(body as ImportReport);
      setPhase(body.committed ? "done" : "reviewing");
    } catch (cause) {
      setError(
        `Could not reach the server: ${cause instanceof Error ? cause.message : "unknown error"}. ` +
          `The import may or may not have completed - check the report before retrying.`,
      );
      setPhase("error");
    }
  }

  const blocking = report?.anomalies.filter((a) => a.blocking) ?? [];
  const unanswered = blocking.filter((a) => !(a.id in decisions));
  const canCommit = report !== null && unanswered.length === 0 && !report.alreadyImported;

  return (
    <div className="flex flex-col gap-6">
      {(phase === "idle" || phase === "error") && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const dropped = e.dataTransfer.files[0];
            if (dropped) void preview(dropped);
          }}
          className={`rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors ${
            dragging ? "border-foreground bg-surface-muted" : "border-border-soft bg-surface"
          }`}
        >
          <p className="text-sm text-muted">Drop the attendance workbook here</p>
          <p className="mt-1 text-xs text-subtle">.xlsx or .xls</p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mt-4 rounded border border-border-strong px-3 py-1.5 text-sm transition-colors hover:bg-surface-muted"
          >
            Choose a file
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls"
            className="sr-only"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              if (chosen) void preview(chosen);
            }}
          />
        </div>
      )}

      {error && (
        <p className="rounded-md border border-border-soft bg-no-bg px-3 py-2 text-sm text-no">
          {error}
        </p>
      )}

      {(phase === "previewing" || phase === "committing") && (
        <p className="animate-row-in text-sm text-muted">
          {phase === "previewing" ? "Reading the workbook…" : "Writing the import…"}
        </p>
      )}

      {report && (phase === "reviewing" || phase === "done") && (
        <>
          {report.alreadyImported ? (
            <p className="rounded-md border border-border-soft bg-surface-muted px-3 py-2 text-sm text-muted">
              This exact file has already been imported. Nothing to do.
            </p>
          ) : (
            <>
              <Summary report={report} committed={phase === "done"} />

              {phase === "reviewing" && report.anomalies.length > 0 && (
                <AnomalyList
                  anomalies={report.anomalies}
                  decisions={decisions}
                  onDecide={(id, accept) =>
                    setDecisions((current) => ({ ...current, [id]: accept }))
                  }
                />
              )}

              {phase === "reviewing" && (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={!canCommit}
                    onClick={() => void commit()}
                    className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    {report.attendance.changed > 0
                      ? `Import ${report.attendance.inserted} new and ${report.attendance.changed} changed`
                      : `Import ${report.attendance.inserted.toLocaleString()} records`}
                  </button>
                  {unanswered.length > 0 && (
                    <p className="text-xs text-muted">
                      {unanswered.length} question{unanswered.length === 1 ? "" : "s"} still
                      to answer before this can be imported.
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setPhase("idle");
                      setReport(null);
                      setFile(null);
                    }}
                    className="text-sm text-muted underline underline-offset-2 transition-opacity hover:opacity-70"
                  >
                    Discard
                  </button>
                </div>
              )}

              {phase === "done" && (
                <div className="animate-row-in rounded-md border border-border-soft bg-yes-bg px-3 py-2 text-sm text-yes">
                  Imported. <Link href="/" className="underline underline-offset-2">View the report</Link>.
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Summary({ report, committed }: { report: ImportReport; committed: boolean }) {
  const stats: [string, string][] = [
    ["Range", `${report.dateRange?.start} → ${report.dateRange?.end}`],
    ["People", `${report.identities.total} names → ${report.identities.created} people`],
    [
      committed ? "Records written" : "What would change",
      `${report.attendance.inserted.toLocaleString()} new · ${report.attendance.changed} changed · ${report.attendance.unchanged.toLocaleString()} unchanged`,
    ],
    ["Explained absences", `${report.attendance.explained} with a written reason`],
    ["Reasons", `${report.reasons.distinct} distinct strings`],
  ];

  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-border-soft bg-surface px-4 py-3 text-sm sm:grid-cols-2">
      {stats.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 sm:block">
          <dt className="text-xs uppercase tracking-wide text-subtle">{label}</dt>
          <dd className="tabular text-right sm:mt-0.5 sm:text-left">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AnomalyList({
  anomalies,
  decisions,
  onDecide,
}: {
  anomalies: Anomaly[];
  decisions: Record<string, boolean>;
  onDecide: (id: string, accept: boolean) => void;
}) {
  const blocking = anomalies.filter((a) => a.blocking);
  const informational = anomalies.filter((a) => !a.blocking);

  return (
    <section className="flex flex-col gap-4">
      {blocking.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-medium">
            Needs a decision
            <span className="ml-2 font-normal text-subtle">
              nothing is written until these are answered
            </span>
          </h2>
          <ul className="flex flex-col gap-2">
            {blocking.map((anomaly) => (
              <li
                key={anomaly.id}
                className="animate-row-in rounded-lg border border-border-soft bg-surface px-4 py-3"
              >
                <p className="text-sm font-medium">{anomaly.title}</p>
                <p className="mt-1 text-sm text-muted">{anomaly.detail}</p>
                {anomaly.evidence && (
                  <p className="mt-2 rounded bg-surface-muted px-2 py-1.5 text-xs text-muted">
                    <span className="text-subtle">From the file: </span>
                    {anomaly.evidence}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Choice
                    label={anomaly.proposal ?? "Accept"}
                    selected={decisions[anomaly.id] === true}
                    onClick={() => onDecide(anomaly.id, true)}
                  />
                  <Choice
                    label="Leave it as it is"
                    selected={decisions[anomaly.id] === false}
                    onClick={() => onDecide(anomaly.id, false)}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {informational.length > 0 && (
        <details className="rounded-lg border border-border-soft bg-surface px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            Worth knowing
            <span className="ml-2 font-normal text-subtle">
              {informational.length} item{informational.length === 1 ? "" : "s"}, none blocking
            </span>
          </summary>
          <ul className="mt-3 flex flex-col gap-2.5">
            {informational.map((anomaly) => (
              <li key={anomaly.id} className="text-sm">
                <p className="font-medium">{anomaly.title}</p>
                <p className="text-muted">{anomaly.detail}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Choice({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded border px-2.5 py-1.5 text-xs transition-colors ${
        selected
          ? "border-foreground bg-foreground text-background"
          : "border-border-soft text-muted hover:border-border-strong hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
