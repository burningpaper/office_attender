import { weekdayInitial } from "@/lib/calendar/cadence";
import type { ComplianceResult, Verdict } from "@/lib/compliance/types";

const STYLES: Record<Verdict, string> = {
  NO: "bg-no-bg text-no",
  YES: "bg-yes-bg text-yes",
  NA: "bg-na-bg text-na",
  EXEMPT: "bg-exempt-bg text-exempt",
};

const LABELS: Record<Verdict, string> = {
  NO: "No",
  YES: "Yes",
  NA: "—",
  EXEMPT: "Exempt",
};

/**
 * A verdict, with the working shown.
 *
 * The fraction is not decoration. "No" alone hides whether somebody missed one
 * required day or all of them, and that difference is the entire point of the
 * report. The excused count is here for the same reason in reverse: a clean
 * "1/1" looks perfect until you notice the three sick days behind it.
 */
export function VerdictCell({
  result,
  title,
}: {
  result: ComplianceResult;
  title?: string;
}) {
  const showFraction = result.verdict === "YES" || result.verdict === "NO";

  return (
    <div className="flex items-baseline gap-1.5" title={title ?? result.note}>
      <span
        className={`inline-flex min-w-[2.75rem] justify-center rounded px-1.5 py-0.5 text-xs font-medium ${STYLES[result.verdict]}`}
      >
        {LABELS[result.verdict]}
      </span>
      {showFraction && (
        <span className="tabular text-xs text-muted">
          {result.attended}/{result.required}
          {result.excused > 0 && (
            <span className="text-subtle" title={`${result.excused} excused`}>
              {" "}
              +{result.excused}ex
            </span>
          )}
        </span>
      )}
      {result.verdict === "NA" && result.note && (
        <span className="truncate text-xs text-subtle">{shortNote(result.note)}</span>
      )}
    </div>
  );
}

/**
 * A verdict cell has room for two or three words. The full sentence stays on
 * the title attribute; this is the version that fits.
 */
function shortNote(note: string): string {
  if (/no required days have elapsed/i.test(note)) return "not yet";
  if (/every required day was excused/i.test(note)) return "all excused";
  const months = note.match(/(\d+) complete month/i);
  if (months) return `${months[1]} mo history`;
  const noDay = note.match(/no required (\w+)(?: or (\w+))? in the last/i);
  if (noDay) return `no ${[noDay[1], noDay[2]].filter(Boolean).map((d) => d.slice(0, 3)).join("/")}`;
  if (/no required days/i.test(note)) return "none due";
  return note;
}

/**
 * Long term is one average per required weekday, not a total - a total invites
 * exactly the wrong reading, because somebody can clear it and still never
 * appear on a Friday.
 */
export function LongTermCell({
  result,
}: {
  result: ComplianceResult & {
    perWeekday: { weekday: number; average: number; judged: boolean }[];
    monthsCounted: number;
  };
}) {
  if (result.verdict === "EXEMPT" || result.verdict === "NA") {
    return (
      <VerdictCell
        result={result}
        title={result.note ?? `${result.monthsCounted} complete months`}
      />
    );
  }

  return (
    <div
      className="flex items-baseline gap-1.5"
      title={
        `Averaged over ${result.monthsCounted} complete months. Target is 3 of each. ` +
        (result.perWeekday.some((d) => !d.judged)
          ? `Faded: too few months of history to judge yet.`
          : "")
      }
    >
      <span
        className={`inline-flex min-w-[2.75rem] justify-center rounded px-1.5 py-0.5 text-xs font-medium ${STYLES[result.verdict]}`}
      >
        {LABELS[result.verdict]}
      </span>
      <span className="tabular text-xs text-muted">
        {result.perWeekday.map((day, i) => (
          <span key={day.weekday} className={day.judged ? undefined : "opacity-50"}>
            {i > 0 && " "}
            {day.average.toFixed(1)}
            <span className="text-subtle">{weekdayInitial(day.weekday)}</span>
          </span>
        ))}
      </span>
    </div>
  );
}
